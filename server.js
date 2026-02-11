const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const TICK_MS = 50;
const PLAYER_TIMEOUT_MS = 12_000;

const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // ws -> client
const rooms = new Map(); // roomName -> roomState

const uid = () => `P-${Math.random().toString(36).slice(2, 10)}`;

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
      leaderId: '',
      pendingStartCfg: null,
      enemyColorByKey: new Map(),
    });
  }
  return rooms.get(roomName);
}

function buildPeerList(room, selfId = '') {
  const peers = [];
  for (const p of room.players.values()) {
    if (p.id === selfId) continue;
    peers.push({ id: p.id, nick: p.nick || 'PILOT' });
  }
  return peers;
}

function assignLeader(room) {
  if (room.leaderId && room.players.has(room.leaderId)) return;
  const next = room.players.keys().next().value;
  room.leaderId = next || '';
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
      prepared: [...room.players.values()]
        .filter((p) => p.prepared)
        .map((p) => p.id),
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
      x: 0,
      y: 0,
      hp: 100,
      hpMax: 100,
      alive: true,
      shield: 0,
      invuln: 0,
      score: 0,
      wave: 1,
      bullets: [],
    },
    lastInputAt: Date.now(),
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

function clipNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function normalizeWorld(world, room) {
  if (!world || typeof world !== 'object') return room.world;
  const normalized = {
    t: clipNum(world.t, performanceNow()),
    mode: String(world.mode || ''),
    wave: clipNum(world.wave, 1),
    score: clipNum(world.score, 0),
    spawnerCd: clipNum(world.spawnerCd, 0),
    enemies: [],
    bulletsE: null,
  };

  const srcEnemies = Array.isArray(world.enemies) ? world.enemies.slice(0, 96) : [];
  for (let i = 0; i < srcEnemies.length; i++) {
    const e = srcEnemies[i] || {};
    const key = String(e.k || `${e.type || 'E'}:${i}`).slice(0, 48);
    const oldCol = room.enemyColorByKey.get(key);
    const col = String(oldCol || e.col || '#FF2F57');
    room.enemyColorByKey.set(key, col);
    normalized.enemies.push({
      k: key,
      x: clipNum(e.x),
      y: clipNum(e.y),
      vx: clipNum(e.vx),
      vy: clipNum(e.vy),
      hp: clipNum(e.hp, 1),
      maxHp: clipNum(e.maxHp, 1),
      r: clipNum(e.r, 16),
      col,
      type: String(e.type || 'ENEMY').slice(0, 32),
    });
  }

  if (Array.isArray(world.bulletsE)) {
    normalized.bulletsE = world.bulletsE.slice(0, 140).map((b) => ({
      x: clipNum(b?.x),
      y: clipNum(b?.y),
      vx: clipNum(b?.vx),
      vy: clipNum(b?.vy),
      r: clipNum(b?.r, 3),
      col: String(b?.col || '#FF2F57'),
      dmg: clipNum(b?.dmg, 1),
      t: clipNum(b?.t, 0),
      spr: String(b?.spr || 'glowE'),
      style: clipNum(b?.style, 1),
    }));
  }

  return normalized;
}

function performanceNow() {
  return Date.now();
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
  for (const p of players) p.prepared = false;
  room.world = null;
  room.enemyColorByKey.clear();

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
        x: clipNum(s.x),
        y: clipNum(s.y),
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
    p.lastInputAt = Date.now();
    return;
  }

  if (msg.type === 'world_state') {
    if (room.leaderId !== c.id) return;
    room.world = normalizeWorld(msg.world, room);
    room.worldVersion += 1;
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
    if (room.leaderId !== c.id) return;
    maybeStart(room, c.id, msg.cfg || null);
    return;
  }

  if (msg.type === 'peer_hit') {
    // authoritative forwarding for workshop hit events
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
  const now = Date.now();
  for (const room of rooms.values()) {
    room.tickSeq += 1;
    assignLeader(room);

    // Cull players that stopped sending state for too long.
    for (const [pid, p] of room.players.entries()) {
      if (now - p.lastInputAt > PLAYER_TIMEOUT_MS) {
        room.players.delete(pid);
        for (const ws of room.members) {
          const c = clients.get(ws);
          if (c?.id === pid) {
            try {
              ws.close();
            } catch {
              // ignore
            }
          }
        }
      }
    }

    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      nick: p.nick || 'PILOT',
      prepared: !!p.prepared,
      state: p.state,
    }));

    const payload = {
      type: 'room_state',
      room: room.name,
      seq: room.tickSeq,
      serverTime: now,
      leaderId: room.leaderId,
      worldVersion: room.worldVersion,
      players,
      world: room.world,
    };

    for (const ws of room.members) {
      safeSend(ws, payload);
    }
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
    handleMessage(ws, msg || {});
  });

  ws.on('close', () => {
    leaveRoom(ws, 'disconnect');
    clients.delete(ws);
  });
});

setInterval(roomTick, TICK_MS);

console.log(`[NEP] Authoritative room server running on ws://0.0.0.0:${PORT}`);
