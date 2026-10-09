import { chromium } from "/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/playwright/index.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:8931/index.html");
await page.waitForFunction(() => window.__aim && document.querySelectorAll(".task-card").length >= 10);

// instrument renderer after load
await page.evaluate(() => {
  const r = window.__aim.renderer;
  window.__perf = { renders: 0, ms: [], calls: 0, tris: 0, raf: 0 };
  const orig = r.render.bind(r);
  r.render = function (...a) {
    const t0 = performance.now();
    orig(...a);
    window.__perf.ms.push(performance.now() - t0);
    window.__perf.calls = r.info.render.calls;
    window.__perf.tris = r.info.render.triangles;
    window.__perf.renders++;
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { window.__perf.raf++; cb(t); });
});

await page.locator(".task-card", { hasText: "GRIDSHOT" }).first().click();
await page.waitForFunction(() => window.__aim.state === "playing", { timeout: 8000 });

// PHASE 1: active shooting for 5s (juice FX all firing)
await page.evaluate(() => { window.__perf.raf = 0; window.__perf.renders = 0; window.__perf.ms = []; });
const t0 = Date.now();
while (Date.now() - t0 < 5000) {
  await page.evaluate(() => {
    const a = window.__aim;
    if (a.targets.length) {
      const p = a.targets[0].mesh.position, c = a.camera.position;
      const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      a.yaw = Math.atan2(-dx, -dz); a.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
  });
  await page.mouse.click(720, 450);
  await page.waitForTimeout(250);
}
const active = await page.evaluate(() => {
  const p = window.__perf;
  const ms = p.ms.slice().sort((a, b) => a - b);
  return {
    raf: p.raf, renders: p.renders,
    msAvg: +(ms.reduce((s, v) => s + v, 0) / ms.length).toFixed(3),
    msP95: +(ms[Math.floor(ms.length * 0.95)] || 0).toFixed(3),
    calls: p.calls, tris: p.tris,
    holes: window.__aim.fx.holes,
  };
});

// PHASE 2: still play — render-on-demand should go quiet.
// Wait out the post-shot FX first: a spent casing bounces for ~4-5 s, so a
// window that overlaps it measures motion, not idleness.
await page.waitForTimeout(6000);
await page.evaluate(() => { window.__perf.raf = 0; window.__perf.renders = 0; });
await page.waitForTimeout(3000);
const still = await page.evaluate(() => ({ raf: window.__perf.raf, renders: window.__perf.renders }));

const secs = 5;
console.log("PLAY-ACTIVE:", JSON.stringify({
  fps: +(active.raf / secs).toFixed(1),
  rendersPerSec: +(active.renders / secs).toFixed(1),
  msAvg: active.msAvg, msP95: active.msP95,
  calls: active.calls, tris: active.tris, holes: active.holes,
}));
console.log("PLAY-STILL (3s):", JSON.stringify({ raf: still.raf, rendersPerSec: +(still.renders / 3).toFixed(1) }));
await browser.close();
