const { WebSocketServer } = require('ws');
const { createHeadlessGameRuntime } = require('./runtime_from_html');

const PORT = Number(process.env.PORT || 8787);
const TICK_MS = 50;
const DT = TICK_MS / 1000;
const PLAYER_TIMEOUT_MS = 12_000;
const WORLD_PUSH_EVERY_TICKS = 2;
const FULL_STATE_INTERVAL_MS = 5_000;

const wss = new WebSocketServer({ port: PORT });

const clients = new Map();
const rooms = new Map();

const uid = () => `P-${Math.random().toString(36).slice(2, 10)}`;

function nowMs() {
  return Date.now();
}

function clipNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sanitizeRoom(raw) {
  return (raw || '')
    .toString()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 20)
    .toUpperCase();
}

function ensureRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      name: roomName,
      members: new Set(),
      players: new Map(),
      world: null,
      worldVersion: 0,
      tickSeq: 0,
      lastFullStateAt: 0,
      leaderId: '',
      pendingStartCfg: null,
      runtime: null,
      match: {
        active: false,
        mode: '',
        wave: 1,
      },
    });
  }
  return rooms.get(roomName);
}

function assignLeader(room) {
  if (room.leaderId && room.players.has(room.leaderId)) return;
  room.leaderId = room.players.keys().next().value || '';
}

function buildPeerList(room, selfId = '') {
  const peers = [];
  for (const p of room.players.values()) {
    if (p.id === selfId) continue;
    peers.push({ id: p.id, nick: p.nick || 'PILOT' });
  }
  return peers;
}

function broadcastRoomEvent(room, event, payload = {}) {
  for (const ws of room.members) {
    safeSend(ws, { type: 'room_event', room: room.name, event, ...payload });
  }
}

function leaveRoom(ws, reason = 'left') {
  const c = clients.get(ws);
  if (!c || !c.room) return;
  const room = rooms.get(c.room);
  if (!room) {
    c.room = '';
    return;
  }

  room.members.delete(ws);
  room.players.delete(c.id);

  for (const peerWs of room.members) {
    safeSend(peerWs, { type: 'peer_left', peerId: c.id, reason });
  }

  assignLeader(room);

  if (room.members.size === 0) {
    rooms.delete(room.name);
  } else {
    broadcastRoomEvent(room, 'prepared_updated', {
      prepared: [...room.players.values()].filter((p) => p.prepared).map((p) => p.id),
      leaderId: room.leaderId,
    });
  }

  c.room = '';
}

function joinRoom(ws, roomName) {
  const c = clients.get(ws);
  if (!c) return;
  leaveRoom(ws);
  const room = ensureRoom(roomName);

  room.members.add(ws);
  room.players.set(c.id, {
    id: c.id,
    nick: c.nick,
    prepared: false,
    prepareCfg: null,
    buildA: null,
    input: null,
    state: {
      x: 360,
      y: 980,
      hp: 100,
      hpMax: 100,
      alive: true,
      shield: 0,
      invuln: 0,
      score: 0,
      wave: 1,
      bullets: [],
    },
    lastInputAt: nowMs(),
  });
  c.room = roomName;
  assignLeader(room);

  safeSend(ws, {
    type: 'room_joined',
    room: roomName,
    peers: buildPeerList(room, c.id),
    leaderId: room.leaderId,
  });

  for (const peerWs of room.members) {
    if (peerWs === ws) continue;
    safeSend(peerWs, {
      type: 'peer_joined',
      peer: { id: c.id, nick: c.nick },
      leaderId: room.leaderId,
    });
  }

  broadcastRoomEvent(room, 'prepared_updated', {
    prepared: [...room.players.values()].filter((p) => p.prepared).map((p) => p.id),
    leaderId: room.leaderId,
  });
}

function onPrepare(room, c, msg) {
  const p = room.players.get(c.id);
  if (!p) return;
  p.prepared = true;
  p.prepareCfg = msg.cfg || null;
  p.buildA = msg.buildA || null;
  broadcastRoomEvent(room, 'prepared_updated', {
    prepared: [...room.players.values()].filter((x) => x.prepared).map((x) => x.id),
    leaderId: room.leaderId,
  });

  maybeStart(room, c.id, msg.cfg || null);
}

function onUnprepare(room, c) {
  const p = room.players.get(c.id);
  if (!p) return;
  p.prepared = false;
  p.prepareCfg = null;
  p.buildA = null;
  broadcastRoomEvent(room, 'prepared_updated', {
    prepared: [...room.players.values()].filter((x) => x.prepared).map((x) => x.id),
    leaderId: room.leaderId,
  });
}

function maybeStart(room, starterId, cfg) {
  const players = [...room.players.values()];
  if (players.length < 2) return false;
  if (players.some((p) => !p.prepared || !p.prepareCfg)) return false;
  const mode = players[0].prepareCfg?.mode;
  if (!mode || players.some((p) => p.prepareCfg?.mode !== mode)) return false;

  room.pendingStartCfg = cfg || players[0].prepareCfg;
  const wave = Math.max(1, clipNum(room.pendingStartCfg?.wave, 1) | 0);

  room.runtime = createHeadlessGameRuntime();
  room.runtime.start(mode, wave);

  room.match = {
    active: true,
    mode: String(mode),
    wave,
  };

  room.world = null;
  for (const p of players) p.prepared = false;

  broadcastRoomEvent(room, 'start_match', {
    starterId,
    cfg: room.pendingStartCfg,
  });
  broadcastRoomEvent(room, 'prepared_updated', {
    prepared: [],
    leaderId: room.leaderId,
  });
  return true;
}

function handleMessage(ws, msg) {
  const c = clients.get(ws);
  if (!c) return;
  c.lastSeenAt = nowMs();

  if (msg.type === 'hello' && typeof msg.nick === 'string') {
    c.nick = msg.nick.trim().slice(0, 16) || c.nick;
    const room = rooms.get(c.room);
    const rp = room?.players.get(c.id);
    if (rp) rp.nick = c.nick;
    return;
  }

  if (msg.type === 'join_room') {
    c.nick = (msg.nick || c.nick || 'PILOT').toString().trim().slice(0, 16) || 'PILOT';
    const roomName = sanitizeRoom(msg.room);
    if (!roomName) {
      safeSend(ws, { type: 'error', message: 'invalid room' });
      return;
    }
    joinRoom(ws, roomName);
    return;
  }

  if (msg.type === 'leave_room') {
    leaveRoom(ws);
    safeSend(ws, { type: 'room_joined', room: '', peers: [] });
    return;
  }

  if (msg.type === 'bye') {
    ws.close();
    return;
  }

  if (!c.room) return;
  const room = rooms.get(c.room);
  if (!room) return;
  const p = room.players.get(c.id);
  if (!p) return;

  if (msg.type === 'input_state') {
    p.input = msg.input || null;
    if (msg.state && typeof msg.state === 'object') {
      const s = msg.state;
      p.state = {
        x: clipNum(s.x, 360),
        y: clipNum(s.y, 980),
        hp: clipNum(s.hp, 100),
        hpMax: clipNum(s.hpMax, 100),
        alive: Boolean(s.alive !== false),
        shield: clipNum(s.shield, 0),
        invuln: clipNum(s.invuln, 0),
        score: clipNum(s.score, 0),
        wave: clipNum(s.wave, 1),
        bullets: Array.isArray(s.bullets) ? s.bullets.slice(0, 120) : [],
      };
    }
    p.lastInputAt = nowMs();
    c.lastSeenAt = nowMs();
    return;
  }

  if (msg.type === 'prepare') {
    onPrepare(room, c, msg);
    return;
  }

  if (msg.type === 'unprepare') {
    onUnprepare(room, c);
    return;
  }

  if (msg.type === 'start_request') {
    maybeStart(room, c.id, msg.cfg || null);
    return;
  }

  if (msg.type === 'peer_hit') {
    for (const peerWs of room.members) {
      if (peerWs === ws) continue;
      safeSend(peerWs, {
        type: 'room_event',
        room: room.name,
        event: 'peer_hit',
        from: c.id,
        dmg: clipNum(msg.dmg, 1),
      });
    }
  }
}

function roomTick() {
  const now = nowMs();
  for (const room of rooms.values()) {
    room.tickSeq += 1;
    assignLeader(room);

    const socketByPlayerId = new Map();
    for (const ws of room.members) {
      const c = clients.get(ws);
      if (c?.id) socketByPlayerId.set(c.id, { ws, client: c });
    }

    for (const [pid, p] of room.players.entries()) {
      const playerConn = socketByPlayerId.get(pid);
      const seenAt = Math.max(p.lastInputAt || 0, playerConn?.client?.lastSeenAt || 0);
      if (now - seenAt > PLAYER_TIMEOUT_MS) {
        room.players.delete(pid);
        const staleWs = playerConn?.ws;
        if (staleWs) {
          try {
            staleWs.close();
          } catch {
            // ignore
          }
        }
      }
    }

    if (room.match.active && room.runtime && room.match.mode !== 'workshop') {
      const playerStates = [...room.players.values()].map((p) => p.state);
      try {
        room.runtime.tick(DT, playerStates);
      } catch (err) {
        room.match.active = false;
        safeSend([...room.members][0], { type: 'error', message: `runtime tick failed: ${err.message}` });
      }

      const shouldCaptureWorld = (room.tickSeq % WORLD_PUSH_EVERY_TICKS) === 0
        || (now - (room.lastFullStateAt || 0)) >= FULL_STATE_INTERVAL_MS;
      if (shouldCaptureWorld) {
        try {
          room.world = room.runtime.snapshot();
          room.worldVersion += 1;
        } catch (err) {
          room.match.active = false;
        }
      }
    }

    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      nick: p.nick || 'PILOT',
      prepared: !!p.prepared,
      state: p.state,
    }));

    const forceFullState = (now - (room.lastFullStateAt || 0)) >= FULL_STATE_INTERVAL_MS;
    if (forceFullState) room.lastFullStateAt = now;
    const includeWorld = forceFullState || ((room.tickSeq % WORLD_PUSH_EVERY_TICKS) === 0);

    const payload = {
      type: 'room_state',
      room: room.name,
      seq: room.tickSeq,
      serverTime: now,
      leaderId: room.leaderId,
      worldVersion: room.worldVersion,
      fullState: forceFullState,
      players,
      world: includeWorld ? room.world : null,
    };

    for (const ws of room.members) {
      safeSend(ws, payload);
    }
  }
}

wss.on('connection', (ws) => {
  const state = { id: uid(), nick: 'PILOT', room: '', lastSeenAt: nowMs() };
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
    handleMessage(ws, msg || {});
  });

  ws.on('close', () => {
    leaveRoom(ws, 'disconnect');
    clients.delete(ws);
  });
});

setInterval(roomTick, TICK_MS);

console.log(`[NEP] HTML-driven authoritative server running on ws://0.0.0.0:${PORT}`);
