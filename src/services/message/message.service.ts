import { query, queryOne, withTransaction, Tx } from '../../db';
import {
  Conversation,
  Message,
  MessageType,
  isValidId,
  conversationColumns,
  messageColumns,
} from '../../models/types';

export const MAX_MESSAGE_LENGTH = 5000;
const MAX_PAGE_SIZE = 100;
const MESSAGE_TYPES: MessageType[] = ['text', 'image', 'audio', 'video', 'call_log'];
const ACCESS_DENIED = 'Conversation not found or access denied';

const fetchMessage = async (db: Tx | null, messageId: string): Promise<Message | null> => {
  const sql = `SELECT ${messageColumns('m', 's')} FROM messages m JOIN users s ON s.id = m.sender_id WHERE m.id = $1`;
  if (db) {
    const { rows } = await db.query(sql, [messageId]);
    return rows[0] ?? null;
  }
  return queryOne<Message>(sql, [messageId]);
};

const fetchConversation = async (conversationId: string): Promise<Conversation | null> =>
  queryOne<Conversation>(`SELECT ${conversationColumns('c')} FROM conversations c WHERE c.id = $1`, [conversationId]);

export class MessageService {
  /** Throws unless `userId` is a participant of the conversation. */
  static async assertParticipant(conversationId: string, userId: string): Promise<void> {
    if (!(await MessageService.isParticipant(conversationId, userId))) {
      throw new Error(ACCESS_DENIED);
    }
  }

  static async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    if (!isValidId(conversationId) || !isValidId(userId)) return false;
    return !!(await queryOne(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    ));
  }

  static async getParticipantIds(conversationId: string): Promise<string[]> {
    if (!isValidId(conversationId)) return [];
    const rows = await query<{ user_id: string }>(
      'SELECT user_id::text AS user_id FROM conversation_participants WHERE conversation_id = $1',
      [conversationId]
    );
    return rows.map((r) => r.user_id);
  }

  static async getConversations(userId: string): Promise<Conversation[]> {
    return query<Conversation>(
      `SELECT ${conversationColumns('c')}
         FROM conversations c
         JOIN conversation_participants me ON me.conversation_id = c.id AND me.user_id = $1
        ORDER BY c.updated_at DESC`,
      [userId]
    );
  }

  static async getConversation(conversationId: string, userId: string): Promise<Conversation | null> {
    if (!(await MessageService.isParticipant(conversationId, userId))) return null;
    return fetchConversation(conversationId);
  }

  static async createConversation(currentUserId: string, participantId: string): Promise<Conversation> {
    if (currentUserId === participantId) {
      throw new Error('Cannot create conversation with yourself');
    }
    if (!isValidId(participantId) || !(await queryOne('SELECT 1 FROM users WHERE id = $1', [participantId]))) {
      throw new Error('Participant not found');
    }

    // One 1-on-1 conversation per pair, enforced by a unique key (safe against double taps / races)
    const directKey = [currentUserId, participantId].sort().join(':');
    const conversationId = await withTransaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO conversations (direct_key) VALUES ($1)
         ON CONFLICT (direct_key) DO NOTHING RETURNING id::text AS id`,
        [directKey]
      );
      if (inserted.rows.length > 0) {
        const id: string = inserted.rows[0].id;
        await tx.query(
          `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
          [id, currentUserId, participantId]
        );
        return id;
      }
      const existing = await tx.query('SELECT id::text AS id FROM conversations WHERE direct_key = $1', [directKey]);
      return existing.rows[0].id as string;
    });

    return (await fetchConversation(conversationId))!;
  }

  static async getMessages(conversationId: string, userId: string, limit = 50, offset = 0): Promise<Message[]> {
    await MessageService.assertParticipant(conversationId, userId);

    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_PAGE_SIZE);
    const safeOffset = Math.max(0, Math.floor(offset) || 0);

    // Newest page first, returned in chronological order
    return query<Message>(
      `SELECT * FROM (
         SELECT ${messageColumns('m', 's')}
           FROM messages m JOIN users s ON s.id = m.sender_id
          WHERE m.conversation_id = $1
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2 OFFSET $3
       ) page ORDER BY "createdAt" ASC, id ASC`,
      [conversationId, safeLimit, safeOffset]
    );
  }

  static async sendMessage(
    senderId: string,
    conversationId: string,
    content: string,
    type: MessageType = 'text'
  ): Promise<{ message: Message; participantIds: string[] }> {
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
    await MessageService.assertParticipant(conversationId, senderId);

    const message = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO messages (conversation_id, sender_id, content, type) VALUES ($1, $2, $3, $4)
         RETURNING id::text AS id`,
        [conversationId, senderId, trimmed, type]
      );
      const messageId: string = rows[0].id;
      // The sender has "read" their own message
      await tx.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2)', [messageId, senderId]);
      await tx.query('UPDATE conversations SET last_message_id = $2, updated_at = now() WHERE id = $1', [
        conversationId,
        messageId,
      ]);
      await tx.query(
        `UPDATE conversation_participants SET unread_count = unread_count + 1
          WHERE conversation_id = $1 AND user_id <> $2`,
        [conversationId, senderId]
      );
      return (await fetchMessage(tx, messageId))!;
    });

    return { message, participantIds: await MessageService.getParticipantIds(conversationId) };
  }

  private static async recalculateUnread(tx: Tx, conversationId: string, userId: string): Promise<void> {
    await tx.query(
      `UPDATE conversation_participants cp
          SET unread_count = (
            SELECT count(*) FROM messages m
             WHERE m.conversation_id = $1 AND m.sender_id <> $2
               AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $2))
        WHERE cp.conversation_id = $1 AND cp.user_id = $2`,
      [conversationId, userId]
    );
  }

  static async markMessageAsRead(messageId: string, userId: string): Promise<Message> {
    if (!isValidId(messageId)) {
      throw new Error('Message not found');
    }
    const msg = await queryOne<{ conversation_id: string; sender_id: string }>(
      'SELECT conversation_id::text AS conversation_id, sender_id::text AS sender_id FROM messages WHERE id = $1',
      [messageId]
    );
    if (!msg) {
      throw new Error('Message not found');
    }
    await MessageService.assertParticipant(msg.conversation_id, userId);

    return withTransaction(async (tx) => {
      await tx.query(
        'INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [messageId, userId]
      );
      if (msg.sender_id !== userId) {
        await tx.query(`UPDATE messages SET status = 'read', updated_at = now() WHERE id = $1`, [messageId]);
      }
      await MessageService.recalculateUnread(tx, msg.conversation_id, userId);
      return (await fetchMessage(tx, messageId))!;
    });
  }

  /** Marks every message from other participants as read and resets the user's unread counter. */
  static async markConversationAsRead(
    conversationId: string,
    userId: string
  ): Promise<{ conversation: Conversation; messageIds: string[] }> {
    await MessageService.assertParticipant(conversationId, userId);

    const messageIds = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO message_reads (message_id, user_id)
         SELECT m.id, $2 FROM messages m
          WHERE m.conversation_id = $1 AND m.sender_id <> $2
            AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $2)
         ON CONFLICT DO NOTHING
         RETURNING message_id::text AS id`,
        [conversationId, userId]
      );
      const ids: string[] = rows.map((r: { id: string }) => r.id);
      if (ids.length > 0) {
        await tx.query(`UPDATE messages SET status = 'read', updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
      }
      await tx.query(
        'UPDATE conversation_participants SET unread_count = 0 WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      );
      return ids;
    });

    return { conversation: (await fetchConversation(conversationId))!, messageIds };
  }

  static async deleteMessage(
    messageId: string,
    userId: string
  ): Promise<{ conversationId: string; participantIds: string[] }> {
    if (!isValidId(messageId)) {
      throw new Error('Message not found');
    }
    const msg = await queryOne<{ conversation_id: string; sender_id: string; read_by_others: boolean }>(
      `SELECT m.conversation_id::text AS conversation_id, m.sender_id::text AS sender_id,
              EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id <> m.sender_id) AS read_by_others
         FROM messages m WHERE m.id = $1`,
      [messageId]
    );
    if (!msg) {
      throw new Error('Message not found');
    }
    if (msg.sender_id !== userId) {
      throw new Error('Not authorized to delete this message');
    }

    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM messages WHERE id = $1', [messageId]);
      // If it was the latest message, point the conversation at the newest remaining one
      await tx.query(
        `UPDATE conversations c
            SET last_message_id = (
              SELECT m.id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
          WHERE c.id = $1 AND (c.last_message_id IS NULL OR c.last_message_id = $2)`,
        [msg.conversation_id, messageId]
      );
      // An unread message that disappears should no longer count as unread
      if (!msg.read_by_others) {
        await tx.query(
          `UPDATE conversation_participants SET unread_count = GREATEST(unread_count - 1, 0)
            WHERE conversation_id = $1 AND user_id <> $2`,
          [msg.conversation_id, userId]
        );
      }
    });

    return {
      conversationId: msg.conversation_id,
      participantIds: await MessageService.getParticipantIds(msg.conversation_id),
    };
  }
}
