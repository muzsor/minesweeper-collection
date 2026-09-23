// 踩地雷求解器與無猜盤面產生器：純邏輯、不碰 DOM，主執行緒（提示）與 Web Worker（產生盤面）共用
//
// 求解器由淺到深三層，某一層推得出來就不往下：
//   1. 單格：一個數字周圍剩下的雷數等於 0 或等於未知格數
//   2. 兩格：比較相鄰兩個數字的共同鄰居（1-2-1、1-2-2-1 這類型態）
//   3. 全域：列舉邊界所有合法的雷位組合，再配合整盤剩幾顆雷判斷
// 推論一定正確（只會推出所有可能情況下都成立的結論），所以「求解器能從起點一路解完」就代表這盤不用猜

import { Board } from './board.js';
import { mulberry32 } from './rng.js';

export const UNKNOWN = 0;
export const OPEN = 1;
export const MINE = 2; // 已推出的雷（不是玩家插的旗）

const ABORT = {};

// 從目前的資訊推出確定安全、確定是雷的格子
// board：用它的 n、nb（鄰居）與 count（只讀已翻開格的數字）
// know：每格 UNKNOWN / OPEN / MINE
// totalMines：整盤雷數，全域那層要用
// opts.nodeLimit：全域列舉最多走幾個節點，超過就放棄這層（避免卡住）；opts.global === false 只用前兩層
// 回傳 { safe, mines, level }，推不出來時兩個陣列都是空的、level 為 0
export function deduce(board, know, totalMines, opts = {}) {
  const cs = constraints(board, know);
  return (
    single(cs) ||
    pairs(cs) ||
    (opts.global === false ? null : global(board, know, cs, totalMines, opts.nodeLimit || 100000)) || { safe: [], mines: [], level: 0 }
  );
}

// 每個已翻開、周圍還有未知格的數字，變成一條「這些格子裡剛好有 rem 顆雷」的限制
function constraints(board, know) {
  const out = [];
  for (let i = 0; i < board.n; i++) {
    if (know[i] !== OPEN) continue;
    let rem = board.count[i];
    const cells = [];
    for (const j of board.nb[i]) {
      if (know[j] === MINE) rem--;
      else if (know[j] === UNKNOWN) cells.push(j);
    }
    if (cells.length) out.push({ cells, rem });
  }
  return out;
}

function result(safe, mines, level) {
  return safe.size || mines.size ? { safe: [...safe], mines: [...mines], level } : null;
}

// ---- 第 1 層：單格 ----
function single(cs) {
  const safe = new Set();
  const mines = new Set();
  for (const c of cs) {
    if (c.rem === 0) c.cells.forEach((j) => safe.add(j));
    else if (c.rem === c.cells.length) c.cells.forEach((j) => mines.add(j));
  }
  return result(safe, mines, 1);
}

// ---- 第 2 層：兩格 ----
// A、B 兩條限制有共同格 I：I 裡的雷數必在 [lo, hi]，由此推出「只屬於 A」與「只屬於 B」的格子的雷數範圍
function pairs(cs) {
  const byCell = new Map();
  cs.forEach((c, k) => {
    c.set = new Set(c.cells);
    for (const j of c.cells) {
      if (!byCell.has(j)) byCell.set(j, []);
      byCell.get(j).push(k);
    }
  });
  const safe = new Set();
  const mines = new Set();
  const apply = (cells, minM, maxM) => {
    if (!cells.length) return;
    if (maxM === 0) cells.forEach((x) => safe.add(x));
    else if (minM === cells.length) cells.forEach((x) => mines.add(x));
  };
  for (let a = 0; a < cs.length; a++) {
    const A = cs[a];
    const seen = new Set();
    for (const j of A.cells) {
      for (const b of byCell.get(j)) {
        if (b <= a || seen.has(b)) continue;
        seen.add(b);
        const B = cs[b];
        const onlyA = A.cells.filter((x) => !B.set.has(x));
        const onlyB = B.cells.filter((x) => !A.set.has(x));
        const inter = A.cells.filter((x) => B.set.has(x));
        const lo = Math.max(0, A.rem - onlyA.length, B.rem - onlyB.length);
        const hi = Math.min(inter.length, A.rem, B.rem);
        if (lo > hi) continue; // 資訊互相矛盾（不會發生在真的盤面上），略過
        apply(inter, lo, hi);
        apply(onlyA, A.rem - hi, A.rem - lo);
        apply(onlyB, B.rem - hi, B.rem - lo);
      }
    }
  }
  return result(safe, mines, 2);
}

// ---- 第 3 層：全域列舉 ----
// 邊界格（跟某個數字相鄰的未知格）依限制分成互不相干的幾群，每群各自列舉所有合法組合，
// 記下「有 k 顆雷時，每格可能是雷嗎、可能安全嗎」。再用總雷數把各群的 k 湊起來：
// 各群雷數總和 S 必須落在 [R − 內部格數, R]，剩下的 R − S 顆由不跟任何數字相鄰的內部格吸收
function global(board, know, cs, totalMines, nodeLimit) {
  const local = new Map(); // 邊界格 → 編號
  const frontier = [];
  for (const c of cs) {
    for (const j of c.cells) {
      if (!local.has(j)) {
        local.set(j, frontier.length);
        frontier.push(j);
      }
    }
  }
  let knownMines = 0;
  const interior = [];
  for (let i = 0; i < board.n; i++) {
    if (know[i] === MINE) knownMines++;
    else if (know[i] === UNKNOWN && !local.has(i)) interior.push(i);
  }
  const R = totalMines - knownMines;
  const N = interior.length;
  if (R < 0) return null;
  if (!frontier.length) {
    if (!N) return null;
    if (R === 0) return { safe: interior, mines: [], level: 3 };
    if (R === N) return { safe: [], mines: interior, level: 3 };
    return null;
  }

  // 用限制把邊界格串成幾群
  const parent = frontier.map((_, k) => k);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const c of cs) {
    const a = find(local.get(c.cells[0]));
    for (let t = 1; t < c.cells.length; t++) {
      const b = find(local.get(c.cells[t]));
      if (a !== b) parent[b] = a;
    }
  }
  const groups = new Map();
  frontier.forEach((cell, k) => {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, { cells: [], cons: [] });
    groups.get(r).cells.push(cell);
  });
  for (const c of cs) groups.get(find(local.get(c.cells[0]))).cons.push(c);
  const comps = [...groups.values()];

  let nodes = 0;
  try {
    for (const comp of comps) enumerate(comp, R, () => {
      if (++nodes > nodeLimit) throw ABORT;
    });
  } catch (e) {
    if (e === ABORT) return null;
    throw e;
  }

  // 可以湊出的雷數總和（布林卷積）
  const conv = (list) => {
    let s = new Uint8Array(R + 1);
    s[0] = 1;
    for (const comp of list) {
      const t = new Uint8Array(R + 1);
      for (let a = 0; a <= R; a++) if (s[a]) for (const k of comp.ks) if (a + k <= R) t[a + k] = 1;
      s = t;
    }
    return s;
  };
  const lo = Math.max(0, R - N);
  const safe = [];
  const mines = [];
  comps.forEach((comp, j) => {
    const others = conv(comps.filter((_, q) => q !== j));
    const okK = comp.ks.filter((k) => {
      for (let t = 0; t + k <= R; t++) if (others[t] && t + k >= lo) return true;
      return false;
    });
    comp.cells.forEach((cell, x) => {
      let canMine = false;
      let canSafe = false;
      for (const k of okK) {
        if (comp.mineAt[k][x]) canMine = true;
        if (comp.safeAt[k][x]) canSafe = true;
      }
      if (canSafe && !canMine) safe.push(cell);
      else if (canMine && !canSafe) mines.push(cell);
    });
  });
  if (N) {
    const all = conv(comps);
    let canMine = false;
    let canSafe = false;
    for (let S = lo; S <= R; S++) {
      if (!all[S]) continue;
      if (R - S >= 1) canMine = true;
      if (R - S <= N - 1) canSafe = true;
    }
    if (canSafe && !canMine) safe.push(...interior);
    else if (canMine && !canSafe) mines.push(...interior);
  }
  return safe.length || mines.length ? { safe, mines, level: 3 } : null;
}

// 回溯列舉一群邊界格的所有合法雷位，結果寫進 comp.ks / comp.mineAt[k] / comp.safeAt[k]
function enumerate(comp, R, tick) {
  const m = comp.cells.length;
  const idx = new Map(comp.cells.map((c, k) => [c, k]));
  const cons = comp.cons.map((c) => ({ cells: c.cells.map((x) => idx.get(x)), rem: c.rem }));
  const cellCons = Array.from({ length: m }, () => []);
  cons.forEach((c, ci) => c.cells.forEach((x) => cellCons[x].push(ci)));
  // 依限制做廣度優先排序，相鄰的格子接連決定，矛盾能早點剪掉
  const order = [];
  const seen = new Uint8Array(m);
  for (let s = 0; s < m; s++) {
    if (seen[s]) continue;
    const q = [s];
    seen[s] = 1;
    for (let h = 0; h < q.length; h++) {
      const x = q[h];
      order.push(x);
      for (const ci of cellCons[x]) {
        for (const y of cons[ci].cells) {
          if (!seen[y]) {
            seen[y] = 1;
            q.push(y);
          }
        }
      }
    }
  }
  const conMines = new Int32Array(cons.length);
  const conLeft = Int32Array.from(cons, (c) => c.cells.length);
  const val = new Uint8Array(m);
  comp.mineAt = [];
  comp.safeAt = [];
  const rec = (p, k) => {
    tick();
    if (p === m) {
      if (!comp.mineAt[k]) {
        comp.mineAt[k] = new Uint8Array(m);
        comp.safeAt[k] = new Uint8Array(m);
      }
      const ma = comp.mineAt[k];
      const sa = comp.safeAt[k];
      for (let x = 0; x < m; x++) {
        if (val[x]) ma[x] = 1;
        else sa[x] = 1;
      }
      return;
    }
    const x = order[p];
    for (let v = 0; v <= 1; v++) {
      if (v && k + 1 > R) break;
      let ok = true;
      for (const ci of cellCons[x]) {
        conLeft[ci]--;
        conMines[ci] += v;
        const need = cons[ci].rem - conMines[ci];
        if (need < 0 || need > conLeft[ci]) ok = false;
      }
      if (ok) {
        val[x] = v;
        rec(p + 1, k + v);
      }
      for (const ci of cellCons[x]) {
        conLeft[ci]++;
        conMines[ci] -= v;
      }
    }
    val[x] = 0;
  };
  rec(0, 0);
  comp.ks = [];
  for (let k = 0; k < comp.mineAt.length; k++) if (comp.mineAt[k]) comp.ks.push(k);
}

// ---- 從起點模擬一個「只靠推理」的玩家 ----
// 一路推、一路翻，直到翻完所有安全格（solved）或推不下去。know 留給產生器找卡住的地方
export function solveFrom(board, start, opts = {}) {
  const know = new Uint8Array(board.n);
  const target = board.n - board.mines;
  let opened = 0;
  const open = (i) => {
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      if (know[k] !== UNKNOWN) continue;
      if (board.mine[k]) throw new Error('求解器錯誤：把雷判成安全格');
      know[k] = OPEN;
      opened++;
      if (board.count[k] === 0) for (const j of board.nb[k]) if (know[j] === UNKNOWN) stack.push(j);
    }
  };
  open(start);
  while (opened < target) {
    const d = deduce(board, know, board.mines, opts);
    if (!d.safe.length && !d.mines.length) return { solved: false, know, opened };
    for (const m of d.mines) know[m] = MINE;
    for (const s of d.safe) open(s);
  }
  return { solved: true, know, opened };
}

// ---- 無猜盤面產生器 ----
// 同樣的尺寸、雷數、seed 一定產生同一盤（只用 seed 衍生的亂數），所以局號可以分享、存檔可以重建
// 作法：起點與周圍八格不放雷（起點必定是 0）→ 隨機佈雷 → 模擬推理。
// 卡住時挑一個卡住的數字，把它周圍未知格的雷搬到遠處（或反過來把遠處的雷搬進來），讓那個數字變得推得出來，再從頭模擬。
// 搬太多次還是不行就整盤重佈
export const NOG_LIMITS = { maxAttempts: 300, maxPerturb: 80, nodeLimit: 20000 };

// shape 預設方格；六角格傳 'hex'（方格的盤面與加入六角格之前完全相同，舊局號不受影響）
export function generateNoGuess(w, h, mines, seed, shape = 'square') {
  const rng = mulberry32(seed);
  const rand = (k) => Math.floor(rng() * k);
  const board = new Board(w, h, mines, shape);
  const n = board.n;
  // 起點盡量不貼邊，開局的空地比較大
  const sx = w >= 3 ? 1 + rand(w - 2) : rand(w);
  const sy = h >= 3 ? 1 + rand(h - 2) : rand(h);
  const start = sy * w + sx;
  const banned = new Uint8Array(n);
  banned[start] = 1;
  for (const j of board.nb[start]) banned[j] = 1;
  const free = [];
  for (let i = 0; i < n; i++) if (!banned[i]) free.push(i);
  if (mines > free.length) throw new Error('雷太多，放不下無猜盤面');

  let runs = 0;
  for (let attempt = 1; attempt <= NOG_LIMITS.maxAttempts; attempt++) {
    for (let i = 0; i < mines; i++) {
      const j = i + rand(free.length - i);
      [free[i], free[j]] = [free[j], free[i]];
    }
    board.setMines(free.slice(0, mines));
    for (let p = 0; p <= NOG_LIMITS.maxPerturb; p++) {
      runs++;
      const r = solveFrom(board, start, { nodeLimit: NOG_LIMITS.nodeLimit });
      if (r.solved) return { start, mines: mineList(board), attempts: attempt, runs, noGuess: true };
      if (!perturb(board, r.know, banned, rand)) break;
    }
  }
  // 雷極密時可能試不出來：退回普通盤面，起點仍然是 0（實際上 21% 以下的密度不會走到這裡）
  board.setMines(free.slice(0, mines));
  return { start, mines: mineList(board), attempts: NOG_LIMITS.maxAttempts, runs, noGuess: false };
}

function perturb(board, know, banned, rand) {
  const edges = [];
  for (let i = 0; i < board.n; i++) {
    if (know[i] === OPEN && board.nb[i].some((j) => know[j] === UNKNOWN)) edges.push(i);
  }
  if (!edges.length) return false;
  const e = edges[rand(edges.length)];
  const around = board.nb[e].filter((j) => know[j] === UNKNOWN && !banned[j]);
  // 遠處：不跟任何已翻開格子相鄰的未知格，搬動它們不會改到已看過的數字附近
  const far = [];
  for (let i = 0; i < board.n; i++) {
    if (know[i] === UNKNOWN && !banned[i] && !board.nb[i].some((j) => know[j] === OPEN)) far.push(i);
  }
  const aMines = around.filter((j) => board.mine[j]);
  const aSafe = around.filter((j) => !board.mine[j]);
  const farSafe = far.filter((j) => !board.mine[j]);
  const farMines = far.filter((j) => board.mine[j]);
  const canClear = aMines.length > 0 && farSafe.length >= aMines.length;
  const canFill = aSafe.length > 0 && farMines.length >= aSafe.length;
  if (!canClear && !canFill) return false;
  const pick = (arr, k) => {
    for (let i = 0; i < k; i++) {
      const j = i + rand(arr.length - i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, k);
  };
  if (canClear && (!canFill || rand(2) === 0)) {
    // 清空：那個數字周圍的未知格全部變安全
    const to = pick(farSafe, aMines.length);
    for (const j of aMines) board.mine[j] = 0;
    for (const j of to) board.mine[j] = 1;
  } else {
    // 填滿：那個數字周圍的未知格全部變成雷
    const from = pick(farMines, aSafe.length);
    for (const j of from) board.mine[j] = 0;
    for (const j of aSafe) board.mine[j] = 1;
  }
  board.computeCounts();
  return true;
}

function mineList(board) {
  const out = [];
  for (let i = 0; i < board.n; i++) if (board.mine[i]) out.push(i);
  return out;
}

// 盤面存進 options 的字串格式：「起點:雷1.雷2.…」，數字用 36 進位縮短（高級約 300 字元）
export function encodeLayout({ start, mines }) {
  return start.toString(36) + ':' + mines.map((i) => i.toString(36)).join('.');
}
export function decodeLayout(s) {
  const [a, b] = String(s).split(':');
  return { start: parseInt(a, 36), mines: b ? b.split('.').map((x) => parseInt(x, 36)) : [] };
}
