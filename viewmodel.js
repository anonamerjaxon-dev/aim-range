/* viewmodel.js — first-person pistol + gloved hand, built from primitives.
   Everything is procedural (no asset files) so the project stays offline.

   Design contract (see README "Performance design"):
   - The viewmodel is a CHILD OF THE CAMERA: aim/turn come for free.
   - It has NO idle animation: when you stand still and nothing happens,
     this module drives zero extra frames (render-on-demand stays at
     0 renders/s). Animation only runs on: fire → recoil+slide+flash,
     aim movement → sway lag, walking → head bob. Each update() call
     reports whether it is still settling so the loop can invalidate().
   - It never affects gameplay: the shooting raycast only tests orbs,
     so no part of the gun can block or swallow a shot.

   Units: camera-space. The gun points -Z, sits bottom-right
   (~x +0.30, y -0.28, z -0.60), sized to stay clear of the crosshair. */

import * as THREE from "./three.module.js";

/* ---------------- shared materials ---------------- */

const metalMat = new THREE.MeshStandardMaterial({
  color: 0x6b7fa8,           // brighter steel: at 0x38445e the gun measured only
                             // 4/255 contrast against the dark floor (invisible)
  metalness: 0.85,
  roughness: 0.30,
  envMapIntensity: 2.0,      // the env's lower hemisphere is dark — boost the pickup
});

const darkMat = new THREE.MeshStandardMaterial({
  color: 0x2a3350,           // lighter so grip/frame read as shapes, not voids
  metalness: 0.55,
  roughness: 0.55,
});

/* near-black seam/gap material: the shadow line between slide and frame and
   the ejection-port opening. Much darker than darkMat so the two halves of
   the gun visibly separate even in dim room light. */
const seamMat = new THREE.MeshStandardMaterial({
  color: 0x0d1120,
  metalness: 0.3,
  roughness: 0.9,
});

/* brass for spent casings */
const casingMat = new THREE.MeshStandardMaterial({
  color: 0xd8a53a,
  metalness: 0.9,
  roughness: 0.3,
  envMapIntensity: 1.5,
});

const gloveMat = new THREE.MeshStandardMaterial({
  color: 0x3d4a6b,        // lifted from 0x232b40 so the hand separates from the floor
  metalness: 0.05,
  roughness: 0.85, // fabric: no specular sheen, contrasts the metal
});

/* neon accent strips — MeshBasicMaterial = unlit, always full-bright, and
   (important) it does NOT take part in the shadow pass lighting math at all */
const accentMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });

/* muzzle flash: one additive sprite, shown for ~45 ms after a shot */
function makeFlashTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const rad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rad.addColorStop(0.0, "rgba(255,255,255,1)");
  rad.addColorStop(0.25, "rgba(255,240,190,0.9)");
  rad.addColorStop(0.6, "rgba(255,170,60,0.35)");
  rad.addColorStop(1.0, "rgba(255,120,0,0)");
  g.fillStyle = rad;
  g.fillRect(0, 0, 128, 128);
  // four spikes so it reads as a burst, not a dot
  g.strokeStyle = "rgba(255,235,180,0.85)";
  g.lineWidth = 5;
  g.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 14, 64 + Math.sin(a) * 14);
    g.lineTo(64 + Math.cos(a) * 58, 64 + Math.sin(a) * 58);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}

/* ---------------- builder ---------------- */

/* theme hook: the neon strips on slide/frame/grip + front post + muzzle halo
   all share one material, so one color set retints the whole gun */
export function setViewmodelAccent(color) {
  accentMat.color.set(color);
}

export function createViewmodel(camera) {
  const group = new THREE.Group(); // everything: position/rotation = base pose + recoil

  /* Slide (the part that cycles) lives in its own pivot so recoil moves the
     whole gun while the slide moves BACKWARD relative to it — two motions,
     one spring each (kick) + one time envelope (slide). The ejection port is
     a TWO-LAYER mechanism: the slide carries a small top WINDOW (no hole at
     rest — the chamber's steel top plate shines through it), and the STATIONARY
     chamber layer under the slide has the real, smaller hole. On fire the slide
     cycles back exactly one window-length, sliding the window over the hole —
     that's when the port opens, the neon rim shows and the casing flies. */
  const slidePivot = new THREE.Group();

  /* add() parents each part IMMEDIATELY — a part that only sits in an array
     is never drawn (three.js only renders what's under the scene graph).
     Default parent is `group`; slide-mounted parts pass slidePivot so they
     cycle backward with the slide.
     Every part is also RECORDED so the whole gun can be merged per material
     below (one draw call per material instead of per box). keep=true opts a
     part out: the sight-align test addresses the two sight meshes by their
     LOCAL position, which merging would bake away. */
  const built = [];
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = group, keep = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = false; // viewmodel never casts: it would flicker on walls
    m.receiveShadow = false;
    parent.add(m);
    if (!keep) built.push(m);
    return m;
  };

  /* ---- pistol (points -Z) ----
     Low-poly but shaped: a machined top rib, cocking serrations, an
     accessory rail with slots, a beavertail, a backstrap and a magazine
     baseplate turn the box pile into a pistol silhouette. All of it gets
     MERGED per material afterwards, so this detail costs ~7 draw calls. */
  /* slide: a SOLID shell — at rest there is NO ejection port. The only
     opening is a small top WINDOW (x -0.010..0.025, z -0.18..-0.12) between
     the nose and breech blocks; the stationary chamber layer below (added
     further down) shows its steel top plate through it, so the gun reads
     sealed until a shot slides the window back over the chamber hole. */
  // full-height nose (z -0.38..-0.18) and breech (z -0.12..0.06) blocks
  add(new THREE.BoxGeometry(0.075, 0.09, 0.20), metalMat, 0, 0.02, -0.28, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.075, 0.09, 0.18), metalMat, 0, 0.02, -0.03, 0, 0, 0, slidePivot);
  // machined top rib, interrupted only across the window
  add(new THREE.BoxGeometry(0.052, 0.014, 0.20), metalMat, 0, 0.068, -0.28, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.052, 0.014, 0.18), metalMat, 0, 0.068, -0.03, 0, 0, 0, slidePivot);
  // window walls: left flank + rib sliver carry the rib height, right flank
  // stops at the body top — the window is cut clean through the slide roof
  add(new THREE.BoxGeometry(0.0275, 0.09, 0.06), metalMat, -0.02375, 0.02, -0.15, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.016, 0.014, 0.06), metalMat, -0.018, 0.068, -0.15, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.0125, 0.09, 0.06), metalMat, 0.03125, 0.02, -0.15, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.066, 0.07, 0.05), metalMat, 0, 0.014, -0.385, 0, 0, 0, slidePivot);
  // rear cocking serrations: dark slabs a hair wider than the slide, so only
  // their edges show as groove lines on both flanks
  for (let i = 0; i < 4; i++) {
    add(new THREE.BoxGeometry(0.079, 0.058, 0.011), darkMat, 0, 0.018, 0.048 - i * 0.030, 0, 0, 0, slidePivot);
  }
  // slide/frame separation: the slide (bright steel) overhangs the frame, and
  // a near-black seam bar at the junction reads as the shadow gap real pistols
  // have between the two halves — without it the gun looked like one blob
  add(new THREE.BoxGeometry(0.077, 0.009, 0.335), seamMat, 0, -0.017, -0.135);
  /* ---- chamber layer (LAYER 2 — stationary, parented to `group`) ----
     The slide's window glides over this. At rest the window sits over the
     solid steel top plate (z -0.18..-0.12) → sealed gun. The REAL hole is
     smaller than the old one: 0.06 × 0.035 (was 0.10 × 0.0535) at
     z -0.116..-0.064 — and it is covered by the slide's breech block until
     the cycle slides the window across it. Inside: a dark barrel hood below
     the rim (depth sells the opening) and a neon line on the hole's rear
     edge — the port "lights up" only while it is actually open. */
  // solid top plate seen through the window at rest (flush steel, 0.015 below
  // the slide roof — reads as a machined pocket, NOT a hole)
  add(new THREE.BoxGeometry(0.034, 0.006, 0.060), metalMat, 0.0075, 0.047, -0.15);
  // barrel hood: fills the hole's floor, dark and glossy
  add(new THREE.BoxGeometry(0.034, 0.034, 0.060), darkMat, 0.0075, -0.003, -0.09);
  // hole end walls (front + rear), steel-topped flush with the plate
  add(new THREE.BoxGeometry(0.034, 0.070, 0.004), seamMat, 0.0075, 0.015, -0.118);
  add(new THREE.BoxGeometry(0.034, 0.070, 0.004), seamMat, 0.0075, 0.015, -0.062);
  // neon rim on the hole's rear edge — hidden inside the breech block at
  // rest, glowing at the back of the opening the moment the port cracks open
  add(new THREE.BoxGeometry(0.030, 0.005, 0.006), accentMat, 0.0075, 0.0475, -0.0615);
  // accent strips BOTH sides, full length — the camera sees the gun's left
  // face from its right-of-center pose, so +x-only strips would hide behind
  // the slide. The window zone has flank walls again, so nothing to split.
  add(new THREE.BoxGeometry(0.012, 0.012, 0.40), accentMat, 0.042, 0.05, -0.16, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.012, 0.012, 0.40), accentMat, -0.042, 0.05, -0.16, 0, 0, 0, slidePivot);
  // barrel poking out of the slide + guide-rod tip under it
  add(new THREE.CylinderGeometry(0.021, 0.021, 0.07, 16), darkMat, 0, 0.02, -0.40, Math.PI / 2, 0, 0, slidePivot);
  add(new THREE.CylinderGeometry(0.010, 0.010, 0.03, 10), metalMat, 0, -0.012, -0.395, Math.PI / 2, 0, 0, slidePivot);
  // frame under the slide + accessory rail with three machined slots
  add(new THREE.BoxGeometry(0.068, 0.06, 0.34), darkMat, 0, -0.04, -0.13);
  add(new THREE.BoxGeometry(0.052, 0.024, 0.16), darkMat, 0, -0.074, -0.24);
  for (let i = 0; i < 3; i++) {
    add(new THREE.BoxGeometry(0.056, 0.007, 0.012), metalMat, 0, -0.074, -0.20 - i * 0.04);
  }
  // beavertail: small swept plate where frame meets grip
  add(new THREE.BoxGeometry(0.06, 0.024, 0.05), darkMat, 0, -0.028, 0.075, 0.35);
  // grip, tilted back ~16° + backstrap + magazine baseplate + accent lip
  add(new THREE.BoxGeometry(0.062, 0.24, 0.115), darkMat, 0, -0.185, 0.045, 0.28);
  add(new THREE.BoxGeometry(0.05, 0.21, 0.03), darkMat, 0, -0.19, 0.104, 0.28);
  add(new THREE.BoxGeometry(0.07, 0.03, 0.13), metalMat, 0, -0.300, 0.014, 0.28);
  add(new THREE.BoxGeometry(0.072, 0.008, 0.132), accentMat, 0, -0.316, 0.017, 0.28);
  // trigger guard: front bar + bottom bar + rounded front-bottom junction
  add(new THREE.BoxGeometry(0.014, 0.10, 0.014), darkMat, 0, -0.10, -0.115);
  add(new THREE.BoxGeometry(0.016, 0.014, 0.10), darkMat, 0, -0.145, -0.07);
  add(new THREE.BoxGeometry(0.016, 0.030, 0.030), darkMat, 0, -0.130, -0.110, -0.7);
  // trigger
  add(new THREE.BoxGeometry(0.014, 0.05, 0.018), metalMat, 0, -0.105, -0.06, 0.2);
  // sights: rear notch block + front post — BOTH ride the slide (slidePivot).
  // On a real pistol both sights are mounted on the slide, so during recoil
  // they cycle backward together; parenting the rear notch to `group` instead
  // made the sights visibly split apart on every shot. keep=true = these two
  // are found by LOCAL position in the sight-align test, so never merge them.
  add(new THREE.BoxGeometry(0.055, 0.022, 0.03), darkMat, 0, 0.075, 0.03, 0, 0, 0, slidePivot, true);
  add(new THREE.BoxGeometry(0.016, 0.02, 0.02), darkMat, -0.021, 0.084, 0.045, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.016, 0.02, 0.02), darkMat, 0.021, 0.084, 0.045, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.03, 0.018, 0.03), darkMat, 0, 0.070, -0.348, 0, 0, 0, slidePivot);
  add(new THREE.BoxGeometry(0.012, 0.02, 0.02), accentMat, 0, 0.076, -0.355, 0, 0, 0, slidePivot, true);

  group.add(slidePivot);

  /* ---- gloved hand wrapping the grip ----
     Sized/placed against the grip box (0.062 wide, front face at z≈-0.01):
     everything sits on the +x side (the hand's own side) and the fingers
     wrap the FRONT edge. Before this pass the fingers and palm were wider
     than the grip itself and centred on it, so from the camera — which sits
     to the gun's right and sees its LEFT face — they read as a stack of
     slabs lying on the flank instead of a hand holding the gun. */
  // palm behind the grip + heel pad under it
  add(new THREE.BoxGeometry(0.058, 0.15, 0.085), gloveMat, 0.012, -0.185, 0.108, 0.28);
  add(new THREE.BoxGeometry(0.056, 0.06, 0.058), gloveMat, 0.012, -0.250, 0.122, 0.34);
  // four fingers wrapping the front of the grip — each finger is TWO segments
  // (proximal flat on the grip face, distal curled just past its front edge)
  for (let i = 0; i < 4; i++) {
    add(
      new THREE.BoxGeometry(0.03, 0.028, 0.052),
      gloveMat,
      0.014,
      -0.115 - i * 0.042,
      0.030 - i * 0.011,
      0.28
    );
    add(
      new THREE.BoxGeometry(0.028, 0.026, 0.046),
      gloveMat,
      0.014,
      -0.126 - i * 0.042,
      -0.016 - i * 0.011,
      0.7
    );
  }
  // thumb: proximal up the side, tip angled onto the frame
  add(new THREE.BoxGeometry(0.03, 0.10, 0.05), gloveMat, 0.045, -0.13, 0.062, 0.2, 0, -0.35);
  add(new THREE.BoxGeometry(0.028, 0.06, 0.045), gloveMat, 0.052, -0.075, 0.036, 0.25, 0, -0.55);
  // trigger finger: straight along the frame, then bent down into the guard
  add(new THREE.BoxGeometry(0.03, 0.032, 0.16), gloveMat, 0.026, -0.065, -0.05, 0.1);
  add(new THREE.BoxGeometry(0.028, 0.03, 0.08), gloveMat, 0.024, -0.098, -0.105, 1.0);
  /* wrist cuff with neon trim, then the forearm as TWO tapered segments that
     run down-and-back out of the bottom of the frame. One 0.42-long slab
     read as a plank lying across the screen; splitting it and dropping the
     end out of frame makes it read as an arm instead. */
  add(new THREE.BoxGeometry(0.095, 0.105, 0.10), gloveMat, 0.012, -0.30, 0.19, 0.42);
  add(new THREE.BoxGeometry(0.10, 0.014, 0.10), accentMat, 0.012, -0.345, 0.215, 0.42);
  add(new THREE.BoxGeometry(0.105, 0.105, 0.26), gloveMat, 0.012, -0.350, 0.332, 0.42);
  add(new THREE.BoxGeometry(0.14, 0.14, 0.30), gloveMat, 0.016, -0.474, 0.558, 0.62, 0, 0.1);

  /* ---- merge: one draw call per material per pivot ----
     Every recorded part sharing a material collapses into a single mesh with
     its transform baked in. Low-poly detail above adds ~15 boxes but the
     gun still draws in ~7 calls (was ~40 unmerged). The two sights and the
     flash stay separate (keep=true / sprite). */
  {
    const buckets = new Map();
    for (const m of built) {
      const key = (m.parent === group ? "g" : "s") + m.material.uuid;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    }
    for (const parts of buckets.values()) {
      if (parts.length < 2) continue;
      const parent = parts[0].parent;
      const geos = parts.map((m) => {
        m.updateMatrix();
        return m.geometry.clone().applyMatrix4(m.matrix); // LOCAL-space bake
      });
      let vCount = 0, iCount = 0;
      for (const g of geos) { vCount += g.attributes.position.count; iCount += g.index.count; }
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
        for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
        vo += g.attributes.position.count;
        io += gi.length;
        g.dispose();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const merged = new THREE.Mesh(geo, parts[0].material);
      merged.castShadow = false; // viewmodel never casts (flicker on walls)
      merged.receiveShadow = false;
      for (const old of parts) parent.remove(old);
      parent.add(merged);
    }
    built.length = 0;
  }

  /* muzzle flash sprite at the barrel tip (parented to slidePivot: flashes
     with the barrel, not with the springing group) */
  const flash = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeFlashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.95,
    })
  );
  flash.position.set(0, 0.02, -0.46);
  flash.scale.setScalar(0.001); // invisible until fired
  slidePivot.add(flash);

  /* base pose: bottom-right corner, barrel converged slightly LEFT so it
     lines up with where the shots actually go. A negative yaw here pointed
     the muzzle off to the right (the gun "aimed away" from the crosshair,
     which is what made the pose read as wrong) — the gun sits right of the
     eye, so the barrel has to cant inward to converge on the aim line. */
  group.position.set(0.30, -0.26, -0.58);
  group.rotation.set(0.03, 0.06, 0.0);
  group.visible = false; // the menu is the startup state: no gun until a round

  camera.add(group);

  /* ---------------- animation state (springs, one per motion) ---------------- */
  // recoil: kick up/back on fire, spring to rest
  let kick = 0, kickVel = 0;
  // slide cycle: seconds since the last shot (-1 = at rest) + current travel
  let slideT = -1, slideTravel = 0;
  // flash timer (seconds remaining)
  let flashT = 0;
  // sway: lag against aim movement, springs back to 0
  let swayX = 0, swayY = 0;
  // head bob phase (walk tasks)
  let bobPhase = 0;

  const REST = { px: 0.30, py: -0.26, pz: -0.58, rx: 0.03, ry: 0.06 };

  /* ---- spent casings: ONE InstancedMesh (1 draw call), pooled ----
     World-space (they fall to the floor, so they can't live under the
     camera-parented gun group). main.js does scene.add(vm.casings). */
  const CASING_N = 8;
  const casings = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.006, 0.0055, 0.026, 6), casingMat, CASING_N
  );
  casings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  casings.frustumCulled = false;
  casings.visible = false;
  const casState = [];
  const _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(),
    _ce = new THREE.Euler(), _cv = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < CASING_N; i++) {
    casState.push({
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Euler(), spin: new THREE.Vector3(),
      life: 0, alive: false, rest: false,
    });
    _cm.makeScale(0, 0, 0);
    casings.setMatrixAt(i, _cm);
  }
  // anchor at the chamber hole — the hole is LAYER 2 (stationary), so the
  // casing spawns from the gun body while the slide cycles over it
  const portAnchor = new THREE.Object3D();
  portAnchor.position.set(0.0075, 0.055, -0.09);
  group.add(portAnchor);
  // muzzle anchor: where bullet trails leave the barrel (world space, so
  // main.js can vm.muzzle.getWorldPosition() right after the shot)
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.02, -0.46);
  slidePivot.add(muzzleAnchor);
  let ejectDelay = -1; // armed by fire(), fires as the port opens (~30 ms)

  function ejectCasing() {
    // oldest or free slot (round-robin: overwrite the oldest = never grow)
    let s = casState.find((c) => !c.alive);
    if (!s) s = casState.reduce((a, b) => (a.life > b.life ? a : b));
    portAnchor.getWorldPosition(s.pos);
    // eject right + up in the CAMERA's frame — the casing flies the way the
    // port faces relative to where you're aiming
    const q = camera.quaternion;
    s.vel.set(1.0 + Math.random() * 0.8, 0.9 + Math.random() * 0.5, 0.15)
      .applyQuaternion(q);
    s.rot.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    s.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 18,
      14 + Math.random() * 10
    );
    s.life = 0; s.alive = true; s.rest = false;
    casings.visible = true;
  }

  function updateCasings(dt) {
    let any = false;
    for (let i = 0; i < CASING_N; i++) {
      const s = casState[i];
      if (!s.alive) continue;
      any = true;
      s.life += dt;
      if (!s.rest) {
        s.vel.y -= 9.8 * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.rot.x += s.spin.x * dt; s.rot.y += s.spin.y * dt; s.rot.z += s.spin.z * dt;
        const restY = 0.013; // floor y + casing radius — it lies ON the floor
        if (s.pos.y <= restY) {
          s.pos.y = restY;
          if (Math.abs(s.vel.y) < 0.6) { // stop bouncing, settle flat
            s.rest = true;
            s.vel.set(0, 0, 0);
            s.rot.x = Math.PI / 2; s.rot.z = Math.random() * Math.PI;
            s.spin.set(0, 0, 0);
          } else {
            s.vel.y = -s.vel.y * 0.35; // bounce: lose 65% each hop
            s.vel.x *= 0.6; s.vel.z *= 0.6;
            s.spin.multiplyScalar(0.5);
          }
        }
      }
      // fade: shrink away in the last 0.35 s of a 4 s rest, then recycle
      let sc = 1;
      const total = s.rest ? 4.0 : 6.0;
      if (s.life > total - 0.35) sc = Math.max(0, (total - s.life) / 0.35);
      if (s.life >= total) { s.alive = false; sc = 0; }
      _ce.copy(s.rot); _cq.setFromEuler(_ce);
      _cv.setScalar(sc);
      _cm.compose(s.pos, _cq, _cv);
      casings.setMatrixAt(i, _cm);
    }
    if (any) casings.instanceMatrix.needsUpdate = true;
    else if (casings.visible) casings.visible = false;
    return any;
  }

  /* FEEL slider hook: scales the visual kick (0..2) without touching timing */
  let kickScale = 1;
  function setKickScale(s) { kickScale = s; }

  function fire() {
    kickVel += 9.0 * kickScale;   // impulse into the recoil spring
    slideT = 0; // restart the slide cycle envelope (mid-cycle refire snaps it)
    flashT = 0.045;   // 45 ms flash
    ejectDelay = 0.03; // casing leaves exactly as the port reaches full open
  }

  /* ctx: { dYaw, dPitch (radians since last frame), walking (bool), speed } */
  function update(dt, ctx) {
    dt = Math.min(dt, 0.05); // clamp: a stalled tab must not explode the springs
    let animating = false;

    /* --- recoil + slide: damped springs toward 0 --- */
    /* Settle thresholds = "imperceptible", not "mathematically zero":
       kick contributes kick*0.16 rad of rotation, so below 0.005 the muzzle
       has moved <0.06° — nobody can see it, so stop paying redraws for it. */
    if (kick !== 0 || kickVel !== 0) {
      kickVel += (-90 * kick - 13 * kickVel) * dt;
      kick += kickVel * dt;
      if (Math.abs(kick) < 0.005 && Math.abs(kickVel) < 0.05) { kick = 0; kickVel = 0; }
      else animating = true;
    }
    /* --- slide cycle: TIME-BASED envelope, not a spring ---
       A spring's amplitude depends on the integration dt (30 fps loses ~15%
       of the peak), so the port would fail to fully open on slow machines.
       Fixed schedule instead: 28 ms snap back → 30 ms full-open HOLD (the
       moment the hole, neon rim and casing all read) → 62 ms eased return.
       Identical at 20 or 240 fps; travel 0.06 = exactly one window length. */
    if (slideT >= 0) {
      slideT += dt;
      if (slideT < 0.028) {
        const k = slideT / 0.028;
        slideTravel = 0.06 * (1 - (1 - k) * (1 - k) * (1 - k)); // ease-out snap
      } else if (slideT < 0.058) {
        slideTravel = 0.06; // FULL OPEN: window aligned over the chamber hole
      } else if (slideT < 0.12) {
        const k = (slideT - 0.058) / 0.062;
        // ease-in-out cubic back to battery
        slideTravel = 0.06 * (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
      } else {
        slideTravel = 0; slideT = -1; // back in battery, at rest
      }
      animating = true;
    }

    /* --- muzzle flash countdown --- */
    if (flashT > 0) {
      flashT -= dt;
      const k = Math.max(0, flashT / 0.045);
      flash.scale.setScalar(0.001 + 0.42 * k);
      (flash.material).opacity = 0.95 * k;
      if (flashT <= 0) { flash.scale.setScalar(0.001); flashT = 0; }
      animating = true;
    }

    /* --- casing eject (delayed until the port cracks open) + physics --- */
    if (ejectDelay >= 0) {
      ejectDelay -= dt;
      if (ejectDelay < 0) { ejectCasing(); ejectDelay = -1; animating = true; }
    }
    if (updateCasings(dt)) animating = true;

    /* --- sway: spring the gun opposite the aim delta, then settle --- */
    const swayTX = ctx && ctx.dYaw ? THREE.MathUtils.clamp(-ctx.dYaw * 2.2, -0.09, 0.09) : 0;
    const swayTY = ctx && ctx.dPitch ? THREE.MathUtils.clamp(-ctx.dPitch * 2.2, -0.09, 0.09) : 0;
    // critically damped follow — converges fast, no visible oscillation
    swayX += (swayTX - swayX) * Math.min(1, dt * 14);
    swayY += (swayTY - swayY) * Math.min(1, dt * 14);
    if (Math.abs(swayX) > 1e-4 || Math.abs(swayY) > 1e-4) animating = true;
    else { swayX = 0; swayY = 0; }

    /* --- head bob: only while actually walking --- */
    let bobY = 0, bobR = 0;
    if (ctx && ctx.walking && ctx.speed > 0.1) {
      bobPhase += dt * (7 + ctx.speed * 0.9);
      bobY = Math.sin(bobPhase) * 0.010;
      bobR = Math.sin(bobPhase * 0.5) * 0.014;
      animating = true;
    } else if (bobPhase !== 0) {
      // stop bobbing smoothly rather than snapping upright
      const decay = Math.max(0, 1 - dt * 8);
      bobPhase *= decay;
      if (bobPhase < 0.01) bobPhase = 0;
      else animating = true;
    }

    /* --- compose: base + recoil kick + sway + bob --- */
    group.position.set(
      REST.px + swayX * 0.6,
      REST.py + swayY * 0.6 + kick * 0.012 + bobY,
      REST.pz + kick * 0.075          // kick pulls the gun toward the camera
    );
    group.rotation.set(
      REST.rx + swayY + kick * 0.16 - bobR * 0.4, // muzzle climbs on fire
      REST.ry + swayX,
      bobR
    );
    // slide cycles BACKWARD (+Z is toward the shooter): 0.06 = one window
    // length, the distance the window must travel to cover the chamber hole
    slidePivot.position.z = slideTravel;

    return animating;
  }

  function setVisible(v) {
    group.visible = v;
    if (!v) { // gun away (menu/pause): drop any airborne casings instantly
      for (const s of casState) s.alive = false;
      casings.visible = false;
      ejectDelay = -1;
    }
  }

  return { group, casings, muzzle: muzzleAnchor, fire, update, setVisible, setKickScale };
}
