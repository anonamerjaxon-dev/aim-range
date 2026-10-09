/* =========================================================================
   AIM RANGE — task definitions (data only)
   Extracted from main.js section 1 so new tasks can be added without
   touching the engine. The 6 original tasks are copied verbatim; the 6
   new ones (4 click/track + 2 walk) use spawn/mode values the integrator
   wires into main.js. Structure of this file:
     1. original task definitions (verbatim from main.js)
     2. new task definitions (solo / slide / strafe / scatter)
     3. walk task definitions (WASD + optional line-of-sight cover)
     4. documentation constants for the integrator
   ========================================================================= */

/* ---------------- 1. original task definitions ---------------- */

export const TASKS = {
  gridshot: {
    name: "GRIDSHOT",
    tag: "PRECISION",
    desc: "Three orbs on a 5×3 grid. Clear them as fast as you can — they respawn instantly.",
    duration: 60,
    mode: "click",          // click to destroy
    targets: 3,             // simultaneous orbs
    radius: 0.62,
    spawn: "grid",          // fixed grid slots
    points: 100,
  },
  flickshot: {
    name: "FLICKSHOT",
    tag: "FLICK",
    desc: "One small orb appears somewhere in the room. Flick to it and click. Distance matters.",
    duration: 60,
    mode: "click",
    targets: 1,
    radius: 0.42,
    spawn: "random",
    points: 150,
  },
  sixshot: {
    name: "SIXSHOT",
    tag: "SPEED",
    desc: "Six tiny orbs at once. Pure click speed — miss and they don't wait for you.",
    duration: 60,
    mode: "click",
    targets: 6,
    radius: 0.34,
    spawn: "random",
    points: 120,
  },
  tracking: {
    name: "TRACKING",
    tag: "TRACK",
    desc: "Keep your crosshair on the drifting orb. You score continuously while you're on it.",
    duration: 60,
    mode: "track",          // no clicking: score while crosshair overlaps
    targets: 1,
    radius: 0.7,
    spawn: "wander",
    points: 0,
  },
  reflex: {
    name: "REFLEX",
    tag: "REACTION",
    desc: "Orbs flash into existence and vanish after a moment. React before they disappear.",
    duration: 60,
    mode: "click",
    targets: 3,
    radius: 0.5,
    spawn: "random",
    lifetime: 1.6,          // seconds before an orb auto-vanishes
    points: 200,
  },
  micro: {
    name: "MICROSHOT",
    tag: "PRECISION",
    desc: "One extremely small orb at long range. The ultimate micro-adjustment test.",
    duration: 60,
    mode: "click",
    targets: 1,
    radius: 0.22,
    spawn: "far",
    points: 250,
  },

  /* ---------------- 2. new task definitions ---------------- */

  spawntarget: {
    name: "SPAWNTARGET",
    tag: "REACTION",
    desc: "One target, random lifetime under a second. Kill it before it blinks out.",
    duration: 60,
    mode: "click",
    targets: 1,
    radius: 0.45,
    spawn: "solo",          // one target at a random position
    lifetime: [0.5, 1.0],   // per-spawn min/max lifetime in seconds; expiring unshot = miss (streak reset) + respawn
    points: 150,
  },
  motionshot: {
    name: "MOTIONSHOT",
    tag: "MOTION",
    desc: "Three orbs glide across the room. Lead your flicks and catch them mid-slide.",
    duration: 60,
    mode: "click",
    targets: 3,
    radius: 0.55,
    spawn: "slide",         // horizontal constant-speed slide, wraps to the opposite side
    speed: 3.5,             // units/sec — engine uses it
    points: 110,
  },
  strafetrack: {
    name: "STRAFETRACK",
    tag: "TRACK",
    desc: "A bot strafing left and right with unpredictable timing. Stay glued to it.",
    duration: 60,
    mode: "track",          // score continuously while crosshair overlaps
    targets: 1,
    radius: 0.6,
    spawn: "strafe",        // A/D strafe with randomized direction changes
    flip: [0.6, 1.4],       // min/max seconds between direction changes (engine-side)
    points: 60,
  },
  detection: {
    name: "DETECTION",
    tag: "SCATTER",
    desc: "Three orbs anywhere in the room — no grid, no mercy. Pure target acquisition.",
    duration: 60,
    mode: "click",
    targets: 3,
    radius: 0.5,
    spawn: "scatter",       // random positions across a wide arc, respawn on kill
    points: 120,
  },

  /* ---------------- 3. walk tasks (WASD movement) ----------------
     walk:true  → main.js enables WASD while the task runs
     cover:true → main.js raises line-of-sight panels; a panel blocks
                  both your bullets and your view (peek to find an angle) */

  peek: {
    name: "PEEK",
    tag: "MOVEMENT",
    desc: "Cover panels split the room. Strafe to find a line of sight — a panel eats your bullets.",
    duration: 60,
    mode: "click",
    targets: 3,
    radius: 0.5,
    spawn: "scatter",
    points: 130,
    walk: true,             // WASD on
    cover: true,            // line-of-sight panels + collision
  },
  freeroam: {
    name: "FREEROAM",
    tag: "SANDBOX",
    desc: "No timer, no score. Walk the room, test your aim, get a feel for the gun.",
    duration: 0,            // 0 = unlimited: timer counts up, round never auto-ends
    mode: "free",           // shots don't count, nothing to hit
    targets: 0,
    radius: 0,
    spawn: "scatter",
    points: 0,
    walk: true,
  },
};

/* ---------------- 3. documentation constants ---------------- */

/* spawn values main.js understands today: "grid" (main.js also treats any
   unknown value as a plain random spawn — "random" and "far"/"wander" are
   explicit). The 4 new values below are handled by the integrator's patch. */
export const SPAWN_TYPES = ["grid", "far", "wander", "solo", "slide", "strafe", "scatter"];

/* scoring styles: "click" = shoot to destroy, "track" = score while on target,
   "free" = sandbox (freeroam): nothing to score */
export const MODES = ["click", "track", "free"];
