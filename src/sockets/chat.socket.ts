import { Server, Socket } from 'socket.io';
import { MessageService } from '../services/message/message.service';

const roomName = (conversationId: string) => `conversation:${conversationId}`;
const PARTICIPANT_CACHE_MS = 60_000;

export const registerChatHandlers = (io: Server, socket: Socket): void => {
  const userId: string = socket.data.userId;

  // conversationId -> { other participant ids, cachedAt } for conversations this user belongs to
  const participantCache = new Map<string, { others: string[]; cachedAt: number }>();

  const getOtherParticipants = async (conversationId: unknown): Promise<string[] | null> => {
    if (typeof conversationId !== 'string' || !conversationId) return null;
    const cached = participantCache.get(conversationId);
    if (cached && Date.now() - cached.cachedAt < PARTICIPANT_CACHE_MS) return cached.others;

    if (!(await MessageService.isParticipant(conversationId, userId))) return null;
    const others = (await MessageService.getParticipantIds(conversationId)).filter((id) => id !== userId);
    participantCache.set(conversationId, { others, cachedAt: Date.now() });
    return others;
  };

  // Join a conversation room — only participants may join
  socket.on('conversation:join', async (conversationId: string, ack?: (ok: boolean) => void) => {
    try {
      const allowed = (await getOtherParticipants(conversationId)) !== null;
      if (allowed) {
        socket.join(roomName(conversationId));
      }
      if (typeof ack === 'function') ack(allowed);
    } catch (err: any) {
      console.error('[ChatSocket] join error:', err.message);
      if (typeof ack === 'function') ack(false);
    }
  });

  // Leave a conversation room
  socket.on('conversation:leave', (conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return;
    socket.leave(roomName(conversationId));
  });

  // Typing indicators go to the other participants' devices (so chat lists can show them too)
  const relayTyping = async (conversationId: unknown, isTyping: boolean) => {
    try {
      const others = await getOtherParticipants(conversationId);
      if (!others || others.length === 0) return;
      io.to(others.map((id) => `user:${id}`)).emit(isTyping ? 'typing:started' : 'typing:stopped', {
        conversationId,
        userId,
        // Never trust a client-supplied name
        ...(isTyping ? { username: socket.data.user?.displayName || 'Someone' } : {}),
      });
    } catch (err: any) {
      console.error('[ChatSocket] typing relay error:', err.message);
    }
  };

  socket.on('typing:start', (payload: { conversationId?: string } = {}) => {
    relayTyping(payload?.conversationId, true);
  });

  socket.on('typing:stop', (payload: { conversationId?: string } = {}) => {
    relayTyping(payload?.conversationId, false);
  });
};
