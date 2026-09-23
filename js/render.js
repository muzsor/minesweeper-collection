// 棋盤渲染與觸控。分兩層：
// - Renderer：點一下翻開、長按或右鍵插旗、點數字 chord、插旗模式、單指拖曳捲動、雙指縮放、Ctrl+滾輪縮放、
//   提示與回饋。這些都跟格子形狀無關
// - 格形畫法（SquareView 方格、HexView 六角格）：負責建立格子、排版與畫出每一格的狀態
//
// 直轉：盤面比畫面「更橫」時（例如直向手機開 30×16 的高級），整個盤面的排列轉 90 度，讓格子大很多。
// 只轉格子的位置，不轉任何圖形，所以數字、旗子、地雷永遠是正的；盤面資料、局號、存檔都不受影響。
// 轉法：邏輯座標 (x, y) 畫到畫面上的 (高 − 1 − y, x)，也就是順時針轉 90 度

import { HIDDEN, REVEALED, FLAG, QUESTION } from './board.js';

const MAX_CS = 44; // 自動排版時格子的最大邊長（px；六角格是兩條平行邊的距離）
const FIT_MIN = 22; // 整盤放得下時可接受的最小格子；再小就改成捲動
const MIN_ZOOM = 12; // 手動縮放的下限：縮到能一眼看完整盤
const MAX_ZOOM = 80; // 手動縮放的上限
const LONG_PRESS_MS = 350;
const MOVE_CANCEL_PX = 8; // 手指移動超過這個距離就當成拖曳，不算點也不算長按
const ROTATE_GAIN = 1.08; // 轉過去格子至少要大 8% 才轉，接近正方形的盤面不會來回切換
const HINT_MS = 1800; // 提示閃爍的總長：0.6 秒一下、閃三下，要和 style.css 的 hint 動畫一致
const HOVER_MS = 350; // 滑鼠停在數字上多久才標出範圍，快速劃過不會一直閃

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- 方格：CSS grid，每格一個 div ----
class SquareView {
  constructor(board, root) {
    this.b = board;
    this.root = root;
    this.rot = null;
    this.cells = new Array(board.n);
  }
  build() {
    this.root.classList.add('sq');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.b.n; i++) {
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.i = i;
      frag.appendChild(d);
      this.cells[i] = d;
    }
    this.root.appendChild(frag);
  }
  // 盤面大小，以格子邊長為單位
  extent(rot) {
    return rot ? { w: this.b.h, h: this.b.w } : { w: this.b.w, h: this.b.h };
  }
  place(rot) {
    if (this.rot === rot) return;
    this.rot = rot;
    const { w, h } = this.b;
    this.root.style.gridTemplateColumns = `repeat(${rot ? h : w}, var(--cs))`;
    for (let i = 0; i < this.b.n; i++) {
      const x = i % w;
      const y = (i - x) / w;
      const el = this.cells[i];
      el.style.gridColumn = String((rot ? h - 1 - y : x) + 1);
      el.style.gridRow = String((rot ? x : y) + 1);
    }
  }
  setCs(cs) {
    this.root.style.setProperty('--cs', cs + 'px');
  }
  setCell(i, state, txt) {
    const el = this.cells[i];
    el.className = 'cell' + state;
    el.textContent = txt;
  }
}

// ---- 六角格：SVG，每格一個 <g>（六邊形 + 文字） ----
// 尖頂朝上、奇數列往右錯半格。座標單位 U = 一格的寬（兩條平行邊的距離），外接圓半徑 R = U / √3。
// 用 SVG 的好處：點擊範圍就是六邊形本身，縮放時只改 svg 的寬高，邊線和數字都不會糊
const U = 100; // 用 100 當單位而不是 1，避免瀏覽器對極小字級另外處理
const R = U / Math.sqrt(3);
const HEX_OFFSETS = [0, 1, 2, 3, 4, 5].map((k) => {
  const a = (Math.PI / 180) * (60 * k - 90); // 尖頂朝上：第一個頂點在正上方
  return [Math.cos(a) * R * 0.97, Math.sin(a) * R * 0.97]; // 縮一點點，格子之間留細縫
});

class HexView {
  constructor(board, root) {
    this.b = board;
    this.root = root;
    this.rot = null;
    this.cells = new Array(board.n);
    this.texts = new Array(board.n);
    const { w, h } = board;
    this.W = w * U + (h > 1 ? U / 2 : 0); // 沒轉時的總寬
    this.H = 2 * R + (h - 1) * 1.5 * R; // 沒轉時的總高
  }
  build() {
    this.root.classList.add('hxb');
    this.svg = document.createElementNS(SVG_NS, 'svg');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.b.n; i++) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'hx');
      g.dataset.i = i;
      const poly = document.createElementNS(SVG_NS, 'polygon');
      const text = document.createElementNS(SVG_NS, 'text');
      g.append(poly, text);
      frag.appendChild(g);
      this.cells[i] = g;
      this.texts[i] = text;
    }
    this.svg.appendChild(frag);
    this.root.appendChild(this.svg);
  }
  extent(rot) {
    return rot ? { w: this.H / U, h: this.W / U } : { w: this.W / U, h: this.H / U };
  }
  place(rot) {
    if (this.rot === rot) return;
    this.rot = rot;
    const { w } = this.b;
    const e = this.extent(rot);
    this.svg.setAttribute('viewBox', `0 0 ${e.w * U} ${e.h * U}`);
    for (let i = 0; i < this.b.n; i++) {
      const x = i % w;
      const y = (i - x) / w;
      let cx = x * U + U / 2 + (y % 2 ? U / 2 : 0);
      let cy = R + y * 1.5 * R;
      // 轉 90 度：點 (px, py) → (總高 − py, px)，頂點偏移 (dx, dy) → (−dy, dx)，尖頂朝上變成平頂朝上
      if (rot) [cx, cy] = [this.H - cy, cx];
      const pts = HEX_OFFSETS.map(([dx, dy]) => (rot ? [cx - dy, cy + dx] : [cx + dx, cy + dy]));
      const g = this.cells[i];
      g.firstChild.setAttribute('points', pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));
      const t = this.texts[i];
      t.setAttribute('x', cx.toFixed(1));
      t.setAttribute('y', cy.toFixed(1));
    }
  }
  setCs(cs) {
    const e = this.extent(this.rot);
    this.svg.setAttribute('width', Math.round(e.w * cs));
    this.svg.setAttribute('height', Math.round(e.h * cs));
  }
  setCell(i, state, txt) {
    this.cells[i].setAttribute('class', 'hx' + state);
    // SVG 沒有 ::after，起點用一個圓點字元畫
    this.texts[i].textContent = state.includes(' start') ? '●' : txt;
  }
}

export class Renderer {
  constructor(tableEl, getSettings, hooks = {}) {
    this.el = tableEl; // 捲動容器
    this.getSettings = getSettings;
    this.hooks = hooks; // onInvalid()
    this.game = null;
    this.view = null;
    this.board = document.createElement('div');
    this.board.className = 'board';
    this.el.appendChild(this.board);
    this.cache = [];
    this.cs = 0; // 目前的格子大小（px）
    this.userCs = null; // 玩家縮放過的大小；null 表示照自動排版
    this.rot = false; // 目前盤面是否轉了 90 度
    this.peeking = null; // 長按或滑鼠停在數字上時標出的範圍（格子編號）
    this.hoverCell = -1; // 滑鼠目前停在哪一格
    this.hoverTimer = null;
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
    this.board.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pointers.size) this.cancelHover();
    });
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

  get cells() {
    return this.view ? this.view.cells : [];
  }

  setGame(game) {
    this.cancelPress();
    this.cancelHover();
    this.game = game;
    this.pointers.clear();
    this.pinch = null;
    this.userCs = null;
    this.board.innerHTML = '';
    this.board.className = 'board';
    this.board.style.gridTemplateColumns = '';
    this.setFlagMode(false);
    const b = game.board;
    this.view = b.shape === 'hex' ? new HexView(b, this.board) : new SquareView(b, this.board);
    this.view.build();
    this.cache = new Array(b.n).fill('');
    this.rot = false;
    // 盤面一變就收起範圍標示：重畫會換掉格子的 class，留著只會剩一半
    game.on('change', () => {
      this.endPeek();
      this.paint();
    });
    this.relayout();
    this.paint();
    this.el.scrollTo(0, 0);
  }

  // 自動排版：決定要不要直轉，再讓格子盡量塞滿畫面，但不小於手指點得準的尺寸；放不下就讓容器捲動。
  // 玩家縮放過就照他的大小；轉向改變時縮放重來
  relayout() {
    if (!this.game) return;
    const W = this.el.clientWidth - 12;
    const H = this.el.clientHeight - 12;
    if (W <= 0 || H <= 0) return;
    const fit = (rot) => {
      const e = this.view.extent(rot);
      return Math.min(W / e.w, H / e.h);
    };
    const f0 = fit(false);
    const f1 = fit(true);
    const rot = this.rot ? f0 * ROTATE_GAIN < f1 : f1 > f0 * ROTATE_GAIN;
    if (rot !== this.rot) {
      this.rot = rot;
      this.userCs = null;
    }
    this.view.place(rot);
    let cs;
    if (this.userCs != null) {
      cs = this.userCs;
    } else {
      // 縮到 FIT_MIN 就能整盤放下時就整盤放下（不必捲動最好點）；放不下反正要捲，就維持手指點得準的大小
      cs = Math.floor(Math.min(rot ? f1 : f0, MAX_CS));
      if (cs < FIT_MIN) cs = this.coarse ? 26 : FIT_MIN;
    }
    this.applyCs(cs);
  }
  applyCs(cs) {
    this.cs = cs;
    this.view.setCs(cs);
    const e = this.view.extent(this.rot);
    this.el.classList.toggle('scrollable', cs * e.w > this.el.clientWidth - 12 || cs * e.h > this.el.clientHeight - 12);
  }
  // 縮放到指定格子大小，並讓手指（fx, fy）底下的那一格留在原地
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
    // 無猜模式開局前標出起點格（經典模式 startCell 是 −1）
    const start = b.revealed === 0 && !g.over ? g.startCell : -1;
    for (let i = 0; i < b.n; i++) {
      const s = b.state[i];
      let cls = '';
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
      if (i === start && s === HIDDEN) cls += ' start';
      const key = cls + '|' + txt;
      if (this.cache[i] !== key) {
        this.cache[i] = key;
        this.view.setCell(i, cls, txt);
      }
    }
  }

  setFlagMode(v) {
    this.flagMode = !!v;
    this.board.classList.toggle('flag-mode', this.flagMode);
  }

  // ---- 指標事件 ----
  cellIndex(e) {
    const t = e.target.closest('[data-i]');
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
    const isNumber = this.isNumber(i);
    this.cancelHover();
    if (e.button === 2) {
      // 滑鼠右鍵：和 Windows 經典一樣只負責插旗；按在已翻開的格子上不做任何事
      this.cancelPress();
      if (i >= 0 && !this.game.over && this.game.board.state[i] !== REVEALED) this.doFlag(i);
      return;
    }
    if (e.button !== 0) return;
    this.cancelPress();
    const p = { id: e.pointerId, i, x: e.clientX, y: e.clientY, moved: false, done: false, timer: null, peek: false };
    // 長按只給觸控與觸控筆：插旗，或在數字上看範圍。滑鼠照 Windows 經典，左鍵放開就是翻開（或 chord）
    if (i >= 0 && !this.game.over && e.pointerType !== 'mouse') {
      p.timer = setTimeout(() => {
        p.timer = null;
        if (p.moved) return;
        p.done = true; // 長按已處理，放開時不再當成點一下（數字不會 chord）
        if (isNumber) {
          p.peek = true;
          this.startPeek(i);
        } else {
          this.doFlag(i);
        }
        this.buzz();
      }, LONG_PRESS_MS);
    }
    this.press = p;
  }

  isNumber(i) {
    const b = this.game && this.game.board;
    return !!b && i >= 0 && b.state[i] === REVEALED && !b.mine[i] && b.count[i] > 0;
  }

  // 滑鼠停在已翻開的數字上一下子，就標出它的範圍；移到別格或離開盤面就消失（只處理沒按鍵的滑鼠移動）
  onHover(e) {
    const i = this.cellIndex(e);
    if (i === this.hoverCell) return;
    this.cancelHover();
    this.hoverCell = i;
    if (!this.isNumber(i) || this.game.over) return;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (this.hoverCell === i && this.isNumber(i)) this.startPeek(i);
    }, HOVER_MS);
  }
  cancelHover() {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverCell = -1;
    this.endPeek();
  }

  // 標出一個數字「算的是哪些格子」：它自己與所有鄰居（方格九格、六角格七格），放開手指或移開滑鼠才消失
  startPeek(i) {
    this.endPeek();
    const area = [...this.game.board.nb[i], i];
    for (const j of area) this.cells[j].classList.add(j === i ? 'peek-center' : 'peek');
    // SVG 後畫的蓋在上面：把範圍內的六角格移到最後，黃色外框才不會被旁邊的格子壓住
    if (this.view instanceof HexView) for (const j of area) this.cells[j].parentNode.appendChild(this.cells[j]);
    this.peeking = area;
  }
  endPeek() {
    if (!this.peeking) return;
    for (const j of this.peeking) this.cells[j].classList.remove('peek', 'peek-center');
    this.peeking = null;
  }
  onMove(e) {
    if (e.pointerType === 'mouse' && e.buttons === 0 && !this.pointers.has(e.pointerId)) {
      this.onHover(e);
      return;
    }
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
    if (p.peek) this.endPeek();
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
    this.endPeek();
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
  // 動畫 class 先拿掉、強制重排、再加回來，連按兩次提示也會重播動畫（getBoundingClientRect 方格與 SVG 都適用）
  flash(el, cls, ms) {
    el.classList.remove(cls);
    el.getBoundingClientRect();
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  showHint(h) {
    if (!h) return false;
    const i = h.safe != null ? h.safe : h.mine;
    const el = this.cells[i];
    if (!el) return false;
    if (this.el.classList.contains('scrollable')) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    // SVG 後畫的蓋在上面：提示的六角格移到最後，外框才不會被旁邊的格子壓住
    if (this.view instanceof HexView) el.parentNode.appendChild(el);
    el.classList.remove('hint-safe', 'hint-mine');
    this.flash(el, h.safe != null ? 'hint-safe' : 'hint-mine', HINT_MS);
    return true;
  }
  nudge(i) {
    const el = this.cells[i];
    if (el) this.flash(el, 'nudge', 300);
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
