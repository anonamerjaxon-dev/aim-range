const { chromium } = await import('/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/playwright/index.mjs');
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('404')) errs.push(m.text()); });
const ok = (n, c, extra = '') => console.log((c ? 'PASS' : 'FAIL'), n, extra);

await p.goto('http://127.0.0.1:8931/index.html');
await p.waitForFunction(() => window.__aim && document.querySelectorAll('.task-card').length === 12);

// --- 1. crosshair settings ---
await p.selectOption('#ch-style', 'circle');
const ring1 = await p.evaluate(() => { const r = document.querySelector('.ch-ring'); return getComputedStyle(r).display; });
ok('crosshair circle → ring visible', ring1 !== 'none', ring1);
await p.selectOption('#ch-style', 'dot');
const line2 = await p.evaluate(() => getComputedStyle(document.querySelector('.ch-line')).display);
ok('crosshair dot → lines hidden', line2 === 'none', line2);
await p.selectOption('#ch-style', 'cross');

await p.locator('#ch-size').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
const sizeVar = await p.evaluate(() => document.getElementById('crosshair').style.getPropertyValue('--ch-size'));
ok('ch-size sets px unit', sizeVar === '30px', sizeVar);

// --- 2. volume slider ---
await p.locator('#sfx-vol').evaluate(el => { el.value = '40'; el.dispatchEvent(new Event('input', { bubbles: true })); });
const volTxt = await p.locator('#sfx-vol-val').textContent();
ok('volume label updates', volTxt === '40', volTxt);

// --- 3. play GRIDSHOT: aim + hit, then force round end ---
await p.locator('.task-card').first().click();
await p.waitForFunction(() => window.__aim.state === 'playing', null, { timeout: 8000 });
const hit = await p.evaluate(() => {
  const { camera, targets } = window.__aim;
  if (!targets.length) return 'NO TARGETS';
  const t = targets[0].mesh.position, c = camera.position;
  const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z;
  window.__aim.yaw = Math.atan2(-dx, -dz);
  window.__aim.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return 'aimed';
});
await p.waitForTimeout(120);
await p.mouse.click(720, 450);
await p.waitForTimeout(200);
const score1 = await p.locator('#hud-score').textContent();
ok('shot scores', score1 !== '0', 'score=' + score1);
ok('aim helper', hit === 'aimed', hit);

// force round end via internal state — simulate timeLeft hitting 0
await p.evaluate(() => {
  const ev = new KeyboardEvent('keydown', { key: 'Escape' }); // pause path sanity
  document.dispatchEvent(ev);
});
await p.waitForTimeout(300);
const st1 = await p.evaluate(() => window.__aim.state);
ok('escape pauses', st1 === 'paused', st1);
await p.evaluate(() => window.__aim.resumeGame());
await p.waitForTimeout(200);

// --- 4. end round by rewinding: play enough via direct call not possible; use restart+menu flow instead.
// Fast path: set a tiny duration is not exposed. Instead check results overlay via a real short task:
// SPAWNTARGET has lifetime orbs but same 60s. So: verify endTask wiring by leaving page open on task end
// is too slow. Alternative: call the click on 'btn-quit' from pause → menu, then verify stats panel.
await p.evaluate(() => window.__aim.pauseGame());
await p.waitForTimeout(150);
await p.click('#btn-quit');
await p.waitForTimeout(300);
const backMenu = await p.evaluate(() => window.__aim.state);
ok('quit → menu', backMenu === 'menu', backMenu);
const menuVisible = await p.locator('#menu').isVisible();
ok('menu overlay visible', menuVisible);

// --- 5. stats panel ---
await p.click('#btn-stats');
await p.waitForTimeout(250);
const statsVisible = await p.locator('#stats').isVisible();
const cards = await p.locator('#stats .stat-card').count();
const head = await p.locator('#stats .stats-head').textContent().catch(() => '');
ok('stats overlay opens', statsVisible);
ok('12 stat cards (one per task)', cards === 12, 'got ' + cards);
console.log('stats-head:', head);
await p.click('#btn-stats-close');
await p.waitForTimeout(200);
ok('stats closes', !(await p.locator('#stats').isVisible()));

// --- 6. motion task spawn: MOTIONSHOT orbs should have vel set ---
const cardTexts = await p.locator('.task-card h3').allTextContents();
console.log('cards:', cardTexts.join(','));
await p.locator('.task-card', { hasText: 'MOTIONSHOT' }).click();
await p.waitForFunction(() => window.__aim.state === 'playing', null, { timeout: 8000 });
const motion = await p.evaluate(() => {
  const t = window.__aim.targets[0];
  return { vel: [t.vel.x, t.vel.y, t.vel.z], n: window.__aim.targets.length };
});
ok('motionshot has velocity', motion.vel[0] !== 0, JSON.stringify(motion));

// watch position drift
const p1 = await p.evaluate(() => window.__aim.targets[0].mesh.position.x);
await p.waitForTimeout(600);
const p2 = await p.evaluate(() => window.__aim.targets[0].mesh.position.x);
ok('orbs actually move', Math.abs(p2 - p1) > 0.5, `Δ=${(p2 - p1).toFixed(2)}`);

console.log('page errors:', errs.length ? errs : 'NONE');
await b.close();
