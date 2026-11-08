/**
 * Domain types returned by the services, already in the shape the API sends
 * (camelCase, string ids). Rows never include password hashes or token data.
 */

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'call_log';
export type MessageStatus = 'sent' | 'delivered' | 'read';
export type CallType = 'audio' | 'video';
export type CallStatus = 'initiated' | 'ringing' | 'accepted' | 'rejected' | 'missed' | 'completed' | 'busy';

/** A user as other people see them (no email). */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  bio: string;
  gender: string;
  statusMessage: string;
  isOnline: boolean;
  lastSeen: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** The signed-in user's own record (includes email). */
export interface User extends PublicUser {
  email: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: PublicUser;
  content: string;
  type: MessageType;
  readBy: string[];
  status: MessageStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface UnreadCount {
  userId: string;
  count: number;
}

export interface Conversation {
  id: string;
  participants: PublicUser[];
  lastMessage: Message | null;
  unreadCounts: UnreadCount[];
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface CallRecord {
  id: string;
  caller: PublicUser;
  receiver: PublicUser;
  conversationId: string | null;
  callType: CallType;
  status: CallStatus;
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  duration: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a syntactically valid UUID (avoids Postgres cast errors on bad ids). */
export const isValidId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id);

// ---------------------------------------------------------------------------
// SQL fragments shared by the services
// ---------------------------------------------------------------------------

/** json_build_object for a public user from table alias `u`. */
export const userJson = (u: string) => `json_build_object(
  'id', ${u}.id, 'username', ${u}.username, 'displayName', ${u}.display_name,
  'avatar', ${u}.avatar, 'bio', ${u}.bio, 'gender', ${u}.gender,
  'statusMessage', ${u}.status_message, 'isOnline', ${u}.is_online, 'lastSeen', ${u}.last_seen,
  'createdAt', ${u}.created_at, 'updatedAt', ${u}.updated_at)`;

/** Ids of users who have read message alias `m`, oldest first. */
export const readByArray = (m: string) =>
  `COALESCE((SELECT array_agg(r.user_id::text ORDER BY r.read_at) FROM message_reads r WHERE r.message_id = ${m}.id), '{}')`;

/** Columns for a full message row: message alias `m` joined with sender alias `s`. */
export const messageColumns = (m: string, s: string) => `
  ${m}.id::text AS id, ${m}.conversation_id::text AS "conversationId", ${m}.content, ${m}.type, ${m}.status,
  ${m}.created_at AS "createdAt", ${m}.updated_at AS "updatedAt",
  ${userJson(s)} AS sender, ${readByArray(m)} AS "readBy"`;

/** A message as a JSON object (for nesting, e.g. conversation.lastMessage). */
export const messageJson = (m: string, s: string) => `json_build_object(
  'id', ${m}.id, 'conversationId', ${m}.conversation_id, 'content', ${m}.content, 'type', ${m}.type,
  'status', ${m}.status, 'createdAt', ${m}.created_at, 'updatedAt', ${m}.updated_at,
  'sender', ${userJson(s)}, 'readBy', ${readByArray(m)})`;

/** Columns for a conversation alias `c` (participants, unread counts, last message). */
export const conversationColumns = (c: string) => `
  ${c}.id::text AS id, ${c}.created_at AS "createdAt", ${c}.updated_at AS "updatedAt",
  (SELECT COALESCE(json_agg(${userJson('pu')} ORDER BY pp.joined_at), '[]')
     FROM conversation_participants pp JOIN users pu ON pu.id = pp.user_id
    WHERE pp.conversation_id = ${c}.id) AS participants,
  (SELECT COALESCE(json_agg(json_build_object('userId', up.user_id, 'count', up.unread_count)), '[]')
     FROM conversation_participants up WHERE up.conversation_id = ${c}.id) AS "unreadCounts",
  (SELECT ${messageJson('lm', 'ls')}
     FROM messages lm JOIN users ls ON ls.id = lm.sender_id
    WHERE lm.id = ${c}.last_message_id) AS "lastMessage"`;

/** Columns for a call record alias `cr` joined with caller `ca` and receiver `re`. */
export const callColumns = (cr: string, ca: string, re: string) => `
  ${cr}.id::text AS id, ${cr}.conversation_id::text AS "conversationId", ${cr}.call_type AS "callType",
  ${cr}.status, ${cr}.started_at AS "startedAt", ${cr}.ended_at AS "endedAt", ${cr}.duration,
  ${cr}.created_at AS "createdAt", ${cr}.updated_at AS "updatedAt",
  ${userJson(ca)} AS caller, ${userJson(re)} AS receiver`;

/** Columns for the signed-in user's own record (never the password hash). */
export const selfUserColumns = (u: string) => `
  ${u}.id::text AS id, ${u}.username, ${u}.email, ${u}.display_name AS "displayName", ${u}.avatar, ${u}.bio,
  ${u}.gender, ${u}.status_message AS "statusMessage", ${u}.is_online AS "isOnline",
  ${u}.last_seen AS "lastSeen", ${u}.created_at AS "createdAt", ${u}.updated_at AS "updatedAt"`;

/** Public user columns (no email). */
export const publicUserColumns = (u: string) => `
  ${u}.id::text AS id, ${u}.username, ${u}.display_name AS "displayName", ${u}.avatar, ${u}.bio,
  ${u}.gender, ${u}.status_message AS "statusMessage", ${u}.is_online AS "isOnline",
  ${u}.last_seen AS "lastSeen", ${u}.created_at AS "createdAt", ${u}.updated_at AS "updatedAt"`;
