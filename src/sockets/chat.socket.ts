import { Server, Socket } from 'socket.io';

export const registerChatHandlers = (io: Server, socket: Socket): void => {
  const userId = socket.data.userId;

  // Join a conversation room
  socket.on('conversation:join', (conversationId: string) => {
    if (!conversationId) return;
    socket.join(`conversation:${conversationId}`);
  });

  // Leave a conversation room
  socket.on('conversation:leave', (conversationId: string) => {
    if (!conversationId) return;
    socket.leave(`conversation:${conversationId}`);
  });

  // Typing indicators
  socket.on('typing:start', ({ conversationId, username }: { conversationId: string; username?: string }) => {
    if (!conversationId) return;
    socket.to(`conversation:${conversationId}`).emit('typing:started', {
      conversationId,
      userId,
      username: username || socket.data.user?.displayName || 'Someone',
    });
  });

  socket.on('typing:stop', ({ conversationId }: { conversationId: string }) => {
    if (!conversationId) return;
    socket.to(`conversation:${conversationId}`).emit('typing:stopped', {
      conversationId,
      userId,
    });
  });

  // Read receipt broadcast
  socket.on('message:read_ack', ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
    if (!conversationId || !messageId) return;
    socket.to(`conversation:${conversationId}`).emit('message:read', {
      conversationId,
      messageId,
      userId,
    });
  });
};
