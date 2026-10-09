# AIM RANGE — Aim Lab clone in HTML/three.js

A browser aim trainer modeled on Aim Lab, rendered with three.js (vendored
locally, so it works fully offline).

## ▶ Play it

**https://anonamerjaxon-dev.github.io/aim-range/** — hosted on GitHub Pages,
no install, no build step.

To run it locally (or offline):

```sh
cd aim-range
python3 -m http.server 8931 --bind 127.0.0.1
# then open http://127.0.0.1:8931/index.html
```

A server is required (ES modules don't load over `file://`).

## How to use it

1. Open the link → the menu shows **12 task cards**, each with a one-line
   description and your personal best.
2. **Click a card** → a 3-2-1 countdown → 60 seconds on the clock. Click the
   orbs. The crosshair is yours: mouse moves it, LMB shoots.
3. Watch **STREAK** (every 5 in a row adds +10%, capped at 2×), **ACCURACY**
   and **TARGETS** in the top corners; the bottom-left shows the current task.
4. **Esc** pauses (and releases the mouse). From pause: resume, restart, or
   quit to menu. On the results screen press **R** to go again.
5. **STATS** (menu, bottom right) shows per-task history, trend, grade vs your
   own best, and a top-3 leaderboard. Everything persists in `localStorage`.
6. Tweak at the bottom of the menu: sensitivity/FOV, crosshair shape/size/
   colour, volume, resolution scale (the GPU dial), **theme** (Neon /
   Synthwave / Ember / Matrix — repaints the room, the HUD *and* the orbs),
   ball style, and the Feel sliders (inertia / camera recoil / gun kick).

## Tasks (12)

| Task | Type | What it trains |
| --- | --- | --- |
| GRIDSHOT | 3 orbs, fixed 5×3 grid | click speed on predictable targets |
| FLICKSHOT | 1 small orb, random position | large-distance flicks |
| SIXSHOT | 6 tiny orbs at once | click speed under clutter |
| TRACKING | 1 drifting orb, no clicking | smooth pursuit (score while on target) |
| REFLEX | 3 orbs that expire in 1.6 s | reaction time |
| MICROSHOT | 1 very small orb at long range | micro-adjustments |
| SPAWNTARGET | 1 orb, lifetime 0.5–1.0 s | snap acquisition before it blinks out |
| MOTIONSHOT | 3 orbs sliding across the room | leading flicks on moving targets |
| STRAFETRACK | 1 orb flipping direction | tracking direction changes |
| DETECTION | 3 orbs scattered anywhere | target search / acquisition |
| **PEEK** | WASD + 3 cover panels | peeking around cover (panels eat bullets) |
| **FREEROAM** | WASD sandbox, no score | walk the room freely, gun fires for fun |

60-second rounds, streak multiplier (up to 2×), accuracy, targets/sec, and
personal bests saved to `localStorage`. FREEROAM has no timer (counts up) and
never scores — it is pure playground.

## Controls

- **Mouse** — aim (pointer lock; Esc pauses, with a keyboard fallback that
  works even if the browser never grants pointer lock)
- **LMB** — shoot (in freeroam the gun fires but nothing counts)
- **WASD** — walk, in walk tasks only (the HUD label reminds you); strafing
  slides along cover panels
- **R** — restart from the results screen

## Viewmodel (gun + hand)

`viewmodel.js` builds a procedural low-poly pistol and gloved hand from
primitives and parents it to the camera: it aims with your look, never enters
the gameplay raycast (shots can't hit your own gun), and animates only on
events — recoil kick + slide spring + muzzle flash on fire, sway while turning,
bob while walking. It is hidden in menus so idle scenes stay at 0 renders/s.

The gun is detailed but cheap: machined top rib, cocking serrations, accessory
rail with slots, beavertail, backstrap, mag baseplate, two-segment fingers.
All ~45 parts are **merged per material** at build time (transforms baked into
one buffer) → the whole gun draws in ~7 calls; both sights stay unmerged
because they ride `slidePivot` together (real pistols mount both on the slide,
so they cycle as one unit under recoil).

## Results & stats

- **Grade** (S/A/B/C/D) scored against your own personal best.
- **Avg reaction** — spawn→hit time per round.
- **Targets/sec** — hits divided by round length.
- **PB chase** — points needed to beat your best on a non-record run.
- **History** — last 50 runs per task (`localStorage`), with trend (last 3 vs
  previous 3), a score sparkline, and a top-3 leaderboard on the STATS panel.

## Sound (procedural WebAudio — no audio files)

Signal chain: `voices → master gain → compressor → output`, with a parallel
`reverb send → convolver` feeding the same compressor.

- **Compressor** (threshold −14, ratio 6) stops a hit firing on top of a
  gunshot from clipping past 0 dBFS.
- **Reverb** is a generated 0.55 s impulse response (decaying stereo noise) —
  a parallel send, so dry sounds stay crisp.
- **Gunshot** = snap burst + low saw body + tail; **wall hit** = short dead
  thud (distinct from an air miss, so cover teaches itself); **hit pitch
  rises with streak** (octave over 16); spawn tick on every new orb;
  **footsteps** every 0.55 m walked (distance-based, so pace follows speed).
- Volume/mute persist in `localStorage`.

## Settings (menu)

- Sensitivity / FOV sliders
- Crosshair: shape (cross/dot/circle), size, colour — persisted
- Sound: volume, mute
- Graphics: resolution scale 60–100% (the big GPU dial)
- **Style**: theme (Neon / Synthwave / Ember / Matrix — repaints room
  materials, environment map and the CSS accent live) and ball style
  (Glossy Orb / Plasma / Hologram / Candy — restyles live targets). The theme
  drives the **whole** language: card borders, tag pills, glows, panel edges,
  the grade-A colour and the crosshair all derive from `--accent` (via
  `color-mix`), so no chrome can drift back to neon cyan. The crosshair
  follows the theme until you pick a colour yourself — that choice then pins
  it, and survives theme switches. **Targets too**: `orbPalette()` derives
  five orb shades from the accent (base, brighter, tinted near-white, deeper,
  +0.06 hue step — never a wrap-around, so Ember stays warm and Synth stays
  pink), and a theme switch rebuilds the palette, drops the baked candy
  textures and restyles every orb currently on screen.
- **Feel**: three 0–300% sliders — movement inertia (velocity smoothing tau),
  camera recoil (subtle shake impulse), gun kick (viewmodel spring strength)

## Hit feedback

Each kill fires three layers at once: a sub-bass body drop + 30 ms crack +
metallic confirm chime (procedural, streak-pitched sparkle on top), plus a
screen-space hitmarker, a floating `+score` pop, and a pooled additive burst
(white flash + 9 gravity sparks) at the impact point. On top of that, every
shot leaves physical evidence:

- **Bullet trail** — a short additive streak, gun-side → impact, ~130 ms. It
  IS the projectile (the shot is hitscan), pooled 8 deep. The start point sits
  **on the aim ray** 1.0 m in front of the eye — so the far end converges on
  whatever you aimed at — but dragged `TRAIL_PULL` (0.85) of the way toward
  the muzzle, so the near end lands ~200 px below-right of the crosshair.
  Neither extreme works: exactly on the ray every point projects to the same
  pixel (an invisible dot — that is what a "broken" trail looks like), while
  the muzzle proper cuts a long diagonal from the corner of the screen (the
  "bent bullet" look). 1.0 m is also past the viewmodel's nose, which is what
  hid the previous version behind the gun's own geometry.
- **Bullet holes** — one `InstancedMesh`, 48 slots, oldest-first recycling.
  Walls and floor keep the dent (dark pit + light chip rim so it reads on
  dark surfaces); orbs absorb the shot and never get one. A dent is permanent
  only for **9 s**, then shrinks away over 0.55 s (`HOLE_TTL` / `HOLE_FADE`)
  so a long spray can't pockmark the room forever — and it only invalidates
  the render loop while something is actually fading.
- Everything animated invalidates the render loop **only while alive**, so an
  idle scene stays at 0 renders/s.

## Performance design

- **Render-on-demand** — the frame only redraws when something visible changed
  (aim moved, orb spawned/killed, overlay toggled). Idle aim = 0 renders/s.
- **Shadow-on-demand** — the 2048² shadow map lives in light space, so camera
  motion doesn't re-render it; only caster changes do.
- **HUD write guards** — DOM text only rewritten when the value changes.
- 60 fps cap, DPR cap 1.5, `powerPreference: "low-power"`, focus-aware menu
  drift. Light count is 6 (three.js has no per-mesh light masking — every light
  runs in every shader, so count is the top cost dial).
- Cover/WASD costs nothing when a task doesn't use them (`coverMeshes` empty
  → the extra raycast is skipped entirely).
- **Merged geometry** — the three walls bake their texture repeat into UVs and
  draw as ONE mesh/material (`mergeGroup`, `main.js:661`): 3 draw calls → 1,
  3 texture-clone sets → 1, visually pixel-identical.
- **One draw call per effect** — the 8 pooled trails share a single
  `InstancedMesh`, and every live hit-burst particle (flash + sparks) is one
  camera-billboarded instanced quad instead of a sprite. Per-instance
  brightness rides `instanceColor` multiplied by a white vertex-colour
  attribute (three only forwards `vColor` to the fragment shader when
  `USE_COLOR` is defined — verified in the vendored r160 source). That removes
  the biggest draw-call spike in the game: a hit burst used to be 10 sprite
  draws.

Measured (`node probes/perf.mjs`, 1440×900): **62.8 fps, 1.26 ms/render
(p95 1.6), 25 draw calls, ~10.1k triangles** while shooting — down from **34
calls** before the effects were instanced — and **0 renders/s** once the
scene settles (a spent casing animates for ~4–5 s first, which is why the
probe waits 6 s before it measures idleness).

## Tests (headless Playwright — server must be up)

```sh
node smoke.mjs          # menu cards, HUD, WebGL, console errors
node probes/e2e.mjs     # 16 assertions: settings, shoot, pause, quit, stats, motion
node probes/juice.mjs   # 8 assertions: trail / holes / burst shape / pop pooling
node probes/theming.mjs # per-theme computed styles + pinned crosshair colour
node probes/fixes.mjs   # trail anchored on the aim ray / hole TTL / orbs follow theme
node probes/perf.mjs    # fps, ms/render, draw calls, idle renders/s
```

## Files

- `index.html` — DOM: menu, HUD, crosshair, pause/results/stats overlays; inline SVG favicon
- `style.css` — all styling (neon/dark theme, crosshair geometry via `--ch-size`)
- `main.js` — scene setup, input, WASD movement, state machine, per-task target logic, settings wiring
- `tasks.js` — the 12 task definitions
- `viewmodel.js` — procedural gun + hand attached to the camera
- `audio.js` — procedural WebAudio SFX (shoot/hit/miss/wall/countdown/go/end/pb/ui/spawn)
- `stats.js` — run history, grades, leaderboard, summaries (localStorage)
- `three.module.js` — vendored three.js r160
- `smoke.mjs` — headless Playwright check (menu cards, HUD, WebGL, console errors)
- `probes/` — the regression suite (e2e, juice, theming, perf); all assume
  `python3 -m http.server 8931` is running
