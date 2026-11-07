import mongoose from 'mongoose';
import { CallRecord, ICallRecord, CallType, CallStatus } from '../../models/CallRecord';
import { User } from '../../models/User';
import { USER_PUBLIC_FIELDS } from '../../models/serialize';

export interface CreateCallInput {
  callerId: string;
  receiverId: string;
  callType: CallType;
  conversationId?: string;
}

const CALL_TYPES: CallType[] = ['audio', 'video'];
const FINAL_STATUSES: CallStatus[] = ['completed', 'rejected', 'missed', 'busy'];

const populateParties = [
  { path: 'caller', select: USER_PUBLIC_FIELDS },
  { path: 'receiver', select: USER_PUBLIC_FIELDS },
];

export class CallService {
  static async createCallRecord(input: CreateCallInput): Promise<ICallRecord> {
    if (!mongoose.Types.ObjectId.isValid(input.receiverId)) {
      throw new Error('Receiver not found');
    }
    if (input.callerId === input.receiverId) {
      throw new Error('You cannot call yourself');
    }
    if (!CALL_TYPES.includes(input.callType)) {
      throw new Error('Invalid call type');
    }
    if (!(await User.exists({ _id: input.receiverId }))) {
      throw new Error('Receiver not found');
    }

    const callRecord = new CallRecord({
      caller: input.callerId,
      receiver: input.receiverId,
      conversationId:
        input.conversationId && mongoose.Types.ObjectId.isValid(input.conversationId)
          ? input.conversationId
          : null,
      callType: input.callType,
      status: 'initiated',
      startedAt: new Date(),
    });

    await callRecord.save();
    return callRecord.populate(populateParties);
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
  ): Promise<ICallRecord> {
    if (!mongoose.Types.ObjectId.isValid(callId)) {
      throw new Error('Call record not found');
    }
    const callRecord = await CallRecord.findById(callId);
    if (!callRecord) {
      throw new Error('Call record not found');
    }

    if (
      actingUserId &&
      callRecord.caller.toString() !== actingUserId &&
      callRecord.receiver.toString() !== actingUserId
    ) {
      throw new Error('Not authorized to update this call');
    }

    callRecord.status = status;
    if (status === 'accepted') {
      // Duration is measured from the moment the call was answered
      callRecord.startedAt = new Date();
    }
    if (FINAL_STATUSES.includes(status)) {
      callRecord.endedAt = new Date();
      callRecord.duration = status === 'completed' ? Math.max(0, Math.round(duration || 0)) : 0;
    }

    await callRecord.save();
    return callRecord.populate(populateParties);
  }

  static async getCallHistory(userId: string): Promise<ICallRecord[]> {
    return CallRecord.find({
      $or: [{ caller: userId }, { receiver: userId }],
    })
      .populate(populateParties)
      .sort({ createdAt: -1 })
      .limit(50);
  }
}
