/* =========================================================================
   AIM RANGE — an Aim Lab–style aim trainer built on three.js
   Structure of this file:
     1. task definitions
     2. three.js scene setup
     3. input (pointer lock + mouse look + shooting)
     4. game state machine (menu → countdown → playing → paused → results)
     5. target logic per task
     6. HUD / DOM wiring
   ========================================================================= */

import * as THREE from "./three.module.js";
import { TASKS } from "./tasks.js";                 // task data lives in its own module
import { sfx, unlockAudio, setVolume, getVolume, setMuted, isMuted } from "./audio.js";
import { recordRun, getSummary, getBoard, getHistory, gradeFor } from "./stats.js";
import { createViewmodel, setViewmodelAccent } from "./viewmodel.js"; // first-person pistol + gloved hand

/* ---------------- 1. task definitions → ./tasks.js ---------------- */

/* ---------------- 2. three.js scene ---------------- */

const canvas = document.getElementById("scene");
const dpr = window.devicePixelRatio || 1;
const renderer = new THREE.WebGLRenderer({
  canvas,
  // Retina (≥1.5×) already supersamples — MSAA off saves GPU bandwidth there;
  // plain 1× displays still get it so the neon grid lines stay clean
  antialias: dpr < 1.5,
  powerPreference: "low-power", // hint: don't spin up a discrete GPU — identical pixels, far less power
});
renderer.setPixelRatio(Math.min(dpr, 1.5)); // 5.2M → 2.9M pixels/frame on Retina
renderer.setSize(window.innerWidth, window.innerHeight);

/* ACES tone mapping: lets us crank lights/emissives bright without the
   highlights clipping to flat white */
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/* ---- render-on-demand + shadow-on-demand --------------------------------
   Two per-frame costs used to be paid unconditionally:
     1. the 2048x2048 shadow depth pass, and
     2. a full scene redraw,
   even when the resulting frame would be pixel-identical to the last one.
   The key light and the room never move, and a shadow map lives in LIGHT
   space, not camera space — so the depth pass only needs to run when a
   shadow caster (an orb) is added, removed, or moves. Likewise the scene
   only needs a redraw when something visible actually changed. Both flags
   are one-shot: three.js resets them after consuming. */
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true; // one full pass to populate the map

let sceneDirty = true;
/* a visible change to the 3D scene (camera moved, orb spawned/moved, fov…) */
function invalidate() { sceneDirty = true; }
/* a shadow caster changed: also implies a visible change */
function invalidateShadows() {
  sceneDirty = true;
  renderer.shadowMap.needsUpdate = true;
}
/* safety net: context restore clears GL state, force a full redraw */
canvas.addEventListener("webglcontextrestored", () => invalidateShadows());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1424);
scene.fog = new THREE.Fog(0x0a1424, 30, 95);

/* ---------------- themes ----------------
   One table drives EVERY color site in the app: fog/bg, hemisphere+key
   lights, ceiling spots, wall glow (emissive COLOR — the wall emissive map
   was repainted grayscale so tinting happens here), surface tint, baseboards,
   fixtures, cover accents, the gun's accent strips and the whole HUD via the
   --accent CSS variable. `neon` is the look that was approved before themes
   existed (byte-for-byte identical). */
const THEMES = {
  neon:   { accent: "#00e5ff", accentDim: "#0899a8", bg: 0x0a1424,
            glow: 0x00c8e6, baseboard: 0x00d5f5, fixture: 0xdff4ff,
            hemiSky: 0xbfe3ff, hemiGround: 0x352c48, key: 0xfff2dd,
            spot: 0xcfeaff, tint: 0xffffff, band: "rgba(0,229,255,0.5)" },
  synth:  { accent: "#ff4fd8", accentDim: "#a8256e", bg: 0x1a0a24,
            glow: 0xff69c4, baseboard: 0xff4fd8, fixture: 0xffe4f4,
            hemiSky: 0xffd9f2, hemiGround: 0x3a2440, key: 0xffeaf6,
            spot: 0xffd0ec, tint: 0xf6e4ff, band: "rgba(255,79,216,0.5)" },
  ember:  { accent: "#ff9a3d", accentDim: "#a85c18", bg: 0x190f08,
            glow: 0xff9a3d, baseboard: 0xff7a2e, fixture: 0xfff0dc,
            hemiSky: 0xffe3c4, hemiGround: 0x3a2818, key: 0xffeed8,
            spot: 0xffdcae, tint: 0xffe8d2, band: "rgba(255,154,61,0.5)" },
  matrix: { accent: "#8dff5c", accentDim: "#4fa82e", bg: 0x081408,
            glow: 0x8dff5c, baseboard: 0x5cf53c, fixture: 0xeaffea,
            hemiSky: 0xdcffd0, hemiGround: 0x1c3818, key: 0xf2ffe8,
            spot: 0xdcffd0, tint: 0xe4ffd8, band: "rgba(141,255,92,0.5)" },
};
/* The saved theme must be loaded BEFORE any material is built, so everything
   is created already-tinted (applyTheme at the end then just syncs lights/HUD
   that can't be creation-time constants). */
let themeName = localStorage.getItem("aimrange.theme") || "neon";
if (!THEMES[themeName]) themeName = "neon";
let curTheme = THEMES[themeName];

const camera = new THREE.PerspectiveCamera(
  90,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 1.6, 8);
/* The camera must be IN the scene graph for its children to render at all —
   three.js only walks scene → children, so a camera-only child is invisible. */
scene.add(camera);

/* First-person viewmodel (pistol + gloved hand) parented to the camera:
   aim/turn come for free. It has no idle animation (render-on-demand stays
   intact) — update() reports whether it's still springing, and we invalidate
   only while that's true. */
const vm = createViewmodel(camera);
scene.add(vm.casings); // spent casings live in WORLD space (they fall to the floor)

/* ---------------- environment map ----------------
   A painted equirectangular gradient run through PMREM. This is what makes
   the glossy balls show a real highlight + reflection instead of reading as
   a flat disc — a lit sphere needs something to reflect. */
function makeEnvTexture() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  /* Deliberately high-contrast: the top half is what the glossy balls reflect
     on their upper hemisphere, the dark bottom half what they reflect below.
     A steep bright→dark transition paints a visible gradient across the
     sphere = the strongest "this is round" cue we have (no per-object lights:
     three.js r160 runs every light in every shader, so adding lights to light
     only the balls would tax the whole room). */
  grad.addColorStop(0.0, "#e8f7ff");   // near-white ceiling core
  grad.addColorStop(0.3, "#79b8e8");
  grad.addColorStop(0.48, "#2a4a78");
  grad.addColorStop(0.55, "#14213c");
  grad.addColorStop(1.0, "#070b16");   // deep dark floor
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  // ceiling light strips → structured reflections on the orbs
  g.fillStyle = "rgba(255,255,255,0.95)";
  for (let i = 0; i < 6; i++) g.fillRect(i * 80 + 18, 26, 44, 14);
  // accent band (the room's neon seams show up in reflections too) — theme-tinted
  g.fillStyle = curTheme.band;
  g.fillRect(0, 150, 512, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function rebuildEnv() {
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(makeEnvTexture()).texture;
  pm.dispose();
}
rebuildEnv();

/* ---------------- lighting ----------------
   hemisphere = base fill · key = sun-ish directional with shadows ·
   ceiling spots = localized pools of light so the room has depth */
const hemi = new THREE.HemisphereLight(curTheme.hemiSky, curTheme.hemiGround, 0.85);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff2dd, 1.5);
key.position.set(8, 14, 10);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.03; // texel-width nudge: kills acne without detaching
scene.add(key);

/* Fit the shadow frustum to the ROOM, not to guesswork. Outside its box
   three.js clamps the depth lookup to the map edge → shadows silently
   vanish/bleed near room edges (3 of 4 floor corners were outside the
   old -24..24 box). Project the room's visible AABB into light space and
   size the ortho box exactly around it. */
function fitShadowCamera() {
  const cam = key.shadow.camera;
  const probe = new THREE.PerspectiveCamera(); // only its view matrix is used
  probe.position.copy(key.position);
  probe.lookAt(key.target.position);
  probe.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let l = Infinity, r = -Infinity, t = -Infinity, b = Infinity, dNear = Infinity, dFar = -Infinity;
  const M = 1.0; // margin for cover panels / orb halos
  for (const x of [-ROOM_W / 2, ROOM_W / 2])
    for (const y of [0, ROOM_H])
      for (const z of [-18, 10]) {        // visible room extent (back wall → behind camera)
        v.set(x, y, z).applyMatrix4(probe.matrixWorldInverse);
        l = Math.min(l, v.x); r = Math.max(r, v.x);
        b = Math.min(b, v.y); t = Math.max(t, v.y);
        dNear = Math.min(dNear, -v.z); dFar = Math.max(dFar, -v.z);
      }
  cam.left = l - M; cam.right = r + M;
  cam.bottom = b - M; cam.top = t + M;
  cam.near = Math.max(0.1, dNear - M); cam.far = dFar + M;
  cam.updateProjectionMatrix();
}

/* ---------------- room construction ----------------
   Procedural canvas textures (no asset files): tiled floor, paneled walls
   with glowing seams, plus real geometry — baseboards, ceiling light
   fixtures, pilasters — so it reads as a PLACE, not a wireframe box. */

const ROOM_W = 28, ROOM_H = 12, ROOM_D = 40;

function canvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/* floor: large dark tiles — 1024² with beveled edges, per-tile tone
   variation, edge wear and scuffs. The height/rough maps below make the
   grout actually sit BELOW the tile face in shading terms: grout = matte,
   tile face = polished (reflects the ceiling lights). */
const floorTex = canvasTexture(1024, 1024, (g, w, h) => {
  g.fillStyle = "#0c1124";
  g.fillRect(0, 0, w, h);
  const n = 4, s = w / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * s, y = j * s;
      // per-tile tone: slight blue variation so the grid isn't a flat checker
      const v = (Math.random() * 14) | 0;
      const base = `rgb(${22 + v}, ${30 + v}, ${55 + v})`;
      g.fillStyle = base;
      g.fillRect(x + 6, y + 6, s - 12, s - 12);
      // bevel: light catches the top/left edge, shadow on bottom/right
      g.fillStyle = "rgba(255,255,255,0.10)";
      g.fillRect(x + 6, y + 6, s - 12, 3);
      g.fillRect(x + 6, y + 6, 3, s - 12);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(x + 6, y + s - 9, s - 12, 3);
      g.fillRect(x + s - 9, y + 6, 3, s - 12);
      // soft inner vignette (tiles catch light in the middle)
      const rad = g.createRadialGradient(x + s / 2, y + s / 2, s * 0.1, x + s / 2, y + s / 2, s * 0.72);
      rad.addColorStop(0, "rgba(255,255,255,0.05)");
      rad.addColorStop(1, "rgba(0,0,0,0.16)");
      g.fillStyle = rad;
      g.fillRect(x + 6, y + 6, s - 12, s - 12);
      // wear: scratches near where feet would scuff
      for (let k = 0; k < 5; k++) {
        g.strokeStyle = `rgba(255,255,255,${Math.random() * 0.07})`;
        g.lineWidth = Math.random() * 1.6;
        g.beginPath();
        const sx = x + Math.random() * s, sy = y + Math.random() * s;
        g.moveTo(sx, sy);
        g.lineTo(sx + (Math.random() - 0.5) * 70, sy + (Math.random() - 0.5) * 14);
        g.stroke();
      }
      // fine grit
      for (let k = 0; k < 140; k++) {
        g.fillStyle = `rgba(255,255,255,${Math.random() * 0.045})`;
        g.fillRect(x + Math.random() * s, y + Math.random() * s, 2, 2);
      }
    }
  }
  // grout: recessed dark channel + slight top shadow inside it
  g.strokeStyle = "#080c1a";
  g.lineWidth = 12;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, h); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(w, i * s); g.stroke();
  }
  g.strokeStyle = "rgba(0,0,0,0.7)";
  g.lineWidth = 3;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * s + 7, 0); g.lineTo(i * s + 7, h); g.stroke();
    g.beginPath(); g.moveTo(0, i * s + 7); g.lineTo(w, i * s + 7); g.stroke();
  }
}, ROOM_W / 4, ROOM_D / 4);

/* floor height (bump): tile faces HIGH, grout LOW + grit — one draw gives
   real relief under the moving lights, no normal-map math needed */
const floorBump = canvasTexture(512, 512, (g, w, h) => {
  g.fillStyle = "#b8b8b8";
  g.fillRect(0, 0, w, h);
  const n = 4, s = w / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = i * s, y = j * s;
    // rounded-ish tile crown
    const rad = g.createRadialGradient(x + s / 2, y + s / 2, s * 0.05, x + s / 2, y + s / 2, s * 0.7);
    rad.addColorStop(0, "#ffffff");
    rad.addColorStop(1, "#9a9a9a");
    g.fillStyle = rad;
    g.fillRect(x + 8, y + 8, s - 16, s - 16);
    for (let k = 0; k < 90; k++) { // pits
      g.fillStyle = `rgba(0,0,0,${Math.random() * 0.18})`;
      g.fillRect(x + Math.random() * s, y + Math.random() * s, 2, 2);
    }
  }
  g.fillStyle = "#101010"; // recessed grout
  g.lineWidth = 0;
  for (let i = 0; i <= n; i++) {
    g.fillRect(i * s - 6, 0, 12, h);
    g.fillRect(0, i * s - 6, w, 12);
  }
}, ROOM_W / 4, ROOM_D / 4);
floorBump.colorSpace = THREE.NoColorSpace;

/* floor roughness: polished tile faces (dark = smooth, mirrors the ceiling
   lights) vs matte grout (light = rough) */
const floorRough = canvasTexture(512, 512, (g, w, h) => {
  g.fillStyle = "#5a5a5a"; // tile: fairly glossy
  g.fillRect(0, 0, w, h);
  const n = 4, s = w / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = i * s, y = j * s;
    // uneven polish patches — reflections break up instead of being uniform
    for (let k = 0; k < 7; k++) {
      g.fillStyle = `rgba(${60 + Math.random() * 70 | 0},${60 + Math.random() * 70 | 0},${60 + Math.random() * 70 | 0},0.5)`;
      g.beginPath();
      g.ellipse(x + Math.random() * s, y + Math.random() * s, 20 + Math.random() * 40, 12 + Math.random() * 26, Math.random() * 3, 0, 7);
      g.fill();
    }
    // scuffs are matte
    g.strokeStyle = "rgba(170,170,170,0.5)";
    g.lineWidth = 3;
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      const sx = x + Math.random() * s, sy = y + Math.random() * s;
      g.moveTo(sx, sy); g.lineTo(sx + (Math.random() - 0.5) * 60, sy + (Math.random() - 0.5) * 12);
      g.stroke();
    }
  }
  g.fillStyle = "#e0e0e0"; // grout: fully matte
  for (let i = 0; i <= n; i++) {
    g.fillRect(i * s - 5, 0, 10, h);
    g.fillRect(0, i * s - 5, w, 10);
  }
}, ROOM_W / 4, ROOM_D / 4);
floorRough.colorSpace = THREE.NoColorSpace;

/* wall color map: brushed panels — 1024² with per-panel bevels, rivets,
   dirt settling at the bottom and hairline scratches. LAYOUT IS CONTRACT:
   8 panels, accent stripe at h·0.60 — the emissive map and every wall's
   stripe alignment depend on these positions. */
const wallColorTex = canvasTexture(1024, 1024, (g, w, h) => {
  g.fillStyle = "#2a3450";
  g.fillRect(0, 0, w, h);
  const pw = w / 8;
  for (let i = 0; i < 8; i++) {
    const x = i * pw;
    g.fillStyle = i % 2 ? "#303b5c" : "#262f4c";
    g.fillRect(x + 4, 0, pw - 8, h);
    // bevel: raised panel catches light on top/left, shades bottom/right
    g.fillStyle = "rgba(255,255,255,0.14)";
    g.fillRect(x + 4, 0, 3, h);
    g.fillRect(x + 4, 0, pw - 8, 3);
    g.fillStyle = "rgba(0,0,0,0.4)";
    g.fillRect(x + pw - 7, 0, 3, h);
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillRect(x, 0, 4, h); // seam shadow between panels
    // rivets down each seam (two columns, 8 rows)
    for (let r = 0; r < 8; r++) {
      const ry = 70 + r * ((h - 140) / 7);
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.beginPath(); g.arc(x + 14, ry + 2, 5, 0, 7); g.fill();
      g.fillStyle = "rgba(255,255,255,0.28)";
      g.beginPath(); g.arc(x + 13, ry, 4, 0, 7); g.fill();
    }
  }
  // brushed-metal streaks (denser, finer than before)
  for (let k = 0; k < 900; k++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    g.fillRect(0, Math.random() * h, w, 1);
  }
  // hairline scratches
  for (let k = 0; k < 40; k++) {
    g.strokeStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.1})`;
    g.lineWidth = 1;
    const sx = Math.random() * w, sy = Math.random() * h;
    g.beginPath(); g.moveTo(sx, sy);
    g.lineTo(sx + (Math.random() - 0.5) * 200, sy + (Math.random() - 0.5) * 60);
    g.stroke();
  }
  // grime settling toward the floor
  const gr = g.createLinearGradient(0, h, 0, h * 0.72);
  gr.addColorStop(0, "rgba(0,0,0,0.32)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, h * 0.72, w, h * 0.28);
  // accent stripe
  g.fillStyle = "#0e5f74";
  g.fillRect(0, h * 0.60, w, 26);
  g.fillStyle = "#128ba8";
  g.fillRect(0, h * 0.60, w, 6);
  // upper darker band
  g.fillStyle = "rgba(0,0,0,0.3)";
  g.fillRect(0, 0, w, h * 0.12);
}, 1, 1);

/* wall height: panels stand proud of the seams; stripe ridge too */
const wallBump = canvasTexture(512, 512, (g, w, h) => {
  g.fillStyle = "#808080"; // neutral
  g.fillRect(0, 0, w, h);
  const pw = w / 8;
  for (let i = 0; i < 8; i++) {
    const x = i * pw;
    const rad = g.createLinearGradient(x, 0, x + pw, 0);
    rad.addColorStop(0, "#5a5a5a");
    rad.addColorStop(0.12, "#a8a8a8");
    rad.addColorStop(0.88, "#a8a8a8");
    rad.addColorStop(1, "#5a5a5a");
    g.fillStyle = rad;
    g.fillRect(x + 4, 0, pw - 8, h);
    for (let r = 0; r < 8; r++) { // rivets bump up
      g.fillStyle = "#ffffff";
      g.beginPath(); g.arc(x + 14, 70 + r * ((h - 140) / 7), 5, 0, 7); g.fill();
    }
  }
  g.fillStyle = "#000000"; // recessed seams
  for (let i = 0; i <= 8; i++) g.fillRect(i * pw - 3, 0, 6, h);
  g.fillStyle = "#d0d0d0"; // stripe ridge
  g.fillRect(0, h * 0.60, w, 26);
}, 1, 1);
wallBump.colorSpace = THREE.NoColorSpace;

/* wall emissive map: ONLY the seams/stripe glow — this is the neon look.
   Painted GRAYSCALE on purpose: emissive color multiplies this map, so the
   theme's glow color tints the seams without redrawing the texture. The old
   cyan paint (0,180,220-class) is matched by white at the same luminance. */
const wallEmissiveTex = canvasTexture(512, 512, (g, w, h) => {
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#e6e6e6";
  g.fillRect(0, h * 0.60, w, 10);
  g.fillStyle = "#8f8f8f";
  g.fillRect(0, h * 0.60 + 14, w, 4);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.fillRect(i * 64, 0, 2, h);
  }
  g.fillStyle = "rgba(255,255,255,0.35)";
  g.fillRect(0, h * 0.12, w, 3);
}, 1, 1);

const wallMats = []; // every wall material ever made — applyTheme retints them
function makeWallMaterial(repeatX, repeatY) {
  const map = wallColorTex.clone();
  const emissiveMap = wallEmissiveTex.clone();
  const bumpMap = wallBump.clone();
  for (const t of [map, emissiveMap, bumpMap]) {
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
  }
  const mat = new THREE.MeshStandardMaterial({
    map,
    emissive: curTheme.glow, // theme-tinted seam glow (map is grayscale)
    emissiveMap,
    emissiveIntensity: 1.6,
    bumpMap,
    bumpScale: 0.4, // panels/seams get real relief under grazing light
    roughness: 0.75,
    metalness: 0.15,
    envMapIntensity: 0.5,
  });
  wallMats.push(mat);
  return mat;
}

/* floor */
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ROOM_W, ROOM_D),
  new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.55,
    roughnessMap: floorRough, // multiplies base: polished tile vs matte grout
    bumpMap: floorBump,
    bumpScale: 0.6,          // grout visibly sits below the tile face
    metalness: 0.35,
    /* 0.7 → 0.45: the env ceiling got brighter to carve the orbs' curvature,
       and the floor (largest surface) was inheriting that as +4 mean brightness.
       The orbs pay for their own light via material.envMapIntensity, so the
       room's ambient level stays where it was approved. */
    envMapIntensity: 0.45,   // slightly polished → reflects the ceiling lights
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, -ROOM_D / 2 + 10);
floor.receiveShadow = true;
scene.add(floor);

/* ceiling */
const ceil = new THREE.Mesh(
  new THREE.PlaneGeometry(ROOM_W, ROOM_D),
  new THREE.MeshStandardMaterial({ color: 0x11172b, roughness: 0.95 })
);
ceil.rotation.x = Math.PI / 2;
ceil.position.set(0, ROOM_H, -ROOM_D / 2 + 10);
scene.add(ceil);

/* walls — the old code gave each wall its own material with repeat = size/8
   (constant panel density). Baking that repeat into the UVs keeps the visuals
   pixel-identical while all three walls share ONE material and merge into ONE
   draw call: 3 → 1 calls, 3 texture-clone sets → 1. */
const wallMat = makeWallMaterial(1, 1);
function bakeWallUV(geo, rx, ry) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry);
  uv.needsUpdate = true;
  return geo;
}
const backWall = new THREE.Mesh(
  bakeWallUV(new THREE.PlaneGeometry(ROOM_W, ROOM_H), ROOM_W / 8, ROOM_H / 8), wallMat
);
backWall.position.set(0, ROOM_H / 2, -18);
/* receiveShadow=false on walls/ceiling is a runtime uniform in the shader
   (no recompile): the PCF shadow lookup is skipped on these huge surfaces.
   Only the floor shows visible orb shadows, so walls gaining nothing. */
scene.add(backWall);

const leftWall = new THREE.Mesh(
  bakeWallUV(new THREE.PlaneGeometry(ROOM_D, ROOM_H), ROOM_D / 8, ROOM_H / 8), wallMat
);
leftWall.rotation.y = Math.PI / 2;
leftWall.position.set(-ROOM_W / 2, ROOM_H / 2, -ROOM_D / 2 + 10);
scene.add(leftWall);

const rightWall = new THREE.Mesh(
  bakeWallUV(new THREE.PlaneGeometry(ROOM_D, ROOM_H), ROOM_D / 8, ROOM_H / 8), wallMat
);
rightWall.rotation.y = -Math.PI / 2;
rightWall.position.set(ROOM_W / 2, ROOM_H / 2, -ROOM_D / 2 + 10);
scene.add(rightWall);

/* baseboards: a lit trim where every wall meets the floor */
const baseboardMat = new THREE.MeshStandardMaterial({
  color: 0x0d2f3c,
  emissive: curTheme.baseboard,
  emissiveIntensity: 1.4,
  roughness: 0.5,
});
const baseboards = [];
function addBaseboard(w, x, z, rotY) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.35, 0.16), baseboardMat);
  b.position.set(x, 0.175, z);
  b.rotation.y = rotY;
  scene.add(b);
  baseboards.push(b);
}
addBaseboard(ROOM_W, 0, -17.92, 0);
addBaseboard(ROOM_D, -ROOM_W / 2 + 0.08, -ROOM_D / 2 + 10, Math.PI / 2);
addBaseboard(ROOM_D, ROOM_W / 2 - 0.08, -ROOM_D / 2 + 10, Math.PI / 2);

/* ceiling light fixtures: emissive panel + a real point light underneath */
const fixtureGeo = new THREE.BoxGeometry(3.6, 0.18, 1.2);
const fixtureMat = new THREE.MeshStandardMaterial({
  color: 0x233052,
  emissive: curTheme.fixture,
  emissiveIntensity: 2.6,
  roughness: 0.4,
});
/* GPU note: three.js has NO per-mesh light masking — every PointLight is
   unrolled in EVERY fragment shader, so light count is one of the most
   expensive dials in the scene. All 10 emissive panels stay (they're free
   — just material emissive), but only the 6 inner ones carry a real light:
   the play area is |x| ≤ 8, so the outer x=±11 columns mostly lit bare wall. */
const fixtures = [];
const spots = [];
for (let i = -2; i <= 2; i++) {
  const fx = new THREE.Mesh(fixtureGeo, fixtureMat);
  fx.position.set(i * 5.5, ROOM_H - 0.4, -8);
  scene.add(fx);
  fixtures.push(fx);
  const fx2 = fx.clone();
  fx2.position.z = -15;
  scene.add(fx2);
  fixtures.push(fx2);

  if (Math.abs(i) <= 1) { // real lights only over the play area
    const spot = new THREE.PointLight(curTheme.spot, 55, 26, 2);
    spots.push(spot);
    spot.position.set(i * 5.5, ROOM_H - 1.2, -8);
    scene.add(spot);
    const spot2 = new THREE.PointLight(curTheme.spot, 45, 26, 2);
    spots.push(spot2);
    spot2.position.set(i * 5.5, ROOM_H - 1.2, -15);
    scene.add(spot2);
  }
}

/* pilasters (shallow columns) on the back wall for depth cueing */
const pillarMat = new THREE.MeshStandardMaterial({
  color: 0x32406a,
  roughness: 0.6,
  metalness: 0.25,
  envMapIntensity: 0.6,
});
const pillars = [];
for (let i = -2; i <= 2; i++) {
  if (i === 0) continue;
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.9, ROOM_H, 0.7), pillarMat);
  pillar.position.set(i * 5.5, ROOM_H / 2, -17.55);
  pillar.castShadow = true;
  pillar.receiveShadow = true;
  scene.add(pillar);
  pillars.push(pillar);
}

/* --- static merge: one draw call per material instead of per box ---
   three r160 ships BufferGeometryUtils only as an addon (not in the vendored
   build), so this is the minimal version: bake each mesh's world transform
   into a clone, concatenate the indexed attributes. Saves 14 draw calls on
   the main pass (3+10+4 boxes → 3) and 4 on the shadow pass (pillars).
   Only safe because these groups never move and share one material. */
function mergeStatic(meshes) {
  if (meshes.length < 2) return null;
  const geos = meshes.map((m) => {
    m.updateMatrixWorld(true);
    return m.geometry.clone().applyMatrix4(m.matrixWorld); // world-space bake
  });
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo; // rebase
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose(); // clone served its purpose
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  return merged;
}

function mergeGroup(meshes, material, opts = {}) {
  const geo = mergeStatic(meshes);
  if (!geo) return;
  const m = new THREE.Mesh(geo, material);
  m.castShadow = !!opts.castShadow;
  m.receiveShadow = !!opts.receiveShadow;
  for (const old of meshes) scene.remove(old);
  scene.add(m);
  return m;
}
const mergedMeshes = [
  mergeGroup([backWall, leftWall, rightWall], wallMat), // 3 walls → 1 draw
  mergeGroup(baseboards, baseboardMat),
  mergeGroup(fixtures, fixtureMat),
  mergeGroup(pillars, pillarMat, { castShadow: true, receiveShadow: true }),
].filter(Boolean);
/* every surface a bullet can end up in: trails stop there and holes stamp
   there (targets are handled separately — they absorb the shot) */
const envMeshes = [floor, ceil, ...mergedMeshes];
invalidateShadows(); // merged casters → refresh the map once

fitShadowCamera(); // room bounds known now — size the shadow frustum to them

/* ---------------- cover panels (PEEK task) ----------------
   Built on demand so every other task renders exactly the scene it always
   did. Each panel is both an obstacle (bullets — see shootRay) and a wall
   you can strafe behind (collision — see hitsCover in the loop). */
const coverMeshes = [];
const coverBoxes = []; // { x0, x1, z0, z1 } for circle-vs-AABB collision
let coverAccentMat = null; // themed by applyTheme if covers exist

function buildCover() {
  if (coverMeshes.length) return; // already built
  const mat = makeWallMaterial(3, 1.2);
  const geo = new THREE.BoxGeometry(0.6, 4.2, 4.5);
  const accent = new THREE.MeshBasicMaterial({ color: curTheme.accent });
  coverAccentMat = accent;
  const accentGeo = new THREE.BoxGeometry(0.64, 0.1, 4.5);
  // three panels staggered across the play area → multiple peek angles
  const spots = [
    [-5.0, -8.5], [4.0, -11.5], [-1.5, -14.5],
  ];
  for (const [x, z] of spots) {
    const p = new THREE.Mesh(geo, mat);
    p.position.set(x, 2.1, z);
    p.castShadow = true;
    p.receiveShadow = true;
    scene.add(p);
    // glowing top edge so panels read as objects, not holes
    const edge = new THREE.Mesh(accentGeo, accent);
    edge.position.set(x, 4.2, z);
    scene.add(edge);
    coverMeshes.push(p, edge);
    coverBoxes.push({ x0: x - 0.55, x1: x + 0.55, z0: z - 2.55, z1: z + 2.55 });
  }
  invalidateShadows(); // new casters → refresh the depth pass once
}

function clearCover() {
  if (!coverMeshes.length) return;
  for (const m of coverMeshes) scene.remove(m);
  coverMeshes.length = 0;
  coverBoxes.length = 0;
  invalidateShadows();
}

/* circle (player, radius R) vs panel AABBs in XZ — used to stop movement */
function hitsCover(x, z, R) {
  for (const b of coverBoxes) {
    if (x + R > b.x0 && x - R < b.x1 && z + R > b.z0 && z - R < b.z1) return true;
  }
  return false;
}

/* ---------------- targets ---------------- */

const orbGeo = new THREE.SphereGeometry(1, 48, 32);
const targets = []; // active target objects

/* Orb colours are DERIVED FROM THE THEME ACCENT, so a target belongs to the
   same neon language as the seams it floats in front of: the accent itself,
   a brighter step, an accent-tinted near-white, a deeper cut and one small
   analogous hue step (+0.06, never a wrap-around — a warm accent must not
   drift into magenta). Five shades of the theme, not five unrelated hues.
   Rebuilt by applyTheme. */
function orbPalette(hex) {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(hex).getHSL(hsl);
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mk = (h, s, l) =>
    new THREE.Color().setHSL(((h % 1) + 1) % 1, cl(s, 0.3, 1), cl(l, 0.3, 0.86)).getHex();
  const h = hsl.h, s = hsl.s, l = hsl.l;
  return [
    mk(h,        s,            cl(l + 0.06, 0, 0.62)), // the accent, lit a touch
    mk(h + 0.03, s,            cl(l + 0.20, 0, 0.74)), // brighter step
    mk(h,        s * 0.55,     0.82),                   // tinted near-white
    mk(h - 0.03, s,            cl(l - 0.10, 0.34, 1)),  // deeper cut
    mk(h + 0.06, s,            cl(l + 0.12, 0, 0.70)),  // analogous neighbour
  ];
}
let TARGET_COLORS = orbPalette(curTheme.accent);

/* soft radial halo so each orb glows instead of sitting flat on the wall */
function makeHaloTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.28)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const haloTex = makeHaloTexture();

/* ---------------- ball styles ----------------
   Four looks, one hitbox contract: every style is still the unit sphere
   (orbGeo scaled by radius), so tasks, hit detection and PB comparability
   are untouched by cosmetics. */
let ballStyle = localStorage.getItem("aimrange.ball") || "orb";

/* candy: baked swirl texture, cached per color so 6 sixshot targets share 1 tex */
const candyTexCache = new Map();
function candyTexture(colorIdx) {
  if (candyTexCache.has(colorIdx)) return candyTexCache.get(colorIdx);
  const base = new THREE.Color(TARGET_COLORS[colorIdx % TARGET_COLORS.length]);
  const hex = "#" + base.getHexString();
  const tex = canvasTexture(128, 64, (g, w, h) => {
    g.fillStyle = hex;
    g.fillRect(0, 0, w, h);
    // diagonal white swirl — reads as a beach-ball/candy stripe on the sphere
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(-0.5);
    g.fillStyle = "rgba(255,255,255,0.75)";
    for (let i = -6; i < 7; i++) g.fillRect(i * 22 - 5, -h, 10, h * 2);
    g.restore();
    // shade the poles slightly so the stripe doesn't flatten the curvature
    const shade = g.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, "rgba(0,0,0,0.25)");
    shade.addColorStop(0.5, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(0,0,0,0.3)");
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
  }, 1, 1);
  candyTexCache.set(colorIdx, tex);
  return tex;
}

/* Returns { mat, haloOpacity, haloMul } for a style at a given color.
   Glossy-ORB is the measured ball (see knobs comment above) — other styles
   are deliberate variants, not retunings of it. */
function buildBallParts(style, colorIdx, gloss) {
  const color = TARGET_COLORS[colorIdx % TARGET_COLORS.length];
  switch (style) {
    case "plasma": // self-lit: emissive carries the body, halo doubles down
      return {
        mat: new THREE.MeshPhysicalMaterial({
          color, emissive: color, emissiveIntensity: 0.85,
          roughness: 0.35, metalness: 0, clearcoat: 0.4,
          clearcoatRoughness: 0.3, envMapIntensity: 0.9,
        }),
        haloOpacity: 0.7, haloMul: 4.4,
      };
    case "holo": // translucent shell + bright rim — "hologram" read
      return {
        mat: new THREE.MeshPhysicalMaterial({
          color, emissive: color, emissiveIntensity: 0.55,
          roughness: 0.1, metalness: 0, transparent: true, opacity: 0.42,
          clearcoat: 1.0, clearcoatRoughness: 0.1, envMapIntensity: 1.9,
          depthWrite: false,
        }),
        haloOpacity: 0.6, haloMul: 3.8,
      };
    case "candy": // baked swirl map on a glossy-but-tamer physical base
      return {
        mat: new THREE.MeshPhysicalMaterial({
          color: 0xffffff, map: candyTexture(colorIdx),
          emissive: color, emissiveIntensity: 0.1,
          roughness: 0.28, metalness: 0, clearcoat: 0.7,
          clearcoatRoughness: 0.2, envMapIntensity: 1.3,
        }),
        haloOpacity: 0.3, haloMul: 3.0,
      };
    default: // orb — the approved glossy physical ball
      return {
        mat: new THREE.MeshPhysicalMaterial({
          color,
          emissive: color,
          emissiveIntensity: gloss.emissiveIntensity,
          roughness: gloss.roughness,
          metalness: 0.05,
          clearcoat: 1.0,
          clearcoatRoughness: 0.07,
          envMapIntensity: gloss.envMapIntensity,
          sheen: 0.2,
          sheenColor: new THREE.Color(0xffffff),
        }),
        haloOpacity: 0.4, haloMul: 3.2,
      };
  }
}

function makeTargetMesh(radius, colorIdx) {
  /* Glossy physical material: the environment map + ceiling lights give it
     a specular highlight and a light-to-dark falloff, which is what makes a
     sphere read as a BALL rather than a lit circle.

     Depth knobs (measured with /tmp/ball-metric.mjs — terminator =
     lit-vs-shaded quadrant delta):
     - emissive is the ONLY term with no direction, so it adds equally to the
       lit top and the shaded bottom = pure terminator killer. Kept low (0.14)
       and paid back with envMapIntensity instead.
     - envMapIntensity drives the reflection gradient (bright ceiling above,
       dark floor below) — that gradient IS the curvature cue.
     - tighter roughness/clearcoat = smaller, punchier specular dot.
     - sheen low: it glows at grazing angles, which brightens the silhouette
       edge and flattening the outline. */
  const gloss = { emissiveIntensity: 0.14, roughness: 0.17, envMapIntensity: 1.75 };
  const { mat, haloOpacity, haloMul } = buildBallParts(ballStyle, colorIdx, gloss);
  const mesh = new THREE.Mesh(orbGeo, mat);
  mesh.scale.setScalar(radius);
  mesh.castShadow = true;
  mesh.userData.colorIdx = colorIdx; // restyle-on-change needs the color back

  /* additive halo sprite behind the orb — cheap "bloom".
     Kept SMALL (≈1.6× the ball, not 3×): a halo wider than the ball blurs
     its outline, and the outline is what sells the silhouette. */
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTex,
      color: TARGET_COLORS[colorIdx % TARGET_COLORS.length],
      transparent: true,
      opacity: haloOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  halo.scale.setScalar(radius * haloMul); // ball spans ±1 × radius
  halo.position.z = -0.05; // sit slightly behind the sphere center
  mesh.add(halo);

  return mesh;
}

/* swap style on already-spawned targets (settings change mid-task) */
function applyBallStyle() {
  const gloss = { emissiveIntensity: 0.14, roughness: 0.17, envMapIntensity: 1.75 };
  for (const t of targets) {
    const ci = t.mesh.userData.colorIdx ?? 0;
    const { mat, haloOpacity, haloMul } = buildBallParts(ballStyle, ci, gloss);
    const r = t.mesh.scale.x;
    t.mesh.material.dispose();
    t.mesh.material = mat;
    const halo = t.mesh.children.find((c) => c.isSprite);
    if (halo) {
      halo.material.color.set(TARGET_COLORS[ci % TARGET_COLORS.length]);
      halo.material.opacity = haloOpacity;
      halo.scale.setScalar(r * haloMul);
    }
  }
  invalidate();
}

function clearTargets() {
  for (const t of targets) scene.remove(t.mesh);
  if (targets.length) invalidateShadows(); // casters gone → refresh the map
  targets.length = 0;
}

/* spawn positions */
const GRID_COLS = [-5.2, -2.6, 0, 2.6, 5.2];
const GRID_ROWS = [1.4, 3.4, 5.4];
const GRID_Z = -12;

function randomSpawn() {
  return new THREE.Vector3(
    (Math.random() - 0.5) * 16,
    1.2 + Math.random() * 5,
    -8 - Math.random() * 8
  );
}

/* scatter: wider arc than randomSpawn — anywhere across the room's width */
function scatterSpawn() {
  return new THREE.Vector3(
    (Math.random() - 0.5) * 15,
    1.2 + Math.random() * 5.5,
    -7 - Math.random() * 9
  );
}

function farSpawn() {
  return new THREE.Vector3(
    (Math.random() - 0.5) * 12,
    1.5 + Math.random() * 4.5,
    -15 - Math.random() * 2
  );
}

function spawnTarget(task, slotIdx = -1) {
  const mesh = makeTargetMesh(task.radius, Math.floor(Math.random() * TARGET_COLORS.length));
  let pos;
  const vel = new THREE.Vector3();   // initial velocity (slide/strafe/wander)
  let flipAt = 0;                    // strafe: next direction-change time (s)
  const tNow = performance.now() / 1000;

  if (task.spawn === "grid") {
    // pick a free grid slot
    const used = new Set(targets.filter((t) => t.slot >= 0).map((t) => t.slot));
    const free = [];
    for (let i = 0; i < GRID_COLS.length * GRID_ROWS.length; i++) if (!used.has(i)) free.push(i);
    const slot = free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * 15);
    const c = slot % GRID_COLS.length;
    const r = Math.floor(slot / GRID_COLS.length);
    pos = new THREE.Vector3(GRID_COLS[c], GRID_ROWS[r], GRID_Z);
    slotIdx = slot;
  } else if (task.spawn === "far") {
    pos = farSpawn();
  } else if (task.spawn === "scatter") {
    pos = scatterSpawn();
  } else if (task.spawn === "slide") {
    // enter from one side, constant horizontal speed toward the other
    const side = Math.random() < 0.5 ? -1 : 1;
    pos = new THREE.Vector3(side * 9, 1.2 + Math.random() * 5, -8 - Math.random() * 7);
    vel.set(-side * (task.speed || 3.5), 0, 0);
  } else if (task.spawn === "strafe") {
    // fixed depth/height, horizontal only; direction flips on a random timer
    pos = new THREE.Vector3(
      (Math.random() - 0.5) * 10,
      1.5 + Math.random() * 3,
      -10 - Math.random() * 4
    );
    vel.set((Math.random() < 0.5 ? -1 : 1) * 4, 0, 0);
    const flip = task.flip || [0.6, 1.4];
    flipAt = tNow + flip[0] + Math.random() * (flip[1] - flip[0]);
  } else if (task.spawn === "solo") {
    pos = scatterSpawn();
  } else {
    pos = randomSpawn();
  }

  /* don't stack a new orb on another, and never bury one inside a cover
     panel (11.9% of PEEK spawns did — the panel clipped the orb visually
     and ate every bullet aimed at it). Re-roll until both hold. */
  const inCover = (p) => coverBoxes.some((b) =>
    p.x > b.x0 - task.radius && p.x < b.x1 + task.radius &&
    p.z > b.z0 - task.radius && p.z < b.z1 + task.radius &&
    p.y < 4.2 + task.radius); // panel top at y=4.2; above it orbs float free
  for (let tries = 0;
       tries < 16 && (inCover(pos) || targets.some((t) => t.mesh.position.distanceTo(pos) < task.radius * 2.6));
       tries++) {
    pos = task.spawn === "far" ? farSpawn()
        : (task.spawn === "scatter" || task.spawn === "solo") ? scatterSpawn()
        : randomSpawn();
  }

  mesh.position.copy(pos);
  scene.add(mesh);
  invalidateShadows(); // new shadow caster
  sfx("spawn");        // barely-there tick: new target is live

  // lifetime: 0 = immortal; a number = fixed; [min,max] = rolled per spawn
  let life = task.lifetime || 0;
  if (Array.isArray(life)) life = life[0] + Math.random() * (life[1] - life[0]);

  const target = {
    mesh,
    slot: slotIdx,
    born: tNow,
    vel,                            // initial velocity (slide/strafe/wander)
    flipAt,                         // strafe direction-change timer
    life,                           // seconds until it expires unshot
    idx: targets.length,
  };

  if (task.spawn === "wander") {
    target.vel.set(
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 2
    );
  }
  targets.push(target);
  return target;
}

/* ---------------- 3. input: pointer lock, look, shoot ---------------- */

let yaw = 0, pitch = 0;
let sensitivity = parseFloat(localStorage.getItem("aimrange.sens") || "1");
let fov = parseInt(localStorage.getItem("aimrange.fov") || "90", 10);

document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * 0.0022 * sensitivity;
  pitch -= e.movementY * 0.0022 * sensitivity;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
  invalidate(); // camera turned → the frame must be redrawn
});

const raycaster = new THREE.Raycaster();
const centerNDC = new THREE.Vector2(0, 0);

function shootRay() {
  /* apply the current aim before raycasting: with render-on-demand the
     matrices are only refreshed inside render(), so a shot fired between
     frames must catch them up itself (also makes hits frame-exact).
     recoilPitch is included so the ray matches the kicked view exactly —
     you hit what the crosshair is ON, gun-climb and all. */
  camera.rotation.set(pitch + recoilPitch, yaw, 0, "YXZ");
  camera.updateMatrixWorld();
  raycaster.setFromCamera(centerNDC, camera);
  const hits = raycaster.intersectObjects(targets.map((t) => t.mesh), false);
  // cover panels eat bullets: a panel closer than any orb (or with no orb
  // behind it at all) blocks the shot — caller plays a distinct wall thud
  if (coverMeshes.length) {
    const wall = raycaster.intersectObjects(coverMeshes, false);
    if (wall.length && (!hits.length || wall[0].distance < hits[0].distance)) return "cover";
  }
  return hits.length ? hits[0] : null;
}

/* --- per-shot juice: bullet trail + surface hole ---
   The trail runs from the muzzle to wherever the bullet ended: an orb
   absorbs it (no hole), a wall/panel/floor keeps the dent. Reuses the ray
   shootRay() just aimed — no second camera setup. */
function shotFX(hit) {
  /* Anchor the streak ON the aim ray, not on the muzzle. The viewmodel sits
     right-of-centre and low, so a muzzle→impact line cuts a diagonal across
     the crosshair and reads as a bent bullet — the gun "points right" while
     the hole appears straight ahead. Every point on the camera ray projects
     to the same screen pixel, so starting a bit in front of the eye makes
     the streak a straight line running out of the crosshair.0.8 m is past
     the muzzle (the gun never enters the gameplay raycast, so no conflict). */
  const from = raycaster.ray.at(TRAIL_START, new THREE.Vector3());
  let end, holeHit = null;
  if (hit && hit !== "cover") {
    end = hit.point;
  } else {
    const env = raycaster.intersectObjects(
      coverMeshes.length ? [...envMeshes, ...coverMeshes] : envMeshes,
      false
    );
    if (env.length) {
      end = env[0].point;
      holeHit = env[0];
    } else {
      end = raycaster.ray.at(60, new THREE.Vector3()); // open-geometry fallback
    }
  }
  spawnTrail(from, end);
  if (holeHit) spawnHole(holeHit.point, holeHit);
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || state !== "playing") return;
  // freeroam: gun fires for fun, but nothing is counted
  if (currentTask.mode === "free") {
    vm.fire();
    addRecoil();  // camera climbs with the gun (visual only in freeroam)
    sfx("shoot");
    shotFX(shootRay()); // trail + hole still happen — it's the sandbox
    invalidate();
    return;
  }
  if (currentTask.mode !== "click") return;

  shots++; // every trigger pull counts toward accuracy
  vm.fire();       // recoil + slide cycle + muzzle flash
  addRecoil();     // camera kick: same impulse source → gun + view climb together
  sfx("shoot");    // trigger sound (hit/miss layer plays after the raycast)
  invalidate();    // ...which needs a redraw to be seen
  const hit = shootRay();
  shotFX(hit); // bullet trail to the impact, hole if it struck the room
  if (hit && hit !== "cover") {
    const target = targets.find((t) => t.mesh === hit.object);
    onHit(target, hit.point);
  } else if (hit === "cover") {
    // panel ate the bullet: distinct thud so the player learns the layout
    streak = 0;
    sfx("wall");
    showHitmarker(false);
  } else {
    onMiss();
  }
});

// click the canvas while paused/locked states re-requests lock
/* requestPointerLock() returns a promise in modern Chrome and REJECTS if the
   document isn't eligible (e.g. right after exitPointerLock) — always catch it */
function lockPointer() {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* ignore */ }
}

canvas.addEventListener("click", () => {
  if (state === "playing" && document.pointerLockElement !== canvas) {
    lockPointer();
  }
});

/* ---------------- 4. game state ---------------- */

let state = "menu"; // menu | countdown | playing | paused | results
let currentTask = TASKS.gridshot;

let score = 0, shots = 0, hits = 0, streak = 0, bestStreak = 0;
let timeLeft = 60;
let countdownVal = 3;
let lastCountdownTxt = "";   // countdown beep guard (one beep per displayed number)
let reactions = [];          // ms from spawn→hit this round (click tasks)
let lastFrame = performance.now();
let vmPrevYaw = 0, vmPrevPitch = 0; // viewmodel sway: aim as of the previous frame
let stepAccum = 0;                  // distance walked since the last footstep
let walkVelX = 0, walkVelZ = 0;     // walk momentum (inertia between frames)
/* Camera recoil: an ADDITIVE pitch kick layered on top of the player's aim.
   The stored `pitch` never changes, so when the spring settles the crosshair
   lands back exactly where the player left it — recovery, not drift.
   Viewmodel kick and camera kick are impulse-driven from the SAME fire(),
   which is why they now climb together. */
let recoilPitch = 0, recoilVel = 0;
/* FEEL multipliers (0..2 / 0..3), set by the settings sliders below */
let feelInertia = 1, feelCamRecoil = 1;
function addRecoil() { recoilVel += 0.33 * feelCamRecoil; } // 0.33 → ~0.5° peak at 100%
let trackOnTarget = false;

const $ = (id) => document.getElementById(id);

const hud = {
  score: $("hud-score"),
  streak: $("hud-streak"),
  acc: $("hud-acc"),
  kills: $("hud-kills"),
  timer: $("hud-timer"),
  name: $("hud-task-name"),
  fps: $("hud-fps"),
};

/* --- audio: procedural SFX live in audio.js; unlock on first gesture --- */
["pointerdown", "keydown"].forEach((ev) =>
  document.addEventListener(ev, unlockAudio, { once: true, passive: true })
);

/* --- floating score popups (pooled: no DOM churn while you're on a streak) --- */
const popPool = [];
function scorePop(worldPos, text, kill = false) {
  const v = worldPos.clone().project(camera);
  if (v.z > 1) return;
  const el = popPool.pop() || document.createElement("div");
  if (!el.parentNode) document.body.appendChild(el);
  el.style.display = "";
  el.classList.remove("score-pop", "kill");
  void el.offsetWidth; // settle the reset so the animation restarts below
  el.textContent = text;
  el.style.left = ((v.x + 1) / 2) * window.innerWidth + "px";
  el.style.top = ((-v.y + 1) / 2) * window.innerHeight + "px";
  el.classList.add("score-pop");
  if (kill) el.classList.add("kill");
  setTimeout(() => {
    el.classList.remove("score-pop", "kill");
    el.style.display = "none";
    popPool.push(el);
  }, 640); // > 0.6s animation, then back to the pool
}

function showHitmarker(kill) {
  const hm = $("hitmarker");
  hm.classList.remove("show", "kill");
  void hm.offsetWidth; // restart animation
  if (kill) hm.classList.add("kill");
  hm.classList.add("show");
}

/* --- hit burst: flash + sparks at the impact point ---
   Audio alone (even a great one) doesn't sell a hit — the eye needs
   confirmation at the SAME instant. Two parts, each with a job:
   white flash = "contact NOW", sparks = direction + weight. Everything is
   additive-blended so it reads as light on top of the orb color. Sprites are
   POOLED (free list) so a streak of hits allocates nothing and frees nothing
   — no GC pause mid-frame while you're aiming. Lives in `hitBursts`; while
   any is alive we invalidate() every frame, so the effect renders but a
   settled scene still costs 0 renders/s. */
const spritePool = [];
function takeSprite(scale) {
  const s = spritePool.pop() || new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  if (!s.parent) scene.add(s);
  s.visible = true;
  s.scale.setScalar(scale);
  s.material.opacity = 1;
  return s;
}
function restSprite(s) {
  s.visible = false;
  spritePool.push(s);
}

const hitBursts = [];
function spawnHitBurst(pos, colorIdx) {
  const color = new THREE.Color(TARGET_COLORS[colorIdx % TARGET_COLORS.length]);
  const flash = takeSprite(1.4);
  flash.position.copy(pos);
  flash.material.color.set(0xffffff);
  // sparks: short-lived additive sprites flung outward with gravity
  const sparks = [];
  for (let i = 0; i < 9; i++) {
    const s = takeSprite(0.16);
    s.position.copy(pos);
    s.material.color.copy(color);
    const a = Math.random() * Math.PI * 2, up = Math.random() * 0.9;
    sparks.push({
      s,
      vx: Math.cos(a) * (2.5 + Math.random() * 3.5),
      vy: up * 5 + 1.5,
      vz: Math.sin(a) * (2.5 + Math.random() * 3.5),
    });
  }
  hitBursts.push({ flash, sparks, t: 0, life: 0.45 });
}

function updateHitBursts(dt) {
  if (!hitBursts.length) return;
  for (let i = hitBursts.length - 1; i >= 0; i--) {
    const b = hitBursts[i];
    b.t += dt;
    const u = b.t / b.life; // 0→1
    if (u >= 1) {
      // done: return the pooled sprites instead of disposing them
      restSprite(b.flash);
      for (const k of b.sparks) restSprite(k.s);
      hitBursts.splice(i, 1);
      continue;
    }
    // flash: brief bright core, gone by 40% of life
    b.flash.scale.setScalar(1.4 * (1 + u * 1.6));
    b.flash.material.opacity = Math.max(0, 1 - u * 2.6);
    // sparks: ballistic — integrate velocity, pull down with gravity
    for (const k of b.sparks) {
      k.vy -= 14 * dt;
      k.s.position.x += k.vx * dt;
      k.s.position.y += k.vy * dt;
      k.s.position.z += k.vz * dt;
      k.s.material.opacity = Math.max(0, 1 - u * 1.15);
      k.s.scale.setScalar(0.16 * (1 - u * 0.7));
    }
  }
  invalidate(); // something is animating → must redraw this frame
}

/* --- bullet trail: a short additive streak, crosshair → impact ---
   Hitscan has no projectile, so the trail IS the bullet's path: the head
   races out at ~50 ms, the tail chases it off ~40 ms later, and the whole
   streak is gone by ~110 ms — long enough to read, short enough to never
   clutter a flick. Pooled (TRAIL_N), one stretched box each — boxy like the
   gun, zero allocation per shot.

   The START point is ON the aim ray (TRAIL_START metres in front of the
   eye), NOT the muzzle: the viewmodel sits right-of-centre, so a
   muzzle→impact line cuts a diagonal across the crosshair and reads as a
   bent bullet. Every point on the camera ray projects to the same screen
   pixel, so anchoring on it makes the streak a straight line running out of
   the crosshair. 0.8 m is past the muzzle, and the gun never enters the
   gameplay raycast, so the two can't conflict. */
const TRAIL_START = 0.8;
const TRAIL_N = 8;
const trailGeo = new THREE.BoxGeometry(1, 1, 1);
const trails = [];
for (let i = 0; i < TRAIL_N; i++) {
  const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  m.visible = false;
  scene.add(m);
  trails.push({ m, a: new THREE.Vector3(), b: new THREE.Vector3(), t: 0, life: 0.11, on: false });
}
let trailIdx = 0;
function spawnTrail(from, to) {
  const tr = trails[trailIdx];
  trailIdx = (trailIdx + 1) % TRAIL_N; // round-robin: oldest streak recycled
  tr.a.copy(from);
  tr.b.copy(to);
  tr.t = 0;
  tr.on = true;
  tr.m.visible = true;
  invalidate(); // first frame of the streak must draw
}
const _tr0 = new THREE.Vector3(), _tr1 = new THREE.Vector3(),
      _trd = new THREE.Vector3(), _trz = new THREE.Vector3(0, 0, 1);
function updateTrails(dt) {
  let anim = false;
  for (const tr of trails) {
    if (!tr.on) continue;
    tr.t += dt;
    if (tr.t >= tr.life) {
      tr.on = false;
      tr.m.visible = false;
      continue;
    }
    const head = Math.min(1, tr.t / 0.05);            // muzzle → impact
    const tail = Math.max(0, Math.min(1, (tr.t - 0.04) / 0.06)); // trailing off
    _tr0.lerpVectors(tr.a, tr.b, tail);
    _tr1.lerpVectors(tr.a, tr.b, head);
    const len = _tr0.distanceTo(_tr1);
    tr.m.position.lerpVectors(_tr0, _tr1, 0.5);
    _trd.subVectors(_tr1, _tr0);
    if (_trd.lengthSq() < 1e-10) _trd.set(0, 0, 1);
    else _trd.normalize();
    tr.m.quaternion.setFromUnitVectors(_trz, _trd);
    const u = tr.t / tr.life;
    tr.m.scale.set(0.024, 0.024, Math.max(len, 1e-4));
    tr.m.material.opacity = u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45;
    anim = true;
  }
  if (anim) invalidate();
}

/* --- bullet holes: one InstancedMesh, 48 slots, round-robin ---
   Walls/floor/panels keep the dent; orbs absorb the shot (no hole). Dark
   neutral scorch reads correctly on all four themes, so no retint hook is
   needed. Static once placed → placement costs one invalidate(), then zero.
   count starts at 0 so identity matrices never render at the origin. */
const HOLE_N = 48;
const holeTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, "rgba(0,0,0,0.97)");    // pit
  rg.addColorStop(0.42, "rgba(0,0,0,0.92)");
  rg.addColorStop(0.58, "rgba(165,180,195,0.68)"); // light chip rim — reads on dark floors/walls
  rg.addColorStop(0.75, "rgba(120,135,150,0.3)");
  rg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const holeMesh = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    map: holeTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }),
  HOLE_N
);
holeMesh.frustumCulled = false; // instances scattered over the whole room
holeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
holeMesh.count = 0;
scene.add(holeMesh);
/* Dents are permanent only for a while: after HOLE_TTL seconds the hole
   shrinks away over HOLE_FADE and frees its slot, so a long FREEROAM spray
   doesn't pockmark the room forever (the 48-slot pool still recycles the
   oldest dent first). updateHoles() runs every frame but only invalidates
   while something is actually fading or dying — a settled room still costs
   0 renders/s. */
const HOLE_TTL = 9;      // seconds a dent stays at full size
const HOLE_FADE = 0.55;  // seconds to shrink away after that
const holes = [];        // { p, q, s, age, fade? }
const _hm = new THREE.Matrix4(), _hq = new THREE.Quaternion(),
      _hq2 = new THREE.Quaternion(), _hp = new THREE.Vector3(),
      _hn = new THREE.Vector3(), _hs = new THREE.Vector3();
function writeHoles() {
  holeMesh.count = holes.length;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const k = h.s * (h.fade === undefined ? 1 : h.fade);
    _hs.set(k, k, 1);
    _hm.compose(h.p, h.q, _hs);
    holeMesh.setMatrixAt(i, _hm);
  }
  holeMesh.instanceMatrix.needsUpdate = true;
}
function spawnHole(point, hitInfo) {
  _hn.copy(hitInfo.face.normal).transformDirection(hitInfo.object.matrixWorld);
  _hq.setFromUnitVectors(_trz, _hn);
  _hq2.setFromAxisAngle(_trz, Math.random() * Math.PI * 2); // random roll
  _hq.multiply(_hq2);
  _hp.copy(point).addScaledVector(_hn, 0.012); // clear the surface: no z-fight
  const h = { p: _hp.clone(), q: _hq.clone(), s: 0.15 + Math.random() * 0.05, age: 0 };
  if (holes.length < HOLE_N) holes.push(h);
  else {
    let old = 0; // pool full → recycle the oldest dent
    for (let i = 1; i < holes.length; i++) if (holes[i].age > holes[old].age) old = i;
    holes[old] = h;
  }
  writeHoles();
  invalidate();
}
function updateHoles(dt) {
  if (!holes.length) return;
  let dirty = false;
  for (let i = holes.length - 1; i >= 0; i--) {
    const h = holes[i];
    h.age += dt;
    if (h.age <= HOLE_TTL) continue;
    const u = (h.age - HOLE_TTL) / HOLE_FADE;
    if (u >= 1) { holes.splice(i, 1); dirty = true; continue; }
    const fade = 1 - u;
    if (h.fade !== fade) { h.fade = fade; dirty = true; }
  }
  if (dirty) { writeHoles(); invalidate(); }
}
function clearHoles() {
  holes.length = 0;
  holeMesh.count = 0;
  holeMesh.instanceMatrix.needsUpdate = true;
}

/* --- hit / miss --- */
function onHit(target, point) {
  if (!target) return;
  hits++;
  streak++;
  bestStreak = Math.max(bestStreak, streak);

  // streak multiplier: +10% per 5-streak, capped at 2×
  const mult = Math.min(2, 1 + Math.floor(streak / 5) * 0.1);
  const gained = Math.round(currentTask.points * mult);
  score += gained;
  reactions.push((performance.now() / 1000 - target.born) * 1000); // spawn→hit, ms

  sfx("hit", { streak });
  showHitmarker(true);
  scorePop(point, `+${gained}`);
  spawnHitBurst(point, target.idx); // impact flash + sparks

  // remove and respawn (grid/flick keep the count topped up)
  scene.remove(target.mesh);
  targets.splice(targets.indexOf(target), 1);
  invalidateShadows(); // caster gone

  if (state === "playing") {
    while (targets.length < currentTask.targets) spawnTarget(currentTask);
  }
}

function onMiss() {
  streak = 0;
  sfx("miss");
  showHitmarker(false);
}

/* --- start / stop / pause --- */
function startTask(key) {
  currentTask = TASKS[key];
  score = 0; shots = 0; hits = 0; streak = 0; bestStreak = 0;
  timeLeft = currentTask.duration;
  countdownVal = 3;
  lastCountdownTxt = "";   // fresh countdown → the "3" beep fires again
  reactions = [];
  trackOnTarget = false;

  clearTargets();
  if (currentTask.cover) buildCover(); else clearCover();
  clearHoles(); // fresh round = unmarked room
  for (let i = 0; i < currentTask.targets; i++) spawnTarget(currentTask);

  yaw = 0; pitch = 0;
  camera.position.set(0, 1.6, 8); // walk tasks move the camera — reset every round
  vm.setVisible(true); // gun comes up for a round
  invalidate(); // camera snapped to spawn view

  $("menu").classList.add("hidden");
  $("results").classList.add("hidden");
  $("pause").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("crosshair").classList.remove("hidden");
  hud.name.textContent = currentTask.name + " — " + currentTask.tag +
    (currentTask.walk ? " — WASD TO MOVE" : ""); // walk tasks advertise movement
  updateHUD();

  state = "countdown";
  $("countdown").classList.remove("hidden");
  $("countdown").textContent = "3";
  lockPointer();
}

function endTask() {
  state = "results";
  document.exitPointerLock();
  clearTargets();
  clearCover(); // panels are per-task scenery
  clearHoles();

  $("hud").classList.add("hidden");
  $("crosshair").classList.add("hidden");
  $("countdown").classList.add("hidden");

  const acc = shots > 0 ? Math.round((hits / shots) * 100) : (currentTask.mode === "track" ? Math.round(trackPct() * 100) : 0);
  const kps = hits / (currentTask.duration || 60); // targets per second
  const avgReact = reactions.length
    ? Math.round(reactions.reduce((a, b) => a + b, 0) / reactions.length)
    : 0;

  const key = Object.keys(TASKS).find((k) => TASKS[k] === currentTask);
  const prevBest = Math.max(
    parseInt(localStorage.getItem("aimrange.best." + key) || "0", 10),
    getSummary(key).best // history counts too — legacy best is only a fallback
  );
  const isBest = score > prevBest;
  if (isBest) localStorage.setItem("aimrange.best." + key, String(score));

  // grade BEFORE recording this run (gradeFor compares against prior best;
  // a brand-new PB would trivially grade S against itself if recorded first)
  const grade = gradeFor(key, score);
  recordRun({
    task: key, score, acc, hits, shots, bestStreak,
    avgReaction: avgReact, kps: Math.round(kps * 10) / 10,
    ts: Date.now(), grade: grade.letter,
  });

  $("res-title").textContent = currentTask.name + " RESULTS";
  $("res-score").textContent = score.toLocaleString();
  $("res-acc").textContent = acc + "%";
  $("res-kills").textContent = hits;
  $("res-streak").textContent = bestStreak;
  $("res-kpm").textContent = kps.toFixed(1);
  $("res-react").textContent = avgReact ? avgReact + " ms" : "—";
  $("res-grade").textContent = grade.letter;
  $("res-grade").className = "big grade g-" + grade.letter; // CSS paints the colour
  $("res-best").textContent = Math.max(score, prevBest).toLocaleString();
  $("res-newbest").classList.toggle("hidden", !isBest);
  $("res-pbchase").textContent = isBest ? "" : (prevBest - score).toLocaleString() + " PTS TO YOUR PB";

  sfx(isBest ? "pb" : "end");
  $("results").classList.remove("hidden");
  buildTaskCards(); // refresh PERSONAL BEST lines behind the overlay
  vm.setVisible(false);
  invalidate(); // gun vanished → redraw the frame behind the overlay
}

function pauseGame() {
  if (state !== "playing" && state !== "countdown") return;
  state = "paused";
  $("pause").classList.remove("hidden");
  invalidate(); // one fresh frame behind the overlay
}

function resumeGame() {
  if (state !== "paused") return;
  state = "playing";
  $("pause").classList.add("hidden");
  invalidate();
  lockPointer();
}

function toMenu() {
  state = "menu";
  document.exitPointerLock();
  // walk tasks move the camera — put it back so the menu backdrop doesn't
  // render from wherever the player happened to stand
  camera.position.set(0, 1.6, 8);
  yaw = 0; pitch = 0;
  clearTargets();
  clearCover();
  clearHoles();
  vm.setVisible(false);
  $("hud").classList.add("hidden");
  $("crosshair").classList.add("hidden");
  $("countdown").classList.add("hidden");
  $("pause").classList.add("hidden");
  $("results").classList.add("hidden");
  $("menu").classList.remove("hidden");
  buildTaskCards();
}

/* ESC exits pointer lock → treat as pause */
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== canvas && (state === "playing" || state === "countdown")) {
    pauseGame();
  }
});

/* ---------------- 5. per-frame update ---------------- */

let trackSeconds = 0; // seconds with crosshair on target (tracking task)
let trackPct = () => hits / Math.max(1, currentTask.duration); // placeholder, overwritten below

function updateTargets(dt, now) {
  const task = currentTask;

  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];

    // lifetime (reflex/spawntarget): vanish after a moment
    if (t.life > 0 && now - t.born > t.life) {
      scene.remove(t.mesh);
      targets.splice(i, 1);
      invalidateShadows(); // caster gone
      streak = 0;
      sfx("miss");
      if (state === "playing") while (targets.length < task.targets) spawnTarget(task);
      continue;
    }

    // wandering orbs (tracking)
    if (task.spawn === "wander") {
      const p = t.mesh.position;
      p.addScaledVector(t.vel, dt);
      if (p.x < -8 || p.x > 8) t.vel.x *= -1;
      if (p.y < 1 || p.y > 7) t.vel.y *= -1;
      if (p.z < -16 || p.z > -6) t.vel.z *= -1;
      p.x = Math.max(-8, Math.min(8, p.x));
      p.y = Math.max(1, Math.min(7, p.y));
      p.z = Math.max(-16, Math.min(-6, p.z));

      // gentle pulse so it feels alive
      const s = task.radius * (1 + Math.sin(now * 6) * 0.05);
      t.mesh.scale.setScalar(s);
      invalidateShadows(); // orb (and its shadow) moved this frame
    }

    // sliding orbs (motionshot): constant horizontal speed, wraps at the walls
    if (task.spawn === "slide") {
      const p = t.mesh.position;
      p.addScaledVector(t.vel, dt);
      if (p.x < -9) p.x = 9;   // exited left → re-enter right (and vice versa)
      if (p.x > 9) p.x = -9;
      invalidateShadows(); // caster moved
    }

    // strafing bot (strafetrack): A/D flips on a randomized timer
    if (task.spawn === "strafe") {
      if (now >= t.flipAt) {
        const flip = task.flip || [0.6, 1.4];
        t.flipAt = now + flip[0] + Math.random() * (flip[1] - flip[0]);
        t.vel.x = (Math.random() < 0.5 ? -1 : 1) * 4; // new direction ±4 u/s
      }
      const p = t.mesh.position;
      p.addScaledVector(t.vel, dt);
      if (p.x < -7.5 || p.x > 7.5) t.vel.x *= -1; // bounce off the side walls
      p.x = Math.max(-7.5, Math.min(7.5, p.x));
      invalidateShadows(); // caster moved
    }

    // lifetime "charging" glow for reflex orbs
    if (t.life > 0) {
      const left = 1 - (now - t.born) / t.life;
      t.mesh.material.emissiveIntensity = 0.4 + left * 0.6;
      invalidate(); // visible glow change (emissive casts no shadow)
    }
  }
}

function updateTracking(dt) {
  // continuous scoring while crosshair overlaps the orb
  const hit = shootRay();
  const onIt = !!hit;
  if (onIt !== trackOnTarget) {
    trackOnTarget = onIt;
    showHitmarker(onIt);
    if (onIt) sfx("ui");
  }
  if (onIt) {
    trackSeconds += dt;
    const gained = Math.round(60 * dt); // 60 pts/sec
    score += gained;
    // spawn a pop occasionally rather than every frame
    if (Math.random() < dt * 4) scorePop(hit.point, "+" + gained);
  }
}

/* last value written to each HUD node — assigning textContent tears down and
   rebuilds the text node (layout + paint), so identical values are skipped */
const hudPrev = {};
function updateHUD() {
  if (score !== hudPrev.score) { hudPrev.score = score; hud.score.textContent = score.toLocaleString(); }
  if (streak !== hudPrev.streak) { hudPrev.streak = streak; hud.streak.textContent = streak; }
  if (hits !== hudPrev.hits) { hudPrev.hits = hits; hud.kills.textContent = hits; }
  const acc = shots > 0 ? Math.round((hits / shots) * 100) + "%" : "—";
  if (acc !== hudPrev.acc) { hudPrev.acc = acc; hud.acc.textContent = acc; }
  // freeroam counts DOWN from 0 (timeLeft negative) → show elapsed instead
  const t = currentTask.duration > 0
    ? Math.max(0, timeLeft).toFixed(1)
    : (-timeLeft).toFixed(1);
  if (t !== hudPrev.timer) { hudPrev.timer = t; hud.timer.textContent = t; }
  const low = currentTask.duration > 0 && timeLeft <= 10;
  if (low !== hudPrev.low) { hudPrev.low = low; hud.timer.classList.toggle("low", low); }
}

/* trackPct used by results: fraction of time on target */
trackPct = () => trackSeconds / currentTask.duration;

let fpsValue = 0, renderCount = 0, fpsCheckedAt = performance.now();
const FRAME_MS = 1000 / 60; // 60 fps cap
let nextFrameAt = 0;

/* last-rendered camera state, compared each frame by the signature check */
const rd = { yaw: NaN, pitch: NaN, fov: NaN, px: NaN, py: NaN, pz: NaN };

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05); // clamp big tab-switch gaps
  lastFrame = now;

  // camera from yaw/pitch (+ live recoil kick)
  /* recoil spring: underdamped (ω²≈160, ζ≈0.6) → quick rise, one soft
     settle-back. Same integration style as the viewmodel spring so the
     camera and gun kick in lockstep. When idle both terms are exactly 0
     and the camera math costs one addition. */
  if (recoilPitch !== 0 || recoilVel !== 0) {
    recoilVel += (-160 * recoilPitch - 16 * recoilVel) * dt;
    recoilPitch += recoilVel * dt;
    if (Math.abs(recoilPitch) < 0.0005 && Math.abs(recoilVel) < 0.01) {
      recoilPitch = 0; recoilVel = 0; // fully recovered
    } else {
      invalidate(); // view is moving → redraw
    }
  }
  camera.rotation.set(pitch + recoilPitch, yaw, 0, "YXZ");

  /* ---- WASD (walk tasks only) ----
     forward = rotate (0,0,-1) by yaw → (-sin, -cos); right = (cos, -sin).
     Axis-separated movement: each axis is applied and reverted on its own,
     so you SLIDE along cover panels and walls instead of sticking.

     Momentum: walkVel keeps state between frames and exponentially chases
     the wish direction (fast ramp in, slower ramp out) — this is what gives
     movement a bit of 惯性: you lean into starts and coast to a stop instead
     of snapping between 0 and full speed. Exponential approach (1-e^(-k·dt))
     is framerate-independent, so the feel is identical at 30 or 144 fps. */
  let walkSpeed = 0;
  if (state === "playing" && currentTask.walk) {
    const fwd = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
    const str = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
    const SPEED = 6.5, R = 0.45;
    const len = Math.hypot(fwd, str) || 1;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const moving = fwd || str;
    // wish velocity in world space (unit dir × speed)
    const wishX = moving ? ((-sy * fwd + cy * str) / len) * SPEED : 0;
    const wishZ = moving ? ((-cy * fwd - sy * str) / len) * SPEED : 0;
    // asymmetric smoothing: accelerate briskly, decelerate a touch slower
    // (τ ≈ 0.10 s in, ≈ 0.16 s out) so stopping coasts instead of freezing
    // FEEL/INERTIA scales both time constants: 0% ⇒ τ=0 (instant, legacy feel),
    // 100% ⇒ the tuned 0.10/0.16, 200% ⇒ heavy ice-skating drift
    const tau = (moving ? 0.10 : 0.16) * feelInertia;
    const k = 1 - Math.exp(-dt / tau);
    walkVelX += (wishX - walkVelX) * k;
    walkVelZ += (wishZ - walkVelZ) * k;
    if (Math.abs(walkVelX) < 0.01) walkVelX = 0; // don't crawl forever
    if (Math.abs(walkVelZ) < 0.01) walkVelZ = 0;

    if (walkVelX || walkVelZ) {
      const dx = walkVelX * dt;
      const dz = walkVelZ * dt;
      const clampX = (v) => Math.max(-13.2, Math.min(13.2, v));
      const clampZ = (v) => Math.max(-17.2, Math.min(9.2, v)); // back wall -18, front edge ~10
      const nx = clampX(camera.position.x + dx);
      if (!hitsCover(nx, camera.position.z, R)) camera.position.x = nx;
      const nz = clampZ(camera.position.z + dz);
      if (!hitsCover(camera.position.x, nz, R)) camera.position.z = nz;

      /* footsteps: fire every ~0.55 m of REAL movement (distance-based, so
         pace follows speed and blocked axes don't produce phantom steps) */
      stepAccum += Math.hypot(dx, dz);
      if (stepAccum >= 0.55) { stepAccum = 0; sfx("step"); }
    }
    walkSpeed = Math.hypot(walkVelX, walkVelZ); // < SPEED while ramping
  } else {
    walkVelX = walkVelZ = 0; // pause / leaving walk task: no stored launch
  }

  /* viewmodel: recoil/slide springs, sway lag against aim delta, head bob.
     The delta is yaw vs the PREVIOUS FRAME's value (capturing it at the top
     of this frame would always give 0). Returns true while it is still
     moving — only then force redraws, so a settled gun costs nothing
     (idle stays 0 renders/s). */
  const vmAnim = vm.update(dt, {
    dYaw: yaw - vmPrevYaw,
    dPitch: pitch - vmPrevPitch,
    walking: walkSpeed > 0,
    speed: walkSpeed,
  });
  vmPrevYaw = yaw;
  vmPrevPitch = pitch;
  if (vmAnim) invalidate();
  updateHitBursts(dt); // hit effects animate → invalidate internally
  updateTrails(dt);    // bullet streaks likewise
  updateHoles(dt);     // dents age out on their own → only invalidates when one is fading

  if (state === "countdown") {
    countdownVal -= dt;
    const el = $("countdown");
    const n = Math.ceil(countdownVal);
    const txt = n > 0 ? n : "GO!";
    el.textContent = txt;
    // one-shot beeps: fire only when the displayed number CHANGES
    // (firing per-frame would stack ~30 tones over the 0.5s GO window)
    if (txt !== lastCountdownTxt) {
      lastCountdownTxt = txt;
      sfx(n > 0 ? "countdown" : "go");
    }
    if (countdownVal <= -0.5) {
      el.classList.add("hidden");
      state = "playing";
      // reaction/lifetime clocks start at GO — orbs sit visible during the
      // 3-2-1, so without this every reflex orb would expire on frame 1
      const t0 = performance.now() / 1000;
      for (const t of targets) t.born = t0;
    }
  } else if (state === "playing") {
    timeLeft -= dt;
    // duration 0 (FREEROAM) counts up forever — only quit ends it
    if (currentTask.duration > 0 && timeLeft <= 0) {
      timeLeft = 0;
      updateHUD();
      endTask();
    } else {
      updateTargets(dt, now / 1000);
      if (currentTask.mode === "track") updateTracking(dt);
      updateHUD();
    }
  } else if (state === "menu") {
    // slow idle camera drift behind the menu; only while the window has
    // focus — an unfocused window would burn GPU for nobody watching
    if (document.hasFocus()) {
      yaw += dt * 0.08;
      invalidate(); // drifting camera → always a fresh frame
    }
  }

  /* camera signature: catches EVERY path that can change the view (input
     handler, fov slider, debug setters) without trusting each caller */
  if (yaw !== rd.yaw || pitch !== rd.pitch || camera.fov !== rd.fov ||
      camera.position.x !== rd.px || camera.position.y !== rd.py ||
      camera.position.z !== rd.pz) sceneDirty = true;

  /* redraw only when something visible actually changed (a paused/idle/
     static-orb frame costs nothing), and at most 60×/s — on 120Hz screens
     we draw every other frame: half the GPU, identical image quality.
     The 3ms tolerance keeps a jittery 60Hz display from dropping to 30. */
  if (sceneDirty && now >= nextFrameAt - 3) {
    renderer.render(scene, camera);
    sceneDirty = false;
    nextFrameAt = now + FRAME_MS;
    renderCount++;
    rd.yaw = yaw; rd.pitch = pitch; rd.fov = camera.fov;
    rd.px = camera.position.x; rd.py = camera.position.y; rd.pz = camera.position.z;
  }

  /* fps meter = frames we actually draw, refreshed twice a second; when
     nothing is being drawn the last reading stays (idle ≠ broken) */
  if (now - fpsCheckedAt >= 500) {
    if (renderCount > 0) {
      fpsValue = Math.round(renderCount / ((now - fpsCheckedAt) / 1000));
      const txt = fpsValue + " fps";
      if (txt !== hudPrev.fps) { hudPrev.fps = txt; hud.fps.textContent = txt; }
    }
    renderCount = 0;
    fpsCheckedAt = now;
  }
}

/* ---------------- 6. DOM wiring ---------------- */

function bestFor(key) {
  return parseInt(localStorage.getItem("aimrange.best." + key) || "0", 10).toLocaleString();
}

function buildTaskCards() {
  const grid = $("task-grid");
  grid.innerHTML = "";
  for (const [key, t] of Object.entries(TASKS)) {
    const card = document.createElement("div");
    card.className = "task-card";
    card.dataset.task = key; // lets tests/targeted UI find a specific task
    card.innerHTML = `
      <span class="tag">${t.tag}</span>
      <h3>${t.name}</h3>
      <p>${t.desc}</p>
      <div class="best">PERSONAL BEST &nbsp;<b>${bestFor(key)}</b></div>`;
    card.addEventListener("click", () => startTask(key));
    grid.appendChild(card);
  }
}

$("btn-resume").addEventListener("click", resumeGame);
$("btn-restart").addEventListener("click", () => startTask(Object.keys(TASKS).find((k) => TASKS[k] === currentTask)));
$("btn-quit").addEventListener("click", toMenu);
$("btn-again").addEventListener("click", () => startTask(Object.keys(TASKS).find((k) => TASKS[k] === currentTask)));
$("btn-menu").addEventListener("click", toMenu);

// sliders
const sensEl = $("sens"), sensVal = $("sens-val");
sensEl.value = sensitivity;
sensVal.textContent = sensitivity.toFixed(2);
sensEl.addEventListener("input", () => {
  sensitivity = parseFloat(sensEl.value);
  sensVal.textContent = sensitivity.toFixed(2);
  localStorage.setItem("aimrange.sens", String(sensitivity));
});

const fovEl = $("fov"), fovVal = $("fov-val");
fovEl.value = fov;
fovVal.textContent = fov;
fovEl.addEventListener("input", () => {
  fov = parseInt(fovEl.value, 10);
  fovVal.textContent = fov;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  invalidate(); // projection changed
  localStorage.setItem("aimrange.fov", String(fov));
});
camera.fov = fov;
camera.updateProjectionMatrix();

// keyboard: R restarts from results, Esc handled by pointer lock
const keys = new Set(); // held keys — populated for WASD movement
document.addEventListener("keydown", (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key === "r" && state === "results") {
    startTask(Object.keys(TASKS).find((k) => TASKS[k] === currentTask));
  }
  /* ESC: pause directly. The pointer-lock path (pointerlockchange) covers the
     normal case, but if lock was never granted — headless, denied prompt,
     or a paused-then-resumed race — that event never fires, leaving no way
     out. pauseGame() is idempotent, so double-firing is harmless. */
  if (e.key === "Escape" && (state === "playing" || state === "countdown")) {
    pauseGame();
  }
});
document.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear()); // alt-tab must not leave keys stuck

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  invalidateShadows(); // buffer rebuild + fresh frame
});

/* ---------------- 6b. settings: crosshair / sound / resolution ---------------- */

const crossEl = $("crosshair");
/* declared here (not with the rest of the crosshair settings below) because
   applyTheme() runs once at boot, BEFORE section 6c builds the swatch */
let chColorEl = null;
/* true once the player has picked a colour (saved or in this session) —
   while false the crosshair is theme-driven */
let chColorPinned = !!localStorage.getItem("aimrange.ch.color");

/* ---------------- themes: apply ----------------
   Everything created at boot is already tinted by `curTheme` above; this
   syncs the live scene (lights, materials, env, HUD) when the user switches.
   Colors only — no shadow-map work needed (positions unchanged), so one
   invalidate() is the whole cost. */
function applyTheme(name) {
  const t = THEMES[name];
  if (!t || t === curTheme) return; // null curTheme = force boot sync
  themeName = name;
  curTheme = t;
  localStorage.setItem("aimrange.theme", name);

  scene.background.set(t.bg);
  scene.fog.color.set(t.bg);
  hemi.color.set(t.hemiSky);
  hemi.groundColor.set(t.hemiGround);
  key.color.set(t.key);
  for (const s of spots) s.color.set(t.spot);

  for (const m of wallMats) m.emissive.set(t.glow);
  baseboardMat.emissive.set(t.baseboard);
  fixtureMat.emissive.set(t.fixture);
  /* surface tint: multiplies the baked blue maps, so themes shift the room's
     hue without redrawing a single texture (neon tint = white = no-op) */
  const tint = new THREE.Color(t.tint);
  floor.material.color.copy(tint);
  ceil.material.color.set(0x11172b).multiply(tint);
  pillarMat.color.set(0x32406a).multiply(tint);
  if (coverAccentMat) coverAccentMat.color.set(t.accent);

  setViewmodelAccent(t.accent);
  rebuildEnv(); // accent band in reflections follows the theme

  /* orbs follow the theme too: rebuild the palette, drop the baked candy
     textures (painted with the OLD accent) and restyle whatever is on screen
     right now — otherwise targets keep the previous theme's colours. */
  TARGET_COLORS = orbPalette(t.accent);
  candyTexCache.clear();
  if (targets.length) applyBallStyle();

  const root = document.documentElement.style;
  root.setProperty("--accent", t.accent);
  root.setProperty("--accent-dim", t.accentDim);
  /* auto crosshair: while no colour is pinned, the swatch mirrors the new
     accent (#crosshair itself follows var(--accent) through CSS) */
  if (!chColorPinned && chColorEl) chColorEl.value = t.accent;
  invalidate();
}

const themeEl = $("theme-style");
themeEl.value = themeName;
themeEl.addEventListener("change", () => {
  applyTheme(themeEl.value);
  sfx("ui");
});
/* boot: materials were created with curTheme already, but lights/HUD/env
   still need the non-default sync. Null-out defeats the same-theme guard. */
if (themeName !== "neon") { curTheme = null; applyTheme(themeName); }

const ballEl = $("ball-style");
ballEl.value = ballStyle;
ballEl.addEventListener("change", () => {
  ballStyle = ballEl.value;
  localStorage.setItem("aimrange.ball", ballStyle);
  applyBallStyle(); // live targets restyle immediately
  sfx("ui");
});

const chStyleEl = $("ch-style");
chStyleEl.value = localStorage.getItem("aimrange.ch.style") || "cross";
crossEl.dataset.style = chStyleEl.value;
chStyleEl.addEventListener("change", () => {
  crossEl.dataset.style = chStyleEl.value;
  localStorage.setItem("aimrange.ch.style", chStyleEl.value);
  sfx("ui");
});

const chSizeEl = $("ch-size"), chSizeVal = $("ch-size-val");
/* --ch-size is registered as <length>: ALWAYS send "24px", never "24" —
   a unitless value silently falls back to the 18px default and the slider
   looks dead */
const chSizeInit = parseInt(localStorage.getItem("aimrange.ch.size") || "18", 10);
chSizeEl.value = chSizeInit;
crossEl.style.setProperty("--ch-size", chSizeInit + "px");
chSizeVal.textContent = chSizeInit;
chSizeEl.addEventListener("input", () => {
  const v = parseInt(chSizeEl.value, 10);
  crossEl.style.setProperty("--ch-size", v + "px");
  chSizeVal.textContent = v;
  localStorage.setItem("aimrange.ch.size", String(v));
});

/* Crosshair colour follows the THEME accent until the player picks their own.
   Pinning an inline --ch-color at boot (what this did before) froze the
   crosshair at neon cyan, so it clashed with every other theme. With nothing
   pinned, #crosshair's CSS `--ch-color: var(--accent)` tracks the theme for
   free; the swatch only mirrors the live accent for display. */
chColorEl = $("ch-color");
if (chColorPinned) {
  chColorEl.value = localStorage.getItem("aimrange.ch.color");
  crossEl.style.setProperty("--ch-color", chColorEl.value);
} else {
  chColorEl.value = curTheme.accent;
}
chColorEl.addEventListener("input", () => {
  chColorPinned = true;
  crossEl.style.setProperty("--ch-color", chColorEl.value);
  localStorage.setItem("aimrange.ch.color", chColorEl.value);
});
const volEl = $("sfx-vol"), volVal = $("sfx-vol-val"), muteEl = $("sfx-mute");
volEl.value = Math.round(getVolume() * 100);
volVal.textContent = volEl.value;
muteEl.checked = isMuted();
volEl.addEventListener("input", () => {
  setVolume(parseInt(volEl.value, 10) / 100);
  volVal.textContent = volEl.value;
});
muteEl.addEventListener("change", () => setMuted(muteEl.checked));

const scaleEl = $("res-scale"), scaleVal = $("res-scale-val");
const maxPR = Math.min(dpr, 1.5); // the cap set at renderer creation
function applyResScale(pct) {
  // linear scale on the pixel ratio → area scales with the SQUARE
  // (100→50% ⇒ 100→25% of the pixels), so this is the strongest GPU dial
  renderer.setPixelRatio((pct / 100) * maxPR);
  renderer.setSize(window.innerWidth, window.innerHeight);
  invalidateShadows(); // buffer rebuild + fresh frame
}
const scaleInit = parseInt(localStorage.getItem("aimrange.resscale") || "100", 10);
scaleEl.value = scaleInit;
scaleVal.textContent = scaleInit + "%";
if (scaleInit !== 100) applyResScale(scaleInit);
scaleEl.addEventListener("input", () => {
  const pct = parseInt(scaleEl.value, 10);
  scaleVal.textContent = pct + "%";
  applyResScale(pct);
  localStorage.setItem("aimrange.resscale", String(pct));
});

/* ---- FEEL: player-tunable game feel (all persist to localStorage) ----
   Three independent dials because they read as different things to a player:
   INERTIA   = how the BODY moves  (exponential smoothing time constants)
   CAM RECOIL= how the VIEW kicks  (camera spring impulse)
   GUN KICK  = how the GUN kicks   (viewmodel spring impulse, visual only)
   100% = the tuned default for each. */
function bindFeel(id, apply) {
  const el = $(id), val = $(id + "-val");
  const init = parseInt(localStorage.getItem("aimrange.feel." + id) || "100", 10);
  el.value = init;
  val.textContent = init + "%";
  apply(init / 100);
  el.addEventListener("input", () => {
    const v = parseInt(el.value, 10);
    val.textContent = v + "%";
    apply(v / 100);
    localStorage.setItem("aimrange.feel." + id, String(v));
  });
}
bindFeel("inertia", (s) => { feelInertia = s; });
bindFeel("cam-recoil", (s) => { feelCamRecoil = s; });
bindFeel("gun-kick", (s) => { vm.setKickScale(s); });

/* ---------------- 6c. statistics panel ---------------- */

function buildStatsPanel() {
  const grid = $("stats-grid");
  grid.innerHTML = "";

  // one-line session summary (created once)
  let head = document.querySelector("#stats .stats-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "stats-head";
    grid.before(head);
  }
  let totalRuns = 0;

  for (const [key, t] of Object.entries(TASKS)) {
    const s = getSummary(key);
    totalRuns += s.runs;
    const hist = getHistory(key, 20); // newest first

    // trend over the last 6 runs (3 newest vs the 3 before) — mirrors getSummary
    let trendCls = "flat", trendTxt = "NO DATA";
    if (hist.length >= 6) {
      const a = hist.slice(0, 3), b = hist.slice(3, 6);
      const am = a.reduce((x, r) => x + r.score, 0) / 3;
      const bm = b.reduce((x, r) => x + r.score, 0) / 3;
      const d = Math.round(am - bm);
      trendCls = d > 0 ? "up" : d < 0 ? "down" : "flat";
      trendTxt = (d > 0 ? "+" : "") + d;
    }

    // sparkline: scores oldest→newest, normalised into a 100×44 viewBox
    let spark = "";
    const scores = hist.slice(0, 20).map((r) => r.score).reverse();
    if (scores.length >= 2) {
      const mx = Math.max(...scores) || 1;
      const pts = scores
        .map((v, i) => `${(i / (scores.length - 1)) * 100},${42 - (v / mx) * 38}`)
        .join(" ");
      spark = `<svg class="s-spark" viewBox="0 0 100 44" preserveAspectRatio="none"><polyline class="spark-line" points="${pts}"></polyline></svg>`;
    }

    const board = getBoard(key, 3);
    const boardRows = board.map((r, i) =>
      `<div class="board-row"><span>#${i + 1} &nbsp;${r.grade}</span><b>${r.score.toLocaleString()}</b></div>`
    ).join("");

    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `
      <h3>${t.name}</h3>
      <div class="stat-row"><span>Best</span><span class="s-best">${(s.best || 0).toLocaleString()}</span></div>
      <div class="stat-row"><span>Avg last 10</span><span class="s-avg">${s.avg10.toLocaleString()}</span></div>
      <div class="stat-row"><span>Runs</span><span class="s-runs">${s.runs}</span></div>
      <div class="stat-row"><span>Trend</span><span class="s-trend ${trendCls}">${trendTxt}</span></div>
      ${spark}
      <div class="s-board">${boardRows || '<div class="board-row"><span>NO RUNS YET</span></div>'}</div>`;
    grid.appendChild(card);
  }

  const lastDay = Object.values(TASKS)
    .map((t) => getSummary(Object.keys(TASKS).find((k) => TASKS[k] === t)).last)
    .filter(Boolean)
    .map((r) => r.ts);
  head.textContent = totalRuns
    ? `${totalRuns} RUNS LOGGED${lastDay.length ? " · LAST PLAYED " + new Date(Math.max(...lastDay)).toLocaleDateString() : ""}`
    : "NO RUNS YET — PLAY A TASK TO START TRACKING";
}

$("btn-stats").addEventListener("click", () => {
  buildStatsPanel();
  $("stats").classList.remove("hidden");
  sfx("ui");
});
$("btn-stats-close").addEventListener("click", () => {
  $("stats").classList.add("hidden");
  sfx("ui");
});

buildTaskCards();
loop();

/* debug handle (harmless in production): lets tests position the camera */
window.__aim = { camera, scene, targets, spawnTarget, renderer, pauseGame, resumeGame, toMenu, startTask, get state() { return state; }, get yaw() { return yaw; }, set yaw(v) { yaw = v; }, get pitch() { return pitch; }, set pitch(v) { pitch = v; },
  // juice-introspection handle (tests assert pools/holes numerically)
  fx: {
    get trails() { return trails.filter((t) => t.on).length; },
    get holes() { return holeMesh.count; },
    get bursts() { return hitBursts.map((b) => Object.keys(b).sort().join(",")); },
    get burstSprites() { return hitBursts.reduce((n, b) => n + 1 + b.sparks.length, 0); },
    step(ms) { updateTrails(ms / 1000); }, // test: advance streak anim manually
    get trailDebug() {
      return trails.map((t) => ({
        on: t.on, vis: t.m.visible, op: t.m.material.opacity,
        pos: t.m.position.toArray(), scale: t.m.scale.toArray(),
        a: t.a.toArray(), b: t.b.toArray(),
      }));
    },
    get holeDebug() {
      const out = [];
      const m = new THREE.Matrix4();
      for (let i = 0; i < holeMesh.count; i++) {
        holeMesh.getMatrixAt(i, m);
        out.push([m.elements[12], m.elements[13], m.elements[14]]);
      }
      return out;
    },
  },
};
