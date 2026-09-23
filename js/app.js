// 應用程式主體：畫面切換、設定、統計、存檔、每日挑戰、按鈕

import { GAME_BY_ID } from './games/index.js';
import { Classic, LEVELS, LEVEL_KEYS, CUSTOM_LIMITS } from './games/classic.js';
import { NoGuess, NOGUESS_DENSITY } from './games/noguess.js';
import { Hex } from './games/hex.js';
import { Game } from './engine.js';
import { FLAG } from './board.js';
import { Renderer } from './render.js';
import { RULES } from './rules.js';
import { randomSeed, MAX_SEED, todayString, dailySeed } from './rng.js';
import { generateNoGuess, encodeLayout } from './solver.js';
import * as Sound from './sound.js';

const $ = (s) => document.querySelector(s);

// 版本資訊由 version.js 提供（index.html 與 sw.js 共用同一份）；APP_BUILD 只給 Service Worker 用
const APP_VERSION = window.APP_VERSION || '?';

// ---------- 本機儲存 ----------
function load(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : def;
  } catch {
    return def;
  }
}
function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}
function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

// ---------- 模式 ----------
// 首頁上有難度可選的模式。每個模式各自記住難度、自訂尺寸、存檔與每個難度的統計
// 每日挑戰另外處理：固定中級無猜，一天一盤
const MODES = {
  classic: { Cls: Classic, level: 'level', custom: 'custom', stats: 'ms.stats.classic.', short: '經典' },
  noguess: { Cls: NoGuess, level: 'nogLevel', custom: 'nogCustom', stats: 'ms.stats.noguess.', short: '無猜' },
  hex: { Cls: Hex, level: 'hexLevel', custom: 'hexCustom', stats: 'ms.stats.hex.', short: '蜂巢' },
};
const MODE_IDS = Object.keys(MODES);
const DAILY_LEVEL = 'intermediate';

// id：classic / noguess / daily
function classOf(id) {
  return id === 'daily' ? NoGuess : MODES[id].Cls;
}

const DEFAULT_SETTINGS = {
  level: 'beginner',
  custom: { w: 12, h: 20, mines: 40 }, // 自訂尺寸的預設值：直向手機剛好塞滿一畫面
  nogLevel: 'beginner',
  nogCustom: { w: 12, h: 20, mines: 40 },
  hexLevel: 'beginner',
  hexCustom: { w: 12, h: 18, mines: 40 },
  hand: 'right', // 慣用手：橫向時按鈕列放在這一側
  undo: false, // 允許復原（含踩雷後救回）；預設關，和傳統玩法一樣
  question: false, // 插旗循環是否含問號
  vibrate: true, // 長按插旗時震一下（iPhone 不支援，Android 有效）
  sound: true,
  table: 'green',
  showTimer: true,
};
function loadSettings() {
  const stored = load('ms.settings', {});
  const s = { ...DEFAULT_SETTINGS, ...stored };
  for (const mid of MODE_IDS) {
    const M = MODES[mid];
    s[M.custom] = { ...DEFAULT_SETTINGS[M.custom], ...(stored[M.custom] || {}) };
    if (!LEVEL_KEYS.includes(s[M.level])) s[M.level] = 'beginner';
  }
  if (s.hand !== 'left' && s.hand !== 'right') s.hand = 'right';
  return s;
}
let settings = loadSettings();

function saveSettings() {
  save('ms.settings', settings);
  applySettings();
}
// 桌面顏色對應的實際色碼，要和 style.css 的 --table 一致
const TABLE_COLORS = { green: '#23613c', blue: '#234a73', gray: '#2b2e33', purple: '#45305f' };

// 標題列是桌面色再疊 24% 黑（style.css 的 --bar），算出實際色給狀態列用
function headerColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * 0.76).toString(16).padStart(2, '0');
  return '#' + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.table = settings.table;
  const bar = headerColor(TABLE_COLORS[settings.table] || TABLE_COLORS.green);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = bar; // iOS 15–25 的狀態列用這個
  const tint = $('#statusbar-tint');
  if (tint) tint.style.backgroundColor = bar; // iOS 26+ 改為取樣最上方 fixed 元素的底色
  document.body.classList.toggle('no-timer', !settings.showTimer);
  document.body.classList.toggle('hand-left', settings.hand === 'left');
  $('#btn-undo').classList.toggle('hidden', !settings.undo);
  Sound.setSoundEnabled(settings.sound);
  if (renderer) renderer.relayout();
}

// ---------- 統計 ----------
// 每個模式的每個難度各自一份；每日挑戰另存
const EMPTY_STATS = { played: 0, won: 0, bestTime: null, streak: 0, bestStreak: 0 };
function getStats(mid, levelKey) {
  return { ...EMPTY_STATS, ...load(MODES[mid].stats + levelKey, {}) };
}
function setStats(mid, levelKey, s) {
  save(MODES[mid].stats + levelKey, s);
}
const EMPTY_DAILY = { results: {}, streak: 0, bestStreak: 0 };
function getDaily() {
  const d = load('ms.daily', {});
  return { ...EMPTY_DAILY, ...d, results: d.results || {} };
}
function setDaily(d) {
  save('ms.daily', d);
}
function saveKey(id) {
  return 'ms.save.' + id;
}
function yesterdayString(today) {
  const [y, m, d] = today.split('-').map(Number);
  return todayString(new Date(y, m - 1, d - 1));
}

// ---------- 狀態 ----------
let current = null; // { id, game, elapsed, runningSince, counted, lastRevealed }
let renderer = null;
let timerHandle = null;
let flagMode = false;
let starting = false; // 正在產生盤面，避免連點開兩局

function fmtTime(ms, precise) {
  const total = ms / 1000;
  const s = Math.floor(total);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const base = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return precise ? base + '.' + Math.floor((total - s) * 10) : base;
}

// ---------- 畫面 ----------
function showScreen(name) {
  $('#home').classList.toggle('hidden', name !== 'home');
  $('#game').classList.toggle('hidden', name !== 'game');
}

// 目前設定對應的難度選項
function levelOptions(mid) {
  const M = MODES[mid];
  const o = { level: settings[M.level] };
  if (o.level === 'custom') Object.assign(o, settings[M.custom]);
  return o;
}
// 某一局的難度選項（輸入局號時要用同一種盤）
function levelOptionsOf(game) {
  const o = game.options;
  return { level: o.level, w: o.w, h: o.h, mines: o.mines };
}
// 三個模式的難度名稱相同（初級、中級、高級），只有尺寸不同，所以標籤共用經典的表
function levelLabel(key, custom) {
  if (LEVELS[key]) return LEVELS[key].label;
  return custom ? `自訂 ${custom.w}×${custom.h}` : '自訂';
}
// 存檔裡是不是一局還沒結束、屬於這個模式的盤面
function savedInProgress(id) {
  const saved = load(saveKey(id), null);
  const g = saved && saved.game;
  if (!g || !(g.moves > 0) || g.won || g.lost) return null;
  if (g.id !== classOf(id).meta.id) return null; // 1.0 的每日挑戰是經典盤面，改版後不接續
  if (id === 'daily' && g.options.daily !== todayString()) return null; // 昨天沒打完的就算了
  return g;
}

function levelControl(mid, useShort) {
  const M = MODES[mid];
  const items = LEVEL_KEYS.map((k) => ({ v: k, label: k === 'custom' ? (useShort ? '自訂' : levelLabel('custom', settings[M.custom])) : LEVELS[k].label }));
  const seg = segmented(items, settings[M.level], (v) => {
    if (v === 'custom') {
      // 先開尺寸對話框，確認後才算選了自訂
      showCustomDialog(mid, () => {
        seg.set('custom');
        if (!current) renderHome();
      });
      return false;
    }
    settings[M.level] = v;
    saveSettings();
    if (!current) renderHome();
  });
  return seg;
}

function renderHome() {
  const list = $('#game-list');
  list.innerHTML = '';

  // ---- 有難度可選的模式：經典、無猜 ----
  for (const mid of MODE_IDS) {
    const M = MODES[mid];
    const m = M.Cls.meta;
    const lvl = settings[M.level];
    const saved = savedInProgress(mid);
    const st = getStats(mid, lvl);
    const rate = st.played ? Math.round((st.won / st.played) * 100) : 0;
    let statLine = `${levelLabel(lvl, settings[M.custom])}：勝 ${st.won} / ${st.played} 局`;
    if (st.played) statLine += ` · ${rate}%`;
    if (st.bestTime) statLine += ` · 最佳 ${fmtTime(st.bestTime, true)}`;
    const chip = saved ? `<span class="chip">進行中 · ${levelLabel(saved.options.level, saved.options)}</span>` : '';
    const card = document.createElement('div');
    card.className = 'gcard';
    card.innerHTML = `
      <div class="gcard-main">
        <div class="gcard-title">${m.name}<span class="en">${m.en}</span>${chip}</div>
        <div class="gcard-desc">${m.desc}</div>
        <div class="gcard-stats">${statLine}</div>
      </div>
      <div class="gcard-foot"></div>`;
    const foot = card.querySelector('.gcard-foot');
    foot.appendChild(levelControl(mid, false));
    const actions = cardActions(foot);
    if (saved) {
      actions.append(
        button('繼續', 'btn primary', () => startGame(mid, 'resume')),
        button('新局', 'btn', () =>
          showModal({
            title: '發新局？',
            html: '<p>目前進行中的那一局會算作放棄，連勝紀錄會歸零。</p>',
            buttons: [
              { label: '取消' },
              {
                label: '發新局',
                primary: true,
                onClick: () => {
                  abandonSaved(mid);
                  startGame(mid, 'new');
                },
              },
            ],
          })
        )
      );
    } else {
      actions.appendChild(button('開始', 'btn primary', () => startGame(mid, 'new')));
    }
    card.querySelector('.gcard-main').addEventListener('click', () => startGame(mid, saved ? 'resume' : 'new'));
    list.appendChild(card);
  }

  // ---- 每日挑戰 ----
  {
    const today = todayString();
    const daily = getDaily();
    const res = daily.results[today];
    const saved = savedInProgress('daily');
    const wonDays = Object.values(daily.results).filter((r) => r && r.won).length;
    let chip = '';
    if (res) chip = res.won ? `<span class="chip done">今日完成 ${fmtTime(res.time, true)}</span>` : '<span class="chip failed">今日踩雷</span>';
    else if (saved) chip = '<span class="chip">進行中</span>';
    const card = document.createElement('div');
    card.className = 'gcard';
    card.innerHTML = `
      <div class="gcard-main">
        <div class="gcard-title">每日挑戰<span class="en">Daily</span>${chip}</div>
        <div class="gcard-desc">每天一盤無猜的中級 16×16、40 雷，全世界同一局，只靠推理就能解完，每天只算一次。今天是 ${today}。</div>
        <div class="gcard-stats">連續 ${daily.streak} 天 · 最長 ${daily.bestStreak} 天 · 完成 ${wonDays} 天</div>
      </div>
      <div class="gcard-foot"></div>`;
    const actions = cardActions(card.querySelector('.gcard-foot'));
    if (res) {
      const note = document.createElement('span');
      note.className = 'gcard-stats';
      note.textContent = res.won ? '今天已完成，明天再來' : '今天已踩雷，明天再來';
      actions.appendChild(note);
    } else {
      actions.appendChild(button(saved ? '繼續' : '開始', 'btn primary', () => startGame('daily', saved ? 'resume' : 'new')));
      card.querySelector('.gcard-main').addEventListener('click', () => startGame('daily', saved ? 'resume' : 'new'));
    }
    list.appendChild(card);
  }
}

// 卡片底部的按鈕組：「繼續」與「新局」包在同一組，空間不夠時整組一起換到下一行，不會被拆開；一律靠右
function cardActions(foot) {
  const actions = document.createElement('div');
  actions.className = 'gcard-actions';
  foot.appendChild(actions);
  return actions;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// 分段按鈕。onChange 回傳 false 表示先不要切換亮起的選項（例如「自訂」要等對話框確認），之後用 el.set(v) 補上
function segmented(items, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  const render = () => {
    wrap.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.v === value) b.classList.add('on');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onChange(it.v) !== false) value = it.v;
        render();
      });
      wrap.appendChild(b);
    }
  };
  wrap.set = (v) => {
    value = v;
    render();
  };
  render();
  return wrap;
}

// ---------- 無猜盤面產生 ----------
// 在 Web Worker 產生，主畫面不會卡住；瀏覽器不支援模組 Worker 時退回主執行緒
let worker = null; // null：還沒建立；false：不能用
let workerSeq = 0;
const workerJobs = new Map();
const layoutNow = (job) => encodeLayout(generateNoGuess(job.w, job.h, job.mines, job.seed, job.shape));
function generateLayout(w, h, mines, seed, shape) {
  const job = { w, h, mines, seed, shape };
  if (worker === null) {
    try {
      worker = new Worker(new URL('./noguess-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const r = workerJobs.get(e.data.id);
        if (!r) return;
        workerJobs.delete(e.data.id);
        r.resolve(e.data.layout || layoutNow(r.job));
      };
      worker.onerror = () => {
        try {
          worker.terminate();
        } catch {}
        worker = false;
        for (const r of workerJobs.values()) r.resolve(layoutNow(r.job));
        workerJobs.clear();
      };
    } catch {
      worker = false;
    }
  }
  if (!worker) return new Promise((resolve) => setTimeout(() => resolve(layoutNow(job)), 30));
  return new Promise((resolve) => {
    const id = ++workerSeq;
    workerJobs.set(id, { resolve, job });
    worker.postMessage({ id, ...job });
  });
}
// 產生超過一瞬間才顯示等待視窗，避免一閃而過
function showWaiting(title) {
  let m = null;
  const t = setTimeout(() => {
    m = showModal({ title, html: '<div class="spinner"></div><p class="note" style="text-align:center">保證不用猜的盤面需要多算一下</p>', sticky: true });
  }, 250);
  return () => {
    clearTimeout(t);
    if (m) m.close();
  };
}

// ---------- 遊戲流程 ----------
function abandonSaved(id) {
  const g = savedInProgress(id);
  if (g && MODES[id]) {
    const key = LEVELS[g.options.level] ? g.options.level : 'custom';
    const st = getStats(id, key);
    st.streak = 0;
    setStats(id, key, st);
  }
  remove(saveKey(id));
}

function abandonCurrent() {
  if (!current) return;
  const g = current.game;
  if (!g.over && g.moves > 0 && MODES[current.id]) {
    const st = getStats(current.id, g.levelKey);
    st.streak = 0;
    setStats(current.id, g.levelKey, st);
  }
  remove(saveKey(current.id));
}

async function startGame(id, mode, extraOptions) {
  if (starting) return;
  starting = true;
  try {
    const Cls = classOf(id);
    let game = null;
    let elapsed = 0;
    const today = todayString();
    if (mode === 'resume' && savedInProgress(id)) {
      const data = load(saveKey(id), null);
      try {
        game = Game.deserialize(Cls, data.game);
        elapsed = data.elapsed || 0;
      } catch (e) {
        console.error('存檔讀取失敗', e);
        game = null;
      }
    }
    if (!game) {
      let seed;
      let opts;
      if (id === 'daily') {
        seed = dailySeed(today);
        opts = { level: DAILY_LEVEL, daily: today };
      } else if (mode === 'replay' && current && current.id === id) {
        seed = current.game.seed;
        opts = { ...current.game.options };
      } else {
        opts = { ...levelOptions(id), ...(extraOptions || {}) };
        // 指定局號（選單「輸入局號」）：局號就是種子
        seed = opts.deal || randomSeed();
        delete opts.deal;
      }
      if (Cls.needsLayout && !opts.layout) {
        const size = Cls.resolveSize(opts);
        const done = showWaiting('產生無猜盤面…');
        try {
          opts.layout = await generateLayout(size.w, size.h, size.mines, seed, Cls.shape);
        } finally {
          done();
        }
      }
      game = new Cls(seed, opts).boot();
    }
    setupGame(id, game, elapsed);
  } finally {
    starting = false;
  }
}

function setupGame(id, game, elapsed) {
  stopTimer();
  current = { id, game, elapsed, runningSince: null, counted: game.moves > 0, lastRevealed: game.board.revealed };
  showScreen('game');
  $('#g-title').textContent = id === 'daily' ? '每日挑戰' : game.meta.name;
  $('#g-sub').textContent = dealLabel(game);
  setFlagMode(false);
  renderer.setGame(game);
  game.on('change', onChange);
  game.on('win', onWin);
  game.on('lose', onLose);
  game.on('message', (msg) => toast(msg));
  updateHud();
  saveCurrent();
  if (game.moves > 0 && !game.over) startTimer();
}

function onChange() {
  const g = current.game;
  if (!current.counted && g.moves > 0) {
    current.counted = true;
    if (MODES[current.id]) {
      const st = getStats(current.id, g.levelKey);
      st.played++;
      setStats(current.id, g.levelKey, st);
    }
  }
  if (g.moves > 0 && !g.over) startTimer();
  updateHud();
  saveCurrent();
  // 音效：依最後一步的種類與翻開的格數
  const a = g.actions[g.actions.length - 1];
  const opened = g.board.revealed - current.lastRevealed;
  current.lastRevealed = g.board.revealed;
  if (g.lost) return; // 爆炸音在 onLose
  if (a && a.t === 'f' && opened === 0) Sound.playFlag();
  else if (opened > 8) Sound.playOpen();
  else if (opened > 0) Sound.playReveal();
}

function onWin() {
  stopTimer();
  const g = current.game;
  const id = current.id;
  const ms = current.elapsed;
  const bv = g.bv3();
  const bvs = ms > 0 ? bv / (ms / 1000) : 0;
  let streakLine = '';
  let newTime = false;
  if (id === 'daily') {
    const d = getDaily();
    const today = g.options.daily;
    d.results[today] = { won: true, time: ms };
    const y = d.results[yesterdayString(today)];
    d.streak = y && y.won ? d.streak + 1 : 1;
    d.bestStreak = Math.max(d.bestStreak, d.streak);
    setDaily(d);
    streakLine = `<div><span>連續天數</span><b>${d.streak}</b></div>`;
  } else {
    const st = getStats(id, g.levelKey);
    st.won++;
    st.streak++;
    st.bestStreak = Math.max(st.bestStreak, st.streak);
    newTime = ms > 0 && (st.bestTime == null || ms < st.bestTime);
    if (newTime) st.bestTime = ms;
    setStats(id, g.levelKey, st);
    streakLine = `<div><span>連勝</span><b>${st.streak}</b></div>`;
  }
  remove(saveKey(id));
  updateHud();
  Sound.playWin();
  renderer.celebrate();
  const html = `<div class="win-stats">
      <div><span>時間</span><b>${fmtTime(ms, true)}${newTime ? ' <em>新紀錄</em>' : ''}</b></div>
      <div><span>3BV</span><b>${bv}</b></div>
      <div><span>3BV/s</span><b>${bvs.toFixed(2)}</b></div>
      ${streakLine}</div>`;
  const buttons = [{ label: '回選單', onClick: goHome, primary: id === 'daily' }];
  if (id !== 'daily') buttons.push({ label: '再玩一局', primary: true, onClick: () => startGame(id, 'new') });
  setTimeout(() => showModal({ title: '🎉 掃雷成功！', html, sticky: true, buttons }), 800);
}

function onLose() {
  stopTimer();
  const g = current.game;
  const ms = current.elapsed;
  const id = current.id;
  if (id === 'daily') {
    const d = getDaily();
    d.results[g.options.daily] = { won: false, time: ms };
    d.streak = 0;
    setDaily(d);
  } else {
    const st = getStats(id, g.levelKey);
    st.streak = 0;
    setStats(id, g.levelKey, st);
  }
  remove(saveKey(id));
  updateHud();
  Sound.playBoom();
  if (settings.vibrate && navigator.vibrate) {
    try {
      navigator.vibrate([60, 40, 90]);
    } catch {}
  }
  const pct = Math.round(g.progress() * 100);
  let note = '';
  if (id === 'daily') note = '<p class="note">每日挑戰每天只算一次，明天再來。</p>';
  else if (g instanceof NoGuess) note = '<p class="note">無猜盤面一定推得出來，這一下是推錯或手滑了。</p>';
  const html = `<div class="win-stats">
      <div><span>時間</span><b>${fmtTime(ms, true)}</b></div>
      <div><span>進度</span><b>${pct}%</b></div>
      <div><span>剩餘地雷</span><b>${g.minesLeft()}</b></div></div>${note}`;
  const buttons = [{ label: '回選單', onClick: goHome, primary: id === 'daily' }];
  if (id !== 'daily') {
    if (settings.undo) {
      buttons.push({
        label: '復原這一步',
        onClick: () => {
          if (current && current.game === g) g.undo();
        },
      });
    }
    buttons.push({ label: '同一盤重來', onClick: restartCurrent });
    buttons.push({ label: '再玩一局', primary: true, onClick: () => startGame(id, 'new') });
  }
  setTimeout(() => showModal({ title: '💥 踩到地雷了', html, sticky: true, buttons }), 700);
}

function updateHud() {
  if (!current) return;
  const g = current.game;
  $('#hud-time').textContent = fmtTime(getElapsed());
  $('#hud-mines').textContent = `💣 ${g.won ? 0 : g.minesLeft()}`; // 贏了剩下的雷會自動插旗，顯示 0
  $('#btn-undo').disabled = !g.canUndo();
}

function getElapsed() {
  if (!current) return 0;
  return current.elapsed + (current.runningSince ? Date.now() - current.runningSince : 0);
}
function startTimer() {
  if (!current || current.runningSince) return;
  current.runningSince = Date.now();
  if (!timerHandle) timerHandle = setInterval(updateHud, 500);
}
function stopTimer() {
  if (current && current.runningSince) {
    current.elapsed += Date.now() - current.runningSince;
    current.runningSince = null;
  }
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function saveCurrent() {
  if (!current) return;
  const g = current.game;
  if (g.over) {
    remove(saveKey(current.id));
    return;
  }
  save(saveKey(current.id), { game: g.serialize(), elapsed: getElapsed() });
}

function goHome() {
  stopTimer();
  saveCurrent();
  current = null;
  renderHome();
  showScreen('home');
}

function newGame(mode, extraOptions) {
  if (!current) return;
  const id = current.id;
  if (id === 'daily') {
    toast('每日挑戰每天只有一盤');
    return;
  }
  abandonCurrent();
  startGame(id, mode, extraOptions);
}

// 回到這局開頭：同一個盤面、計時歸零，不影響連勝
function restartCurrent() {
  if (!current) return;
  const g = current.game;
  if (!g.restart()) {
    toast('這局還沒開始，沒有可以重來的步');
    return;
  }
  stopTimer();
  current.elapsed = 0;
  current.lastRevealed = 0;
  updateHud();
  saveCurrent();
}

function confirmRestart() {
  if (!current) return;
  if (current.game.moves === 0) {
    toast('這局還沒開始');
    return;
  }
  showModal({
    title: '回到這局開頭？',
    html: '<p>盤面不變，時間會歸零。這不算放棄，連勝紀錄不受影響。</p>',
    buttons: [{ label: '取消' }, { label: '重新開始', primary: true, onClick: restartCurrent }],
  });
}

function setFlagMode(v) {
  flagMode = !!v;
  renderer.setFlagMode(flagMode);
  $('#btn-flag').classList.toggle('on', flagMode);
}

// ---------- 對話框與提示 ----------
function showModal({ title, html, buttons = [], sticky = false, cls = '' }) {
  const root = $('#modal-root');
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal ${cls}"><h2>${title}</h2><div class="modal-body">${html}</div><div class="modal-buttons"></div></div>`;
  const close = () => bd.remove();
  const btnWrap = bd.querySelector('.modal-buttons');
  for (const b of buttons) {
    const el = button(b.label, 'btn' + (b.primary ? ' primary' : ''), () => {
      // noClose：由 onClick 自己決定何時關（例如輸入驗證失敗要留在對話框）；其他按鈕按完就關
      if (b.noClose) {
        b.onClick && b.onClick();
        return;
      }
      close();
      b.onClick && b.onClick();
    });
    btnWrap.appendChild(el);
  }
  if (!buttons.length) btnWrap.remove();
  if (!sticky) {
    bd.addEventListener('click', (e) => {
      if (e.target === bd) close();
    });
  }
  root.appendChild(bd);
  return { close, el: bd };
}

let toastTimer = null;
function toast(msg, action, duration = 2500) {
  const t = $('#toast');
  t.innerHTML = `<span>${msg}</span>`;
  if (action) {
    const b = button(action.label, '', () => {
      hideToast();
      action.fn();
    });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}
function hideToast() {
  $('#toast').classList.remove('show');
}

// 無猜與每日挑戰的規則都建立在經典規則上，接在後面一起顯示
function showRules(id) {
  let html = RULES.classic;
  if (id === 'noguess') html = RULES.noguess + html;
  if (id === 'hex') html = RULES.hex + RULES.noguess + html;
  if (id === 'daily') html = RULES.daily + RULES.noguess + html;
  const title = id === 'daily' ? '每日挑戰 規則' : `${GAME_BY_ID[id].meta.name} 規則`;
  showModal({ title, html, buttons: [{ label: '知道了', primary: true }] });
}

function statsTable(st) {
  const rate = st.played ? Math.round((st.won / st.played) * 100) : 0;
  return `<table class="stats">
      <tr><td>局數</td><td>${st.played}</td><td>勝場</td><td>${st.won}</td></tr>
      <tr><td>勝率</td><td>${rate}%</td><td>最佳時間</td><td>${st.bestTime ? fmtTime(st.bestTime, true) : '—'}</td></tr>
      <tr><td>目前連勝</td><td>${st.streak}</td><td>最長連勝</td><td>${st.bestStreak}</td></tr>
    </table>`;
}

function showStats() {
  let html = '';
  for (const mid of MODE_IDS) {
    for (const key of LEVEL_KEYS) {
      const st = getStats(mid, key);
      if (!st.played && key === 'custom') continue;
      html += `<h3>${MODES[mid].short} · ${levelLabel(key)}</h3>${statsTable(st)}`;
    }
  }
  const d = getDaily();
  const results = Object.values(d.results);
  const wonDays = results.filter((r) => r && r.won).length;
  const best = results.filter((r) => r && r.won).reduce((m, r) => (m == null || r.time < m ? r.time : m), null);
  html += `<h3>每日挑戰</h3><table class="stats">
      <tr><td>挑戰天數</td><td>${results.length}</td><td>完成天數</td><td>${wonDays}</td></tr>
      <tr><td>連續天數</td><td>${d.streak}</td><td>最長連續</td><td>${d.bestStreak}</td></tr>
      <tr><td>最佳時間</td><td colspan="3">${best != null ? fmtTime(best, true) : '—'}</td></tr>
    </table>`;
  showModal({
    title: '統計',
    html,
    buttons: [
      {
        label: '清除統計',
        onClick: () =>
          showModal({
            title: '確定清除？',
            html: '<p>會刪除所有模式、難度與每日挑戰的紀錄，無法復原。</p>',
            buttons: [
              { label: '取消' },
              {
                label: '清除',
                primary: true,
                onClick: () => {
                  for (const mid of MODE_IDS) for (const key of LEVEL_KEYS) remove(MODES[mid].stats + key);
                  remove('ms.daily');
                  if (!current) renderHome();
                },
              },
            ],
          }),
      },
      { label: '關閉', primary: true },
    ],
  });
}

function showSettings() {
  const rows = [];
  const row = (label, control) => {
    const d = document.createElement('div');
    d.className = 'setting-row';
    const l = document.createElement('span');
    l.textContent = label;
    d.append(l, control);
    rows.push(d);
  };
  const toggle = (key) => {
    const lab = document.createElement('label');
    lab.className = 'switch';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = !!settings[key];
    inp.addEventListener('change', () => {
      settings[key] = inp.checked;
      saveSettings();
    });
    const knob = document.createElement('span');
    lab.append(inp, knob);
    return lab;
  };
  const seg = (key, items) =>
    segmented(items, settings[key], (v) => {
      settings[key] = v;
      saveSettings();
    });

  for (const mid of MODE_IDS) row(`${MODES[mid].short}難度`, levelControl(mid, true));
  row(
    '慣用手',
    seg('hand', [
      { v: 'right', label: '右手' },
      { v: 'left', label: '左手' },
    ])
  );
  row('允許復原', toggle('undo'));
  row('問號標記', toggle('question'));
  row('震動回饋', toggle('vibrate'));
  row('音效', toggle('sound'));
  row('顯示計時', toggle('showTimer'));
  row(
    '桌面顏色',
    seg('table', [
      { v: 'green', label: '綠' },
      { v: 'blue', label: '藍' },
      { v: 'gray', label: '灰' },
      { v: 'purple', label: '紫' },
    ])
  );
  const m = showModal({ title: '設定', html: '', buttons: [{ label: '完成', primary: true, onClick: () => !current && renderHome() }] });
  const body = m.el.querySelector('.modal-body');
  rows.forEach((r) => body.appendChild(r));
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = '難度會在下一局生效，經典與無猜各自記住。慣用手決定橫向時按鈕列放哪一側。允許復原後踩雷也能救回，但那樣的勝場只是休閒。';
  body.appendChild(note);
  const dataRow = document.createElement('div');
  dataRow.className = 'setting-row';
  dataRow.append(
    Object.assign(document.createElement('span'), { textContent: '資料備份' }),
    button('匯出 / 匯入', 'btn small', () => {
      m.close();
      showBackup();
    })
  );
  body.appendChild(dataRow);
}

// 自訂尺寸：寬、高 5–40；雷數上限經典是 (寬−1)×(高−1)，無猜是格子數的 21%
function showCustomDialog(mid, onDone) {
  const M = MODES[mid];
  const c = settings[M.custom];
  const limitNote = M.Cls.needsLayout
    ? `雷數最多是格子數的 ${Math.round(NOGUESS_DENSITY * 100)}%，太密就產生不出不用猜的盤面`
    : '雷數最多 (寬−1)×(高−1)';
  const noAuto = 'type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" class="num-input"';
  const m = showModal({
    title: `自訂盤面（${M.short}）`,
    html: `<p class="note deal-note">寬、高 ${CUSTOM_LIMITS.minW} 到 ${CUSTOM_LIMITS.maxW}，${limitNote}。太大的盤面可以拖曳捲動。</p>
      <div class="custom-grid">
        <label>寬<input id="cw" ${noAuto} value="${c.w}"></label>
        <label>高<input id="ch" ${noAuto} value="${c.h}"></label>
        <label>雷數<input id="cm" ${noAuto} value="${c.mines}"></label>
      </div>
      <p id="custom-err" class="field-err"></p>`,
    buttons: [
      { label: '取消' },
      {
        label: '確定',
        primary: true,
        noClose: true,
        onClick: () => {
          const w = parseInt(m.el.querySelector('#cw').value, 10);
          const h = parseInt(m.el.querySelector('#ch').value, 10);
          const mines = parseInt(m.el.querySelector('#cm').value, 10);
          const err = m.el.querySelector('#custom-err');
          if (!(w >= CUSTOM_LIMITS.minW && w <= CUSTOM_LIMITS.maxW) || !(h >= CUSTOM_LIMITS.minH && h <= CUSTOM_LIMITS.maxH)) {
            err.textContent = `寬和高必須在 ${CUSTOM_LIMITS.minW} 到 ${CUSTOM_LIMITS.maxW} 之間`;
            return;
          }
          const max = M.Cls.maxMinesFor(w, h);
          if (!(mines >= CUSTOM_LIMITS.minMines && mines <= max)) {
            err.textContent = `${w}×${h} 的雷數必須在 ${CUSTOM_LIMITS.minMines} 到 ${max} 之間`;
            return;
          }
          settings[M.custom] = { w, h, mines };
          settings[M.level] = 'custom';
          saveSettings();
          m.close();
          onDone && onDone();
        },
      },
    ],
  });
  m.el.querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '');
      m.el.querySelector('#custom-err').textContent = '';
    })
  );
  setTimeout(() => m.el.querySelector('#cw').focus(), 50);
}

// ---------- 資料備份：把統計、設定、進行中的盤面匯出成一段文字 ----------
const BACKUP_PREFIX = 'MS1:';

function exportData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('ms.')) data[k] = localStorage.getItem(k);
  }
  const json = JSON.stringify({ v: 1, at: new Date().toISOString(), data });
  return BACKUP_PREFIX + btoa(unescape(encodeURIComponent(json)));
}

// 解讀備份字串並寫回 localStorage。錯誤訊息要讓人看得出怎麼補救：
// - iPhone 鍵盤會把貼上內容開頭的 MS1 自動改成小寫，所以前綴不分大小寫
// - 經由聊天軟體轉貼可能夾進空白或換行，一律忽略
function importData(text) {
  const t = (text || '').trim();
  if (!t) throw new Error('還沒貼上任何內容。請先在原本的裝置按「複製」，再貼到這裡。');
  if (!/^ms1:/i.test(t)) {
    throw new Error(`開頭應該是「${BACKUP_PREFIX}」，但貼上的內容開頭是「${t.slice(0, 8)}」。請確認是從備份文字的最前面開始複製。`);
  }
  const body = t.slice(BACKUP_PREFIX.length).replace(/\s+/g, '');
  let parsed;
  try {
    parsed = JSON.parse(decodeURIComponent(escape(atob(body))));
  } catch {
    throw new Error('內容不完整或被改動過：可能只複製到一部分，或貼上時被鍵盤自動修正。請回到原裝置重新按「複製」，整段貼上。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('v' in parsed)) throw new Error('內容不是踩地雷合集的備份格式。');
  if (parsed.v !== 1) throw new Error(`這份備份來自較新的版本（格式 v${parsed.v}），請先把這台裝置的 App 更新到最新版再匯入。`);
  if (!parsed.data || typeof parsed.data !== 'object') throw new Error('內容不是踩地雷合集的備份格式。');
  let n = 0;
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k.startsWith('ms.') && typeof v === 'string') {
      localStorage.setItem(k, v);
      n++;
    }
  }
  if (!n) throw new Error('這份備份裡沒有任何資料。');
  return { count: n, at: parsed.at };
}

function showBackup() {
  const code = exportData();
  // 文字框關掉 iPhone 鍵盤的自動修正與自動大寫，否則貼上的 MS1 會被改成 ms1
  const noAuto = 'autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"';
  const m = showModal({
    title: '資料備份',
    html: `<p class="note">內容包含統計、設定與進行中的盤面。複製這段文字保存，換手機或清除瀏覽器資料後貼回來就能還原。</p>
      <textarea id="backup-out" readonly rows="4" ${noAuto}></textarea>
      <div class="row-btns"><button id="backup-copy" class="btn small">複製</button><span id="backup-msg" class="note"></span></div>
      <p class="note" style="margin-top:14px">還原：把之前複製的文字貼在下面，會覆蓋目前的資料。</p>
      <textarea id="backup-in" rows="3" placeholder="${BACKUP_PREFIX}…" ${noAuto}></textarea>
      <p id="backup-err" class="field-err"></p>`,
    buttons: [
      { label: '關閉' },
      {
        label: '匯入並還原',
        primary: true,
        noClose: true, // 失敗時留在對話框，把原因顯示在文字框下方讓人修正
        onClick: () => {
          const input = m.el.querySelector('#backup-in');
          let result;
          try {
            result = importData(input.value);
          } catch (e) {
            m.el.querySelector('#backup-err').textContent = '匯入失敗：' + e.message;
            input.classList.add('invalid');
            return;
          }
          m.close();
          applyImported(result);
        },
      },
    ],
  });
  const out = m.el.querySelector('#backup-out');
  out.value = code;
  const input = m.el.querySelector('#backup-in');
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    m.el.querySelector('#backup-err').textContent = '';
  });
  m.el.querySelector('#backup-copy').addEventListener('click', async () => {
    const msg = m.el.querySelector('#backup-msg');
    if (await copyText(code)) {
      msg.textContent = '已複製';
    } else {
      out.focus();
      out.setSelectionRange(0, code.length);
      msg.textContent = '無法自動複製，請長按文字框選「全選」再「拷貝」';
    }
  });
}

// 複製到剪貼簿：Clipboard API 只在 HTTPS 提供，不行就用暫時的文字框加舊式 execCommand（iPhone、區網 http 都可用）
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // 先設唯讀，iPhone 才不會彈鍵盤
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;-webkit-user-select:text;user-select:text';
  document.body.appendChild(ta);
  try {
    // execCommand 複製的是「目前焦點元素」的選取範圍，所以一定要先 focus；
    // iPhone 對唯讀欄位的 select() 沒反應，要暫時變成可編輯並用 Range 選取
    ta.focus({ preventScroll: true });
    ta.contentEditable = 'true';
    ta.readOnly = false;
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

function applyImported(result) {
  settings = loadSettings();
  applySettings();
  if (!current) renderHome();
  toast(`已還原 ${result.count} 筆資料`);
}

// 標題列副標：每日挑戰顯示日期；其他顯示局號加難度，例如「第 123456 局 · 中級 16×16 · 40 雷」
function dealLabel(game) {
  if (game.options.daily) return `${game.options.daily} · 無猜 · ${game.subtitle()}`;
  return `第 ${game.dealNumber} 局 · ${game.subtitle()}`;
}

// 複製局號：對話框大字顯示純數字並立刻複製到剪貼簿
function showDealCode() {
  const g = current.game;
  const n = String(g.dealNumber);
  const m = showModal({
    title: '局號',
    html: `<p class="deal-code">${n}</p><p class="note deal-note" style="text-align:center">${g.meta.name}・${g.subtitle()}，同模式同難度輸入這個局號會得到同一盤</p><p id="deal-copy-msg" class="note deal-copy-msg"></p>`,
    buttons: [{ label: '關閉' }, { label: '複製', primary: true, noClose: true, onClick: () => copyDealCode() }],
  });
  const copyDealCode = async () => {
    m.el.querySelector('#deal-copy-msg').textContent = (await copyText(n)) ? '已複製' : '無法自動複製，請長按數字選取後拷貝';
  };
  copyDealCode();
}

function showMenu() {
  const g = current.game;
  const isDaily = current.id === 'daily';
  const m = showModal({ title: isDaily ? '每日挑戰' : g.meta.name, html: `<p class="note deal-note">${dealLabel(g)}</p><div class="menu-list"></div>` });
  const list = m.el.querySelector('.menu-list');
  const item = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      m.close();
      fn();
    });
    list.appendChild(b);
  };
  item('回到這局開頭', confirmRestart);
  if (!isDaily) {
    item('複製局號…', showDealCode);
    item('輸入局號…', showDealInput);
  }
  item('規則說明', () => showRules(isDaily ? 'daily' : g.meta.id));
  item('統計', showStats);
  item('設定', showSettings);
  item('回到選單', goHome);
}

// 輸入局號開新局：用目前這局的模式與難度，局號上限 2^31 − 1
function showDealInput() {
  const g = current.game;
  const max = MAX_SEED;
  const digits = String(max).length;
  const m = showModal({
    title: '輸入局號',
    html: `<p>輸入 1 到 ${max} 之間的局號，就能玩到和別人同一盤（${g.meta.name}・${g.subtitle()}）。目前是第 ${g.dealNumber} 局。</p><input id="deal-input" class="deal-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${digits}" autocomplete="off" enterkeyhint="go" placeholder="例如 ${g.dealNumber}"><p id="deal-err" class="field-err"></p>`,
    buttons: [
      { label: '取消' },
      {
        label: '開始',
        primary: true,
        noClose: true,
        onClick: () => {
          const input = m.el.querySelector('#deal-input');
          const v = parseInt(input.value, 10);
          if (!v || v < 1 || v > max) {
            m.el.querySelector('#deal-err').textContent = input.value ? `局號必須在 1 到 ${max} 之間` : '請輸入局號';
            input.classList.add('invalid');
            input.focus();
            input.select();
            return;
          }
          m.close();
          newGame('new', { deal: v, ...levelOptionsOf(g) });
        },
      },
    ],
  });
  const input = m.el.querySelector('#deal-input');
  input.addEventListener('input', () => {
    const clean = input.value.replace(/\D/g, '').slice(0, digits);
    if (clean !== input.value) input.value = clean;
    input.classList.remove('invalid');
    m.el.querySelector('#deal-err').textContent = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') m.el.querySelector('.modal-buttons .btn.primary').click();
  });
  setTimeout(() => input.focus(), 50);
}

function confirmNewGame() {
  const g = current.game;
  if (current.id === 'daily') {
    if (g.moves > 0 && !g.over) confirmRestart();
    else toast('每日挑戰每天只有一盤');
    return;
  }
  const inProgress = g.moves > 0 && !g.over;
  const buttons = [{ label: '取消' }];
  if (inProgress) buttons.push({ label: '回到這局開頭', onClick: restartCurrent });
  buttons.push({ label: '發新局', primary: true, onClick: () => newGame('new') });
  showModal({
    title: '新局',
    html: inProgress
      ? '<p><b>回到這局開頭</b>：同一個盤面重來，不算放棄。<br><b>發新局</b>：目前這局算作放棄，連勝紀錄會歸零。</p>'
      : '',
    buttons,
  });
}

function showHint() {
  if (!current) return;
  const g = current.game;
  if (g.over) return;
  const h = g.hint();
  if (!h) {
    if (g.board.revealed === 0) toast('先隨便點一格開局，第一下不會踩雷');
    else if (g instanceof NoGuess) toast('目前推不出能確定的格子，檢查看看有沒有插錯的旗');
    else toast('目前沒有能確定的格子，只能猜一下了');
    return;
  }
  // 確定是雷：直接幫忙插旗（算一步，可以復原）。問號狀態要按兩次才會變成旗
  if (h.mine != null) {
    for (let k = 0; k < 2 && g.board.state[h.mine] !== FLAG; k++) g.flag(h.mine, settings.question);
  }
  // 先插旗再閃：插旗會重畫格子，閃爍的 class 要加在重畫之後
  renderer.showHint(h);
  if (g.board.revealed === 0 && h.safe === g.startCell) toast('從閃爍的起點開始');
  else toast(h.safe != null ? '綠色的格子確定安全' : '紅色的格子是雷，已幫你插旗');
}

// ---------- 轉向補救 ----------
// iOS 27 加到主畫面、狀態列為 default 時：橫向會隱藏狀態列、視圖長到滿版；轉回直向後視圖縮回狀態列底下，
// 但 WebKit 的觸控座標可能停在橫向的位置，整個畫面要往上一個狀態列高度才點得到。
// 補救：轉向後等尺寸穩定（iOS 會連續回報幾次錯的寬高），把 viewport-fit 切成 auto 再切回 cover，
// 逼 WebKit 重算視口幾何，再捲回原點、強制重排。400 毫秒後再踢一次，避免第一次時狀態列還沒回來。
function installRotationFix() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta || !meta.content.includes('viewport-fit=cover')) return null;
  const original = meta.content;
  // 切回 cover 用 setTimeout 而不是 requestAnimationFrame：頁面不在前景時 rAF 會暫停，meta 就會卡在 auto
  const kick = () => {
    meta.content = original.replace('viewport-fit=cover', 'viewport-fit=auto');
    setTimeout(() => {
      meta.content = original;
      window.scrollTo(0, 0);
      const root = document.documentElement;
      root.style.height = window.innerHeight + 'px';
      void root.offsetHeight;
      root.style.height = '';
      if (renderer) renderer.relayout();
    }, 50);
  };
  let poll = null;
  const onRotate = () => {
    clearInterval(poll);
    let last = null;
    let stable = 0;
    let ticks = 0;
    poll = setInterval(() => {
      const now = `${window.innerWidth}x${window.innerHeight}`;
      stable = now === last ? stable + 1 : 0;
      last = now;
      ticks++;
      if (stable >= 2 || ticks > 20) {
        clearInterval(poll);
        poll = null;
        kick();
        setTimeout(kick, 400);
      }
    }, 100);
  };
  window.addEventListener('orientationchange', onRotate);
  if (screen.orientation) screen.orientation.addEventListener('change', onRotate);
  return kick;
}

// ---------- Service Worker ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      const onWaiting = (sw) => {
        toast('有新版本可用', {
          label: '更新',
          fn: () => sw.postMessage('skipWaiting'),
        }, 15000);
      };
      if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) onWaiting(sw);
        });
      });
    })
    .catch((e) => console.warn('SW 註冊失敗', e));
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    saveCurrent();
    location.reload();
  });
}

// ---------- 啟動 ----------
function init() {
  // 已加入主畫面（獨立模式）時，隱藏「加入主畫面」提示
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  document.body.classList.toggle('standalone', standalone);
  renderer = new Renderer($('#table'), () => settings, { onInvalid: () => Sound.playError() });
  applySettings();

  $('#btn-settings').addEventListener('click', showSettings);
  $('#btn-stats-home').addEventListener('click', showStats);
  $('#btn-back').addEventListener('click', goHome);
  $('#btn-undo').addEventListener('click', () => {
    if (!current || !current.game.undo()) toast('沒有可以復原的步');
  });
  $('#btn-hint').addEventListener('click', showHint);
  $('#btn-flag').addEventListener('click', () => setFlagMode(!flagMode));
  $('#btn-new').addEventListener('click', confirmNewGame);
  $('#btn-menu').addEventListener('click', showMenu);

  document.addEventListener('pointerdown', Sound.primeAudio, { once: true });

  // iPhone Safari 雙擊會放大頁面：第二下快速點擊時取消預設行為
  // 按鈕也一併攔下（CSS touch-action 在某些 iOS 版本不可靠），手指還在按鈕上就由程式補發 click
  // 輸入框、開關、連結除外：它們需要預設行為（對焦、切換）
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 350 && !e.target.closest('input, textarea, select, label, a')) {
        e.preventDefault();
        const btn = e.target.closest('button');
        const t = e.changedTouches && e.changedTouches[0];
        if (btn && t) {
          const r = btn.getBoundingClientRect();
          if (t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom) btn.click();
        }
      }
      lastTouchEnd = now;
    },
    { passive: false }
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTimer();
      saveCurrent();
    } else if (current && current.game.moves > 0 && !current.game.over) {
      startTimer();
    }
  });
  window.addEventListener('pagehide', saveCurrent);
  window.addEventListener('keydown', (e) => {
    if (!current || e.target.closest('input, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (settings.undo) current.game.undo();
    } else if (e.key === 'f' || e.key === 'F') {
      setFlagMode(!flagMode);
    }
  });

  $('#app-version').textContent = `v${APP_VERSION}`;
  renderHome();
  showScreen('home');
  const kick = installRotationFix();
  registerSW();
  // 除錯用：在主控台可透過 __ms.game 取得目前遊戲，__ms.kick() 手動觸發轉向補救；
  // __ms.start（回傳 Promise）與 __ms.renderer 給 scripts/screenshots.mjs 用固定局號開局、調整縮放
  window.__ms = {
    get game() {
      return current && current.game;
    },
    get renderer() {
      return renderer;
    },
    start: startGame,
    kick,
  };
}

init();
