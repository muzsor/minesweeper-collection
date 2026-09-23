import { Classic } from './classic.js';
import { NoGuess } from './noguess.js';
import { Hex } from './hex.js';

// 所有遊戲類別。新增一款遊戲：在這裡加進來，在 app.js 的 MODES 加一筆，並在 rules.js 加規則、sw.js 加檔案路徑
export const GAMES = [Classic, NoGuess, Hex];
export const GAME_BY_ID = Object.fromEntries(GAMES.map((G) => [G.meta.id, G]));
