const fs = require('fs');
const vm = require('vm');

const HTML_PATH = 'Not Enough Plane.html';

function makeNoopFn(ret) {
  return function noop() {
    return ret;
  };
}

function makeElementProxy(ctx2d) {
  const style = {};
  const classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  const p = new Proxy(
    {
      style,
      classList,
      dataset: { key: '', id: '' },
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      clientWidth: 720,
      clientHeight: 1280,
      width: 720,
      height: 1280,
      children: [null, null, null, null, null],
      childElementCount: 5,
      parentNode: { replaceChild() {}, appendChild() {}, removeChild() {} },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      blur() {},
      appendChild() {},
      removeChild() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 1280 }),
      getContext: () => ctx2d,
      querySelector() { return p; },
      querySelectorAll() { return [p, p, p, p, p]; },
    },
    {
      get(target, prop) {
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop in target) return target[prop];
        return makeNoopFn(undefined);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  p.children = [p, p, p, p, p];
  p.childElementCount = p.children.length;
  return p;
}

function make2DContextProxy() {
  return new Proxy(
    {
      canvas: { width: 720, height: 1280 },
      globalAlpha: 1,
      lineWidth: 1,
      fillStyle: '#000',
      strokeStyle: '#fff',
      globalCompositeOperation: 'source-over',
      createLinearGradient() { return { addColorStop() {} }; },
      createRadialGradient() { return { addColorStop() {} }; },
      createPattern() { return {}; },
      measureText(text) { return { width: (String(text || '').length || 1) * 8 }; },
      getImageData() { return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; },
      putImageData() {},
      createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return makeNoopFn(undefined);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

function makeStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}

function makeAudioContextStub() {
  function node() {
    return {
      connect() { return this; },
      disconnect() {},
      gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} },
      frequency: { value: 440, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} },
      Q: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
      detune: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
      pan: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
      start() {},
      stop() {},
      setPosition() {},
    };
  }

  return class AudioContextStub {
    constructor() {
      this.currentTime = 0;
      this.destination = node();
      this.sampleRate = 44100;
      this.state = 'running';
    }

    createGain() { return node(); }
    createOscillator() { return node(); }
    createBiquadFilter() { return node(); }
    createDynamicsCompressor() { return node(); }
    createDelay() { return node(); }
    createConvolver() { return node(); }
    createStereoPanner() { return node(); }
    createChannelSplitter() { return node(); }
    createChannelMerger() { return node(); }
    createBufferSource() { return node(); }
    createBuffer(channels, length) { return { getChannelData() { return new Float32Array(length); }, channels, length }; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
}

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/i);
  if (!m) throw new Error('Cannot locate main <script> in Not Enough Plane.html');
  return m[1];
}

function createHeadlessGameRuntime() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const script = extractScript(html);

  const ctx2d = make2DContextProxy();
  const elem = makeElementProxy(ctx2d);
  const localStorage = makeStorage();
  const AudioContextStub = makeAudioContextStub();

  const document = {
    body: elem,
    documentElement: elem,
    createElement() { return makeElementProxy(ctx2d); },
    getElementById() { return elem; },
    querySelector() { return elem; },
    querySelectorAll() { return [elem, elem, elem, elem, elem]; },
    addEventListener() {},
    removeEventListener() {},
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document,
    localStorage,
    sessionStorage: makeStorage(),
    navigator: { userAgent: 'node', maxTouchPoints: 0 },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    innerWidth: 720,
    innerHeight: 1280,
    addEventListener() {},
    removeEventListener() {},
    Image: class ImageStub {},
    AudioContext: AudioContextStub,
    webkitAudioContext: AudioContextStub,
    alert() {},
    confirm() { return true; },
    prompt() { return ''; },
    Math,
    Date,
    JSON,
    Array,
    Object,
    Number,
    String,
    Boolean,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    Infinity,
    NaN,
  };
  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(script, context, { timeout: 5000 });

  function exec(code) {
    return vm.runInContext(code, context, { timeout: 1000 });
  }

  function start(mode, wave) {
    const safeMode = JSON.stringify(mode || 'survival');
    const safeWave = Math.max(1, Number(wave) || 1);
    exec(`audioOn = false; startRun({mode:${safeMode}, wave:${safeWave}, net:false}); if (typeof ui==='object'){ const __d = document.getElementById('bombDotStub'); ui.bombDots = new Proxy([], { get:(t,k)=> (k in t ? t[k] : __d) }); }`);
  }

  function tick(dt, players) {
    const arr = (players || []).map((p) => ({
      x: Number.isFinite(+p.x) ? +p.x : 360,
      y: Number.isFinite(+p.y) ? +p.y : 960,
      alive: p.alive !== false,
      hp: Number.isFinite(+p.hp) ? +p.hp : 100,
      hpMax: Number.isFinite(+p.hpMax) ? +p.hpMax : 100,
      bullets: Array.isArray(p.bullets) ? p.bullets.slice(0, 120) : [],
    }));
    context.__serverPlayers = arr;

    exec(`
      if (Array.isArray(__serverPlayers) && __serverPlayers.length){
        const p0 = __serverPlayers.find(p=>p.alive!==false) || __serverPlayers[0];
        Player.x = p0.x; Player.y = p0.y;
        Player.hp = p0.hp; Player.maxHp = Math.max(p0.hpMax || 100, 1);
        Player.alive = p0.alive !== false;
        Player.bomb = 0;
        Input.px = Player.x; Input.py = Player.y; Input.tx = Player.x; Input.ty = Player.y;
      }
      update(${Math.max(0, Number(dt) || 0.05)});

      // extra server targeting layer for multiplayer: enemies chase nearest remote player.
      if (Array.isArray(__serverPlayers) && __serverPlayers.length){
        for (const e of enemies){
          if (!e || !e.alive) continue;
          let best = null, bd2 = 1e30;
          for (const p of __serverPlayers){
            if (!p || p.alive===false) continue;
            const dx = p.x - e.x, dy = p.y - e.y;
            const d2 = dx*dx + dy*dy;
            if (d2 < bd2){ bd2 = d2; best = p; }
          }
          if (!best) continue;
          const d = Math.sqrt(Math.max(1, bd2));
          const nx = (best.x - e.x) / d;
          const ny = (best.y - e.y) / d;
          const steer = 0.16;
          const sp = Math.hypot(e.vx||0, e.vy||0) || (90 + (Game.difficulty||1)*12);
          e.vx = lerp(e.vx||0, nx*sp, steer);
          e.vy = lerp(e.vy||0, ny*sp, steer);
        }
      }
    `);
  }

  function snapshot() {
    const json = exec(`JSON.stringify({
      t: performance.now(),
      mode: Game.mode,
      wave: Game.wave,
      score: Game.score,
      spawnerCd: Spawner.cd,
      bossAlive: Game.bossAlive,
      enemies: enemies.slice(0,96).map((e,i)=>({
        k: e.spawnId || e.id || (e.type||'E')+':'+i,
        x:e.x,y:e.y,vx:e.vx,vy:e.vy,hp:e.hp,maxHp:e.maxHp,r:e.r,
        col:e.baseCol||e.tint||'#FF2F57',
        bodySeed:e.bodySeed||0,
        type:e.type||'ENEMY'
      })),
      bulletsE: bulletsE.slice(0,140).map((b)=>({
        x:b.x,y:b.y,vx:b.vx,vy:b.vy,r:b.r,col:b.col,dmg:b.dmg,t:b.t,spr:b.spr,style:b.style,
        life:b.life,noHitT:b.noHitT,turnAfter:b.turnAfter,reverseT:b.reverseT,
        accel:b.accel,angVel:b.angVel,pauseT:b.pauseT,homing:b.homing,
        waveA:b.waveA,waveF:b.waveF,waveP:b.waveP,mineT:b.mineT,bounce:b.bounce,
        mods:Array.isArray(b.mods)?b.mods:[]
      }))
    })`);
    return JSON.parse(json);
  }

  return { start, tick, snapshot, exec };
}

module.exports = { createHeadlessGameRuntime };
