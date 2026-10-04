import { GraphQLError } from 'graphql';
import { UserService } from '../../services/user/user.service';
import { MessageService } from '../../services/message/message.service';
import { CallService } from '../../services/call/call.service';
import { emitToConversation, emitToUser, isUserOnline } from '../../sockets/socketManager';
import { IUser } from '../../models/User';

export interface GraphQLContext {
  user: IUser | null;
}

const checkAuth = (context: GraphQLContext): IUser => {
  if (!context.user) {
    throw new GraphQLError('Authentication required for this operation', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return context.user;
};

export const resolvers = {
  User: {
    id: (parent: any) => parent._id?.toString() || parent.id,
    isOnline: (parent: any) => {
      // Check real-time active socket connection or db state
      return isUserOnline(parent._id?.toString() || parent.id) || !!parent.isOnline;
    },
    createdAt: (parent: any) => new Date(parent.createdAt).toISOString(),
    updatedAt: (parent: any) => new Date(parent.updatedAt).toISOString(),
    lastSeen: (parent: any) => (parent.lastSeen ? new Date(parent.lastSeen).toISOString() : null),
  },

  Conversation: {
    id: (parent: any) => parent._id?.toString() || parent.id,
    createdAt: (parent: any) => new Date(parent.createdAt).toISOString(),
    updatedAt: (parent: any) => new Date(parent.updatedAt).toISOString(),
  },

  UnreadCount: {
    userId: (parent: any) => parent.userId?.toString() || parent.userId,
    count: (parent: any) => parent.count || 0,
  },

  Message: {
    id: (parent: any) => parent._id?.toString() || parent.id,
    conversationId: (parent: any) => parent.conversationId?.toString() || parent.conversationId,
    readBy: (parent: any) => (parent.readBy || []).map((id: any) => id.toString()),
    createdAt: (parent: any) => new Date(parent.createdAt).toISOString(),
    updatedAt: (parent: any) => new Date(parent.updatedAt).toISOString(),
  },

  CallRecord: {
    id: (parent: any) => parent._id?.toString() || parent.id,
    conversationId: (parent: any) => (parent.conversationId ? parent.conversationId.toString() : null),
    startedAt: (parent: any) => (parent.startedAt ? new Date(parent.startedAt).toISOString() : null),
    endedAt: (parent: any) => (parent.endedAt ? new Date(parent.endedAt).toISOString() : null),
    createdAt: (parent: any) => new Date(parent.createdAt).toISOString(),
    updatedAt: (parent: any) => new Date(parent.updatedAt).toISOString(),
  },

  Query: {
    GetCurrentUser: async (_: any, __: any, context: GraphQLContext) => {
      const user = checkAuth(context);
      return user;
    },

    SearchUsers: async (_: any, { query }: { query?: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      return UserService.searchUsers(query || '', user._id.toString());
    },

    GetUserProfile: async (_: any, { userId }: { userId: string }, context: GraphQLContext) => {
      checkAuth(context);
      const profile = await UserService.getUserProfile(userId);
      if (!profile) {
        throw new GraphQLError('User not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return profile;
    },

    GetConversations: async (_: any, __: any, context: GraphQLContext) => {
      const user = checkAuth(context);
      return MessageService.getConversations(user._id.toString());
    },

    GetConversation: async (_: any, { conversationId }: { conversationId: string }, context: GraphQLContext) => {
      const user = checkAuth(context);
      const conversation = await MessageService.getConversation(conversationId, user._id.toString());
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
      checkAuth(context);
      return MessageService.getMessages(conversationId, limit, offset);
    },

    GetCallHistory: async (_: any, __: any, context: GraphQLContext) => {
      const user = checkAuth(context);
      return CallService.getCallHistory(user._id.toString());
    },
  },

  Mutation: {
    UpdateProfile: async (
      _: any,
      { input }: { input: any },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      return UserService.updateProfile(user._id.toString(), input);
    },

    CreateConversation: async (
      _: any,
      { participantId }: { participantId: string },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      const conversation = await MessageService.createConversation(
        user._id.toString(),
        participantId
      );

      // Notify the participant that a conversation has been created
      emitToUser(participantId, 'conversation:created', conversation);

      return conversation;
    },

    SendMessage: async (
      _: any,
      {
        conversationId,
        content,
        type,
      }: { conversationId: string; content: string; type?: any },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      const message = await MessageService.sendMessage(
        user._id.toString(),
        conversationId,
        content,
        type
      );

      // Real-time broadcast to room
      emitToConversation(conversationId, 'message:new', message);

      return message;
    },

    MarkMessageAsRead: async (
      _: any,
      { messageId }: { messageId: string },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      const message = await MessageService.markMessageAsRead(
        messageId,
        user._id.toString()
      );

      // Real-time notification of read status
      emitToConversation(message.conversationId.toString(), 'message:read', {
        messageId: message._id.toString(),
        userId: user._id.toString(),
      });

      return message;
    },

    DeleteMessage: async (
      _: any,
      { messageId }: { messageId: string },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      const deleted = await MessageService.deleteMessage(
        messageId,
        user._id.toString()
      );
      return deleted;
    },

    CreateCallRecord: async (
      _: any,
      { input }: { input: any },
      context: GraphQLContext
    ) => {
      const user = checkAuth(context);
      return CallService.createCallRecord({
        callerId: user._id.toString(),
        receiverId: input.receiverId,
        callType: input.callType,
        conversationId: input.conversationId,
      });
    },

    UpdateCallStatus: async (
      _: any,
      {
        callId,
        status,
        duration,
      }: { callId: string; status: any; duration?: number },
      context: GraphQLContext
    ) => {
      checkAuth(context);
      return CallService.updateCallStatus(callId, status, duration);
    },
  },
};
