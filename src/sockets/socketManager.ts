import { Server } from 'socket.io';

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

/** Emit once to every device of every listed user (socket.io de-duplicates across rooms). */
export const emitToUsers = (userIds: string[], event: string, data: any): void => {
  if (ioInstance && userIds.length > 0) {
    ioInstance.to(userIds.map((id) => `user:${id}`)).emit(event, data);
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

export const getOnlineUserIds = (): string[] =>
  Array.from(onlineUsers.entries())
    .filter(([, sockets]) => sockets.size > 0)
    .map(([uid]) => uid);
