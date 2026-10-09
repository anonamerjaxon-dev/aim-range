import { chromium } from "/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/playwright/index.mjs";
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
p.on("pageerror", e => errs.push("PAGEERROR " + e.message));
p.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errs.push("CONSOLE " + m.text()); });
const ok = (n, c, e = "") => console.log(c ? "PASS" : "FAIL", n, e);

await p.goto("http://127.0.0.1:8931/index.html");
await p.waitForFunction(() => window.__aim && document.querySelectorAll(".task-card").length === 12);

// --- 1. trail is anchored on the aim ray (projects to the crosshair) ---
await p.locator(".task-card", { hasText: "GRIDSHOT" }).first().click();
await p.waitForFunction(() => window.__aim.state === "playing", { timeout: 8000 });
await p.evaluate(() => { window.__aim.yaw = 0; window.__aim.pitch = -0.35; });
await p.waitForTimeout(100);
await p.mouse.click(640, 380);   // hits the floor/wall → a trail + a hole
await p.waitForTimeout(60);
const trailNdc = await p.evaluate(() => {
  const a = window.__aim;
  const t = ((a.fx && a.fx.trailDebug) || []).find(x => x.on);
  if (!t) return null;
  const V = a.camera.position.constructor;          // THREE.Vector3
  const v = new V(t.a[0], t.a[1], t.a[2]).project(a.camera);
  const dist = new V(t.a[0], t.a[1], t.a[2]).distanceTo(a.camera.position);
  return [ +v.x.toFixed(4), +v.y.toFixed(4), +dist.toFixed(3) ];
});
ok("trail starts on the aim ray (NDC ≈ 0,0)", !!trailNdc && Math.abs(trailNdc[0]) < 0.01 && Math.abs(trailNdc[1]) < 0.01, JSON.stringify(trailNdc));
const holesNow = await p.evaluate(() => window.__aim.fx.holes);
ok("bullet hole stamped on the surface", holesNow === 1, "holes=" + holesNow);

// --- 2. holes age out on their own ---
await p.waitForTimeout(10500);
const holesAfter = await p.evaluate(() => window.__aim.fx.holes);
ok("hole disappears after its TTL", holesAfter === 0, "holes=" + holesAfter);

// --- 3. orbs follow the theme ---
const before = await p.evaluate(() => {
  const a = window.__aim;
  return a.targets.map(t => "#" + t.mesh.material.color.getHexString());
});
await p.evaluate(() => { const el = document.getElementById("theme-style"); el.value = "ember"; el.dispatchEvent(new Event("change")); });
await p.waitForTimeout(300);
const after = await p.evaluate(() => {
  const a = window.__aim;
  return a.targets.map(t => "#" + t.mesh.material.color.getHexString());
});
const changed = before.length && before.some((c, i) => c !== after[i]);
ok("orb colours change with the theme", changed, `${before[0]} -> ${after[0]}`);
const accentOk = await p.evaluate(() => {
  const el = document.getElementById("theme-style");
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
});
ok("accent switched to ember", accentOk === "#ff9a3d", accentOk);

console.log("errors:", errs.length ? errs : "NONE");
await b.close();
