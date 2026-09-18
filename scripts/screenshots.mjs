// 產生 README 用的截圖（App Store 風格 iPhone 外框）：node scripts/screenshots.mjs [--png] [home classic ...]
// - 用無頭 Chrome 載入 App，模擬 iPhone 直向 / 橫向與「加入主畫面」獨立模式，用固定局號開局、翻開幾片空地與插幾支旗後擷圖
// - 再套上 scripts/screenshots-frame.html 的外框、狀態列與標題，輸出到 docs/screenshots/*.webp（加 --png 同時輸出 PNG）
// - 需要本機有 Chrome 或 Edge（找不到時用環境變數 CHROME 指定執行檔），Node 20.10 以上
// - 只想重出幾張就把檔名當參數：npm run screenshots -- home classic
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile, stat, mkdir, rm } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Node 20 / 21 的 WebSocket 要加旗標才有，這裡自動帶旗標重新執行一次
if (typeof WebSocket === 'undefined') {
  if (process.execArgv.includes('--experimental-websocket')) {
    console.error('這個 Node 版本沒有 WebSocket，請改用 Node 20.10 以上');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', ...process.argv.slice(1)], { stdio: 'inherit' });
  if (r.status === 9) console.error('需要 Node 20.10 以上');
  process.exit(r.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'screenshots');
const args = process.argv.slice(2);
const wantPng = args.includes('--png');
const only = args.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模擬的機型：6.3 吋 iPhone（402×874 pt、3x），狀態列 62pt
// 獨立模式下 iOS 27 回報的底部安全區較大，App 端上限 40px（見 style.css 的 --safe-bottom）；橫向時動態島在側邊
const PT = { w: 402, h: 874, status: 62, bottom: 40, landSide: 62, landBottom: 21 };

// 每張圖：檔名、標題與副標，以及進 App 後要做的事（在頁面裡執行的程式）
// 盤面用固定局號，重跑結果一樣；opens 是要翻開幾片空地、flags 是要插幾支旗
const SHOTS = [
  { file: 'home', t: '踩地雷，離線也能玩', s: '經典三級與自訂、每日挑戰，免費、無廣告、可離線' },
  { file: 'classic', t: '經典踩地雷', s: '初級、中級、高級與自訂尺寸，第一下永遠安全', start: ['classic', { deal: 20260918, level: 'beginner' }], opens: 3, flags: 3 },
  { file: 'flags', t: '插旗與 chord', s: '長按插旗，點數字一次翻開周圍', start: ['classic', { deal: 1024, level: 'intermediate' }], opens: 4, flags: 6 },
  { file: 'expert', t: '高級 30×16', s: '雙指縮放、單指拖曳，大盤面也能玩', start: ['classic', { deal: 99, level: 'expert' }], opens: 7, flags: 8, zoom: 12 },
  { file: 'daily', t: '每日挑戰', s: '每天一盤中級，全世界同一局，連續天數累計', start: ['daily'], opens: 3, flags: 4 },
  { file: 'win', t: '完成統計', s: '時間、3BV、3BV/s 與連勝紀錄', start: ['classic', { deal: 777, level: 'beginner' }], win: true },
  { file: 'landscape', land: true, t: '直向、橫向都能玩', s: '橫向時按鈕列放在慣用手那一側', start: ['classic', { deal: 99, level: 'expert' }], opens: 7, flags: 8, zoom: 22 },
];
const todo = only.length ? SHOTS.filter((s) => only.includes(s.file)) : SHOTS;
if (!todo.length) {
  console.error(`沒有符合的截圖名稱，可用：${SHOTS.map((s) => s.file).join(' ')}`);
  process.exit(1);
}

// ---------- 找瀏覽器 ----------
const chrome = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('找不到 Chrome 或 Edge，請用環境變數 CHROME 指定執行檔路徑');
  process.exit(1);
}

// ---------- 靜態伺服器：專案根目錄 + 外框樣板 + 記憶體中的原始截圖；不給 sw.js，擷圖時不註冊 Service Worker ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const raw = new Map();
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/sw.js') throw new Error('no sw');
    if (p.startsWith('/__raw/')) {
      const buf = raw.get(p.slice(7));
      if (!buf) throw new Error('no raw');
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(buf);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = p === '/__frame.html' ? join(root, 'scripts', 'screenshots-frame.html') : normalize(join(root, p));
    if (!file.startsWith(root)) throw new Error('bad path');
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- 啟動無頭 Chrome，從 DevToolsActivePort 拿到偵錯埠 ----------
const profile = join(tmpdir(), 'minesweeper-screenshots-profile');
await rm(profile, { recursive: true, force: true });
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--lang=zh-TW',
    '--hide-scrollbars',
    '--window-size=500,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let ws;
try {
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    } catch {}
    if (!port) await sleep(200);
  }
  if (!port) throw new Error('Chrome 沒有啟動');
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
    } catch {}
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('找不到 Chrome 分頁');

  // ---------- DevTools Protocol ----------
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else {
      listeners.forEach((l) => l(m));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const waitEvent = (name) =>
    new Promise((r) => {
      const l = (m) => {
        if (m.method === name) {
          listeners.delete(l);
          r(m.params);
        }
      };
      listeners.add(l);
    });
  const nav = async (url) => {
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url });
    await loaded;
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const metrics = (width, height, deviceScaleFactor, mobile) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height });
  const capture = async (format, quality) => Buffer.from((await send('Page.captureScreenshot', { format, quality })).data, 'base64');
  await send('Page.enable');
  await send('Runtime.enable');

  // ---------- 1. 進 App 擷取原始畫面 ----------
  for (const s of todo) {
    const land = !!s.land;
    await metrics(land ? PT.h : PT.w, land ? PT.w : PT.h - PT.status, 3, true);
    const insets = land
      ? { left: PT.landSide, leftMax: PT.landSide, right: PT.landSide, rightMax: PT.landSide, bottom: PT.landBottom, bottomMax: PT.landBottom }
      : { bottom: PT.bottom, bottomMax: PT.bottom };
    await send('Emulation.setSafeAreaInsetsOverride', { insets });
    await nav(`${base}/index.html`);
    // 當作已加入主畫面，隱藏安裝提示；清掉上一張留下的存檔與統計，首頁與對話框才乾淨
    await evaluate(`(() => {
      document.body.classList.add('standalone');
      for (const k of Object.keys(localStorage)) if (k.startsWith('ms.save.') || k.startsWith('ms.stats.') || k === 'ms.daily') localStorage.removeItem(k);
      return 'ok';
    })()`);
    if (s.start) {
      const [id, extra] = s.start;
      await evaluate(`(async () => {
        for (let i = 0; i < 100 && !window.__ms; i++) await new Promise((r) => setTimeout(r, 50));
        __ms.start(${JSON.stringify(id)}, 'new', ${JSON.stringify(extra || {})});
        const g = __ms.game, b = g.board;
        if (${!!s.win}) {
          // 贏：先開一片空地讓計時器跑，停幾秒讓時間有數字，再把其餘安全格全翻開
          for (let i = 0; i < b.n; i++) if (!b.mine[i] && b.count[i] === 0) { g.reveal(i); break; }
          await new Promise((r) => setTimeout(r, 5200));
          for (let i = 0; i < b.n; i++) if (!b.mine[i] && b.canOpen(i)) g.reveal(i);
          return 'win';
        }
        // 翻開幾片空地（0 的格子會連鎖），再對已翻開數字旁邊的雷插旗
        let opened = 0;
        for (let i = 0; i < b.n && opened < ${s.opens || 0}; i++) {
          if (!b.mine[i] && b.count[i] === 0 && b.canOpen(i)) { g.reveal(i); opened++; }
        }
        let flags = 0;
        for (let i = 0; i < b.n && flags < ${s.flags || 0}; i++) {
          if (b.mine[i] && b.nb[i].some((j) => b.state[j] === 1)) { g.flag(i, false); flags++; }
        }
        if (${s.zoom || 0}) {
          const r = document.querySelector('.board').getBoundingClientRect();
          __ms.renderer.zoomTo(${s.zoom || 0}, r.left + r.width / 2, r.top + r.height / 2);
          document.querySelector('#table').scrollTo(0, 0);
        }
        return 'ok';
      })()`);
    }
    await sleep(s.win ? 1800 : 600); // 等勝利對話框或動畫結束
    raw.set(`${s.file}.png`, await capture('png'));
    console.log(`擷取 ${s.file}`);
  }

  // ---------- 2. 套外框、標題，輸出 ----------
  await mkdir(outDir, { recursive: true });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  for (const s of todo) {
    const land = !!s.land;
    await send('Emulation.clearDeviceMetricsOverride');
    await metrics(land ? PT.h : PT.w, land ? 470 : PT.h, 2, false);
    const q = new URLSearchParams({ img: `/__raw/${s.file}.png`, t: s.t, s: s.s, land: land ? '1' : '0' });
    await nav(`${base}/__frame.html?${q}`);
    await evaluate(`new Promise((r) => { const i = document.getElementById('img'); if (i.complete && i.naturalWidth) r(1); else i.onload = () => r(1); })`);
    await sleep(300);
    const webp = await capture('webp', 92);
    await writeFile(join(outDir, `${s.file}.webp`), webp);
    let msg = `${s.file}.webp (${Math.round(webp.length / 1024)} KB)`;
    if (wantPng) {
      const png = await capture('png');
      await writeFile(join(outDir, `${s.file}.png`), png);
      msg += `、${s.file}.png (${Math.round(png.length / 1024)} KB)`;
    }
    console.log(`✓ docs/screenshots/${msg}`);
  }
} finally {
  ws?.close();
  proc.kill();
  server.close();
}
