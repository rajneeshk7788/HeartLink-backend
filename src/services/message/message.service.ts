import mongoose from 'mongoose';
import { Conversation, IConversation } from '../../models/Conversation';
import { Message, IMessage, MessageType } from '../../models/Message';
import { User } from '../../models/User';

export class MessageService {
  static async getConversations(userId: string): Promise<IConversation[]> {
    return Conversation.find({ participants: userId })
      .populate('participants', 'username displayName avatar bio isOnline lastSeen')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'username displayName avatar' },
      })
      .sort({ updatedAt: -1 });
  }

  static async getConversation(conversationId: string, userId: string): Promise<IConversation | null> {
    return Conversation.findOne({
      _id: conversationId,
      participants: userId,
    })
      .populate('participants', 'username displayName avatar bio isOnline lastSeen')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'username displayName avatar' },
      });
  }

  static async createConversation(currentUserId: string, participantId: string): Promise<IConversation> {
    if (currentUserId === participantId) {
      throw new Error('Cannot create conversation with yourself');
    }

    const participantExists = await User.findById(participantId);
    if (!participantExists) {
      throw new Error('Participant not found');
    }

    // Check if 1-on-1 conversation already exists
    let conversation = await Conversation.findOne({
      participants: { $all: [currentUserId, participantId], $size: 2 },
    })
      .populate('participants', 'username displayName avatar bio isOnline lastSeen')
      .populate('lastMessage');

    if (conversation) {
      return conversation;
    }

    conversation = new Conversation({
      participants: [currentUserId, participantId],
      unreadCounts: [
        { userId: currentUserId, count: 0 },
        { userId: participantId, count: 0 },
      ],
    });

    await conversation.save();

    return conversation.populate('participants', 'username displayName avatar bio isOnline lastSeen');
  }

  static async getMessages(conversationId: string, limit = 50, offset = 0): Promise<IMessage[]> {
    return Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('sender', 'username displayName avatar')
      .then((msgs) => msgs.reverse()); // return in chronological order
  }

  static async sendMessage(
    senderId: string,
    conversationId: string,
    content: string,
    type: MessageType = 'text'
  ): Promise<IMessage> {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const isParticipant = conversation.participants.some(
      (p) => p.toString() === senderId
    );
    if (!isParticipant) {
      throw new Error('Sender is not a participant in this conversation');
    }

    const message = new Message({
      conversationId,
      sender: senderId,
      content,
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

    await conversation.save();

    return message.populate('sender', 'username displayName avatar');
  }

  static async markMessageAsRead(messageId: string, userId: string): Promise<IMessage> {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found');
    }

    const hasRead = message.readBy.some((id) => id.toString() === userId);
    if (!hasRead) {
      message.readBy.push(new mongoose.Types.ObjectId(userId));
      message.status = 'read';
      await message.save();
    }

    // Reset unread count for this user in the conversation
    await Conversation.updateOne(
      { _id: message.conversationId, 'unreadCounts.userId': userId },
      { $set: { 'unreadCounts.$.count': 0 } }
    );

    return message.populate('sender', 'username displayName avatar');
  }

  static async deleteMessage(messageId: string, userId: string): Promise<boolean> {
    const message = await Message.findById(messageId);
    if (!message) {
      throw new Error('Message not found');
    }

    if (message.sender.toString() !== userId) {
      throw new Error('Not authorized to delete this message');
    }

    await Message.findByIdAndDelete(messageId);
    return true;
  }
}
