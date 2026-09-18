import { Game } from '../engine.js';
import { Board, REVEALED, FLAG } from '../board.js';

// 標準三級難度，與 Windows 相同
export const LEVELS = {
  beginner: { label: '初級', w: 9, h: 9, mines: 10 },
  intermediate: { label: '中級', w: 16, h: 16, mines: 40 },
  expert: { label: '高級', w: 30, h: 16, mines: 99 },
};
export const LEVEL_KEYS = ['beginner', 'intermediate', 'expert', 'custom'];
export const CUSTOM_LIMITS = { minW: 5, maxW: 40, minH: 5, maxH: 40, minMines: 1 };
// 自訂雷數上限：(寬−1)×(高−1)，與 Windows 相同，保證第一下附近一定有空位可搬雷
export function maxMines(w, h) {
  return (w - 1) * (h - 1);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

export class Classic extends Game {
  static meta = {
    id: 'classic',
    name: '經典踩地雷',
    en: 'Classic',
    desc: '翻開所有沒有雷的格子。數字是周圍八格的雷數，長按或插旗模式標記地雷。',
  };

  init() {
    const o = this.options;
    const lv = LEVELS[o.level];
    let w, h, mines;
    if (lv) {
      ({ w, h, mines } = lv);
    } else {
      o.level = 'custom';
      w = clamp(o.w, CUSTOM_LIMITS.minW, CUSTOM_LIMITS.maxW);
      h = clamp(o.h, CUSTOM_LIMITS.minH, CUSTOM_LIMITS.maxH);
      mines = clamp(o.mines, CUSTOM_LIMITS.minMines, maxMines(w, h));
    }
    // 把實際尺寸寫回 options，存檔與局號分享時才知道是哪一種盤
    o.w = w;
    o.h = h;
    o.mines = mines;
    this.board = new Board(w, h, mines);
    this.board.placeMines(this.rng);
  }

  get levelKey() {
    return LEVELS[this.options.level] ? this.options.level : 'custom';
  }
  levelLabel() {
    const lv = LEVELS[this.options.level];
    return lv ? lv.label : '自訂';
  }
  subtitle() {
    const o = this.options;
    return `${this.levelLabel()} ${o.w}×${o.h} · ${o.mines} 雷`;
  }

  extraState() {
    return this.board.serializeState();
  }
  restoreExtra(x) {
    this.board.restoreState(x);
  }
  isWon() {
    return this.board.isWon();
  }
  isLost() {
    return this.board.isLost();
  }

  // ---- 三種動作 ----
  // 翻開；第一下若踩到雷會先把雷搬走（只在還沒翻開任何格子時）
  reveal(i) {
    const b = this.board;
    if (this.over || !b.canOpen(i)) return false;
    return this.commit(
      () => {
        if (b.revealed === 0) b.ensureSafe(i);
        b.reveal(i);
      },
      { t: 'r', i }
    );
  }
  // 插旗循環。q 記在動作裡，重播時才知道當時有沒有開問號
  flag(i, useQuestion) {
    const b = this.board;
    if (this.over || b.state[i] === REVEALED) return false;
    const q = useQuestion ? 1 : 0;
    return this.commit(() => b.toggleFlag(i, !!q), { t: 'f', i, q });
  }
  chord(i) {
    const b = this.board;
    if (this.over || !b.canChord(i)) return false;
    return this.commit(() => b.chord(i), { t: 'c', i });
  }
  applyAction(a) {
    switch (a.t) {
      case 'r':
        return this.reveal(a.i);
      case 'f':
        return this.flag(a.i, !!a.q);
      case 'c':
        return this.chord(a.i);
      default:
        return super.applyAction(a);
    }
  }

  // 提示：只用「單格推論」找一格確定安全或確定是雷的格子，找不到就回傳 null（表示要猜）
  // 先找安全格，因為翻開安全格才會有新資訊
  hint() {
    const b = this.board;
    if (b.revealed === 0) return null;
    let mineHint = null;
    for (let i = 0; i < b.n; i++) {
      if (b.state[i] !== REVEALED || b.count[i] === 0) continue;
      const hidden = b.nb[i].filter((j) => b.canOpen(j));
      if (!hidden.length) continue;
      const flags = b.flagsAround(i);
      if (flags === b.count[i]) return { safe: hidden[0] };
      if (!mineHint && flags + hidden.length === b.count[i]) mineHint = { mine: hidden[0] };
    }
    return mineHint;
  }

  progress() {
    return this.board.progress();
  }
  bv3() {
    return this.board.compute3BV();
  }
  minesLeft() {
    return this.board.minesLeft();
  }
  // 提示用：目前有沒有插錯的旗（給提示按鈕判斷要不要提醒）
  wrongFlags() {
    const b = this.board;
    let n = 0;
    for (let i = 0; i < b.n; i++) if (b.state[i] === FLAG && !b.mine[i]) n++;
    return n;
  }
}
