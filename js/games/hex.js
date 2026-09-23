import { NoGuess } from './noguess.js';

// 蜂巢難度：格數與雷數參考網路上常見的六角踩地雷（約 60 格 10 雷、150 格 30 雷、300 格 65 雷），排成長方形。
// 預設直立（寬比高窄），直向手機剛好；橫向時渲染器會自動把盤面轉 90 度
export const HEX_LEVELS = {
  beginner: { label: '初級', w: 8, h: 8, mines: 10 },
  intermediate: { label: '中級', w: 10, h: 15, mines: 30 },
  expert: { label: '高級', w: 15, h: 20, mines: 65 },
};

// 蜂巢踩地雷：六角形格子、每格六個鄰居，一律是無猜盤面。
// 規則、求解器、存檔都沿用無猜模式，只換格形與難度表
export class Hex extends NoGuess {
  static meta = {
    id: 'hex',
    name: '蜂巢踩地雷',
    en: 'Hex',
    desc: '六角形格子，每格只有六個鄰居。保證只靠推理就能解完，從亮起的起點格開局。',
  };
  static shape = 'hex';
  static levels = HEX_LEVELS;
}
