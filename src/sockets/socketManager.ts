import { Server, Socket } from 'socket.io';

let ioInstance: Server | null = null;

// Map of userId -> Set of socketIds (supports multiple tabs / devices per user)
export const onlineUsers = new Map<string, Set<string>>();

export const setIO = (io: Server): void => {
  ioInstance = io;
};

export const getIO = (): Server => {
  if (!ioInstance) {
    throw new Error('Socket.IO has not been initialized');
  }
  return ioInstance;
};

export const emitToUser = (userId: string, event: string, data: any): void => {
  if (ioInstance) {
    ioInstance.to(`user:${userId}`).emit(event, data);
  }
};

export const emitToConversation = (conversationId: string, event: string, data: any): void => {
  if (ioInstance) {
    ioInstance.to(`conversation:${conversationId}`).emit(event, data);
  }
};

export const isUserOnline = (userId: string): boolean => {
  const sockets = onlineUsers.get(userId.toString());
  return !!sockets && sockets.size > 0;
};
