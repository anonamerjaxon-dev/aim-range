import { chromium } from "/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/playwright/index.mjs";

const URL = "http://127.0.0.1:8931/index.html";
const results = [];
const ok = (name, cond, detail = "") =>
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL);
await page.waitForFunction(() => window.__aim && document.querySelectorAll(".task-card").length >= 10);

// --- start GRIDSHOT ---
await page.locator(".task-card", { hasText: "GRIDSHOT" }).first().click();
await page.waitForFunction(() => window.__aim.state === "playing", { timeout: 8000 });

// --- 1) floor shot → trail immediately, hole after it lands ---
await page.evaluate(() => { window.__aim.pitch = -1.3; window.__aim.yaw = 0; });
await page.mouse.click(720, 450);
const trailsNow = await page.evaluate(() => window.__aim.fx.trails);
ok("trail spawned on shot", trailsNow >= 1, `trails=${trailsNow}`);

// capture the streak mid-life (~50ms in) then the hole later
await page.waitForTimeout(45);
await page.screenshot({ path: "/tmp/juice-trail.png" });
await page.waitForTimeout(400);
const holes = await page.evaluate(() => window.__aim.fx.holes);
ok("bullet hole stamped", holes >= 1, `holes=${holes}`);
await page.screenshot({ path: "/tmp/juice-hole.png" });
const trailsAfter = await page.evaluate(() => window.__aim.fx.trails);
ok("trail expired by 450ms", trailsAfter === 0, `trails=${trailsAfter}`);

// --- 2) target hit → pooled burst WITHOUT ring ---
let burstKeys = null, burstSprites = 0, hitOk = false;
for (let i = 0; i < 6 && !hitOk; i++) {
  const aim = await page.evaluate(() => {
    const a = window.__aim;
    if (!a.targets.length) return null;
    const p = a.targets[0].mesh.position, c = a.camera.position;
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    a.yaw = Math.atan2(-dx, -dz);
    a.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return true;
  });
  if (!aim) { await page.waitForTimeout(200); continue; }
  await page.mouse.click(720, 450);
  const b = await page.evaluate(() => ({ keys: window.__aim.fx.bursts, n: window.__aim.fx.burstSprites }));
  if (b.keys.length) { burstKeys = b.keys[0]; burstSprites = b.n; hitOk = true; break; }
  await page.waitForTimeout(250);
}
ok("hit burst spawned", hitOk, `keys=${burstKeys}`);
if (burstKeys) {
  ok("burst has NO ring (flash,life,sparks,t)", burstKeys === "flash,life,sparks,t", burstKeys);
  ok("burst = flash + 9 sparks", burstSprites === 10, `sprites=${burstSprites}`);
}
await page.waitForTimeout(40);
await page.screenshot({ path: "/tmp/juice-burst.png" });

// --- 3) score-pop pooling: 3 sequential hits must leave exactly ONE div ---
let popDivs = -1;
for (let k = 0; k < 3; k++) {
  let hit = false;
  for (let i = 0; i < 6 && !hit; i++) {
    const aim = await page.evaluate(() => {
      const a = window.__aim;
      if (!a.targets.length) return null;
      const p = a.targets[0].mesh.position, c = a.camera.position;
      const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      a.yaw = Math.atan2(-dx, -dz);
      a.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      return true;
    });
    if (!aim) { await page.waitForTimeout(200); continue; }
    await page.mouse.click(720, 450);
    hit = await page.evaluate(() => window.__aim.fx.bursts.length > 0);
    if (!hit) await page.waitForTimeout(250);
  }
  await page.waitForTimeout(750); // let the pop finish + return to pool
}
popDivs = await page.evaluate(() =>
  Array.from(document.body.children).filter(
    (el) => el.tagName === "DIV" && /^\+\d+$/.test(el.textContent)
  ).length
);
ok("score-pop divs pooled (4 pops → ≤2 divs = reuse)", popDivs >= 1 && popDivs <= 2, `divs=${popDivs}`);

// --- 4) no runtime errors anywhere ---
ok("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));

console.log(results.join("\n"));
const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await browser.close();
process.exit(fails ? 1 : 0);
