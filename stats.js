/* ---------------- stats: localStorage history, boards, grades ----------------
   Per-task run history lives under `aimrange.runs.<taskKey>` as a JSON array,
   NEWEST FIRST, capped at 50 entries. Legacy `aimrange.best.<taskKey>` plain
   integers are read-only fallbacks (written by main.js) — never touched here.
   No localStorage (node / unit tests) ⇒ in-memory Map fallback. Defensive
   against corrupt JSON. Zero console output, zero top-level side effects.
   API: recordRun(run) · getHistory(key, limit) · getBoard(key, limit)
        getSummary(key) · getAllSummaries() · gradeFor(key, score)
        clearStats(key) · clearAll()                                  */

const RUNS_PREFIX = "aimrange.runs.";
const BEST_PREFIX = "aimrange.best.";
const CAP = 50;

const mem = new Map(); // in-memory fallback store when localStorage is absent

/* --- storage (guarded: works in the browser, in node, and when blocked) --- */

function ls() {
  try { if (typeof localStorage !== "undefined" && localStorage) return localStorage; }
  catch (_) { /* access can throw in privacy modes */ }
  return null;
}
function get(k) {
  const s = ls();
  if (s) { try { const v = s.getItem(k); if (v !== null) return v; } catch (_) { /* fall through */ } }
  return mem.has(k) ? mem.get(k) : null;
}
function set(k, v) {
  const s = ls();
  if (s) { try { s.setItem(k, v); return; } catch (_) { /* full / blocked */ } }
  mem.set(k, v);
}
function remove(k) {
  const s = ls();
  if (s) { try { s.removeItem(k); } catch (_) { /* ignore */ } }
  mem.delete(k);
}
function allKeys() {
  const out = new Set();
  const s = ls();
  if (s) { try { for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) out.add(k); } } catch (_) { /* ignore */ } }
  for (const k of mem.keys()) out.add(k);
  return [...out];
}

/* --- coercion helpers --- */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d = "") => (typeof v === "string" ? v : d);
const avg = (list) => list.reduce((s, r) => s + num(r.score), 0) / list.length;

function ts(v) { // fill if missing / empty / unparseable
  if (v === undefined || v === null || v === "") return Date.now();
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.now();
}

function parseRuns(key) {
  const raw = get(key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((r) => r && typeof r === "object") : [];
  } catch (_) { return []; } // corrupt storage ⇒ start fresh, never throw
}

function legacyBest(taskKey) {
  const n = parseInt(get(BEST_PREFIX + taskKey) || "", 10);
  return Number.isFinite(n) ? n : 0;
}

function historyBest(runs) {
  return runs.length ? Math.max(...runs.map((r) => num(r.score))) : 0;
}

/* --- API --- */

export function recordRun(run) {
  const r = run && typeof run === "object" ? run : {};
  const stored = {
    task: str(r.task),
    score: num(r.score),
    acc: num(r.acc),
    hits: num(r.hits),
    shots: num(r.shots),
    bestStreak: num(r.bestStreak),
    avgReaction: num(r.avgReaction),
    kps: Math.round(num(r.kps) * 10) / 10,
    ts: ts(r.ts),
    grade: str(r.grade),
  };
  const key = RUNS_PREFIX + stored.task;
  if (!stored.grade) stored.grade = gradeFor(stored.task, stored.score).letter;
  const hist = parseRuns(key); // corrupt ⇒ []
  hist.unshift(stored);        // newest first
  if (hist.length > CAP) hist.length = CAP;
  set(key, JSON.stringify(hist));
  return stored;
}

export function getHistory(taskKey, limit = 20) {
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
  return parseRuns(RUNS_PREFIX + String(taskKey)).slice(0, n);
}

export function getBoard(taskKey, limit = 5) {
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5;
  const key = String(taskKey);
  return parseRuns(RUNS_PREFIX + key)
    .slice()
    .sort((a, b) => num(b.score) - num(a.score)) // stable: ties keep recency
    .slice(0, n)
    .map((r) => ({
      score: num(r.score),
      ts: num(r.ts),
      grade: str(r.grade) || gradeFor(key, num(r.score)).letter,
    }));
}

export function getSummary(taskKey) {
  const key = String(taskKey);
  const runs = parseRuns(RUNS_PREFIX + key);
  const last10 = runs.slice(0, 10);
  let trend = 0;
  if (runs.length >= 6) {
    const recent = avg(runs.slice(0, 3));   // newest 3
    const prior = avg(runs.slice(3, 6));     // the 3 before those
    trend = recent > prior ? 1 : recent < prior ? -1 : 0;
  }
  return {
    best: runs.length ? historyBest(runs) : legacyBest(key),
    avg10: last10.length ? Math.round(avg(last10)) : 0,
    runs: runs.length,
    last: runs[0] || null,
    trend,
  };
}

export function getAllSummaries() {
  const out = {};
  for (const k of allKeys()) {
    const m = /^aimrange\.runs\.(.+)$/.exec(k);
    if (m) out[m[1]] = getSummary(m[1]);
  }
  return out;
}

export function gradeFor(taskKey, score) {
  const s = num(score);
  const best = historyBest(parseRuns(RUNS_PREFIX + String(taskKey))); // history only, never legacy
  const ratio = s / Math.max(best, s, 1);
  if (ratio >= 0.98) return { letter: "S", title: "SPECTACULAR", ratio };
  if (ratio >= 0.90) return { letter: "A", title: "SHARP", ratio };
  if (ratio >= 0.75) return { letter: "B", title: "SOLID", ratio };
  if (ratio >= 0.60) return { letter: "C", title: "STEADY", ratio };
  return { letter: "D", title: "SCRAPPY", ratio };
}

export function clearStats(taskKey) {
  remove(RUNS_PREFIX + String(taskKey));
}

export function clearAll() {
  for (const k of allKeys()) if (k.startsWith(RUNS_PREFIX)) remove(k);
}
