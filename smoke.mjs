import { chromium } from '/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// write screenshots next to this script, no matter where it's run from
const HERE = dirname(fileURLToPath(import.meta.url)) + '/';

const ctx = await chromium.launch({ channel: 'chrome', headless: true });
const page = await ctx.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:8931/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.screenshot({ path: HERE + 'shot-menu.png' });

// menu sanity: 6 task cards
const cards = await page.locator('.task-card').count();
console.log('task cards:', cards);

// start a task (pointer lock will fail headless-ish but game should still count down)
await page.locator('.task-card').first().click();
await page.waitForTimeout(4500);
await page.screenshot({ path: HERE + 'shot-game.png' });

const hudVisible = await page.locator('#hud').isVisible();
const timer = await page.locator('#hud-timer').textContent();
console.log('hud visible:', hudVisible, 'timer:', timer);

// simulate a shot at center (may or may not hit)
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(300);

// WebGL context present?
const webgl = await page.evaluate(() => {
  const c = document.getElementById('scene');
  return !!(c && (c.getContext('webgl2') || c.getContext('webgl')));
});
console.log('webgl ok:', webgl);

console.log('console errors:', errors.length ? errors : 'none');
await ctx.close();
