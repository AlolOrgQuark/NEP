const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // ws -> {id,nick,room}
const rooms = new Map(); // room -> Set<ws>

const uid = () => `P-${Math.random().toString(36).slice(2, 10)}`;

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function roomPeers(room, selfWs) {
  const set = rooms.get(room);
  if (!set) return [];
  const peers = [];
  for (const ws of set) {
    if (ws === selfWs) continue;
    const c = clients.get(ws);
    if (!c) continue;
    peers.push({ id: c.id, nick: c.nick });
  }
  return peers;
}

function leaveRoom(ws) {
  const c = clients.get(ws);
  if (!c || !c.room) return;
  const room = c.room;
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    for (const peerWs of set) {
      safeSend(peerWs, { type: 'peer_left', peerId: c.id });
    }
    if (set.size === 0) rooms.delete(room);
  }
  c.room = '';
}

function joinRoom(ws, room) {
  const c = clients.get(ws);
  if (!c) return;
  leaveRoom(ws);
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room);
  set.add(ws);
  c.room = room;

  safeSend(ws, {
    type: 'room_joined',
    room,
    peers: roomPeers(room, ws),
  });

  for (const peerWs of set) {
    if (peerWs === ws) continue;
    safeSend(peerWs, { type: 'peer_joined', peer: { id: c.id, nick: c.nick } });
  }
}

wss.on('connection', (ws) => {
  const state = { id: uid(), nick: 'PILOT', room: '' };
  clients.set(ws, state);
  safeSend(ws, { type: 'welcome', id: state.id });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: 'error', message: 'invalid json' });
      return;
    }
    const c = clients.get(ws);
    if (!c) return;

    if (msg.type === 'hello' && typeof msg.nick === 'string') {
      c.nick = msg.nick.trim().slice(0, 16) || c.nick;
      return;
    }

    if (msg.type === 'create_room' || msg.type === 'join_room') {
      c.nick = (msg.nick || c.nick || 'PILOT').toString().trim().slice(0, 16) || 'PILOT';
      const room = (msg.room || '').toString().trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20).toUpperCase();
      if (!room) {
        safeSend(ws, { type: 'error', message: 'invalid room' });
        return;
      }
      if (msg.type === 'join_room' && !rooms.has(room)) {
        safeSend(ws, { type: 'error', message: `room ${room} not found` });
        return;
      }
      joinRoom(ws, room);
      return;
    }

    if (msg.type === 'leave_room') {
      leaveRoom(ws);
      safeSend(ws, { type: 'room_joined', room: '', peers: [] });
      return;
    }

    if (msg.type === 'relay') {
      if (!c.room || !rooms.has(c.room)) return;
      const set = rooms.get(c.room);
      for (const peerWs of set) {
        if (peerWs === ws) continue;
        safeSend(peerWs, {
          type: 'relay',
          from: c.id,
          room: c.room,
          payload: msg.payload || {},
          t: Date.now(),
        });
      }
      return;
    }

    if (msg.type === 'bye') {
      ws.close();
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

console.log(`[NEP] WebSocket server running on ws://0.0.0.0:${PORT}`);
