import crypto from 'crypto';
import { queryOne, withTransaction } from '../../db';
import { Message, isValidId, messageColumns } from '../../models/types';
import { MessageService } from '../message/message.service';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ImageInfo {
  mime: ImageMime;
  width: number | null;
  height: number | null;
}

/** URL path clients use to fetch a photo (message.content of an image message). */
export const mediaPath = (mediaId: string) => `/api/media/${mediaId}`;
const MEDIA_PATH_RE = /^\/api\/media\/([0-9a-f-]{36})$/i;
export const mediaIdFromContent = (content: string): string | null => {
  const m = MEDIA_PATH_RE.exec(content || '');
  return m && isValidId(m[1]) ? m[1] : null;
};

/**
 * Identifies an image from its bytes (never trusts the file name or the client's
 * Content-Type) and reads its pixel size when the header allows.
 */
export const sniffImage = (buf: Buffer): ImageInfo | null => {
  if (buf.length < 16) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR width/height
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mime: 'image/png', width: buf.length >= 24 ? buf.readUInt32BE(16) : null, height: buf.length >= 24 ? buf.readUInt32BE(20) : null };
  }

  // GIF87a / GIF89a
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    let width: number | null = null;
    let height: number | null = null;
    if (chunk === 'VP8X' && buf.length >= 30) {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    } else if (chunk === 'VP8 ' && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >> 14) & 0x3fff);
    }
    return { mime: 'image/webp', width, height };
  }

  // JPEG: FF D8 FF, size from the first SOFn marker
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let width: number | null = null;
    let height: number | null = null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { mime: 'image/jpeg', width, height };
  }

  return null;
};

export class MediaService {
  /** Stores a photo and posts it as an image message in one transaction. */
  static async sendImage(
    senderId: string,
    conversationId: string,
    file: Buffer
  ): Promise<{ message: Message; participantIds: string[] }> {
    if (!file || file.length === 0) throw new Error('No photo was uploaded');
    if (file.length > MAX_IMAGE_BYTES) throw new Error('Photo is too large (max 8 MB)');
    const info = sniffImage(file);
    if (!info) throw new Error('Only JPEG, PNG, WebP or GIF photos can be sent');
    await MessageService.assertParticipant(conversationId, senderId);

    const mediaId = crypto.randomUUID();
    const message = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO messages (conversation_id, sender_id, content, type) VALUES ($1, $2, $3, 'image')
         RETURNING id::text AS id`,
        [conversationId, senderId, mediaPath(mediaId)]
      );
      const messageId: string = rows[0].id;
      await tx.query(
        `INSERT INTO media (id, message_id, conversation_id, uploader_id, mime_type, size_bytes, width, height, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [mediaId, messageId, conversationId, senderId, info.mime, file.length, info.width, info.height, file]
      );
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
      const { rows: msgRows } = await tx.query(
        `SELECT ${messageColumns('m', 's')} FROM messages m JOIN users s ON s.id = m.sender_id WHERE m.id = $1`,
        [messageId]
      );
      return msgRows[0] as Message;
    });

    return { message, participantIds: await MessageService.getParticipantIds(conversationId) };
  }

  /** Returns the photo if `userId` is a participant of its conversation, otherwise null. */
  static async getForUser(
    mediaId: string,
    userId: string
  ): Promise<{ mime: string; data: Buffer; size: number } | null> {
    if (!isValidId(mediaId)) return null;
    return queryOne<{ mime: string; data: Buffer; size: number }>(
      `SELECT md.mime_type AS mime, md.data, md.size_bytes AS size
         FROM media md
         JOIN conversation_participants cp ON cp.conversation_id = md.conversation_id AND cp.user_id = $2
        WHERE md.id = $1`,
      [mediaId, userId]
    );
  }
}
