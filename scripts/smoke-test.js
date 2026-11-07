/**
 * End-to-end smoke test: auth, authorization, GraphQL, Socket.IO chat/typing/read
 * receipts and the full call-signaling state machine.
 *
 * Needs a running backend with the demo users seeded (SEED_DEMO_DATA=true):
 *   SMOKE_BASE_URL=http://localhost:5000 npm run test:smoke
 *
 * It creates messages/calls, so never point it at production data.
 */
const { io } = require('socket.io-client');
const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const gql = async (token, query, variables = {}) => {
  const res = await fetch(BASE + '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
};
const login = async (email) => (await post('/api/auth/login', { email, password: 'Password123!' })).json.data;
const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const waitFor = (socket, event, ms = 4000, pred = () => true) =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      socket.off(event, h);
      resolve(null);
    }, ms);
    const h = (data) => {
      if (!pred(data)) return;
      clearTimeout(t);
      socket.off(event, h);
      resolve(data ?? true);
    };
    socket.on(event, h);
  });

(async () => {
  // ---- Auth ----
  const alice = await login('alice@example.com');
  const bob = await login('bob@example.com');
  const charlie = await login('charlie@example.com');
  ok(alice?.accessToken && bob?.accessToken && charlie?.accessToken, 'demo users can log in');
  ok(!('refreshTokens' in alice.user) && !('password' in alice.user), 'login response has no secrets');

  const fp = await post('/api/auth/forgot-password', { email: 'nobody@example.com' });
  ok(fp.status === 200 && !fp.json.resetToken, 'forgot-password for unknown email reveals nothing');

  const bad = await post('/api/auth/login', { email: { $gt: '' }, password: 'x' });
  ok(bad.status === 400, 'object (NoSQL-injection) email rejected with 400');

  // Refresh rotation: old token cannot be reused
  const r1 = await post('/api/auth/refresh-token', { refreshToken: bob.refreshToken });
  ok(r1.status === 200 && r1.json.data.refreshToken, 'refresh token works');
  const r2 = await post('/api/auth/refresh-token', { refreshToken: bob.refreshToken });
  ok(r2.status === 401, 'reused (rotated) refresh token is rejected');
  bob.accessToken = r1.json.data.accessToken;
  bob.refreshToken = r1.json.data.refreshToken;

  // Logout with only a refresh token (no access token)
  const extra = await login('charlie@example.com');
  const lo = await post('/api/auth/logout', { refreshToken: extra.refreshToken });
  const r3 = await post('/api/auth/refresh-token', { refreshToken: extra.refreshToken });
  ok(lo.status === 200 && r3.status === 401, 'logout revokes the refresh token without an access token');

  // ---- GraphQL authorization ----
  const convs = await gql(alice.accessToken, '{ GetConversations { id participants { id username email } } }');
  const conv = convs.data.GetConversations[0];
  ok(!!conv, 'alice has the seeded conversation');
  ok(conv.participants.every((p) => p.email === null), 'emails hidden in participant lists');
  const me = await gql(alice.accessToken, '{ GetCurrentUser { email } SearchUsers(query:"bob") { email } }');
  ok(me.data.GetCurrentUser.email === 'alice@example.com' && me.data.SearchUsers.every((u) => u.email === null),
    'own email visible via GetCurrentUser, others hidden in search');

  const spy = await gql(charlie.accessToken, 'query($c:ID!){ GetMessages(conversationId:$c){ id content } }', { c: conv.id });
  ok(!!spy.errors && !spy.data, 'charlie CANNOT read alice/bob messages');

  const search = await gql(alice.accessToken, '{ SearchUsers(query:"example.com") { id } }');
  ok(search.data.SearchUsers.length === 0, 'search no longer matches on email');
  const redos = await gql(alice.accessToken, '{ SearchUsers(query:"(a+)+$") { id } }');
  ok(!redos.errors, 'regex metacharacters in search are handled safely');

  const badAvatar = await gql(alice.accessToken, 'mutation{ UpdateProfile(input:{avatar:"javascript:alert(1)"}){ id } }');
  ok(!!badAvatar.errors, 'non-http avatar URL rejected');

  // ---- Sockets ----
  const sa = await connect(alice.accessToken);
  const sb = await connect(bob.accessToken);
  const sc = await connect(charlie.accessToken);

  const joinAck = await new Promise((r) => sc.emit('conversation:join', conv.id, r));
  ok(joinAck === false, 'charlie CANNOT join alice/bob conversation room');

  // bob gets messages via his user room, without joining the conversation room
  const bobGotMsg = waitFor(sb, 'message:new');
  const charlieGotMsg = waitFor(sc, 'message:new', 1500);
  const sent = await gql(alice.accessToken, 'mutation($c:ID!){ SendMessage(conversationId:$c, content:"hi bob"){ id } }', { c: conv.id });
  const m = await bobGotMsg;
  ok(m && m.id === sent.data.SendMessage.id && m.sender?.id, 'bob receives message:new with string ids');
  ok(!(await charlieGotMsg), 'charlie does not receive the message');

  // Unread + mark read
  let bc = await gql(bob.accessToken, '{ GetConversations { id unreadCounts { userId count } } }');
  const bobId = bob.user.id;
  const unread = bc.data.GetConversations[0].unreadCounts.find((u) => u.userId === bobId).count;
  ok(unread === 1, 'bob has 1 unread');
  const aliceRead = waitFor(sa, 'conversation:read');
  await gql(bob.accessToken, 'mutation($c:ID!){ MarkConversationAsRead(conversationId:$c){ id } }', { c: conv.id });
  bc = await gql(bob.accessToken, '{ GetConversations { id unreadCounts { userId count } } }');
  ok(bc.data.GetConversations[0].unreadCounts.find((u) => u.userId === bobId).count === 0, 'MarkConversationAsRead resets unread');
  ok(!!(await aliceRead), 'alice is notified of the read receipt');

  // Typing reaches bob's user room without a room join; charlie's fake conversation id is ignored
  const typing = waitFor(sb, 'typing:started');
  sa.emit('typing:start', { conversationId: conv.id });
  const t = await typing;
  ok(t && t.username === 'Alice Johnson', 'typing indicator relayed with server-side name');

  // Delete repoints lastMessage
  const delEvt = waitFor(sb, 'message:deleted');
  await gql(alice.accessToken, 'mutation($m:ID!){ DeleteMessage(messageId:$m) }', { m: sent.data.SendMessage.id });
  ok(!!(await delEvt), 'message:deleted broadcast');
  const after = await gql(alice.accessToken, '{ GetConversations { lastMessage { id content } } }');
  ok(after.data.GetConversations[0].lastMessage?.content !== 'hi bob', 'lastMessage repointed after delete');

  // ---- Calls ----
  const offer = { type: 'offer', sdp: 'v=0\r\n' };
  const answer = { type: 'answer', sdp: 'v=0\r\n' };

  const incoming = waitFor(sb, 'call:incoming');
  const initiated = waitFor(sa, 'call:initiated');
  sa.emit('call:initiate', { receiverId: bobId, callType: 'video', conversationId: conv.id, offer });
  const init = await initiated;
  const inc = await incoming;
  ok(init?.callId && inc?.callId === init.callId && inc.offer?.sdp, 'call initiated, bob gets incoming with offer');

  // charlie cannot inject ICE into this call
  const bobIce = waitFor(sb, 'webrtc:ice-candidate', 1500);
  sc.emit('webrtc:ice-candidate', { callId: init.callId, candidate: { candidate: 'evil' } });
  ok(!(await bobIce), 'third party cannot send ICE candidates into a call');

  // busy: charlie calling bob while bob is ringing
  const busy = waitFor(sc, 'call:busy');
  sc.emit('call:initiate', { receiverId: bobId, callType: 'audio', offer });
  ok(!!(await busy), 'second caller gets busy');

  const accepted = waitFor(sa, 'call:accepted');
  sb.emit('call:accept', { callId: init.callId, answer });
  const acc = await accepted;
  ok(acc?.answer?.sdp, 'alice receives answer');

  const iceToBob = waitFor(sb, 'webrtc:ice-candidate');
  sa.emit('webrtc:ice-candidate', { callId: init.callId, candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } });
  ok(!!(await iceToBob), 'ICE relayed between call parties');

  await new Promise((r) => setTimeout(r, 1200));
  const endedB = waitFor(sb, 'call:ended');
  sa.emit('call:end', { callId: init.callId });
  const ended = await endedB;
  ok(ended?.status === 'completed' && ended.duration >= 1, `call completed with server-side duration (${ended?.duration}s)`);

  // Offline receiver
  sc.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const unavailable = waitFor(sa, 'call:unavailable');
  sa.emit('call:initiate', { receiverId: charlie.user.id, callType: 'audio', offer });
  ok(!!(await unavailable), 'calling an offline user reports unavailable');

  const hist = await gql(alice.accessToken, '{ GetCallHistory { status duration caller { username } } }');
  const statuses = hist.data.GetCallHistory.map((c) => c.status);
  ok(statuses.includes('completed') && statuses.includes('missed'), `call history statuses: ${statuses.join(', ')}`);

  // Reject flow
  const inc2 = waitFor(sb, 'call:incoming');
  sa.emit('call:initiate', { receiverId: bobId, callType: 'audio', offer });
  const i2 = await inc2;
  const rejected = waitFor(sa, 'call:rejected');
  sb.emit('call:reject', { callId: i2.callId });
  ok(!!(await rejected), 'reject reaches caller');

  sa.disconnect();
  sb.disconnect();
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
