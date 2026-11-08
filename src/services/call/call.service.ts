import { query, queryOne } from '../../db';
import { CallRecord, CallType, CallStatus, isValidId, callColumns } from '../../models/types';

export interface CreateCallInput {
  callerId: string;
  receiverId: string;
  callType: CallType;
  conversationId?: string;
}

const CALL_TYPES: CallType[] = ['audio', 'video'];
const CALL_STATUSES: CallStatus[] = ['initiated', 'ringing', 'accepted', 'rejected', 'missed', 'completed', 'busy'];
const FINAL_STATUSES: CallStatus[] = ['completed', 'rejected', 'missed', 'busy'];

const fetchCall = (callId: string) =>
  queryOne<CallRecord>(
    `SELECT ${callColumns('cr', 'ca', 're')}
       FROM call_records cr
       JOIN users ca ON ca.id = cr.caller_id
       JOIN users re ON re.id = cr.receiver_id
      WHERE cr.id = $1`,
    [callId]
  );

export class CallService {
  static async createCallRecord(input: CreateCallInput): Promise<CallRecord> {
    if (!isValidId(input.receiverId)) {
      throw new Error('Receiver not found');
    }
    if (input.callerId === input.receiverId) {
      throw new Error('You cannot call yourself');
    }
    if (!CALL_TYPES.includes(input.callType)) {
      throw new Error('Invalid call type');
    }
    if (!(await queryOne('SELECT 1 FROM users WHERE id = $1', [input.receiverId]))) {
      throw new Error('Receiver not found');
    }
    const conversationId =
      input.conversationId && isValidId(input.conversationId) &&
      (await queryOne('SELECT 1 FROM conversations WHERE id = $1', [input.conversationId]))
        ? input.conversationId
        : null;

    const row = await queryOne<{ id: string }>(
      `INSERT INTO call_records (caller_id, receiver_id, conversation_id, call_type, status, started_at)
       VALUES ($1, $2, $3, $4, 'initiated', now()) RETURNING id::text AS id`,
      [input.callerId, input.receiverId, conversationId, input.callType]
    );
    return (await fetchCall(row!.id))!;
  }

  /**
   * Updates a call's status. When `actingUserId` is given, only the caller or
   * receiver may change it.
   */
  static async updateCallStatus(
    callId: string,
    status: CallStatus,
    duration = 0,
    actingUserId?: string
  ): Promise<CallRecord> {
    if (!isValidId(callId)) {
      throw new Error('Call record not found');
    }
    if (!CALL_STATUSES.includes(status)) {
      throw new Error('Invalid call status');
    }
    const existing = await queryOne<{ caller_id: string; receiver_id: string }>(
      'SELECT caller_id::text AS caller_id, receiver_id::text AS receiver_id FROM call_records WHERE id = $1',
      [callId]
    );
    if (!existing) {
      throw new Error('Call record not found');
    }
    if (actingUserId && existing.caller_id !== actingUserId && existing.receiver_id !== actingUserId) {
      throw new Error('Not authorized to update this call');
    }

    const isFinal = FINAL_STATUSES.includes(status);
    await query(
      `UPDATE call_records
          SET status = $2,
              -- duration is measured from the moment the call was answered
              started_at = CASE WHEN $2 = 'accepted' THEN now() ELSE started_at END,
              ended_at = CASE WHEN $3 THEN now() ELSE ended_at END,
              duration = CASE WHEN $3 THEN $4 ELSE duration END,
              updated_at = now()
        WHERE id = $1`,
      [callId, status, isFinal, status === 'completed' ? Math.max(0, Math.round(duration || 0)) : 0]
    );
    return (await fetchCall(callId))!;
  }

  static async getCallHistory(userId: string): Promise<CallRecord[]> {
    return query<CallRecord>(
      `SELECT ${callColumns('cr', 'ca', 're')}
         FROM call_records cr
         JOIN users ca ON ca.id = cr.caller_id
         JOIN users re ON re.id = cr.receiver_id
        WHERE cr.caller_id = $1 OR cr.receiver_id = $1
        ORDER BY cr.created_at DESC
        LIMIT 50`,
      [userId]
    );
  }
}
