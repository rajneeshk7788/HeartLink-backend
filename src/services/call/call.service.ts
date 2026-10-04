import { CallRecord, ICallRecord, CallType, CallStatus } from '../../models/CallRecord';

export interface CreateCallInput {
  callerId: string;
  receiverId: string;
  callType: CallType;
  conversationId?: string;
}

export class CallService {
  static async createCallRecord(input: CreateCallInput): Promise<ICallRecord> {
    const callRecord = new CallRecord({
      caller: input.callerId,
      receiver: input.receiverId,
      conversationId: input.conversationId || null,
      callType: input.callType,
      status: 'initiated',
      startedAt: new Date(),
    });

    await callRecord.save();
    return callRecord.populate([
      { path: 'caller', select: 'username displayName avatar' },
      { path: 'receiver', select: 'username displayName avatar' },
    ]);
  }

  static async updateCallStatus(
    callId: string,
    status: CallStatus,
    duration = 0
  ): Promise<ICallRecord> {
    const callRecord = await CallRecord.findById(callId);
    if (!callRecord) {
      throw new Error('Call record not found');
    }

    callRecord.status = status;
    if (status === 'completed' || status === 'rejected' || status === 'missed') {
      callRecord.endedAt = new Date();
      callRecord.duration = duration;
    }

    await callRecord.save();
    return callRecord.populate([
      { path: 'caller', select: 'username displayName avatar' },
      { path: 'receiver', select: 'username displayName avatar' },
    ]);
  }

  static async getCallHistory(userId: string): Promise<ICallRecord[]> {
    return CallRecord.find({
      $or: [{ caller: userId }, { receiver: userId }],
    })
      .populate('caller', 'username displayName avatar')
      .populate('receiver', 'username displayName avatar')
      .sort({ createdAt: -1 })
      .limit(50);
  }
}
