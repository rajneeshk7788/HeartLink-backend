import mongoose, { Document, Schema, Model } from 'mongoose';

export type CallType = 'audio' | 'video';
export type CallStatus = 'initiated' | 'ringing' | 'accepted' | 'rejected' | 'missed' | 'completed' | 'busy';

export interface ICallRecord extends Document {
  _id: mongoose.Types.ObjectId;
  caller: mongoose.Types.ObjectId;
  receiver: mongoose.Types.ObjectId;
  conversationId?: mongoose.Types.ObjectId;
  callType: CallType;
  status: CallStatus;
  startedAt?: Date;
  endedAt?: Date;
  duration: number; // in seconds
  createdAt: Date;
  updatedAt: Date;
}

const CallRecordSchema = new Schema<ICallRecord>(
  {
    caller: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    receiver: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
    },
    callType: {
      type: String,
      enum: ['audio', 'video'],
      required: true,
    },
    status: {
      type: String,
      enum: ['initiated', 'ringing', 'accepted', 'rejected', 'missed', 'completed', 'busy'],
      default: 'initiated',
    },
    startedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

CallRecordSchema.index({ caller: 1, createdAt: -1 });
CallRecordSchema.index({ receiver: 1, createdAt: -1 });

export const CallRecord: Model<ICallRecord> = mongoose.model<ICallRecord>(
  'CallRecord',
  CallRecordSchema
);
