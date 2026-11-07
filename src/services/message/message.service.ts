import mongoose from 'mongoose';
import { Conversation, IConversation } from '../../models/Conversation';
import { Message, IMessage, MessageType } from '../../models/Message';
import { User } from '../../models/User';
import { USER_PUBLIC_FIELDS } from '../../models/serialize';

export const MAX_MESSAGE_LENGTH = 5000;
const MAX_PAGE_SIZE = 100;
const MESSAGE_TYPES: MessageType[] = ['text', 'image', 'audio', 'video', 'call_log'];

const isValidId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

const conversationPopulate = [
  { path: 'participants', select: USER_PUBLIC_FIELDS },
  {
    path: 'lastMessage',
    populate: { path: 'sender', select: USER_PUBLIC_FIELDS },
  },
];

export class MessageService {
  /** Throws unless `userId` is a participant of the conversation. */
  static async assertParticipant(conversationId: string, userId: string): Promise<IConversation> {
    if (!isValidId(conversationId)) {
      throw new Error('Conversation not found or access denied');
    }
    const conversation = await Conversation.findOne({ _id: conversationId, participants: userId });
    if (!conversation) {
      throw new Error('Conversation not found or access denied');
    }
    return conversation;
  }

  static async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    if (!isValidId(conversationId)) return false;
    return !!(await Conversation.exists({ _id: conversationId, participants: userId }));
  }

  static async getConversations(userId: string): Promise<IConversation[]> {
    return Conversation.find({ participants: userId })
      .populate(conversationPopulate)
      .sort({ updatedAt: -1 });
  }

  static async getConversation(conversationId: string, userId: string): Promise<IConversation | null> {
    if (!isValidId(conversationId)) return null;
    return Conversation.findOne({
      _id: conversationId,
      participants: userId,
    }).populate(conversationPopulate);
  }

  static async createConversation(currentUserId: string, participantId: string): Promise<IConversation> {
    if (currentUserId === participantId) {
      throw new Error('Cannot create conversation with yourself');
    }
    if (!isValidId(participantId)) {
      throw new Error('Participant not found');
    }

    const participantExists = await User.exists({ _id: participantId });
    if (!participantExists) {
      throw new Error('Participant not found');
    }

    // Check if 1-on-1 conversation already exists
    const existing = await Conversation.findOne({
      participants: { $all: [currentUserId, participantId], $size: 2 },
    }).populate(conversationPopulate);

    if (existing) {
      return existing;
    }

    const conversation = new Conversation({
      participants: [currentUserId, participantId],
      unreadCounts: [
        { userId: currentUserId, count: 0 },
        { userId: participantId, count: 0 },
      ],
    });

    await conversation.save();
    return conversation.populate(conversationPopulate);
  }

  static async getMessages(
    conversationId: string,
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<IMessage[]> {
    await MessageService.assertParticipant(conversationId, userId);

    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_PAGE_SIZE);
    const safeOffset = Math.max(0, Math.floor(offset) || 0);

    const msgs = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(safeOffset)
      .limit(safeLimit)
      .populate('sender', USER_PUBLIC_FIELDS);
    return msgs.reverse(); // chronological order
  }

  static async sendMessage(
    senderId: string,
    conversationId: string,
    content: string,
    type: MessageType = 'text'
  ): Promise<{ message: IMessage; participantIds: string[] }> {
    const trimmed = (content || '').trim();
    if (!trimmed) {
      throw new Error('Message content cannot be empty');
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);
    }
    if (!MESSAGE_TYPES.includes(type)) {
      throw new Error('Invalid message type');
    }

    const conversation = await MessageService.assertParticipant(conversationId, senderId);

    const message = new Message({
      conversationId,
      sender: senderId,
      content: trimmed,
      type,
      readBy: [senderId],
      status: 'sent',
    });

    await message.save();

    // Update conversation lastMessage & increment unread for other participants
    conversation.lastMessage = message._id;
    conversation.unreadCounts.forEach((uc) => {
      if (uc.userId.toString() !== senderId) {
        uc.count = (uc.count || 0) + 1;
      }
    });
    conversation.markModified('unreadCounts');
    await conversation.save();

    await message.populate('sender', USER_PUBLIC_FIELDS);
    return {
      message,
      participantIds: conversation.participants.map((p) => p.toString()),
    };
  }

  static async markMessageAsRead(messageId: string, userId: string): Promise<IMessage> {
    if (!isValidId(messageId)) {
      throw new Error('Message not found');
    }
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found');
    }

    await MessageService.assertParticipant(message.conversationId.toString(), userId);

    const hasRead = message.readBy.some((id) => id.toString() === userId);
    if (!hasRead) {
      message.readBy.push(new mongoose.Types.ObjectId(userId));
      if (message.sender.toString() !== userId) {
        message.status = 'read';
      }
      await message.save();
    }

    await MessageService.recalculateUnread(message.conversationId.toString(), userId);

    return message.populate('sender', USER_PUBLIC_FIELDS);
  }

  /** Marks every message from other participants as read and resets the user's unread counter. */
  static async markConversationAsRead(
    conversationId: string,
    userId: string
  ): Promise<{ conversation: IConversation; messageIds: string[] }> {
    const conversation = await MessageService.assertParticipant(conversationId, userId);
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const unread = await Message.find(
      { conversationId, sender: { $ne: userObjectId }, readBy: { $ne: userObjectId } },
      { _id: 1 }
    );
    const messageIds = unread.map((m) => m._id);

    if (messageIds.length > 0) {
      await Message.updateMany(
        { _id: { $in: messageIds } },
        { $addToSet: { readBy: userObjectId }, $set: { status: 'read' } }
      );
    }

    await Conversation.updateOne(
      { _id: conversationId, 'unreadCounts.userId': userObjectId },
      { $set: { 'unreadCounts.$.count': 0 } }
    );

    const refreshed = await Conversation.findById(conversation._id).populate(conversationPopulate);
    return {
      conversation: refreshed || conversation,
      messageIds: messageIds.map((id) => id.toString()),
    };
  }

  private static async recalculateUnread(conversationId: string, userId: string): Promise<void> {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const remaining = await Message.countDocuments({
      conversationId,
      sender: { $ne: userObjectId },
      readBy: { $ne: userObjectId },
    });
    await Conversation.updateOne(
      { _id: conversationId, 'unreadCounts.userId': userObjectId },
      { $set: { 'unreadCounts.$.count': remaining } }
    );
  }

  static async deleteMessage(
    messageId: string,
    userId: string
  ): Promise<{ conversationId: string; participantIds: string[] }> {
    if (!isValidId(messageId)) {
      throw new Error('Message not found');
    }
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found');
    }

    if (message.sender.toString() !== userId) {
      throw new Error('Not authorized to delete this message');
    }

    const conversationId = message.conversationId.toString();
    await Message.deleteOne({ _id: messageId });

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return { conversationId, participantIds: [] };
    }

    // Repoint lastMessage if the deleted message was the latest one
    if (conversation.lastMessage?.toString() === messageId) {
      const latest = await Message.findOne({ conversationId }).sort({ createdAt: -1 });
      conversation.lastMessage = latest ? latest._id : undefined;
    }

    // If the other side had not read it yet, it should no longer count as unread
    if (!message.readBy.some((id) => id.toString() !== userId)) {
      conversation.unreadCounts.forEach((uc) => {
        if (uc.userId.toString() !== userId && uc.count > 0) {
          uc.count -= 1;
        }
      });
      conversation.markModified('unreadCounts');
    }
    await conversation.save();

    return {
      conversationId,
      participantIds: conversation.participants.map((p) => p.toString()),
    };
  }
}
