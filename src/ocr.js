// Lokalne rozpoznawanie tekstu (OCR) – Tesseract z polskim słownikiem, w pełni offline.
const path = require("path");
const os = require("os");
const { createWorker, createScheduler, OEM } = require("tesseract.js");

const LANG_PATH = path.join(path.dirname(require.resolve("@tesseract.js-data/pol/package.json")), "4.0.0_best_int");
const WORKERS = 1; // jeden wątek – procesor i pamięć są potrzebne modelowi AI

let scheduler = null;
let ready = null;
const workerProgress = new Map();
let progressListener = null;

function init() {
  if (ready) return ready;
  ready = (async () => {
    scheduler = createScheduler();
    for (let i = 0; i < WORKERS; i++) {
      const w = await createWorker("pol", OEM.LSTM_ONLY, {
        langPath: LANG_PATH,
        gzip: true,
        cacheMethod: "none",
        logger: (m) => {
          if (m.status === "recognizing text") {
            workerProgress.set(m.workerId, m.progress);
            if (progressListener) progressListener([...workerProgress.values()]);
          }
        },
      });
      await w.setParameters({ preserve_interword_spaces: "1", user_defined_dpi: "300" });
      scheduler.addWorker(w);
    }
  })();
  ready.catch(() => (ready = null));
  return ready;
}

function round(b) {
  return [Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1)];
}

/** Uproszczona struktura: akapity → linie → słowa (z pozycjami i pewnością rozpoznania). */
function simplify(data) {
  const paragraphs = [];
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) {
      const lines = (par.lines || [])
        .map((l) => ({
          text: (l.words || []).map((w) => w.text).join(" "),
          conf: Math.round(l.confidence),
          bbox: round(l.bbox),
          words: (l.words || []).map((w) => ({ t: w.text, c: Math.round(w.confidence), b: round(w.bbox) })),
        }))
        .filter((l) => l.text.trim());
      if (lines.length) paragraphs.push({ bbox: round(par.bbox), conf: Math.round(par.confidence), lines });
    }
  }
  return { paragraphs };
}

async function recognize(imageBuffer) {
  await init();
  const res = await scheduler.addJob("recognize", Buffer.from(imageBuffer), {}, { blocks: true, text: false });
  return simplify(res.data);
}

function onProgress(fn) {
  progressListener = fn;
  workerProgress.clear();
}

async function shutdown() {
  if (scheduler) await scheduler.terminate();
}

module.exports = { init, recognize, onProgress, shutdown };
