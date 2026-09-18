import { Classic } from './classic.js';

// 首頁卡片的順序。新增一款遊戲：在這裡加進來，並在 rules.js 加規則、sw.js 加檔案路徑
export const GAMES = [Classic];
export const GAME_BY_ID = Object.fromEntries(GAMES.map((G) => [G.meta.id, G]));
