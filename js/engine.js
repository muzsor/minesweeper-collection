// 共用遊戲引擎：seed、步驟提交、復原、動作日誌與重播、存檔
// 盤面本身由各遊戲透過 extraState / restoreExtra 交給引擎存取，引擎不管格子長什麼樣

import { mulberry32 } from './rng.js';

export class Game {
  static meta = { id: 'base', name: '', en: '', desc: '' };

  constructor(seed, options = {}) {
    this.seed = seed;
    this.options = { ...options };
    this.rng = mulberry32(seed);
    this.undoStack = [];
    this.moves = 0;
    this.won = false;
    this.lost = false;
    this.initialSnap = null; // 開局時的快照，「回到這局開頭」用
    // 動作日誌：每一步記成可重播的小物件（例如 {t:'r', i:37}）
    // 存檔只存這份日誌，重開時從同一個 seed 佈雷再重播，比存快照小很多
    this.actions = [];
    this.logComplete = true; // 若有未附動作的 commit（測試或作弊），日誌就不可信，改存快照
    this.replaying = false;
    this.listeners = {};
  }

  // 建立盤面：呼叫子類別的 init()，並記住初始狀態
  boot() {
    this.init();
    this.initialSnap = this.snapshot();
    return this;
  }

  get meta() {
    return this.constructor.meta;
  }
  get over() {
    return this.won || this.lost;
  }

  // ---- 事件 ----
  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  emit(ev, data) {
    (this.listeners[ev] || []).forEach((fn) => fn(data));
  }

  // ---- 快照 / 復原 ----
  snapshot() {
    return { x: this.extraState() };
  }
  restore(snap) {
    this.restoreExtra(snap.x);
  }
  // action：這一步的可重播描述；沒給的話日誌就不完整，存檔會退回存快照
  commit(fn, action) {
    if (this.over) return false;
    const snap = this.snapshot();
    fn();
    this.moves++;
    this.undoStack.push(snap);
    if (this.undoStack.length > 500) this.undoStack.shift();
    if (action) this.actions.push(action);
    else this.logComplete = false;
    if (this.isWon()) this.won = true;
    else if (this.isLost()) this.lost = true;
    if (!this.replaying) {
      // 先發 change 讓畫面畫出最終狀態（含踩到的雷），再發 win / lose
      this.emit('change');
      if (this.won) this.emit('win');
      else if (this.lost) this.emit('lose');
    }
    return true;
  }
  // 贏了就不能復原；踩雷後可以（是否允許由設定決定，引擎只管能不能）
  canUndo() {
    return this.undoStack.length > 0 && !this.won;
  }
  undo() {
    if (!this.canUndo()) return false;
    this.restore(this.undoStack.pop());
    this.actions.pop();
    this.moves = Math.max(0, this.moves - 1);
    this.lost = this.isLost();
    this.emit('change');
    return true;
  }
  // 回到這局開頭：同一個盤面，步數與時間歸零，不算放棄
  restart() {
    if (!this.initialSnap || this.moves === 0) return false;
    this.restore(this.initialSnap);
    this.undoStack = [];
    this.actions = [];
    this.logComplete = true;
    this.moves = 0;
    this.won = false;
    this.lost = false;
    this.emit('change');
    return true;
  }

  // ---- 動作重播（各遊戲覆寫） ----
  applyAction(a) {
    throw new Error('未知動作 ' + a.t);
  }

  // ---- 存檔 ----
  // 日誌完整：存 actions（每步約 10 個字元）＋最終快照當校驗
  // 日誌不完整：退回存快照與最近 50 步復原
  serialize() {
    return {
      id: this.meta.id,
      seed: this.seed,
      options: this.options,
      moves: this.moves,
      won: this.won,
      lost: this.lost,
      snap: this.snapshot(),
      actions: this.logComplete ? this.actions : null,
      undo: this.logComplete ? undefined : this.undoStack.slice(-50),
    };
  }
  static sameState(a, b) {
    return !!a && !!b && JSON.stringify(a.x) === JSON.stringify(b.x);
  }
  static deserialize(Cls, data) {
    let g = new Cls(data.seed, data.options).boot(); // 同樣的 seed 與選項會佈出同一盤
    let replayed = false;
    if (Array.isArray(data.actions)) {
      g.replaying = true;
      try {
        for (const a of data.actions) g.applyAction(a);
        replayed = !data.snap || Game.sameState(g.snapshot(), data.snap);
      } catch {
        replayed = false;
      }
      g.replaying = false;
    }
    if (!replayed) {
      // 重播失敗（規則改版或日誌損壞）：直接採用最終快照，復原歷史只剩存檔裡有的
      g = new Cls(data.seed, data.options).boot();
      g.restore(data.snap);
      g.undoStack = data.undo || [];
      g.actions = [];
      g.logComplete = false;
      g.moves = data.moves || 0;
    }
    g.won = !!data.won;
    g.lost = !!data.lost;
    return g;
  }

  // 局號：預設就是種子，同一局號加同一組選項會佈出同一盤
  get dealNumber() {
    return this.seed;
  }
  static fromDeal(deal, options) {
    return new this(deal, options);
  }

  // ---- 各遊戲覆寫 ----
  init() {}
  extraState() {
    return null;
  }
  restoreExtra() {}
  subtitle() {
    return '';
  }
  isWon() {
    return false;
  }
  isLost() {
    return false;
  }
  hint() {
    return null;
  }
}
