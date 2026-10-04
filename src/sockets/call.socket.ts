import { Server, Socket } from 'socket.io';
import { CallService } from '../services/call/call.service';
import { CallStatus, CallType } from '../models/CallRecord';

export const registerCallHandlers = (io: Server, socket: Socket): void => {
  const userId = socket.data.userId;
  const user = socket.data.user;

  // Initiate a call
  socket.on(
    'call:initiate',
    async ({
      receiverId,
      callType,
      conversationId,
      offer,
    }: {
      receiverId: string;
      callType: CallType;
      conversationId?: string;
      offer?: any;
    }) => {
      try {
        if (!receiverId) return;

        // Create call record in DB
        const callRecord = await CallService.createCallRecord({
          callerId: userId,
          receiverId,
          callType: callType || 'video',
          conversationId,
        });

        // Notify the receiver
        io.to(`user:${receiverId}`).emit('call:incoming', {
          callId: callRecord._id.toString(),
          caller: {
            id: user?._id?.toString() || userId,
            username: user?.username || 'Caller',
            displayName: user?.displayName || 'Caller',
            avatar: user?.avatar,
          },
          callerId: userId,
          callType,
          conversationId,
          offer,
        });

        // Acknowledge back to caller with callId
        socket.emit('call:initiated', {
          callId: callRecord._id.toString(),
          receiverId,
        });
      } catch (err: any) {
        console.error('[CallSocket] Error initiating call:', err);
        socket.emit('call:error', { message: err.message });
      }
    }
  );

  // Accept a call
  socket.on(
    'call:accept',
    async ({
      callerId,
      callId,
      answer,
    }: {
      callerId: string;
      callId?: string;
      answer?: any;
    }) => {
      try {
        if (callId) {
          await CallService.updateCallStatus(callId, 'accepted');
        }

        io.to(`user:${callerId}`).emit('call:accepted', {
          receiverId: userId,
          callId,
          answer,
        });
      } catch (err: any) {
        console.error('[CallSocket] Error accepting call:', err);
      }
    }
  );

  // Reject a call
  socket.on(
    'call:reject',
    async ({
      callerId,
      callId,
      reason,
    }: {
      callerId: string;
      callId?: string;
      reason?: string;
    }) => {
      try {
        if (callId) {
          await CallService.updateCallStatus(callId, 'rejected');
        }

        io.to(`user:${callerId}`).emit('call:rejected', {
          receiverId: userId,
          callId,
          reason: reason || 'declined',
        });
      } catch (err: any) {
        console.error('[CallSocket] Error rejecting call:', err);
      }
    }
  );

  // End a call
  socket.on(
    'call:end',
    async ({
      targetUserId,
      callId,
      duration,
    }: {
      targetUserId: string;
      callId?: string;
      duration?: number;
    }) => {
      try {
        if (callId) {
          await CallService.updateCallStatus(callId, 'completed', duration || 0);
        }

        if (targetUserId) {
          io.to(`user:${targetUserId}`).emit('call:ended', {
            callId,
            by: userId,
            duration,
          });
        }
      } catch (err: any) {
        console.error('[CallSocket] Error ending call:', err);
      }
    }
  );

  // WebRTC Signaling: Offer
  socket.on(
    'webrtc:offer',
    ({ targetUserId, offer }: { targetUserId: string; offer: any }) => {
      if (!targetUserId) return;
      io.to(`user:${targetUserId}`).emit('webrtc:offer', {
        from: userId,
        offer,
      });
    }
  );

  // WebRTC Signaling: Answer
  socket.on(
    'webrtc:answer',
    ({ targetUserId, answer }: { targetUserId: string; answer: any }) => {
      if (!targetUserId) return;
      io.to(`user:${targetUserId}`).emit('webrtc:answer', {
        from: userId,
        answer,
      });
    }
  );

  // WebRTC Signaling: ICE Candidate
  socket.on(
    'webrtc:ice-candidate',
    ({ targetUserId, candidate }: { targetUserId: string; candidate: any }) => {
      if (!targetUserId) return;
      io.to(`user:${targetUserId}`).emit('webrtc:ice-candidate', {
        from: userId,
        candidate,
      });
    }
  );
};
