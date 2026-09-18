// 棋盤渲染與觸控：格子 DOM、點一下翻開、長按或右鍵插旗、點數字 chord、插旗模式、
// 單指拖曳捲動、雙指縮放（自己處理，不走瀏覽器的頁面縮放，標題列與按鈕列不會跟著變）、Ctrl+滾輪縮放

import { REVEALED, FLAG, QUESTION } from './board.js';

const MAX_CS = 44; // 自動排版時格子的最大邊長（px）
const MIN_ZOOM = 12; // 手動縮放的下限：縮到能一眼看完整盤
const MAX_ZOOM = 80; // 手動縮放的上限
const LONG_PRESS_MS = 350;
const MOVE_CANCEL_PX = 8; // 手指移動超過這個距離就當成拖曳，不算點也不算長按

export class Renderer {
  constructor(tableEl, getSettings, hooks = {}) {
    this.el = tableEl; // 捲動容器
    this.getSettings = getSettings;
    this.hooks = hooks; // onInvalid()
    this.game = null;
    this.board = document.createElement('div');
    this.board.className = 'board';
    this.el.appendChild(this.board);
    this.cells = [];
    this.cache = [];
    this.cs = 0; // 目前格子邊長
    this.userCs = null; // 玩家縮放過的邊長；null 表示照自動排版
    this.flagMode = false;
    this.press = null; // 單指：{ id, i, x, y, moved, done, timer }
    this.pointers = new Map(); // 目前按著的指標
    this.pinch = null; // 雙指縮放：{ startDist, startCs }
    // 觸控裝置的格子要大到手指點得準
    this.coarse = window.matchMedia('(pointer: coarse)').matches;

    this.board.addEventListener('pointerdown', (e) => this.onDown(e));
    this.board.addEventListener('pointermove', (e) => this.onMove(e));
    this.board.addEventListener('pointerup', (e) => this.onUp(e));
    this.board.addEventListener('pointercancel', (e) => this.onCancel(e));
    // 右鍵插旗、長按插旗都不要跳出系統選單
    this.board.addEventListener('contextmenu', (e) => e.preventDefault());
    // 桌機：Ctrl（Mac 是 ⌘）加滾輪縮放
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!this.game || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.zoomTo(this.cs * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
      },
      { passive: false }
    );
    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(this.el);
  }

  setGame(game) {
    this.game = game;
    this.cancelPress();
    this.pointers.clear();
    this.pinch = null;
    this.userCs = null;
    this.board.innerHTML = '';
    this.board.className = 'board';
    this.setFlagMode(false);
    const b = game.board;
    this.board.style.gridTemplateColumns = `repeat(${b.w}, var(--cs))`;
    this.cells = new Array(b.n);
    this.cache = new Array(b.n).fill('');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < b.n; i++) {
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.i = i;
      frag.appendChild(d);
      this.cells[i] = d;
    }
    this.board.appendChild(frag);
    game.on('change', () => this.paint());
    this.relayout();
    this.paint();
    this.el.scrollTo(0, 0);
  }

  // 自動排版：盡量塞滿畫面，但不小於手指點得準的尺寸；放不下就讓容器捲動。玩家縮放過就照他的
  relayout() {
    if (!this.game) return;
    const b = this.game.board;
    const W = this.el.clientWidth - 12;
    const H = this.el.clientHeight - 12;
    if (W <= 0 || H <= 0) return;
    let cs;
    if (this.userCs != null) {
      cs = this.userCs;
    } else {
      const min = this.coarse ? 26 : 22;
      cs = Math.floor(Math.min(W / b.w, H / b.h, MAX_CS));
      if (cs < min) cs = min;
    }
    this.applyCs(cs);
  }
  applyCs(cs) {
    this.cs = cs;
    this.board.style.setProperty('--cs', cs + 'px');
    const b = this.game.board;
    this.el.classList.toggle('scrollable', cs * b.w > this.el.clientWidth - 12 || cs * b.h > this.el.clientHeight - 12);
  }
  // 縮放到指定格子邊長，並讓手指（fx, fy）底下的那一格留在原地
  zoomTo(cs, fx, fy) {
    cs = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(cs)));
    if (!this.game || cs === this.cs) return;
    const before = this.board.getBoundingClientRect();
    const bx = (fx - before.left) / this.cs; // 焦點在盤面上的位置，以格為單位
    const by = (fy - before.top) / this.cs;
    this.userCs = cs;
    this.applyCs(cs);
    const after = this.board.getBoundingClientRect(); // 重排後（margin:auto 可能變）
    this.el.scrollLeft += after.left + bx * cs - fx;
    this.el.scrollTop += after.top + by * cs - fy;
  }

  // 依盤面狀態更新每一格；只改有變的格子
  paint() {
    const g = this.game;
    if (!g) return;
    const b = g.board;
    const lost = g.lost;
    const won = g.won;
    this.board.classList.toggle('lost', lost);
    this.board.classList.toggle('over', g.over);
    for (let i = 0; i < b.n; i++) {
      const s = b.state[i];
      let cls = 'cell';
      let txt = '';
      if (s === REVEALED) {
        if (b.mine[i]) {
          cls += i === b.exploded ? ' open boom' : ' open mine';
          txt = '💣';
        } else {
          cls += ' open';
          if (b.count[i]) {
            cls += ' n' + b.count[i];
            txt = String(b.count[i]);
          }
        }
      } else if (s === FLAG) {
        if (lost && !b.mine[i]) {
          cls += ' flag wrong'; // 插錯的旗
          txt = '✕';
        } else {
          cls += ' flag';
          txt = '🚩';
        }
      } else if (s === QUESTION) {
        cls += ' q';
        txt = '?';
      } else if (lost && b.mine[i]) {
        cls += ' mine'; // 輸了：把沒找到的雷亮出來
        txt = '💣';
      } else if (won && b.mine[i]) {
        cls += ' flag'; // 贏了：剩下的雷自動插旗
        txt = '🚩';
      }
      const key = cls + '|' + txt;
      if (this.cache[i] !== key) {
        this.cache[i] = key;
        const el = this.cells[i];
        el.className = cls;
        el.textContent = txt;
      }
    }
  }

  setFlagMode(v) {
    this.flagMode = !!v;
    this.board.classList.toggle('flag-mode', this.flagMode);
  }

  // ---- 指標事件 ----
  cellIndex(e) {
    const t = e.target.closest('.cell');
    return t ? Number(t.dataset.i) : -1;
  }
  onDown(e) {
    if (!this.game) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 捕捉指標：手指滑出格子再放開也收得到 pointerup
    try {
      this.board.setPointerCapture(e.pointerId);
    } catch {}
    if (this.pointers.size === 2) {
      // 第二根手指下來：取消點與長按，改成縮放
      this.cancelPress();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { startDist: Math.hypot(a.x - b.x, a.y - b.y), startCs: this.cs };
      return;
    }
    if (this.pointers.size > 2 || this.pinch) return;
    const i = this.cellIndex(e);
    if (e.button === 2) {
      // 滑鼠右鍵：直接插旗
      this.cancelPress();
      if (i >= 0 && !this.game.over) this.doFlag(i);
      return;
    }
    if (e.button !== 0) return;
    this.cancelPress();
    const p = { id: e.pointerId, i, x: e.clientX, y: e.clientY, moved: false, done: false, timer: null };
    if (i >= 0 && !this.game.over) {
      p.timer = setTimeout(() => {
        p.timer = null;
        if (p.moved) return;
        p.done = true; // 長按已處理，放開時不再當成點一下
        this.doFlag(i);
        this.buzz();
      }, LONG_PRESS_MS);
    }
    this.press = p;
  }
  onMove(e) {
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    const prev = { x: pt.x, y: pt.y };
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (this.pinch) {
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch.startDist > 0) this.zoomTo((this.pinch.startCs * d) / this.pinch.startDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      return;
    }
    const p = this.press;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.hypot(pt.x - p.x, pt.y - p.y) > MOVE_CANCEL_PX) {
      p.moved = true;
      this.clearTimer(p);
    }
    // 單指拖曳：捲動容器
    if (p.moved) {
      this.el.scrollLeft -= pt.x - prev.x;
      this.el.scrollTop -= pt.y - prev.y;
    }
  }
  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      // 縮放結束：剩下的那根手指不算點
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const p = this.press;
    if (!p || p.id !== e.pointerId) return;
    this.press = null;
    this.clearTimer(p);
    if (p.done || p.moved || p.i < 0 || this.game.over) return;
    this.doTap(p.i);
  }
  onCancel(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    if (this.press && this.press.id === e.pointerId) this.cancelPress();
  }
  cancelPress() {
    if (this.press) {
      this.clearTimer(this.press);
      this.press = null;
    }
  }
  clearTimer(p) {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
  }

  // 點一下：已翻開的數字是 chord；插旗模式下是插旗；一般模式下翻開；點旗子不動（要長按才拔，避免誤觸）
  doTap(i) {
    const g = this.game;
    const b = g.board;
    const s = b.state[i];
    let ok;
    if (s === REVEALED) ok = g.chord(i);
    else if (this.flagMode) ok = g.flag(i, this.getSettings().question);
    else if (s === FLAG) ok = false;
    else ok = g.reveal(i);
    if (!ok && s !== REVEALED) this.invalid(i);
  }
  doFlag(i) {
    const g = this.game;
    if (g.over) return;
    if (!g.flag(i, this.getSettings().question)) this.invalid(i);
  }
  invalid(i) {
    this.nudge(i);
    this.hooks.onInvalid && this.hooks.onInvalid();
  }
  buzz() {
    if (this.getSettings().vibrate && navigator.vibrate) {
      try {
        navigator.vibrate(15);
      } catch {}
    }
  }

  // ---- 提示與回饋 ----
  showHint(h) {
    if (!h) return false;
    const i = h.safe != null ? h.safe : h.mine;
    const el = this.cells[i];
    if (!el) return false;
    if (this.el.classList.contains('scrollable')) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    const cls = h.safe != null ? 'hint-safe' : 'hint-mine';
    el.classList.remove('hint-safe', 'hint-mine');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1600);
    return true;
  }
  nudge(i) {
    const el = this.cells[i];
    if (!el) return;
    el.classList.remove('nudge');
    void el.offsetWidth;
    el.classList.add('nudge');
    setTimeout(() => el.classList.remove('nudge'), 300);
  }
  // 勝利：格子由左上往右下依序跳一下
  celebrate() {
    if (!this.game) return;
    const b = this.game.board;
    for (let i = 0; i < b.n; i++) {
      const { x, y } = b.xy(i);
      this.cells[i].style.setProperty('--d', `${(x + y) * 25}ms`);
    }
    this.board.classList.add('won');
  }
}
