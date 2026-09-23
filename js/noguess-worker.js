// 在背景執行緒產生無猜盤面，主畫面不會卡住。訊息：{ id, w, h, mines, seed, shape } → { id, layout }
import { generateNoGuess, encodeLayout } from './solver.js';

self.onmessage = (e) => {
  const { id, w, h, mines, seed, shape } = e.data;
  try {
    self.postMessage({ id, layout: encodeLayout(generateNoGuess(w, h, mines, seed, shape)) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
