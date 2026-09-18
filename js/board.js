// 棋盤模型：格子狀態、佈雷、鄰接數、翻開與洪水填充、插旗、chord、勝負、3BV
// 純邏輯，不碰 DOM；渲染器與遊戲類別都透過這個類別操作盤面

export const HIDDEN = 0;
export const REVEALED = 1;
export const FLAG = 2;
export const QUESTION = 3;

export class Board {
  constructor(w, h, mines) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.mines = mines;
    this.mine = new Uint8Array(this.n); // 1 = 有雷
    this.seedMines = null; // 佈雷當下的雷位，第一下搬雷後要還原時用
    this.count = new Uint8Array(this.n); // 周圍雷數
    this.state = new Uint8Array(this.n); // HIDDEN / REVEALED / FLAG / QUESTION
    this.exploded = -1; // 踩到的那顆雷；-1 表示還沒踩雷
    this.revealed = 0; // 已翻開的安全格數
    this.flags = 0;
    this.relocated = false; // 第一下踩到雷、把雷搬走過
    // 預先算好每格的鄰居，洪水填充與 chord 都很常用
    this.nb = new Array(this.n);
    for (let i = 0; i < this.n; i++) this.nb[i] = this.computeNeighbors(i);
  }

  computeNeighbors(i) {
    const x = i % this.w;
    const y = (i - x) / this.w;
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        out.push(ny * this.w + nx);
      }
    }
    return out;
  }
  index(x, y) {
    return y * this.w + x;
  }
  xy(i) {
    return { x: i % this.w, y: Math.floor(i / this.w) };
  }

  // 佈雷：只由 rng（也就是 seed）決定，同局號同盤面
  placeMines(rng) {
    const idx = new Array(this.n);
    for (let i = 0; i < this.n; i++) idx[i] = i;
    // 部分 Fisher–Yates：只需要抽出前 mines 個
    for (let i = 0; i < this.mines; i++) {
      const j = i + Math.floor(rng() * (this.n - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    this.setMines(idx.slice(0, this.mines));
  }
  // 直接指定雷位（測試與變體用）
  setMines(indices) {
    this.mine.fill(0);
    for (const i of indices) this.mine[i] = 1;
    this.mines = indices.length;
    this.seedMines = Uint8Array.from(this.mine);
    this.relocated = false;
    this.computeCounts();
  }
  computeCounts() {
    for (let i = 0; i < this.n; i++) {
      let c = 0;
      for (const j of this.nb[i]) c += this.mine[j];
      this.count[i] = c;
    }
  }
  // 第一下保證安全（Windows 作法）：點到雷就把那顆雷搬到第一個沒有雷的格子，由左上往右下找。
  // 只看 seed 與點的位置，重播時結果一樣
  ensureSafe(i) {
    if (!this.mine[i]) return false;
    for (let j = 0; j < this.n; j++) {
      if (j !== i && !this.mine[j]) {
        this.mine[j] = 1;
        this.mine[i] = 0;
        this.relocated = true;
        this.computeCounts();
        return true;
      }
    }
    return false;
  }

  canOpen(i) {
    return this.state[i] === HIDDEN || this.state[i] === QUESTION;
  }
  flagsAround(i) {
    let c = 0;
    for (const j of this.nb[i]) if (this.state[j] === FLAG) c++;
    return c;
  }
  hiddenAround(i) {
    let c = 0;
    for (const j of this.nb[i]) if (this.canOpen(j)) c++;
    return c;
  }

  // 翻開一格：踩雷回傳 true；0 的格子會洪水填充把整片空地翻開
  reveal(i) {
    if (!this.canOpen(i)) return false;
    if (this.mine[i]) {
      this.state[i] = REVEALED;
      this.exploded = i;
      return true;
    }
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      if (!this.canOpen(k) || this.mine[k]) continue;
      this.state[k] = REVEALED;
      this.revealed++;
      if (this.count[k] === 0) for (const j of this.nb[k]) if (this.canOpen(j)) stack.push(j);
    }
    return false;
  }
  // 插旗循環：空 → 旗 → （問號）→ 空
  toggleFlag(i, useQuestion) {
    const s = this.state[i];
    if (s === REVEALED) return false;
    if (s === HIDDEN) {
      this.state[i] = FLAG;
      this.flags++;
    } else if (s === FLAG) {
      this.flags--;
      this.state[i] = useQuestion ? QUESTION : HIDDEN;
    } else {
      this.state[i] = HIDDEN;
    }
    return true;
  }
  // chord：點已翻開的數字，周圍旗數等於數字時把其餘未插旗的格子一起翻開；旗插錯就會踩雷
  canChord(i) {
    return this.state[i] === REVEALED && this.count[i] > 0 && this.flagsAround(i) === this.count[i] && this.hiddenAround(i) > 0;
  }
  chord(i) {
    if (!this.canChord(i)) return false;
    for (const j of this.nb[i]) {
      if (this.canOpen(j) && this.reveal(j)) return true;
    }
    return false;
  }

  isWon() {
    return this.exploded < 0 && this.revealed === this.n - this.mines;
  }
  isLost() {
    return this.exploded >= 0;
  }
  minesLeft() {
    return this.mines - this.flags;
  }
  progress() {
    return this.revealed / (this.n - this.mines);
  }

  // 3BV：這一盤最少要點幾下。每一片 0 的空地算 1（點一下全開），其餘不鄰接空地的數字格各算 1
  compute3BV() {
    const seen = new Uint8Array(this.n);
    let bv = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.mine[i] || this.count[i] !== 0 || seen[i]) continue;
      bv++;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        for (const j of this.nb[k]) {
          if (seen[j] || this.mine[j]) continue;
          seen[j] = 1;
          if (this.count[j] === 0) stack.push(j);
        }
      }
    }
    for (let i = 0; i < this.n; i++) if (!this.mine[i] && !seen[i]) bv++;
    return bv;
  }

  // 快照：狀態一格一個字元；雷位只在搬過後才存，沒搬過就由 seed 重建
  serializeState() {
    let st = '';
    for (let i = 0; i < this.n; i++) st += this.state[i];
    return { st, ex: this.exploded, mn: this.relocated ? this.mineList() : null };
  }
  mineList() {
    const out = [];
    for (let i = 0; i < this.n; i++) if (this.mine[i]) out.push(i);
    return out.join(',');
  }
  restoreState(x) {
    if (x.mn != null) {
      this.mine.fill(0);
      for (const s of x.mn.split(',')) if (s !== '') this.mine[Number(s)] = 1;
      this.relocated = true;
      this.computeCounts();
    } else if (this.relocated) {
      this.mine.set(this.seedMines);
      this.relocated = false;
      this.computeCounts();
    }
    this.revealed = 0;
    this.flags = 0;
    for (let i = 0; i < this.n; i++) {
      const s = x.st.charCodeAt(i) - 48;
      this.state[i] = s;
      if (s === REVEALED && !this.mine[i]) this.revealed++;
      if (s === FLAG) this.flags++;
    }
    this.exploded = x.ex;
  }
}
