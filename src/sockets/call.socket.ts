import { Server, Socket } from 'socket.io';
import { CallService } from '../services/call/call.service';
import { CallStatus, CallType } from '../models/CallRecord';
import { config } from '../config';
import { isUserOnline } from './socketManager';

/**
 * Call signaling protocol (shared by web and mobile clients)
 *
 * client -> server
 *   call:initiate         { receiverId, callType, conversationId?, offer }
 *   call:accept           { callId, answer }
 *   call:reject           { callId, reason? }
 *   call:end              { callId }
 *   webrtc:ice-candidate  { callId, candidate }
 *
 * server -> client
 *   call:initiated        { callId, receiverId }                 (to the calling socket)
 *   call:incoming         { callId, caller, callerId, callType, conversationId, offer }
 *   call:accepted         { callId, receiverId, answer }          (to the calling socket)
 *   call:rejected         { callId, reason }                      (to the calling socket)
 *   call:busy             { callId, reason: 'busy' }               (to the calling socket)
 *   call:unavailable      { callId, reason: 'offline' }            (to the calling socket)
 *   call:ended            { callId, by, reason, duration }         (to both users, all devices)
 *   call:dismissed        { callId }                               (receiver's other devices)
 *   call:error            { message }
 *   webrtc:ice-candidate  { callId, from, candidate }
 */

interface ActiveCall {
  callId: string;
  callerId: string;
  receiverId: string;
  callerSocketId: string;
  receiverSocketId?: string;
  callType: CallType;
  acceptedAt?: number;
  ringTimer?: NodeJS.Timeout;
}

const activeCalls = new Map<string, ActiveCall>();
const userActiveCall = new Map<string, string>(); // userId -> callId

const getCallForUser = (callId: unknown, userId: string): ActiveCall | null => {
  if (typeof callId !== 'string') return null;
  const call = activeCalls.get(callId);
  if (!call) return null;
  if (call.callerId !== userId && call.receiverId !== userId) return null;
  return call;
};

const releaseCall = (call: ActiveCall): boolean => {
  if (!activeCalls.has(call.callId)) return false; // already finalized
  activeCalls.delete(call.callId);
  if (call.ringTimer) clearTimeout(call.ringTimer);
  if (userActiveCall.get(call.callerId) === call.callId) userActiveCall.delete(call.callerId);
  if (userActiveCall.get(call.receiverId) === call.callId) userActiveCall.delete(call.receiverId);
  return true;
};

type EndReason = 'ended' | 'cancelled' | 'missed' | 'disconnected' | 'rejected';

const finalizeCall = async (
  io: Server,
  call: ActiveCall,
  reason: EndReason,
  byUserId: string | null
): Promise<void> => {
  if (!releaseCall(call)) return;

  let status: CallStatus;
  let duration = 0;
  if (reason === 'rejected') {
    status = 'rejected';
  } else if (call.acceptedAt) {
    status = 'completed';
    duration = Math.round((Date.now() - call.acceptedAt) / 1000);
  } else {
    status = 'missed';
  }

  try {
    await CallService.updateCallStatus(call.callId, status, duration);
  } catch (err: any) {
    console.error('[CallSocket] Failed to finalize call record:', err.message);
  }

  io.to([`user:${call.callerId}`, `user:${call.receiverId}`]).emit('call:ended', {
    callId: call.callId,
    by: byUserId,
    reason,
    status,
    duration,
  });
};

export const registerCallHandlers = (io: Server, socket: Socket): void => {
  const userId: string = socket.data.userId;
  const user = socket.data.user;

  socket.on(
    'call:initiate',
    async (payload: { receiverId?: string; callType?: CallType; conversationId?: string; offer?: any } = {}) => {
      const { receiverId, conversationId, offer } = payload || {};
      const callType: CallType = payload?.callType === 'audio' ? 'audio' : 'video';
      try {
        if (typeof receiverId !== 'string' || !receiverId) {
          socket.emit('call:error', { message: 'receiverId is required' });
          return;
        }
        if (!offer || typeof offer !== 'object' || typeof offer.sdp !== 'string') {
          socket.emit('call:error', { message: 'A WebRTC offer is required to start a call' });
          return;
        }
        if (userActiveCall.has(userId)) {
          socket.emit('call:error', { message: 'You are already in a call' });
          return;
        }

        const callRecord = await CallService.createCallRecord({
          callerId: userId,
          receiverId,
          callType,
          conversationId,
        });
        const callId = callRecord._id.toString();

        if (!isUserOnline(receiverId)) {
          await CallService.updateCallStatus(callId, 'missed');
          socket.emit('call:unavailable', { callId, receiverId, reason: 'offline' });
          return;
        }

        if (userActiveCall.has(receiverId)) {
          await CallService.updateCallStatus(callId, 'busy');
          socket.emit('call:busy', { callId, receiverId, reason: 'busy' });
          return;
        }

        const call: ActiveCall = {
          callId,
          callerId: userId,
          receiverId,
          callerSocketId: socket.id,
          callType,
        };
        activeCalls.set(callId, call);
        userActiveCall.set(userId, callId);
        userActiveCall.set(receiverId, callId);

        // Unanswered calls become "missed" after the ring timeout
        call.ringTimer = setTimeout(() => {
          const current = activeCalls.get(callId);
          if (current && !current.acceptedAt) {
            finalizeCall(io, current, 'missed', null).catch(() => undefined);
          }
        }, config.callRingTimeoutMs);

        await CallService.updateCallStatus(callId, 'ringing');

        // Acknowledge first so the caller knows the callId before ICE candidates flow
        socket.emit('call:initiated', { callId, receiverId });

        io.to(`user:${receiverId}`).emit('call:incoming', {
          callId,
          caller: {
            id: userId,
            username: user?.username || 'caller',
            displayName: user?.displayName || 'Caller',
            avatar: user?.avatar,
          },
          callerId: userId,
          callType,
          conversationId: conversationId || null,
          offer,
        });
      } catch (err: any) {
        console.error('[CallSocket] Error initiating call:', err.message);
        socket.emit('call:error', { message: err.message || 'Could not start call' });
      }
    }
  );

  socket.on('call:accept', async (payload: { callId?: string; answer?: any } = {}) => {
    const call = getCallForUser(payload?.callId, userId);
    if (!call || call.receiverId !== userId || call.acceptedAt) {
      socket.emit('call:error', { message: 'This call is no longer available' });
      return;
    }
    if (!payload.answer || typeof payload.answer.sdp !== 'string') {
      socket.emit('call:error', { message: 'A WebRTC answer is required to accept a call' });
      return;
    }

    call.acceptedAt = Date.now();
    call.receiverSocketId = socket.id;
    if (call.ringTimer) clearTimeout(call.ringTimer);

    io.to(call.callerSocketId).emit('call:accepted', {
      callId: call.callId,
      receiverId: userId,
      answer: payload.answer,
    });
    // Stop ringing on the receiver's other devices
    socket.to(`user:${userId}`).emit('call:dismissed', { callId: call.callId });

    try {
      await CallService.updateCallStatus(call.callId, 'accepted');
    } catch (err: any) {
      console.error('[CallSocket] Error marking call accepted:', err.message);
    }
  });

  socket.on('call:reject', async (payload: { callId?: string; reason?: string } = {}) => {
    const call = getCallForUser(payload?.callId, userId);
    if (!call || call.receiverId !== userId || call.acceptedAt) return;

    const reason = payload.reason === 'busy' ? 'busy' : 'declined';
    io.to(call.callerSocketId).emit('call:rejected', { callId: call.callId, receiverId: userId, reason });
    await finalizeCall(io, call, 'rejected', userId);
  });

  socket.on('call:end', async (payload: { callId?: string } = {}) => {
    const call = getCallForUser(payload?.callId, userId);
    if (!call) return;
    const reason: EndReason = call.acceptedAt ? 'ended' : userId === call.callerId ? 'cancelled' : 'rejected';
    await finalizeCall(io, call, reason, userId);
  });

  // ICE candidates are only relayed between the two parties of an active call
  socket.on('webrtc:ice-candidate', (payload: { callId?: string; candidate?: any } = {}) => {
    const call = getCallForUser(payload?.callId, userId);
    if (!call || !payload.candidate) return;

    const isCaller = userId === call.callerId;
    const target = isCaller
      ? call.receiverSocketId || `user:${call.receiverId}` // before answer: every ringing device queues it
      : call.callerSocketId;

    io.to(target).emit('webrtc:ice-candidate', {
      callId: call.callId,
      from: userId,
      candidate: payload.candidate,
    });
  });

  // Renegotiation relays (e.g. ICE restart), restricted to call parties
  socket.on('webrtc:offer', (payload: { callId?: string; offer?: any } = {}) => {
    const call = getCallForUser(payload?.callId, userId);
    if (!call || !call.acceptedAt || !payload.offer) return;
    const target = userId === call.callerId ? call.receiverSocketId : call.callerSocketId;
    if (target) io.to(target).emit('webrtc:offer', { callId: call.callId, from: userId, offer: payload.offer });
  });

  socket.on('webrtc:answer', (payload: { callId?: string; answer?: any } = {}) => {
    const call = getCallForUser(payload?.callId, userId);
    if (!call || !call.acceptedAt || !payload.answer) return;
    const target = userId === call.callerId ? call.receiverSocketId : call.callerSocketId;
    if (target) io.to(target).emit('webrtc:answer', { callId: call.callId, from: userId, answer: payload.answer });
  });

  // A dropped connection ends any call this socket was carrying
  socket.on('disconnect', () => {
    const callId = userActiveCall.get(userId);
    if (!callId) return;
    const call = activeCalls.get(callId);
    if (!call) return;
    if (call.callerSocketId === socket.id || call.receiverSocketId === socket.id) {
      finalizeCall(io, call, 'disconnected', userId).catch(() => undefined);
    }
  });
};
