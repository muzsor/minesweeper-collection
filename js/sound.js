// 簡單音效（WebAudio 合成，不需要音檔）

let ctx = null;
let enabled = true;

export function setSoundEnabled(v) {
  enabled = v;
}

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// iOS 需要在使用者手勢中建立 AudioContext
export function primeAudio() {
  if (enabled) ac();
}

function blip(freq, dur, type = 'sine', gain = 0.08, when = 0) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, c.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + when + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + when);
  o.stop(c.currentTime + when + dur + 0.02);
}

// 翻開一格
export function playReveal() {
  if (!enabled) return;
  blip(520, 0.05, 'triangle', 0.05);
}
// 一次翻開一片空地
export function playOpen() {
  if (!enabled) return;
  blip(440, 0.05, 'triangle', 0.05);
  blip(660, 0.06, 'triangle', 0.04, 0.04);
}
// 插旗 / 拔旗
export function playFlag() {
  if (!enabled) return;
  blip(880, 0.04, 'square', 0.03);
}
// 無效操作
export function playError() {
  if (!enabled) return;
  blip(160, 0.12, 'sawtooth', 0.04);
}
// 踩雷：低頻噪音感的爆炸
export function playBoom() {
  if (!enabled) return;
  blip(90, 0.35, 'sawtooth', 0.12);
  blip(60, 0.5, 'square', 0.08, 0.05);
}
export function playWin() {
  if (!enabled) return;
  [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.25, 'triangle', 0.08, i * 0.12));
}
