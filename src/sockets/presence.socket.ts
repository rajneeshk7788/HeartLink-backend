import { Server, Socket } from 'socket.io';
import { UserService } from '../services/user/user.service';
import { onlineUsers, getOnlineUserIds } from './socketManager';

export const registerPresenceHandlers = (io: Server, socket: Socket): void => {
  const userId: string = socket.data.userId;
  if (!userId) return;

  // Add socket ID to user's set of connections
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  const userSockets = onlineUsers.get(userId)!;
  const wasOffline = userSockets.size === 0;
  userSockets.add(socket.id);

  // Join personal room for targeted events
  socket.join(`user:${userId}`);

  // If user just came online from 0 active connections
  if (wasOffline) {
    const now = new Date();
    UserService.setPresence(userId, true).catch((err) =>
      console.error('[Presence] Failed to mark online:', err.message)
    );
    socket.broadcast.emit('user:online', {
      userId,
      isOnline: true,
      lastSeen: now.toISOString(),
    });
  }

  // Push the full online list to the newly connected client
  socket.emit('presence:sync', { onlineUserIds: getOnlineUserIds() });

  // Client requests list of all currently online users
  socket.on('users:get_online', (callback?: (onlineUserIds: string[]) => void) => {
    const onlineList = getOnlineUserIds();
    if (typeof callback === 'function') {
      callback(onlineList);
    } else {
      socket.emit('users:online_list', onlineList);
    }
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    const currentSockets = onlineUsers.get(userId);
    if (!currentSockets) return;
    currentSockets.delete(socket.id);
    if (currentSockets.size === 0) {
      onlineUsers.delete(userId);
      const lastSeen = new Date();
      try {
        await UserService.setPresence(userId, false);
      } catch (err: any) {
        console.error('[Presence] Failed to mark offline:', err.message);
      }
      io.emit('user:offline', {
        userId,
        isOnline: false,
        lastSeen: lastSeen.toISOString(),
      });
    }
  });
};
