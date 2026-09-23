import { Game } from '../engine.js';
import { Board, REVEALED, FLAG } from '../board.js';
import { deduce, OPEN, MINE } from '../solver.js';

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
  // 格形與難度表，子類別可覆寫（蜂巢模式是六角格、另一組尺寸）
  static shape = 'square';
  static levels = LEVELS;
  // 自訂尺寸的雷數上限，子類別可覆寫（無猜模式比較低）
  static maxMinesFor(w, h) {
    return maxMines(w, h);
  }
  // 由難度選項算出實際的寬、高、雷數（自訂尺寸會被限制在範圍內）
  static resolveSize(o) {
    const lv = this.levels[o.level];
    if (lv) return { level: o.level, w: lv.w, h: lv.h, mines: lv.mines };
    const w = clamp(o.w, CUSTOM_LIMITS.minW, CUSTOM_LIMITS.maxW);
    const h = clamp(o.h, CUSTOM_LIMITS.minH, CUSTOM_LIMITS.maxH);
    const mines = clamp(o.mines, CUSTOM_LIMITS.minMines, this.maxMinesFor(w, h));
    return { level: 'custom', w, h, mines };
  }

  init() {
    // 把實際尺寸寫回 options，存檔與局號分享時才知道是哪一種盤
    const size = this.constructor.resolveSize(this.options);
    Object.assign(this.options, size);
    this.board = new Board(size.w, size.h, size.mines, this.constructor.shape);
    this.layMines();
  }
  layMines() {
    this.board.placeMines(this.rng);
  }
  // 無猜模式的起點格；經典模式沒有
  get startCell() {
    return -1;
  }

  get levelKey() {
    return this.constructor.levels[this.options.level] ? this.options.level : 'custom';
  }
  levelLabel() {
    const lv = this.constructor.levels[this.options.level];
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

  // 提示：用完整的求解器（單格、兩格、全域計數），一次給「一步推理」的結果。
  // 只看已翻開的數字，不信任玩家的旗（旗可能插錯）。這一步推得出安全格就給安全格（翻開才有新資訊）；
  // 只推得出雷，就給一顆還沒插旗的雷（App 會直接幫忙插旗），下一次提示再利用它推出安全格。
  // 推出的雷若玩家都已經插好旗，就記下來繼續推下一步。找不到就回傳 null，表示真的必須猜
  hint() {
    const b = this.board;
    if (b.revealed === 0) return null;
    const know = new Uint8Array(b.n);
    for (let i = 0; i < b.n; i++) if (b.state[i] === REVEALED && !b.mine[i]) know[i] = OPEN;
    for (let guard = 0; guard < b.n; guard++) {
      const d = deduce(b, know, b.mines, { nodeLimit: 300000 });
      if (d.safe.length) return { safe: d.safe[0] };
      const unflagged = d.mines.find((m) => b.state[m] !== FLAG);
      if (unflagged != null) return { mine: unflagged };
      if (!d.mines.length) break;
      for (const m of d.mines) know[m] = MINE;
    }
    return null;
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
}
