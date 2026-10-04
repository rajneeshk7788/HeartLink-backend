import { Server, Socket } from 'socket.io';
import { User } from '../models/User';
import { onlineUsers } from './socketManager';

export const registerPresenceHandlers = (io: Server, socket: Socket): void => {
  const userId = socket.data.userId;
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
    User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() }).exec();
    io.emit('user:online', {
      userId,
      isOnline: true,
      lastSeen: new Date().toISOString(),
    });
  }

  // Client requests list of all currently online users
  socket.on('users:get_online', (callback?: (onlineUserIds: string[]) => void) => {
    const onlineList = Array.from(onlineUsers.keys()).filter(
      (uid) => (onlineUsers.get(uid)?.size || 0) > 0
    );
    if (typeof callback === 'function') {
      callback(onlineList);
    } else {
      socket.emit('users:online_list', onlineList);
    }
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    const currentSockets = onlineUsers.get(userId);
    if (currentSockets) {
      currentSockets.delete(socket.id);
      if (currentSockets.size === 0) {
        onlineUsers.delete(userId);
        const lastSeen = new Date();
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen }).exec();
        io.emit('user:offline', {
          userId,
          isOnline: false,
          lastSeen: lastSeen.toISOString(),
        });
      }
    }
  });
};
