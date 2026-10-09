import { chromium } from "/Users/jackson/.nvm/versions/node/v22.21.1/lib/node_modules/playwright/index.mjs";
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
p.on("pageerror", e => errs.push("PAGEERROR " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("CONSOLE " + m.text()); });
await p.goto("http://127.0.0.1:8931/index.html");
await p.waitForFunction(() => window.__aim && document.querySelectorAll(".task-card").length >= 10);
for (const t of ["neon", "synth", "ember", "matrix"]) {
  await p.evaluate((v) => { const el = document.getElementById("theme-style"); el.value = v; el.dispatchEvent(new Event("change")); }, t);
  await p.waitForTimeout(250);
  const r = await p.evaluate(() => {
    const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : "(missing)"; };
    return {
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      cardBorder: cs(".task-card", "borderTopColor"),
      tagBorder: cs(".task-card .tag", "borderTopColor"),
      tagBg: cs(".task-card .tag", "backgroundColor"),
      timerGlow: cs("#hud-timer", "textShadow"),
      panelBorder: cs(".panel", "borderTopColor"),
      gradeA: cs(".res-cell .grade.g-A", "color"),
      ch: cs("#crosshair", "--ch-color"),
      swatch: document.getElementById("ch-color").value,
      btnPrimaryColor: null,
    };
  });
  console.log(t.padEnd(7), JSON.stringify(r));
}
// pin a colour and confirm it survives a theme switch
await p.evaluate(() => { const el = document.getElementById("ch-color"); el.value = "#ff0000"; el.dispatchEvent(new Event("input", { bubbles: true })); });
await p.evaluate(() => { const el = document.getElementById("theme-style"); el.value = "neon"; el.dispatchEvent(new Event("change")); });
await p.waitForTimeout(200);
console.log("pinned after theme switch:", await p.evaluate(() => getComputedStyle(document.getElementById("crosshair")).getPropertyValue("--ch-color")));
console.log("errors:", errs.length ? errs : "none");
await b.close();
