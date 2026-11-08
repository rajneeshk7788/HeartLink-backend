import { GraphQLError } from 'graphql';
import { UserService } from '../../services/user/user.service';
import { MessageService } from '../../services/message/message.service';
import { CallService } from '../../services/call/call.service';
import { emitToUser, emitToUsers, isUserOnline } from '../../sockets/socketManager';
import { User } from '../../models/types';

export interface GraphQLContext {
  user: User | null;
}

const checkAuth = (context: GraphQLContext): User => {
  if (!context.user) {
    throw new GraphQLError('Authentication required for this operation', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return context.user;
};

/** Converts service errors into client-friendly GraphQL errors. */
const run = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof GraphQLError) throw err;
    const message: string = err?.message || 'Request failed';
    const code = /not found|access denied/i.test(message)
      ? 'NOT_FOUND'
      : /not authorized/i.test(message)
        ? 'FORBIDDEN'
        : 'BAD_USER_INPUT';
    throw new GraphQLError(message, { extensions: { code } });
  }
};

const idOf = (parent: any): string => String(parent?.id);

const toISO = (value: any): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
// Non-null timestamp fields fall back to "now" rather than crashing on partial documents
const toISORequired = (value: any): string => toISO(value) || new Date().toISOString();

/** Plain JSON copy for socket payloads (Dates become ISO strings). */
const serialize = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const resolvers = {
  User: {
    id: idOf,
    // Email is private: only returned on the requesting user's own record
    email: (parent: any, _: any, context: GraphQLContext) =>
      context.user && idOf(parent) === context.user.id ? parent.email || null : null,
    isOnline: (parent: any) => isUserOnline(idOf(parent)),
    createdAt: (parent: any) => toISORequired(parent.createdAt),
    updatedAt: (parent: any) => toISORequired(parent.updatedAt),
    lastSeen: (parent: any) => toISO(parent.lastSeen),
  },

  Conversation: {
    id: idOf,
    createdAt: (parent: any) => toISORequired(parent.createdAt),
    updatedAt: (parent: any) => toISORequired(parent.updatedAt),
  },

  UnreadCount: {
    userId: (parent: any) => parent.userId?.toString() || parent.userId,
    count: (parent: any) => parent.count || 0,
  },

  Message: {
    id: idOf,
    conversationId: (parent: any) => parent.conversationId?.toString() || parent.conversationId,
    readBy: (parent: any) => (parent.readBy || []).map((id: any) => id.toString()),
    createdAt: (parent: any) => toISORequired(parent.createdAt),
    updatedAt: (parent: any) => toISORequired(parent.updatedAt),
  },

  CallRecord: {
    id: idOf,
    conversationId: (parent: any) => (parent.conversationId ? parent.conversationId.toString() : null),
    startedAt: (parent: any) => toISO(parent.startedAt),
    endedAt: (parent: any) => toISO(parent.endedAt),
    createdAt: (parent: any) => toISORequired(parent.createdAt),
    updatedAt: (parent: any) => toISORequired(parent.updatedAt),
  },

  Query: {
    GetCurrentUser: async (_: any, __: any, context: GraphQLContext) => checkAuth(context),

    SearchUsers: async (_: any, { query }: { query?: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      return run(() => UserService.searchUsers(query || '', user.id));
    },

    GetUserProfile: async (_: any, { userId }: { userId: string }, context: GraphQLContext) => {
      checkAuth(context);
      const profile = await UserService.getUserProfile(userId);
      if (!profile) {
        throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
      }
      return profile;
    },

    GetConversations: async (_: any, __: any, context: GraphQLContext) => {
      const user = checkAuth(context);
      return run(() => MessageService.getConversations(user.id));
    },

    GetConversation: async (_: any, { conversationId }: { conversationId: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      const conversation = await MessageService.getConversation(conversationId, user.id);
      if (!conversation) {
        throw new GraphQLError('Conversation not found or access denied', {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return conversation;
    },

    GetMessages: async (
      _: any,
      { conversationId, limit, offset }: { conversationId: string; limit?: number; offset?: number },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      return run(() =>
        MessageService.getMessages(conversationId, user.id, limit ?? 50, offset ?? 0)
      );
    },

    GetCallHistory: async (_: any, __: any, context: GraphQLContext) => {
      const user = checkAuth(context);
      return run(() => CallService.getCallHistory(user.id));
    },
  },

  Mutation: {
    UpdateProfile: async (_: any, { input }: { input: any }, context: GraphQLContext) => {
      const user = checkAuth(context);
      return run(() => UserService.updateProfile(user.id, input || {}));
    },

    CreateConversation: async (_: any, { participantId }: { participantId: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      const conversation = await run(() =>
        MessageService.createConversation(user.id, participantId)
      );

      // Notify the participant that a conversation is available
      emitToUser(participantId, 'conversation:created', serialize(conversation));

      return conversation;
    },

    SendMessage: async (
      _: any,
      { conversationId, content, type }: { conversationId: string; content: string; type?: any },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      const { message, participantIds } = await run(() =>
        MessageService.sendMessage(user.id, conversationId, content, type || 'text')
      );

      // Deliver to every device of every participant (chat list + open chat both update)
      emitToUsers(participantIds, 'message:new', serialize(message));

      return message;
    },

    MarkMessageAsRead: async (_: any, { messageId }: { messageId: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      const message = await run(() => MessageService.markMessageAsRead(messageId, user.id));
      const participantIds = await MessageService.getParticipantIds(message.conversationId);

      emitToUsers(participantIds, 'message:read', {
        conversationId: message.conversationId,
        messageId: message.id,
        userId: user.id,
      });

      return message;
    },

    MarkConversationAsRead: async (
      _: any,
      { conversationId }: { conversationId: string },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      const { conversation, messageIds } = await run(() =>
        MessageService.markConversationAsRead(conversationId, user.id)
      );

      emitToUsers(
        conversation.participants.map((p: any) => idOf(p)),
        'conversation:read',
        { conversationId, userId: user.id, messageIds }
      );

      return conversation;
    },

    DeleteMessage: async (_: any, { messageId }: { messageId: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      const { conversationId, participantIds } = await run(() =>
        MessageService.deleteMessage(messageId, user.id)
      );
      emitToUsers(participantIds, 'message:deleted', { conversationId, messageId });
      return true;
    },

    CreateCallRecord: async (_: any, { input }: { input: any }, context: GraphQLContext) => {
      const user = checkAuth(context);
      return run(() =>
        CallService.createCallRecord({
          callerId: user.id,
          receiverId: input.receiverId,
          callType: input.callType,
          conversationId: input.conversationId,
        })
      );
    },

    UpdateCallStatus: async (
      _: any,
      { callId, status, duration }: { callId: string; status: any; duration?: number },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      return run(() => CallService.updateCallStatus(callId, status, duration, user.id));
    },
  },
};
