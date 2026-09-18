// 隨機數工具

// mulberry32：可重現的 32 位元偽隨機數，seed 相同則盤面相同（局號分享、存檔重播都靠它）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 種子上限：31 位元正整數，也是局號的上限
export const MAX_SEED = 0x7fffffff;

export function randomSeed() {
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

// 本地日期字串 YYYY-MM-DD（每日挑戰以使用者所在時區的日期為準）
export function todayString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 每日挑戰的 seed：FNV-1a 雜湊日期字串。全世界同一天同一盤，離線也算得出來
export function dailySeed(dateStr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateStr.length; i++) {
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % MAX_SEED) + 1;
}
