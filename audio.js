/* ---------------- audio: procedural WebAudio SFX ----------------
   Zero assets — every sound is an oscillator, envelope, or noise burst.
   Lazily builds one AudioContext + master gain; safe to import (and to
   call) before any user gesture or even with no AudioContext at all.
   API: unlockAudio() · sfx(name, opts) · setMuted(b)/isMuted()
        setVolume(v)/getVolume()                                     */

const LS_VOL = "aimrange.vol";
const LS_MUTED = "aimrange.muted";

let ctx = null;        // single AudioContext, created on demand
let master = null;     // master GainNode: volume/mute without touching ctx
let comp = null;       // DynamicsCompressor: hit+shoot+miss overlap can't clip
let reverb = null;     // ConvolverNode: procedural room tail (spatial depth)
let reverbSend = null; // how much of the mix feeds the reverb
let noiseBuffer = null; // one shared white-noise buffer (reused by 'miss')
let failed = false;     // AudioContext unavailable — stop retrying
let vol = null;         // lazy: 0..1, default 0.7
let muted = null;       // lazy: boolean

/* --- persistence (guarded: no localStorage ⇒ in-memory only) --- */

function lsGet(k) {
  try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : null; }
  catch (_) { return null; }
}
function lsSet(k, v) {
  try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); }
  catch (_) { /* private mode etc. */ }
}

export function getVolume() {
  if (vol === null) {
    const raw = parseFloat(lsGet(LS_VOL));
    vol = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.7;
  }
  return vol;
}

export function setVolume(v) {
  vol = Math.min(1, Math.max(0, Number(v) || 0));
  lsSet(LS_VOL, String(vol));
  applyMaster();
}

export function isMuted() {
  if (muted === null) muted = lsGet(LS_MUTED) === "1";
  return muted;
}

export function setMuted(b) {
  muted = !!b;
  lsSet(LS_MUTED, muted ? "1" : "0");
  applyMaster();
}

function applyMaster() {
  if (master) master.gain.value = isMuted() ? 0 : getVolume();
}

/* --- lazy context --- */

function ensure() {
  if (ctx) return ctx;
  if (failed) return null;
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) { failed = true; return null; }
    ctx = new AC();

    /* signal chain:  voices → master(gain) → compressor → destination
                                   └→ reverbSend → convolver ┘
       compressor first: gunshots are transient spikes; without it, a hit
       firing on top of a shot pushes past 0 dBFS and the output distorts.
       reverb is a parallel SEND, not in-line, so dry sounds stay crisp and
       only a fraction (reverbSend) gets the room tail. */
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);

    master = ctx.createGain();
    master.connect(comp);

    reverb = ctx.createConvolver();
    reverb.buffer = makeIR(); // procedural: decaying noise = a small room
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.22;
    reverbSend.connect(reverb);
    reverb.connect(comp); // wet tail also passes the compressor
    master.connect(reverbSend); // parallel send: dry stays crisp, tail is wet

    applyMaster();
    return ctx;
  } catch (_) {
    failed = true; ctx = null; master = null; comp = null; reverb = null;
    return null;
  }
}

/* impulse response: stereo noise whose amplitude decays exponentially —
   exactly what a room does to a sound. 0.55 s = medium training hall. */
function makeIR() {
  const len = Math.floor(ctx.sampleRate * 0.55);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.4); // exp-ish decay
    }
  }
  return buf;
}

export function unlockAudio() {
  try {
    const c = ensure();
    if (c && c.state === "suspended") {
      const p = c.resume();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (_) { /* not gesture-locked yet; next gesture retries */ }
}

function getNoise() {
  if (noiseBuffer) return noiseBuffer;
  const n = Math.floor(ctx.sampleRate * 0.3);
  noiseBuffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

/* --- synthesis primitives: 2 ms attack, exponential decay, clean-up --- */

function env(g, t, peak, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(freq, dur, type, peak, when = 0, to = 0) {
  /* GUARD: no sound in this game is ever scheduled MORE than 1 s out (the
     longest delay used is 0.18 s). A `when` above that means someone passed
     a frequency into the delay slot — this exact bug once scheduled the hit
     body boom 52 SECONDS after each kill (felt like a random faint thump),
     because `tone(180, 0.13, "sine", 0.62, 52)` read 52 as `when` not `to`.
     Re-interpreting it as the frequency target reproduces the intended
     180→52 Hz sweep instead of playing a late orphan. */
  if (when > 1 && to === 0) { to = when; when = 0; }
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  o.connect(g).connect(master);
  env(g, t, peak, dur);
  o.start(t);
  o.stop(t + dur + 0.02);
  o.onended = () => { o.disconnect(); g.disconnect(); };
}

function burst(dur, peak, cutoff) { // filtered noise hit (thuds, ticks)
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  src.connect(f).connect(g).connect(master);
  env(g, t, peak, dur);
  src.start(t);
  src.stop(t + dur + 0.02);
  src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
}

/* --- public SFX --- */

export function sfx(name, opts) {
  const c = ctx;
  if (!c || c.state !== "running" || isMuted()) return; // silent pre-gesture, never throws
  const o = opts || {};
  const vm = Number.isFinite(o.vol) ? Math.min(1, Math.max(0, o.vol)) : 1;
  if (vm <= 0) return;
  try {
    switch (name) {
      case "hit": {
        /* Delta-Force-style HIT CONFIRM. The old sound was only a rising
           triangle — it read as a UI beep, not an impact. A satisfying hit
           sound has THREE simultaneous layers (this is how game audio does it):
           1. BODY   — sub-bass punch with a fast downward sweep (you FEEL it)
           2. CRACK  — 30 ms bright noise transient (the actual "tap" contact)
           3. CONFIRM— short metallic two-note chime (the "you hit" reward)
           Because this game hits ONE ball at a time (no multi-hit spray to
           build rhythm from), each confirm is deliberately exaggerated.
           The streak pitch stays, but demoted to a sparkle ON TOP of the
           chime instead of being the whole sound. */
        const semi = Math.min(Math.max(o.streak | 0, 0), 16);
        const ring = 620 * Math.pow(2, semi / 12);
        // 1. body: 180→52 Hz sweep, punchy decay
        tone(180, 0.13, "sine", 0.62 * vm, 0, 52);
        // 2. crack: tight high noise tick
        burst(0.03, 0.5 * vm, 6000);
        // 3. confirm chime: bell pair, slightly detuned for shimmer
        tone(988, 0.09, "triangle", 0.3 * vm);        // B5
        tone(1319, 0.14, "sine", 0.22 * vm, 0.015);   // E6, delayed 15 ms
        // streak sparkle on top (rises with streak, never alone)
        tone(ring * 2, 0.05, "sine", 0.1 * vm);
        break;
      }
      case "miss":
        tone(90, 0.14, "sine", 0.5 * vm);      // low body
        burst(0.12, 0.22 * vm, 900);           // soft noise thud
        break;
      case "wall":
        // cover panel eats the bullet: short, dead, no pitch tail — you hear
        // "stopped" instead of "missed into open air"
        burst(0.05, 0.4 * vm, 1400);
        tone(140, 0.06, "square", 0.18 * vm);
        break;
      case "shoot":
        // three layers = what makes a gunshot read as "gun" not "beep":
        // 1. sharp transient snap (high-cut noise, 30 ms)
        burst(0.03, 0.5 * vm, 5000);
        // 2. body: fast downward pitch sweep (the "thump" of the action)
        tone(220, 0.09, "sawtooth", 0.34 * vm, 0, 60);
        // 3. tail: quiet low rumble decaying behind it
        burst(0.16, 0.12 * vm, 700);
        break;
      case "countdown":
        tone(700, 0.12, "square", 0.28 * vm);  // mid beep
        break;
      case "go":
        tone(1046, 0.16, "triangle", 0.4 * vm); // higher, satisfying
        tone(2093, 0.07, "sine", 0.1 * vm);
        break;
      case "end":
        tone(659, 0.16, "triangle", 0.4 * vm, 0);    // E5
        tone(440, 0.2, "triangle", 0.4 * vm, 0.14);  // A4 falling away
        break;
      case "pb":
        tone(659, 0.1, "triangle", 0.4 * vm, 0);     // E5
        tone(880, 0.1, "triangle", 0.4 * vm, 0.09);  // A5
        tone(1319, 0.16, "triangle", 0.42 * vm, 0.18); // E6
        break;
      case "ui":
        tone(1200, 0.035, "square", 0.15 * vm); // tiny click
        break;
      case "spawn":
        tone(320, 0.05, "sine", 0.08 * vm);     // barely-there tick
        break;
      case "step":
        // soft shoe scuff: filtered noise burst, very quiet — feet, not gunfire
        burst(0.045, 0.10 * vm, 700);
        tone(70, 0.03, "sine", 0.08 * vm);
        break;
    }
  } catch (_) { /* audio must never break gameplay */ }
}
