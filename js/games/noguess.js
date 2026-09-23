import { Classic } from './classic.js';
import { generateNoGuess, encodeLayout, decodeLayout } from '../solver.js';

// 無猜模式的自訂雷數上限：盤面的 21%（高級 30×16 放 99 顆約 20.6%，剛好在內）
// 雷越密越難產生不用猜的盤面，太密時可能怎麼試都找不到。起點與周圍一圈必須沒有雷
export const NOGUESS_DENSITY = 0.21;
export function noGuessMaxMines(w, h, shape = 'square') {
  return Math.min(Math.floor(w * h * NOGUESS_DENSITY), w * h - (shape === 'hex' ? 7 : 9));
}

// 無猜踩地雷：規則、操作與經典完全相同，只差盤面怎麼產生。
// 盤面由 solver.js 產生，保證從標示的起點開始只靠推理就能解完。
// 產生好的盤面（起點與雷位）存在 options.layout：存檔重開、回到開頭都直接用，不必重新產生。
// 沒有 layout 時（例如單元測試）才在這裡同步產生；App 會先在 Web Worker 產生好再建立遊戲，避免畫面卡住
export class NoGuess extends Classic {
  static meta = {
    id: 'noguess',
    name: '無猜踩地雷',
    en: 'No Guess',
    desc: '保證只靠推理就能解完，不必賭運氣。從亮起的起點格開局。',
  };
  static needsLayout = true; // App 看到這個就先在背景產生盤面
  static maxMinesFor(w, h) {
    return noGuessMaxMines(w, h, this.shape);
  }

  layMines() {
    const b = this.board;
    if (!this.options.layout) this.options.layout = encodeLayout(generateNoGuess(b.w, b.h, b.mines, this.seed, b.shape));
    const { start, mines } = decodeLayout(this.options.layout);
    b.setMines(mines);
    this.start = start;
  }
  get startCell() {
    return this.start;
  }

  // 第一下只能點起點：從別的地方開局就得靠運氣，無猜的保證只對起點成立
  reveal(i) {
    if (!this.over && this.board.revealed === 0 && i !== this.start) {
      this.emit('message', '先點亮起的起點格，無猜盤面從那裡開始');
      return false;
    }
    return super.reveal(i);
  }

  hint() {
    if (this.board.revealed === 0) return { safe: this.start };
    return super.hint();
  }
}
