"use strict";

// ================== stan ==================
const MAX_PAGES = 60;
const MAX_LONG_EDGE = 2600; // rozdzielczość przechowywanej strony (wycinki grafik)
const MAX_PIXELS = 5_000_000;
const LETTERS = "ABCDEFGHIJ";
const BLANK = "………………";
const READ_TOKENS = 800; // typowa długość odczytu strony – do paska postępu

const state = {
  pages: [], // {id, hash, baseHash, rot, name, url, width, height, selected, status, tokens, analysis}
  settings: {
    kind: "kartkowka",
    difficulty: "sredni",
    count: 8,
    figures: "kilka",
    formats: ["open", "abc", "tf", "match", "gap"],
    grade: "",
    subject: "",
    extra: "",
  },
  test: null,
  view: "test",
  showPoints: true,
  showLines: true,
  showSummary: true,
  keyUnlocked: false, // klucz odpowiedzi widoczny dopiero po podaniu hasła rodzica
  generating: false,
  ai: null, // status silnika AI (Claude przez Claude Code albo model lokalny)
};

let uid = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(msg, isError = false, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), isError ? 8000 : ms);
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const fmtTime = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.max(1, Math.round(sec))} s`);

// ================== obrazy ==================
const imgCache = new Map();
function loadImage(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  imgCache.set(url, p);
  return p;
}

function fitSize(w, h, maxEdge = MAX_LONG_EDGE, maxPixels = MAX_PIXELS) {
  let scale = Math.min(1, maxEdge / Math.max(w, h));
  if (w * scale * h * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function fileToPage(file) {
  const bytes = await file.arrayBuffer();
  const baseHash = await sha256(bytes);
  // imageOrientation: "from-image" – uwzględnia obrót zapisany przez telefon (EXIF)
  const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  const { w, h } = fitSize(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { id: newId("p"), hash: baseHash, baseHash, rot: 0, name: file.name, url: c.toDataURL("image/jpeg", 0.9), width: w, height: h, selected: true, status: "new", tokens: 0, analysis: null };
}

/** Kopia strony dla modelu AI (base64 JPEG) – rozmiar zależny od silnika. */
async function aiImage(page) {
  const img = await loadImage(page.url);
  const edge = (state.ai && state.ai.imageEdge) || 1024;
  const { w, h } = fitSize(page.width, page.height, edge, Infinity);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const url = c.toDataURL("image/jpeg", 0.88);
  return { image: url.slice(url.indexOf(",") + 1), width: w, height: h };
}

async function rotatePage(page) {
  const img = await loadImage(page.url);
  const c = document.createElement("canvas");
  c.width = page.height;
  c.height = page.width;
  const ctx = c.getContext("2d");
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, 0, 0);
  window.api.libraryRemove(page.hash);
  page.url = c.toDataURL("image/jpeg", 0.9);
  [page.width, page.height] = [page.height, page.width];
  page.rot = (page.rot + 90) % 360;
  page.hash = page.rot ? `${page.baseHash}_r${page.rot}` : page.baseHash;
  page.analysis = null;
  page.status = "new";
  await queuePages([page]);
}

function cropCanvas(img, box) {
  const w = Math.max(1, Math.round(box.x1 - box.x0)), h = Math.max(1, Math.round(box.y1 - box.y0));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, Math.round(box.x0), Math.round(box.y0), w, h, 0, 0, w, h);
  return c;
}

async function cropFigure(page, box, masks) {
  const img = await loadImage(page.url);
  const c = cropCanvas(img, box);
  if (Array.isArray(masks) && masks.length) {
    const ctx = c.getContext("2d");
    ctx.lineWidth = Math.max(1, Math.round(c.width / 400));
    for (const m of masks) {
      const x = m.x0 - box.x0, y = m.y0 - box.y0, w = m.x1 - m.x0, h = m.y1 - m.y0;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#9ca3af";
      ctx.strokeRect(x, y, w, h);
    }
  }
  return c.toDataURL("image/jpeg", 0.92);
}

/**
 * Binaryzacja lokalna: piksel jest czarny, gdy wyraźnie różni się od średniej jasności swojego otoczenia.
 * Dzięki temu napisy jasne na ciemnym i ciemne na jasnym tle wychodzą jako czarny tekst na białym – czytelny dla OCR.
 */
function localBinarize(src) {
  const w = src.width, h = src.height;
  const px = src.getContext("2d").getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2];
  const W1 = w + 1, S = new Float64Array(W1 * (h + 1)); // obraz całkowy
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row;
    }
  }
  const R = Math.max(8, Math.round(Math.min(w, h) / 25));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  const od = octx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - R), yb = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - R), xb = Math.min(w, x + R + 1);
      const mean = (S[yb * W1 + xb] - S[ya * W1 + xb] - S[yb * W1 + xa] + S[ya * W1 + xa]) / ((xb - xa) * (yb - ya));
      const v = Math.abs(gray[y * w + x] - mean) > 45 ? 0 : 255, i = (y * w + x) * 4;
      od.data[i] = od.data[i + 1] = od.data[i + 2] = v;
      od.data[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

const labelKey = (s) => String(s || "").toLowerCase().replace(/[^a-ząćęłńóśźż0-9]+/gi, "");

/**
 * Wycina ilustrację wskazaną przez model i usuwa z brzegów wycinka napisy (podpis, opis obok),
 * żeby uczeń nie mógł przeczytać odpowiedzi z obrazka.
 */
async function figureFromAnalysis(page, fig) {
  const img = await loadImage(page.url);
  const W = page.width, H = page.height;
  const pad = Math.round(Math.max(W, H) * 0.008);
  let box = {
    x0: Math.max(0, (fig.box.x0 / 1000) * W - pad),
    y0: Math.max(0, (fig.box.y0 / 1000) * H - pad),
    x1: Math.min(W, (fig.box.x1 / 1000) * W + pad),
    y1: Math.min(H, (fig.box.y1 / 1000) * H + pad),
  };
  const masks = [];
  try {
    // OCR sprawdza obszar nieco większy niż wycinek (w pionie): podpis ucięty w połowie przez ramkę
    // byłby nieczytelny dla OCR, a jego górne połówki liter zostałyby na obrazku.
    const ext = Math.round(H * 0.04);
    const scan = { x0: box.x0, x1: box.x1, y0: Math.max(0, box.y0 - ext), y1: Math.min(H, box.y1 + ext) };
    const off = box.y0 - scan.y0; // przesunięcie: współrzędne skanu → współrzędne wycinka
    const c = cropCanvas(img, scan);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const res = await window.api.ocr(await blob.arrayBuffer());
    if (res.ok) {
      const cw = c.width, ch = Math.round(box.y1 - box.y0);
      const lines = res.data.paragraphs.flatMap((p) => p.lines).filter((l) => l.conf >= 55 && /[a-ząćęłńóśźż]{3,}/i.test(l.text));
      let { x0, y0, x1, y1 } = { x0: 0, y0: 0, x1: cw, y1: ch };
      for (const l of lines) {
        const ly0 = l.bbox[1] - off, ly1 = l.bbox[3] - off; // w układzie wycinka
        if (ly1 <= 0 || ly0 >= ch) continue; // linia całkiem poza wycinkiem
        const cy = (ly0 + ly1) / 2;
        if (cy > ch * 0.62) y1 = Math.min(y1, ly0 - 6); // podpis pod obrazkiem (także częściowo ucięty)
        else if (cy < ch * 0.25) y0 = Math.max(y0, ly1 + 6); // tekst nad obrazkiem
      }
      // urywki tekstu przy bokach (sąsiednia kolumna, opis obok). Tesseract „widzi” też litery w fakturze zdjęć,
      // więc boki przycinamy tylko, gdy jest tam kolumna tekstu: ≥3 pewne słowa w różnych wierszach.
      const words = res.data.paragraphs
        .flatMap((p) => p.lines.flatMap((l) => l.words))
        .filter((w) => w.c >= 55 && /[a-ząćęłńóśźż]{2,}/i.test(w.t))
        .map((w) => ({ ...w, b: [w.b[0], w.b[1] - off, w.b[2], w.b[3] - off] }))
        .filter((w) => (w.b[1] + w.b[3]) / 2 > y0 && (w.b[1] + w.b[3]) / 2 < y1);
      const column = (ws) => new Set(ws.map((w) => Math.round(w.b[1] / Math.max(8, w.b[3] - w.b[1])))).size >= 3;
      const leftWords = words.filter((w) => (w.b[0] + w.b[2]) / 2 < cw * 0.3);
      const rightWords = words.filter((w) => (w.b[0] + w.b[2]) / 2 > cw * 0.7);
      if (column(leftWords)) x0 = Math.min(cw * 0.35, Math.max(x0, ...leftWords.map((w) => w.b[2] + 4)));
      if (column(rightWords)) x1 = Math.max(cw * 0.65, Math.min(x1, ...rightWords.map((w) => w.b[0] - 4)));
      if (y1 - y0 >= ch * 0.4 && x1 - x0 >= cw * 0.4) box = { x0: box.x0 + x0, y0: box.y0 + y0, x1: box.x0 + x1, y1: box.y0 + y1 };
      // napisy NA rysunku (etykiety wskazane przez AI) zasłaniamy białym polem – nie zdradzą odpowiedzi
      const labels = (fig.labels || []).map(labelKey).filter((k) => k.length >= 3);
      if (labels.length) {
        const pad = Math.round(Math.max(W, H) * 0.003);
        const found = new Set();
        const collect = (data) => {
          for (const l of data.paragraphs.flatMap((p) => p.lines)) {
            const key = labelKey(l.text);
            const hit = key.length >= 3 && l.conf >= 40 ? labels.find((k) => key.includes(k) || k.includes(key)) : null;
            if (!hit) continue;
            const m = { x0: scan.x0 + l.bbox[0] - pad, y0: scan.y0 + l.bbox[1] - pad, x1: scan.x0 + l.bbox[2] + pad, y1: scan.y0 + l.bbox[3] + pad };
            const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
            if (cx > box.x0 && cx < box.x1 && cy > box.y0 && cy < box.y1 && !masks.some((o) => Math.abs(o.x0 - m.x0) < 6 && Math.abs(o.y0 - m.y0) < 6)) {
              masks.push(m);
              found.add(hit);
            }
          }
        };
        collect(res.data);
        // napisy na kolorowym tle (np. biały tekst na brązowej glebie) – drugi przebieg po binaryzacji lokalnej
        if (labels.some((k) => !found.has(k))) {
          const bin = localBinarize(c);
          const bblob = await new Promise((r) => bin.toBlob(r, "image/png"));
          const res2 = await window.api.ocr(await bblob.arrayBuffer(), { sparse: true });
          if (res2.ok) collect(res2.data);
        }
      }
    }
  } catch (e) {
    console.warn("OCR wycinka", e);
  }
  return { id: newId("f"), pageId: page.id, box, masks, description: fig.shows || fig.caption || "", scale: 1, cropUrl: await cropFigure(page, box, masks) };
}

// ================== biblioteka stron (czytanie przez model w tle) ==================
async function queuePages(pages) {
  if (!state.ai || !state.ai.ready) {
    renderThumbs();
    return;
  }
  const items = [];
  for (const p of pages) {
    if (p.analysis) continue;
    items.push({ hash: p.hash, name: p.name, ...(await aiImage(p)) });
  }
  if (items.length) await window.api.libraryEnqueue(items);
}

let thumbsTimer = null;
function renderThumbsSoon() {
  if (thumbsTimer) return;
  thumbsTimer = setTimeout(() => {
    thumbsTimer = null;
    renderThumbs();
  }, 300);
}

window.api.onLibraryUpdate((u) => {
  for (const p of state.pages.filter((x) => x.hash === u.hash)) {
    p.status = u.status;
    if (u.tokens != null) p.tokens = u.tokens;
    if (u.status === "done" && u.data) p.analysis = u.data;
    if (u.status === "error") p.error = u.error;
  }
  renderThumbsSoon();
  if (waitResolve) waitResolve();
});

// ================== strony (panel „Materiał”) ==================
async function addFiles(files) {
  const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
  const rejected = [...files].length - list.length;
  if (rejected) toast(`Pominięto ${rejected} plik(ów) – obsługiwane są JPG, PNG, WEBP. (Zdjęcia HEIC z iPhone'a zapisz jako JPG.)`, true);

  const room = MAX_PAGES - state.pages.length;
  if (list.length > room) toast(`Można dodać maksymalnie ${MAX_PAGES} stron.`, true);

  const added = [];
  const thumbs = $("#thumbs");
  for (const file of list.slice(0, Math.max(0, room))) {
    const ph = document.createElement("li");
    ph.className = "page-item loading";
    ph.textContent = `Wczytuję ${file.name}…`;
    thumbs.appendChild(ph);
    try {
      const page = await fileToPage(file);
      if (!state.pages.some((p) => p.hash === page.hash)) {
        state.pages.push(page);
        added.push(page);
      }
    } catch (e) {
      console.error(e);
      toast(`Nie udało się wczytać pliku ${file.name}.`, true);
    }
    ph.remove();
  }
  renderThumbs();
  await queuePages(added);
  return added;
}

const readPct = (p) => Math.min(99, Math.round((p.tokens / READ_TOKENS) * 100));

function pageStatus(p) {
  if (p.analysis) return `<span class="page-status ok">✓ przeczytana</span>`;
  if (p.status === "reading")
    return state.ai && state.ai.kind === "ollama"
      ? `<span class="page-status busy">${p.tokens ? `czyta… ${readPct(p)}%` : "ogląda zdjęcie…"}</span>`
      : `<span class="page-status busy">AI czyta…</span>`;
  if (p.status === "queued") return `<span class="page-status wait">w kolejce</span>`;
  if (p.status === "error") return `<span class="page-status err" data-act="retry" title="${esc(p.error || "Błąd")} – kliknij, aby spróbować ponownie">⚠ błąd – ponów</span>`;
  if (!state.ai || !state.ai.ready) return `<span class="page-status wait">czeka na silnik AI</span>`;
  return "";
}

function renderThumbs() {
  const n = state.pages.length;
  $("#dropzone").classList.toggle("hidden", n > 0);
  $("#select-row").classList.toggle("hidden", n === 0);
  $("#thumbs").innerHTML = state.pages
    .map(
      (p, i) => `
      <li class="page-item ${p.selected ? "selected" : ""}" data-id="${p.id}" title="${p.selected ? "W sprawdzianie" : "Pominięta"} – kliknij, aby zmienić">
        <span class="cb"></span>
        <img src="${p.url}" alt="" />
        <div class="page-meta">
          <div class="page-title">${esc((p.analysis && p.analysis.title) || `Strona ${i + 1}`)}</div>
          <div class="page-file">${i + 1}. ${esc(p.name)}</div>
          ${pageStatus(p)}
          ${p.status === "reading" && state.ai && state.ai.kind === "ollama" ? `<div class="mini-bar"><div style="width:${readPct(p)}%"></div></div>` : ""}
        </div>
        <div class="page-tools">
          <button data-act="up" title="Przesuń wyżej" ${i === 0 ? "disabled" : ""}><svg><use href="#i-up"/></svg></button>
          <button data-act="rotate" title="Obróć o 90°"><svg><use href="#i-rotate"/></svg></button>
          <button data-act="remove" title="Usuń z listy"><svg><use href="#i-x"/></svg></button>
        </div>
      </li>`
    )
    .join("");
  const sel = state.pages.filter((p) => p.selected).length;
  const read = state.pages.filter((p) => p.analysis).length;
  $("#pages-info").textContent = n ? `${n} ${plural(n, "strona", "strony", "stron")} · przeczytane ${read}/${n} · w sprawdzianie ${sel}` : "Brak stron – dodaj zdjęcia z podręcznika";
  $("#material-count").textContent = n ? (read < n ? `${read}/${n}` : `${sel}`) : "0";
  $("#material-count").title = n ? `przeczytane ${read} z ${n}, w sprawdzianie ${sel}` : "";
  updateGenerateButton();
  updateStatusBar();
}

function updateGenerateButton() {
  const btn = $("#btn-generate");
  const sel = state.pages.filter((p) => p.selected);
  btn.disabled = sel.length === 0 || state.generating;
  $("#btn-generate-top").disabled = state.generating;
  btn.innerHTML = `<svg class="ico"><use href="#i-spark"/></svg> ${state.generating ? "AI pracuje…" : state.test ? "Ułóż nowy sprawdzian" : "Generuj sprawdzian"}`;
  const ai = state.ai || {};
  const unread = sel.filter((p) => !p.analysis).length;
  const perPage = (ai.secPerPage || 30) / Math.max(1, ai.kind === "claude" ? 2.5 : 1);
  $("#generate-hint").textContent = !state.pages.length
    ? "Dodaj zdjęcia stron – AI przeczyta je w tle."
    : !sel.length
      ? "Zaznacz w panelu „Materiał” strony do sprawdzianu."
      : unread
        ? `${unread} z wybranych stron czeka na przeczytanie (ok. ${fmtTime(unread * perPage)}). Możesz już kliknąć.`
        : `${sel.length} ${plural(sel.length, "strona", "strony", "stron")} · ${state.settings.count} zadań · ok. ${fmtTime(15 + state.settings.count * (ai.secPerTask || 5))}`;
  syncUi();
}

function updateStatusBar() {
  const total = state.pages.length;
  const read = state.pages.filter((p) => p.analysis).length;
  const busy = state.pages.filter((p) => p.status === "reading" || p.status === "queued").length;
  const errors = state.pages.filter((p) => p.status === "error").length;
  const ai = state.ai || {};
  const left = $("#status-left");
  left.classList.toggle("busy", busy > 0 || state.generating);
  left.textContent = state.generating
    ? "AI układa sprawdzian…"
    : busy
      ? `AI czyta strony: ${read}/${total} gotowe · zostało ok. ${fmtTime((busy * (ai.secPerPage || 30)) / (ai.kind === "claude" ? 2.5 : 1))}`
      : total
        ? `Wszystkie strony przeczytane (${read}/${total})${errors ? ` · ${errors} z błędem` : ""}`
        : "Gotowy";
  const t = state.test;
  $("#status-right").textContent = [
    t ? `${t.questions.length} ${plural(t.questions.length, "zadanie", "zadania", "zadań")} · ${t.questions.reduce((a, q) => a + q.points, 0)} pkt` : "",
    ai.label ? `Silnik: ${ai.label}` : "",
  ]
    .filter(Boolean)
    .join("   ·   ");
}

$("#select-row").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-sel]");
  if (!a) return;
  e.preventDefault();
  for (const p of state.pages) p.selected = a.dataset.sel === "all" || (a.dataset.sel === "ready" && Boolean(p.analysis));
  renderThumbs();
});

$("#thumbs").addEventListener("click", async (e) => {
  const item = e.target.closest(".page-item");
  if (!item || !item.dataset.id || state.generating) return;
  const idx = state.pages.findIndex((p) => p.id === item.dataset.id);
  if (idx < 0) return;
  const page = state.pages[idx];
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) page.selected = !page.selected;
  if (act === "retry") {
    page.status = "queued";
    const img = await aiImage(page);
    await window.api.libraryRetry({ hash: page.hash, name: page.name, ...img });
  }
  if (act === "remove") {
    state.pages.splice(idx, 1);
    if (!state.pages.some((p) => p.hash === page.hash)) window.api.libraryRemove(page.hash);
  }
  if (act === "up" && idx > 0) [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
  if (act === "rotate") await rotatePage(page);
  renderThumbs();
});

async function addPhotosDialog() {
  const room = MAX_PAGES - state.pages.length;
  if (room <= 0) return toast(`Można dodać maksymalnie ${MAX_PAGES} stron.`, true);
  const res = await window.api.pickFiles(room);
  if (!res.ok) return;
  const files = res.files.map((f) => new File([f.data], f.name, { type: f.type }));
  const added = await addFiles(files);
  if (added.length) toast(`Dodano ${added.length} ${plural(added.length, "stronę", "strony", "stron")}. AI czyta je w tle.`);
}

async function addFolderDialog() {
  const room = MAX_PAGES - state.pages.length;
  if (room <= 0) return toast(`Można dodać maksymalnie ${MAX_PAGES} stron. Usuń część, aby dodać nowe.`, true);
  const res = await window.api.pickFolder(room);
  if (!res.ok) return;
  if (!res.files.length) {
    return toast(
      res.heic ? `W folderze „${res.folder}” są tylko zdjęcia HEIC (${res.heic}). Zapisz je jako JPG i spróbuj ponownie.` : `W folderze „${res.folder}” nie ma zdjęć JPG, PNG ani WEBP.`,
      true
    );
  }
  const notes = [];
  if (res.total > res.files.length) notes.push(`wczytano ${res.files.length} z ${res.total} (limit ${MAX_PAGES} stron)`);
  if (res.heic) notes.push(`pominięto ${res.heic} ${plural(res.heic, "zdjęcie", "zdjęcia", "zdjęć")} HEIC`);
  toast(`Folder „${res.folder}”: wczytuję ${res.files.length} ${plural(res.files.length, "zdjęcie", "zdjęcia", "zdjęć")}…${notes.length ? " (" + notes.join(", ") + ")" : ""}`, false, 5000);
  const files = res.files.map((f) => new File([f.data], f.name, { type: f.type }));
  await addFiles(files);
  const unread = state.pages.filter((p) => !p.analysis).length;
  if (unread) toast(`AI czyta strony w tle: ${unread} do przeczytania. Przeczytane strony są zapamiętywane – następnym razem będą gotowe od razu.`, false, 7000);
}

$("#btn-add-photos").addEventListener("click", addPhotosDialog);
$("#btn-folder").addEventListener("click", addFolderDialog);
$("#empty-add").addEventListener("click", () => (openDialog("dlg-material"), addPhotosDialog()));
$("#empty-folder").addEventListener("click", () => (openDialog("dlg-material"), addFolderDialog()));
$("#empty-settings").addEventListener("click", () => openDialog("dlg-settings"));
$("#btn-material").addEventListener("click", () => openDialog("dlg-material"));
$("#btn-settings").addEventListener("click", () => openDialog("dlg-settings"));
$("#btn-generate-top").addEventListener("click", () => generate());

const dz = $("#dropzone");
dz.addEventListener("click", addPhotosDialog);
dz.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && addPhotosDialog());
$("#file-input").addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = "";
});
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// ================== ustawienia testu ==================
function bindSettings() {
  document.querySelectorAll(".segmented").forEach((seg) => {
    const name = seg.dataset.name;
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.settings[name] = b.dataset.value;
      if (name === "kind") state.settings.count = b.dataset.value === "sprawdzian" ? 12 : 6;
      bindSettingsValues();
      persistPrefs();
      updateGenerateButton();
    });
  });

  $("#formats").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const set = new Set(state.settings.formats);
    if (set.has(b.dataset.value)) {
      if (set.size === 1) return toast("Musi zostać zaznaczony co najmniej jeden rodzaj zadań.", true);
      set.delete(b.dataset.value);
    } else set.add(b.dataset.value);
    state.settings.formats = ["open", "abc", "tf", "match", "gap"].filter((f) => set.has(f));
    bindSettingsValues();
    persistPrefs();
  });

  const count = $("#count");
  count.addEventListener("input", () => {
    state.settings.count = Number(count.value);
    $("#count-value").textContent = count.value;
    persistPrefs();
    updateGenerateButton();
  });

  for (const key of ["grade", "subject", "extra"]) {
    const el = $("#" + key);
    el.addEventListener("input", () => {
      state.settings[key] = el.value;
      persistPrefs();
    });
  }
  bindSettingsValues();
}

function bindSettingsValues() {
  document.querySelectorAll(".segmented").forEach((seg) =>
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === state.settings[seg.dataset.name]))
  );
  document.querySelectorAll("#formats button").forEach((b) => b.classList.toggle("active", state.settings.formats.includes(b.dataset.value)));
  $("#count").value = state.settings.count;
  $("#count-value").textContent = state.settings.count;
  for (const key of ["grade", "subject", "extra"]) $("#" + key).value = state.settings[key] || "";
}

let prefsTimer;
function persistPrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const { kind, difficulty, count, figures, grade, formats } = state.settings;
    window.api.savePrefs({ kind, difficulty, count, figures, grade, formats });
  }, 400);
}

// ================== silnik AI ==================
async function refreshAi() {
  state.ai = await window.api.aiStatus();
  const s = state.ai;
  const chip = $("#ai-status");
  chip.classList.toggle("warn", !s.ready);
  chip.innerHTML = s.ready
    ? `<span class="dot"></span>${esc(s.label)}<svg class="ico"><use href="#i-chevron"/></svg>`
    : `<span class="dot"></span>${{ claude: "Brak Claude Code", codex: "Brak Codex", gemini: "Brak klucza Gemini" }[s.kind] || (!s.installed ? "Brak Ollamy" : !s.server ? "Ollama nie odpowiada" : "Brak modelu")}<svg class="ico"><use href="#i-chevron"/></svg>`;
  updateStatusBar();
  return s.ready;
}

function openAiSetup() {
  openEngineDialog();
}

async function engineChanged() {
  if (await refreshAi()) queuePages(state.pages.filter((p) => !p.analysis));
  renderThumbs();
}

window.api.onEngineChanged(async () => {
  await engineChanged();
  toast(`Silnik AI: ${state.ai.label}.`);
});

// ================== podokna ==================
function openDialog(id) {
  document.querySelectorAll("[data-dialog]").forEach((d) => d.id !== id && d.classList.add("hidden"));
  $("#" + id).classList.remove("hidden");
  if (id === "dlg-material") renderThumbs();
}
function closeDialog(id) {
  $("#" + id).classList.add("hidden");
}
document.querySelectorAll("[data-dialog]").forEach((dlg) => {
  dlg.addEventListener("mousedown", (e) => {
    if (e.target === dlg) dlg.classList.add("hidden"); // kliknięcie w tło zamyka podokno
  });
  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) dlg.classList.add("hidden");
    const open = e.target.closest("[data-open]");
    if (open) openDialog(open.dataset.open);
  });
});

// ================== silnik AI: podokno wyboru ==================
const LINKS = {
  claude: "https://claude.com/product/claude-code",
  codex: "https://developers.openai.com/codex",
  gemini: "https://aistudio.google.com/apikey",
  ollama: "https://ollama.com/download",
};

async function openEngineDialog() {
  openDialog("dlg-engines");
  $("#engine-cards").innerHTML = `<p class="muted">Sprawdzam, co jest zainstalowane na tym komputerze…</p>`;
  const [av, st] = await Promise.all([window.api.aiAvailability(), window.api.aiStatus()]);
  state.ai = st;
  const cur = st.engine;
  const isCur = (...ids) => ids.includes(cur);
  const found = (ok, yes, no) => `<span class="tag ${ok ? "ok" : "no"}">${ok ? yes : no}</span>`;
  const activeTag = (...ids) => (isCur(...ids) ? `<span class="tag active">używany</span>` : "");
  const ol = av.ollama || {};
  $("#engine-cards").innerHTML = `
    <div class="engine-card ${isCur("gemini") ? "active" : ""}">
      <h3>Google Gemini <span class="tag free">DARMOWY</span> ${found(av.gemini.installed, "klucz zapisany", "brak klucza")} ${activeTag("gemini")}</h3>
      <p>Najlepszy wybór bez płatnej subskrypcji. Wystarczy konto Google: utwórz bezpłatny klucz w <a href="${LINKS.gemini}" target="_blank">Google AI Studio</a> i wklej go poniżej. Szybki i dokładny; darmowy poziom ma dzienny limit zapytań (zwykle wystarcza na kilka sprawdzianów dziennie).</p>
      <div class="keyrow"><input type="password" id="gemini-key" placeholder="${av.gemini.installed ? "klucz zapisany – wpisz nowy, aby zmienić" : "wklej klucz API (zaczyna się od AIza…)"}" autocomplete="off" /><button class="btn" data-eact="gemini-save">Zapisz klucz</button></div>
      <div class="engine-note" id="gemini-msg">Uwaga: w darmowym poziomie Google może wykorzystywać przesłane treści do ulepszania usług. Klucz jest zapisywany na tym komputerze w postaci zaszyfrowanej.</div>
      <div class="actions">
        <button class="btn ${isCur("gemini") ? "" : "primary"}" data-engine="gemini" ${av.gemini.installed ? "" : "disabled"}>Używaj Gemini</button>
        ${av.gemini.installed ? `<button class="btn ghost" data-eact="gemini-remove">Usuń klucz</button>` : ""}
      </div>
    </div>

    <div class="engine-card ${isCur("claude-sonnet", "claude-opus") ? "active" : ""}">
      <h3>Claude <span class="tag paid">subskrypcja Pro / Max</span> ${found(av.claude.installed, "Claude Code znaleziony", "nie znaleziono Claude Code")} ${activeTag("claude-sonnet", "claude-opus")}</h3>
      <p>Najwyższa jakość. Korzysta z płatnej subskrypcji Claude przez zainstalowany i zalogowany program <a href="${LINKS.claude}" target="_blank">Claude Code</a> – bez klucza API. Darmowy plan Claude nie obejmuje Claude Code.</p>
      <div class="actions">
        <button class="btn ${isCur("claude-sonnet") ? "" : "primary"}" data-engine="claude-sonnet" ${av.claude.installed ? "" : "disabled"}>Sonnet – szybki</button>
        <button class="btn" data-engine="claude-opus" ${av.claude.installed ? "" : "disabled"}>Opus – dokładniejszy</button>
      </div>
    </div>

    <div class="engine-card ${isCur("codex") ? "active" : ""}">
      <h3>Codex (ChatGPT) <span class="tag paid">subskrypcja ChatGPT</span> ${found(av.codex.installed, "Codex znaleziony", "nie znaleziono Codex")} ${activeTag("codex")}</h3>
      <p>Korzysta z konta ChatGPT przez zainstalowany i zalogowany program <a href="${LINKS.codex}" target="_blank">Codex</a>. Codex w tym trybie wymaga płatnego planu ChatGPT (darmowy plan go nie obejmuje albo ma bardzo małe limity).</p>
      <div class="actions">
        <button class="btn ${isCur("codex") ? "" : "primary"}" data-engine="codex" ${av.codex.installed ? "" : "disabled"}>Używaj Codex</button>
      </div>
    </div>

    <div class="engine-card ${isCur("ollama") ? "active" : ""}">
      <h3>Model lokalny <span class="tag free">DARMOWY · OFFLINE</span> ${found(ol.installed && ol.model, "gotowy", ol.installed ? "brak modelu" : "brak programu Ollama")} ${activeTag("ollama")}</h3>
      <p>Działa bez internetu i bez kont, w darmowym programie <a href="${LINKS.ollama}" target="_blank">Ollama</a> (model ok. 3,3 GB). Szybki na komputerze z kartą graficzną NVIDIA; na zwykłym laptopie bardzo wolny (ok. 12 min na stronę) i potrzebuje ok. 4 GB wolnej pamięci.</p>
      <div class="engine-note" id="ollama-msg"></div>
      <div class="actions">
        ${ol.installed && !ol.model ? `<button class="btn" data-eact="ollama-pull">Pobierz model (3,3 GB)</button>` : ""}
        <button class="btn ${isCur("ollama") ? "" : "primary"}" data-engine="ollama" ${ol.installed && ol.model ? "" : "disabled"}>Używaj modelu lokalnego</button>
      </div>
    </div>`;
}

$("#engine-cards").addEventListener("click", async (e) => {
  const use = e.target.closest("[data-engine]");
  if (use && !use.disabled) {
    await window.api.aiSetEngine(use.dataset.engine);
    closeDialog("dlg-engines");
    return;
  }
  const act = e.target.closest("[data-eact]")?.dataset.eact;
  if (act === "gemini-save") {
    const key = $("#gemini-key").value.trim();
    if (!key) return ($("#gemini-msg").textContent = "Wklej klucz z Google AI Studio.");
    $("#gemini-msg").textContent = "Sprawdzam klucz…";
    const res = await window.api.aiSetGeminiKey(key);
    if (!res.ok) return ($("#gemini-msg").textContent = res.error);
    await window.api.aiSetEngine("gemini");
    closeDialog("dlg-engines");
    toast(`Klucz Gemini działa (model: ${res.model}).`);
  }
  if (act === "gemini-remove") {
    await window.api.aiSetGeminiKey("");
    openEngineDialog();
  }
  if (act === "ollama-pull") {
    const btn = e.target.closest("button");
    btn.disabled = true;
    const unsub = window.api.onPullProgress((p) => {
      $("#ollama-msg").textContent = p.total ? `Pobieranie: ${Math.round((p.completed / p.total) * 100)}% (${(p.completed / 1e9).toFixed(2)} / ${(p.total / 1e9).toFixed(2)} GB)` : p.status || "";
    });
    const res = await window.api.aiPull();
    unsub();
    if (!res.ok) return ($("#ollama-msg").textContent = "Błąd pobierania: " + res.error);
    openEngineDialog();
  }
});

$("#ai-status").addEventListener("click", openEngineDialog);

window.api.onLibraryCleared(() => {
  for (const p of state.pages) {
    p.analysis = null;
    p.status = "new";
  }
  renderThumbs();
  queuePages(state.pages);
  toast("Biblioteka stron wyczyszczona – strony zostaną przeczytane ponownie.");
});

// ================== generowanie ==================
let waitResolve = null;
const waitForUpdate = (ms = 2000) => new Promise((r) => ((waitResolve = r), setTimeout(r, ms)));
let progressTimer;
let cancelRequested = false;

function showProgress(on) {
  $("#progress").classList.toggle("hidden", !on);
  if (on) {
    $("#empty-state").classList.add("hidden");
    const start = Date.now();
    setProgress("Przygotowuję…", 2);
    const tick = () => {
      const s = Math.round((Date.now() - start) / 1000);
      $("#progress-sub").textContent = `Czas: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    progressTimer = setInterval(tick, 1000);
  } else clearInterval(progressTimer);
}

function setProgress(title, pct) {
  $("#progress-title").textContent = title;
  if (pct != null) $("#progress-fill").style.width = `${Math.max(2, Math.min(100, pct))}%`;
}

/** Plan sprawdzianu: jakie rodzaje zadań, w jakiej kolejności i które z grafiką. */
function buildPlan(n, formats, figureCount) {
  const s = state.settings;
  const groups = ["tf", "match", "gap"].filter((f) => formats.includes(f));
  const singles = ["abc", "open"].filter((f) => formats.includes(f));
  const plan = [];
  const perGroup = singles.length ? (n >= 12 ? 2 : 1) : Math.ceil(n / groups.length);
  for (const g of groups) for (let i = 0; i < perGroup && plan.length < n; i++) plan.push({ type: g });
  if (singles.length) {
    const abcShare = { latwy: 0.5, sredni: 0.4, trudny: 0.3 }[s.difficulty] ?? 0.4;
    const rest = n - plan.length;
    const nAbc = singles.length === 2 ? Math.round(rest * abcShare) : singles[0] === "abc" ? rest : 0;
    for (let i = 0; i < nAbc; i++) plan.push({ type: "abc" });
    for (let i = 0; i < rest - nAbc; i++) plan.push({ type: "open" });
  }
  // zadania z ilustracjami – tylko pojedyncze (abc / open)
  const share = { brak: 0, kilka: 0.25, duzo: 0.5 }[s.figures] ?? 0.25;
  let figTasks = Math.min(figureCount, Math.round(n * share));
  if (s.figures !== "brak" && figureCount && !figTasks) figTasks = 1;
  const singleIdx = plan.map((p, i) => (p.type === "abc" || p.type === "open" ? i : -1)).filter((i) => i >= 0);
  for (const i of shuffle(singleIdx).slice(0, figTasks)) plan[i].figure = true;
  const order = { abc: 0, tf: 1, match: 2, gap: 3, open: 4 };
  return plan.slice(0, n).sort((a, b) => order[a.type] - order[b.type]);
}

/** Materiał dla modelu: tekst stron (przycięty, gdy stron jest dużo) i lista ilustracji. */
function buildMaterial(pages) {
  const budget = 9000; // znaków – dłuższy tekst bardzo wydłuża pracę modelu na tym komputerze
  const per = Math.floor(budget / pages.length);
  const material = pages.map((p) => ({ title: p.analysis.title, text: (p.analysis.text || "").slice(0, Math.max(per, 1500)) }));
  const figures = [];
  for (const p of pages) for (const f of p.analysis.figures || []) figures.push({ ...f, pageId: p.id });
  return { material, figures };
}

const clampInt = (v, min, max, def) => {
  const n = Number.isFinite(+v) ? Math.round(+v) : def;
  return Math.max(min, Math.min(max, n));
};
const cleanText = (s) => String(s || "").replace(/\s+/g, " ").trim();
const uniq = (arr, key = (x) => x.toLowerCase()) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Zamienia zadanie od modelu na format aplikacji (z kontrolą poprawności). */
async function taskToQuestion(t, figures) {
  let type = ["open", "abc", "tf", "match", "gap"].includes(t.type) ? t.type : "open";
  const q = {
    id: newId("q"),
    format: type,
    question: cleanText(t.q),
    points: clampInt(t.points, 1, 4, type === "open" || type === "abc" ? 1 : 2),
    answer_lines: 0,
    model_answer: cleanText(t.answer),
    key: newId("k"),
    src: newId("s"),
    figures: [],
  };
  if (!q.question) return null;
  if (type === "abc") {
    const opts = uniq((t.options || []).map(cleanText).filter(Boolean)).slice(0, 4);
    const correctText = cleanText((t.options || [])[t.correct]);
    if (opts.length < 3 || !opts.includes(correctText)) {
      type = q.format = "open"; // zepsute zadanie zamknięte → pytanie otwarte
      q.model_answer = q.model_answer || correctText;
    } else {
      q.options = shuffle(opts);
      q.correct = q.options.indexOf(correctText);
      q.model_answer = correctText;
    }
  }
  if (type === "open") {
    if (!q.model_answer) q.model_answer = "(odpowiedź według podręcznika)";
    q.answer_lines = clampInt(Math.round(q.model_answer.split(/\s+/).length / 8) + 2, 2, 8, 3);
  }
  if (type === "tf") {
    const st = uniq((t.statements || []).map((s) => ({ text: cleanText(s.t), truth: Boolean(s.p) })).filter((s) => s.text), (s) => s.text.toLowerCase());
    if (st.length < 2) return null;
    q.statements = st.slice(0, 6);
  }
  if (type === "match") {
    const pairs = uniq((t.pairs || []).map((p) => ({ l: cleanText(p.l), r: cleanText(p.r) })).filter((p) => p.l && p.r), (p) => p.l.toLowerCase()).slice(0, 6);
    if (pairs.length < 3) return null;
    q.left = pairs.map((p) => p.l);
    q.right = shuffle(pairs.map((p) => p.r));
    q.answers = pairs.map((p) => q.right.indexOf(p.r));
  }
  if (type === "gap") {
    const items = [];
    for (const g of t.gaps || []) {
      let text = cleanText(g.t), answer = cleanText(g.a);
      if (!text || !answer) continue;
      if (/_{2,}|…{2,}|\.{4,}/.test(text)) text = text.replace(/_{2,}|…{2,}|\.{4,}/, BLANK);
      else if (text.toLowerCase().includes(answer.toLowerCase())) text = text.replace(new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), BLANK);
      else continue;
      items.push({ text, answer });
    }
    if (items.length < 2) return null;
    q.items = items.slice(0, 6);
    q.bank = state.settings.difficulty === "trudny" ? null : shuffle(q.items.map((i) => i.answer));
    if (q.bank) q.question = q.question.replace(/\.?$/, "") + ". Wykorzystaj wyrazy z ramki.";
  }
  if (type !== "open") q.model_answer = q.model_answer || "";
  const fig = Number.isInteger(t.figure) && t.figure >= 0 ? figures[t.figure] : null;
  if (fig) {
    const page = state.pages.find((p) => p.id === fig.pageId);
    if (page) q.figures.push(await figureFromAnalysis(page, fig));
  }
  return q;
}

function selectedReadyPages() {
  return state.pages.filter((p) => p.selected && p.analysis && (p.analysis.text || "").length > 40);
}

/** Czeka, aż AI przeczyta wybrane strony (z paskiem postępu). */
async function waitForPages(sel) {
  await window.api.libraryPrioritize(sel.map((p) => p.hash));
  await queuePages(sel.filter((p) => !p.analysis && p.status !== "queued" && p.status !== "reading"));
  const ai = state.ai || {};
  const local = ai.kind === "ollama";
  while (!cancelRequested) {
    const unread = sel.filter((p) => !p.analysis && p.status !== "error");
    if (!unread.length) return true;
    const cur = sel.find((p) => p.status === "reading");
    const done = sel.length - unread.length;
    const part = local && cur ? Math.min(0.99, cur.tokens / READ_TOKENS) : 0;
    setProgress(
      local
        ? `AI czyta strony: ${done + 1} z ${sel.length}` + (cur ? ` – ${cur.tokens ? `przepisuje tekst (${readPct(cur)}%)` : "ogląda zdjęcie"}` : " – czeka w kolejce")
        : `AI czyta strony: ${done} z ${sel.length} gotowe`,
      2 + ((done + part) / sel.length) * 60
    );
    $("#progress-note").textContent = `Zostało ok. ${fmtTime((unread.length * (ai.secPerPage || 30)) / (local ? 1 : 2.5))}. Przeczytane strony są zapamiętywane na stałe.`;
    await waitForUpdate();
  }
  return false;
}

async function generate() {
  const sel = state.pages.filter((p) => p.selected);
  if (state.generating) return;
  if (!sel.length) {
    openDialog("dlg-material");
    return toast(state.pages.length ? "Zaznacz strony, z których ma być sprawdzian." : "Najpierw dodaj zdjęcia stron podręcznika.", true);
  }
  document.querySelectorAll("[data-dialog]").forEach((d) => d.classList.add("hidden"));
  if (!(await refreshAi())) return openAiSetup();
  if (sel.length > 8) toast(`Wybrano ${sel.length} stron – sprawdzian obejmie skrócony tekst każdej z nich. Dla lepszych pytań wybierz 2–6 stron.`, false, 7000);

  state.generating = true;
  cancelRequested = false;
  updateGenerateButton();
  showProgress(true);
  const unsubs = [];
  try {
    if (!(await waitForPages(sel))) return toast("Anulowano.");
    const ready = selectedReadyPages();
    if (!ready.length) return toast("Nie udało się przeczytać wybranych stron. Sprawdź zdjęcia (ostrość, światło) i spróbuj ponownie.", true);

    const s = state.settings;
    const { material, figures } = buildMaterial(ready);
    const plan = buildPlan(s.count, s.formats, figures.length);
    const kindLabel = s.kind === "sprawdzian" ? "Sprawdzian" : "Kartkówka";
    const topic = ready[0].analysis.title || s.subject || "";
    state.test = { title: topic ? `${kindLabel} – ${topic.replace(/^\d+\.?\s*/, "")}` : kindLabel, subject: s.subject || "", questions: [] };
    resetSolve();
    state.view = "test";
    state.keyUnlocked = false;
    renderPreview();
    showProgress(false);
    showGenBanner(true, plan.length);

    const pending = [];
    const seen = new Set();
    const accept = (task, index) => {
      if (seen.has(index)) return;
      seen.add(index);
      pending.push(
        taskToQuestion(task, figures).then((q) => {
          if (q && state.test) {
            state.test.questions.push(q);
            renderPreviewKeepScroll();
          }
          updateGenBanner(plan.length);
        })
      );
    };
    unsubs.push(window.api.onTask(({ task, index }) => accept(task, index)));
    unsubs.push(window.api.onProgress(() => updateGenBanner(plan.length)));
    const res = await window.api.generate({ pages: material, figures: figures.map((f) => ({ caption: f.caption, shows: f.shows, labels: f.labels || [] })), plan, settings: s, avoid: [] });
    // odpowiedź może dojść przed komunikatami z pojedynczymi zadaniami – bierzemy też zadania z wyniku
    if (res.ok) (res.tasks || []).forEach((t, i) => accept(t, i));
    await Promise.all(pending);
    if (!res.ok) {
      toast(res.error, res.error !== "Anulowano.");
      if (!state.test.questions.length) state.test = null;
      return;
    }
    if (res.title && state.test.questions.length) state.test.title = cleanText(res.title);
    // kolejność: najpierw zamknięte, na końcu otwarte
    const order = { abc: 0, tf: 1, match: 2, gap: 3, open: 4 };
    state.test.questions.sort((a, b) => order[a.format] - order[b.format]);
    renderPreview();
    const nQ = state.test.questions.length;
    const pts = state.test.questions.reduce((a, q) => a + q.points, 0);
    toast(
      nQ < plan.length
        ? `Model ułożył ${nQ} z ${plan.length} zadań (część odrzuciłem jako niepoprawne). Brakujące możesz dodać przyciskiem „Inne zadanie” (przy zadaniu) lub „Dodaj pytanie”.`
        : `Gotowe: ${nQ} ${plural(nQ, "zadanie", "zadania", "zadań")} za ${pts} pkt. Przejrzyj je przed drukiem.`,
      nQ < plan.length,
      7000
    );
  } catch (e) {
    console.error(e);
    toast("Coś poszło nie tak: " + (e.message || e), true);
  } finally {
    unsubs.forEach((u) => u());
    state.generating = false;
    showProgress(false);
    showGenBanner(false);
    if (!state.test) $("#empty-state").classList.remove("hidden");
    else renderPreview();
    updateGenerateButton();
  }
}

let genStart = 0;
function showGenBanner(on, total) {
  $("#gen-banner").classList.toggle("hidden", !on);
  if (on) {
    genStart = Date.now();
    updateGenBanner(total);
  }
}
function updateGenBanner(total) {
  if (!state.test) return;
  const n = state.test.questions.length;
  const sec = Math.round((Date.now() - genStart) / 1000);
  $("#gen-banner-text").textContent = `AI układa zadania: ${n} z ${total} gotowe · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} · kolejne pojawią się poniżej`;
}
$("#btn-gen-cancel").addEventListener("click", () => window.api.cancel());

/** „Inne zadanie” – model układa jedno nowe zadanie tego samego rodzaju. */
async function swapQuestion(qi) {
  if (!(await refreshAi())) return openAiSetup();
  const ready = selectedReadyPages().length ? selectedReadyPages() : state.pages.filter((p) => p.analysis);
  if (!ready.length) return toast("Brak przeczytanych stron, z których można ułożyć nowe zadanie.", true);
  const old = state.test.questions[qi];
  const { material, figures } = buildMaterial(ready);
  const plan = [{ type: old.format || "open", figure: Boolean(old.figures && old.figures.length) && figures.length > 0 }];
  state.generating = true;
  old.swapping = true;
  renderPreviewKeepScroll();
  updateGenerateButton();
  let got = null;
  const unsub = window.api.onTask(({ task }) => (got = task));
  try {
    const res = await window.api.generate({
      pages: material,
      figures: figures.map((f) => ({ caption: f.caption, shows: f.shows, labels: f.labels || [] })),
      plan,
      settings: state.settings,
      avoid: state.test.questions.map((q) => q.question).slice(0, 20),
    });
    const task = got || (res.tasks && res.tasks[0]);
    const q = res.ok && task ? await taskToQuestion(task, figures) : null;
    if (q) state.test.questions[qi] = q;
    else toast(res.ok ? "Model nie ułożył poprawnego zadania – spróbuj jeszcze raz." : res.error, true);
  } finally {
    unsub();
    old.swapping = false;
    state.generating = false;
    renderPreviewKeepScroll();
    updateGenerateButton();
  }
}

$("#btn-generate").addEventListener("click", () => {
  closeDialog("dlg-settings");
  generate();
});
$("#btn-cancel").addEventListener("click", () => {
  cancelRequested = true;
  window.api.cancel();
  setProgress("Przerywam…", null);
});

// ================== podgląd ==================
function figureWidthMm(fig) {
  const page = state.pages.find((p) => p.id === fig.pageId);
  const pageW = page ? page.width : 2000;
  const base = ((fig.box.x1 - fig.box.x0) / pageW) * 175;
  return Math.max(40, Math.min(175, base * 1.05 * (fig.scale || 1)));
}

function figureMaxHeightMm(fig) {
  return Math.round(95 * (fig.scale || 1));
}

const FORMAT_LABEL = { open: "otwarte", abc: "zamknięte (ABC)", tf: "prawda / fałsz", match: "dopasowanie", gap: "uzupełnianie luk" };
const LEVEL_LABEL = { 1: "łatwe", 2: "średnie", 3: "trudne" };
const fmtOf = (q) => q.format || "open";
const letter = (i) => LETTERS[i] || "?";

// Skala ocen – typowe progi procentowe w szkole podstawowej
const GRADE_SCALE = [
  { grade: "celujący (6)", min: 1.0 },
  { grade: "bardzo dobry (5)", min: 0.9 },
  { grade: "dobry (4)", min: 0.75 },
  { grade: "dostateczny (3)", min: 0.5 },
  { grade: "dopuszczający (2)", min: 0.3 },
  { grade: "niedostateczny (1)", min: 0 },
];
function gradeRanges(total) {
  let upper = total;
  return GRADE_SCALE.map((g) => {
    const lo = Math.ceil(g.min * total - 1e-9);
    const r = { grade: g.grade, lo, hi: upper };
    upper = Math.min(upper, lo - 1);
    return r;
  });
}
function scaleTable(total) {
  return `
    <table class="scale">
      <tr><th>Ocena</th>${gradeRanges(total).map((r) => `<td>${r.grade}</td>`).join("")}</tr>
      <tr><th>Punkty</th>${gradeRanges(total)
        .map((r) => `<td>${r.lo > r.hi ? "–" : r.lo === r.hi ? r.lo : `${r.lo}–${r.hi}`}</td>`)
        .join("")}</tr>
    </table>`;
}

function renderSummaryTest(t, total) {
  const n = t.questions.length;
  const per = 12;
  let tables = "";
  for (let i = 0; i < n; i += per) {
    const slice = t.questions.slice(i, i + per);
    const last = i + per >= n;
    tables += `
      <table class="sum">
        <tr><th>Zadanie</th>${slice.map((_, k) => `<td>${i + k + 1}</td>`).join("")}${last ? "<td><b>Razem</b></td>" : ""}</tr>
        <tr><th>Maks. punktów</th>${slice.map((q) => `<td>${q.points}</td>`).join("")}${last ? `<td><b>${total}</b></td>` : ""}</tr>
        <tr><th>Zdobyte punkty</th>${slice.map(() => "<td></td>").join("")}${last ? "<td></td>" : ""}</tr>
      </table>`;
  }
  return `
    <section class="summary">
      <h2>Podsumowanie</h2>
      ${tables}
      <div class="scale-title">Skala ocen</div>
      ${scaleTable(total)}
      <div class="sum-fields">
        <div class="f">Ocena: <span class="fill"></span></div>
        <div class="f">Podpis rodzica: <span class="fill"></span></div>
      </div>
    </section>`;
}

function renderSummaryKey(t, total) {
  const byFmt = {}, byLvl = {};
  for (const q of t.questions) {
    byFmt[fmtOf(q)] = (byFmt[fmtOf(q)] || 0) + 1;
    if (q.level) byLvl[q.level] = (byLvl[q.level] || 0) + 1;
  }
  const fmtTxt = Object.keys(FORMAT_LABEL).filter((f) => byFmt[f]).map((f) => `${FORMAT_LABEL[f]}: ${byFmt[f]}`).join(", ");
  const lvlTxt = [1, 2, 3].filter((l) => byLvl[l]).map((l) => `${LEVEL_LABEL[l]}: ${byLvl[l]}`).join(", ");
  const closedPts = t.questions.filter((q) => fmtOf(q) !== "open").reduce((a, q) => a + q.points, 0);
  return `
    <section class="summary">
      <h2>Podsumowanie testu</h2>
      <ul class="sum-list">
        <li>Liczba zadań: <b>${t.questions.length}</b>, łącznie <b>${total} pkt</b>
          (zadania zamknięte: ${closedPts} pkt, otwarte: ${total - closedPts} pkt).</li>
        <li>Rodzaje zadań: ${fmtTxt || "–"}.</li>
        ${lvlTxt ? `<li>Poziom trudności: ${lvlTxt}.</li>` : ""}
        <li>Zadania otwarte oceniaj według wskazówek – liczy się sens odpowiedzi, nie dosłowne brzmienie.</li>
      </ul>
      <div class="scale-title">Skala ocen</div>
      ${scaleTable(total)}
    </section>`;
}

function renderPreview() {
  const t = state.test;
  $("#preview").classList.toggle("hidden", !t);
  $("#empty-state").classList.toggle("hidden", Boolean(t));
  syncChrome();
  if (!t) return;

  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  $("#sheet-test").classList.toggle("hidden", state.view !== "test");
  $("#sheet-key").classList.toggle("hidden", state.view !== "key");
  $("#sheet-solve").classList.toggle("hidden", state.view !== "solve");
  $("#mode-hint").textContent =
    state.view === "solve"
      ? "Uczeń zaznacza i wpisuje odpowiedzi na ekranie"
      : state.view === "key"
        ? "Widoczny tylko po podaniu hasła rodzica"
        : "Kliknij w tekst, aby go poprawić · najedź na zadanie, aby zobaczyć opcje";
  if (state.view === "solve") renderSolve();
  $("#sheet-test").classList.toggle("hide-points", !state.showPoints);
  $("#sheet-test").classList.toggle("hide-lines", !state.showLines);
  $("#sheet-key").classList.toggle("hide-points", !state.showPoints);

  const total = t.questions.reduce((a, q) => a + q.points, 0);
  const sub = [esc(t.subject || state.settings.subject), esc(state.settings.grade)].filter(Boolean).join(" · ");

  $("#sheet-test").innerHTML = `
    <div class="t-head">
      <h1 class="t-title" contenteditable="true" data-edit="title">${esc(t.title)}</h1>
      ${sub ? `<div class="t-sub">${sub}</div>` : ""}
      <div class="t-fields">
        <div class="f">Imię i nazwisko: <span class="fill"></span></div>
        <div class="f">Klasa: <span class="fill"></span></div>
        <div class="f">Data: <span class="fill"></span></div>
      </div>
      <div class="t-score">
        <div>Punkty: <span class="fill"></span> / ${total}</div>
        <div>Ocena: <span class="fill"></span></div>
      </div>
    </div>
    ${t.questions.map((q, i) => renderQuestion(q, i)).join("")}
    <button class="add-q no-print" data-act="add-q"><svg class="ico"><use href="#i-plus"/></svg> Dodaj pytanie</button>
    ${state.showSummary && t.questions.length ? renderSummaryTest(t, total) : ""}
  `;

  if (!state.keyUnlocked) {
    $("#sheet-key").innerHTML = "";
    if (state.view === "key") state.view = "test";
    return;
  }
  $("#sheet-key").innerHTML = `
    <div class="t-head">
      <h1 class="t-title">Klucz odpowiedzi</h1>
      <div class="t-sub">${esc(t.title)}</div>
    </div>
    <div class="hint no-print">W zadaniach zamkniętych kliknij odpowiedź, aby zmienić, która jest poprawna.</div>
    ${t.questions.map((q, i) => renderKeyItem(q, i)).join("")}
    <div class="k-total t-score" style="justify-content:flex-start">Razem: ${total} pkt</div>
    ${state.showSummary ? renderSummaryKey(t, total) : ""}
  `;
}

function renderKeyItem(q, i) {
  const f = fmtOf(q);
  let body = "";
  if (f === "open") {
    body = `<div class="k-a" contenteditable="true" data-edit="model_answer">${esc(q.model_answer)}</div>`;
  } else if (f === "abc") {
    body = `<div class="k-opts">${q.options
      .map((o, k) => `<button class="k-opt ${k === q.correct ? "ok" : ""}" data-act="key-abc" data-idx="${k}">${letter(k)}. ${esc(o)}</button>`)
      .join("")}</div>`;
  } else if (f === "tf") {
    body = `<ol class="k-list">${q.statements
      .map((s, k) => `<li><button class="k-tf ${s.truth ? "p" : "f"}" data-act="key-tf" data-idx="${k}">${s.truth ? "P" : "F"}</button> ${esc(s.text)}</li>`)
      .join("")}</ol>`;
  } else if (f === "match") {
    body = `<ol class="k-list">${q.left
      .map((l, k) => `<li>${esc(l)} → <button class="k-tf p" data-act="key-match" data-idx="${k}">${letter(q.answers[k])}</button> ${esc(q.right[q.answers[k]] || "")}</li>`)
      .join("")}</ol>`;
  } else if (f === "gap") {
    body = `<ol class="k-list">${q.items
      .map((g, k) => `<li><b contenteditable="true" data-edit="items.${k}.answer">${esc(g.answer)}</b> <span class="muted">– ${esc(g.text)}</span></li>`)
      .join("")}</ol>`;
  }
  const title = f === "open" || f === "abc" ? esc(q.question) : `<span class="k-fmt">${FORMAT_LABEL[f]}</span>`;
  return `
    <div class="k-item" data-qid="${q.id}">
      <div class="k-q">${i + 1}. ${title} <span class="q-points">(${q.points} pkt)</span></div>
      ${body}
    </div>`;
}

function renderQuestion(q, i) {
  const f = fmtOf(q);
  const figs = (q.figures || [])
    .map(
      (fg) => `
      <div class="fig" data-fid="${fg.id}" style="width:${figureWidthMm(fg).toFixed(1)}mm">
        <img src="${fg.cropUrl}" alt="${esc(fg.description)}" style="max-height:${figureMaxHeightMm(fg)}mm; width:100%; object-fit:contain" />
        <div class="tools">
          <button data-act="fig-crop" title="Zmień wycinek"><svg class="ico"><use href="#i-crop"/></svg>Kadruj</button>
          <button data-act="fig-smaller" class="sq" title="Zmniejsz"><svg class="ico"><use href="#i-minus"/></svg></button>
          <button data-act="fig-bigger" class="sq" title="Powiększ"><svg class="ico"><use href="#i-plus"/></svg></button>
          <button data-act="fig-remove" class="danger sq" title="Usuń grafikę"><svg class="ico"><use href="#i-trash"/></svg></button>
        </div>
      </div>`
    )
    .join("");

  let body = "";
  if (f === "open") {
    body = `<div class="lines">${"<div></div>".repeat(q.answer_lines)}</div>`;
  } else if (f === "abc") {
    const maxLen = Math.max(...q.options.map((o) => o.length));
    const cls = maxLen <= 16 ? "cols4" : maxLen <= 34 ? "cols2" : "";
    body = `<ol class="opts ${cls}">${q.options
      .map((o, k) => `<li><span class="opt-l">${letter(k)}.</span><span class="opt-t" contenteditable="true" data-edit="options.${k}">${esc(o)}</span></li>`)
      .join("")}</ol>`;
  } else if (f === "tf") {
    body = `<table class="tf">
      <tr><th></th><th></th><th>P</th><th>F</th></tr>
      ${q.statements
        .map((s, k) => `<tr><td class="n">${k + 1}.</td><td contenteditable="true" data-edit="statements.${k}.text">${esc(s.text)}</td><td class="pf">P</td><td class="pf">F</td></tr>`)
        .join("")}
    </table>`;
  } else if (f === "match") {
    body = `<div class="match">
      <ol class="m-left">${q.left
        .map((l, k) => `<li><span class="m-n">${k + 1}.</span><span class="m-t" contenteditable="true" data-edit="left.${k}">${esc(l)}</span><span class="m-box"></span></li>`)
        .join("")}</ol>
      <ol class="m-right">${q.right
        .map((r, k) => `<li><span class="m-n">${letter(k)}.</span><span class="m-t" contenteditable="true" data-edit="right.${k}">${esc(r)}</span></li>`)
        .join("")}</ol>
    </div>`;
  } else if (f === "gap") {
    body = `${q.bank ? `<div class="bank">${q.bank.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : ""}
      <ol class="gaps">${q.items.map((g, k) => `<li contenteditable="true" data-edit="items.${k}.text">${esc(g.text)}</li>`).join("")}</ol>`;
  }

  return `
    <section class="q q-${f} ${q.swapping ? "swapping" : ""}" data-qid="${q.id}">
      ${q.swapping ? `<div class="swap-note no-print">🔄 AI układa nowe zadanie…</div>` : ""}
      <div class="tools q-tools">
        <button data-act="q-swap" class="accent wide" title="Zamień na inne zadanie z tych stron"><svg class="ico"><use href="#i-rotate"/></svg>Inne zadanie</button>
        <div class="tg"><span class="tl">Kolejność</span><button data-act="q-up" class="sq" title="Przesuń wyżej" ${i === 0 ? "disabled" : ""}><svg class="ico"><use href="#i-up"/></svg></button><button data-act="q-down" class="sq" title="Przesuń niżej" ${i === state.test.questions.length - 1 ? "disabled" : ""}><svg class="ico"><use href="#i-down"/></svg></button></div>
        <div class="tg"><span class="tl">Punkty</span><button data-act="pts-minus" class="sq" title="Mniej punktów"><svg class="ico"><use href="#i-minus"/></svg></button><span class="val">${q.points}<span class="tl-short"> pkt</span></span><button data-act="pts-plus" class="sq" title="Więcej punktów"><svg class="ico"><use href="#i-plus"/></svg></button></div>
        ${f === "open" ? `<div class="tg"><span class="tl">Linie</span><button data-act="lines-minus" class="sq" title="Mniej linii"><svg class="ico"><use href="#i-minus"/></svg></button><span class="val">${q.answer_lines}<span class="tl-short"> linii</span></span><button data-act="lines-plus" class="sq" title="Więcej linii"><svg class="ico"><use href="#i-plus"/></svg></button></div>` : ""}
        <button data-act="fig-add" class="wide" title="Dodaj grafikę ze strony"><svg class="ico"><use href="#i-image"/></svg>Grafika</button>
        <button data-act="q-remove" class="danger wide" title="Usuń zadanie"><svg class="ico"><use href="#i-trash"/></svg><span class="tl">Usuń</span></button>
      </div>
      <div class="q-row">
        <span class="q-num">${i + 1}.</span>
        <div class="q-text" contenteditable="true" data-edit="question">${esc(q.question)}</div>
        <span class="q-points">(${q.points} pkt)</span>
      </div>
      ${figs ? `<div class="q-figs">${figs}</div>` : ""}
      ${body}
    </section>`;
}

function setPath(obj, path, value) {
  const parts = path.split(".").map((p) => (/^\d+$/.test(p) ? +p : p));
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}

// edycja tekstu
document.querySelector(".sheets").addEventListener("input", (e) => {
  const el = e.target.closest("[data-edit]");
  if (!el || !state.test) return;
  const field = el.dataset.edit;
  const text = el.innerText.replace(/\n$/, "");
  if (field === "title") {
    state.test.title = text;
    return;
  }
  const qid = el.closest("[data-qid]")?.dataset.qid;
  const q = state.test.questions.find((x) => x.id === qid);
  if (q) setPath(q, field, text);
});

document.querySelector(".sheets").addEventListener("paste", (e) => {
  if (!e.target.closest("[contenteditable]")) return;
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});

function renderPreviewKeepScroll() {
  const main = $(".main");
  const top = main.scrollTop;
  renderPreview();
  main.scrollTop = top;
}

document.querySelector(".sheets").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !state.test) return;
  const act = btn.dataset.act;
  const qs = state.test.questions;

  if (act === "add-q") {
    qs.push({ id: newId("q"), format: "open", question: "Nowe pytanie – kliknij, aby wpisać treść.", points: 1, answer_lines: 3, model_answer: "", key: newId("k"), src: newId("s"), level: 1, figures: [] });
    renderPreviewKeepScroll();
    return;
  }

  const qEl = btn.closest("[data-qid]");
  const qi = qs.findIndex((q) => q.id === qEl?.dataset.qid);
  if (qi < 0) return;
  const q = qs[qi];
  const fid = btn.closest("[data-fid]")?.dataset.fid;
  const fig = q.figures.find((f) => f.id === fid);

  switch (act) {
    case "key-abc":
      q.correct = +btn.dataset.idx;
      break;
    case "key-tf": {
      const st = q.statements[+btn.dataset.idx];
      st.truth = !st.truth;
      break;
    }
    case "key-match": {
      const k = +btn.dataset.idx;
      q.answers[k] = (q.answers[k] + 1) % q.right.length;
      break;
    }
    case "q-swap":
      if (!state.pages.some((p) => p.ocr)) return toast("Brak odczytanych stron – dodaj zdjęcia i kliknij Generuj.", true);
      if (!(await swapQuestion(qi))) return;
      break;
    case "q-up":
      if (qi > 0) [qs[qi - 1], qs[qi]] = [qs[qi], qs[qi - 1]];
      break;
    case "q-down":
      if (qi < qs.length - 1) [qs[qi + 1], qs[qi]] = [qs[qi], qs[qi + 1]];
      break;
    case "q-remove":
      if (!confirm(`Usunąć pytanie ${qi + 1}?`)) return;
      qs.splice(qi, 1);
      break;
    case "pts-minus":
      q.points = Math.max(1, q.points - 1);
      break;
    case "pts-plus":
      q.points = Math.min(10, q.points + 1);
      break;
    case "lines-minus":
      q.answer_lines = Math.max(0, q.answer_lines - 1);
      break;
    case "lines-plus":
      q.answer_lines = Math.min(15, q.answer_lines + 1);
      break;
    case "fig-add": {
      if (!state.pages.length) return toast("Brak zdjęć stron – dodaj je w panelu po lewej.", true);
      const result = await openCropper(null);
      if (!result) return;
      q.figures.push({ id: newId("f"), description: "", scale: 1, ...result });
      break;
    }
    case "fig-crop": {
      const result = await openCropper(fig);
      if (!result) return;
      Object.assign(fig, result);
      break;
    }
    case "fig-smaller":
      fig.scale = Math.max(0.4, +(fig.scale - 0.15).toFixed(2));
      break;
    case "fig-bigger":
      fig.scale = Math.min(2.5, +(fig.scale + 0.15).toFixed(2));
      break;
    case "fig-remove":
      q.figures = q.figures.filter((f) => f !== fig);
      break;
  }
  renderPreviewKeepScroll();
});

document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", async () => {
    if (b.dataset.view === "key" && !state.keyUnlocked) {
      if (!(await askPassword())) return syncUi();
      state.keyUnlocked = true;
    }
    if (b.dataset.view !== "key") state.keyUnlocked = false; // wyjście z klucza = klucz znowu zablokowany
    if (b.dataset.view !== "solve" && state.solve) state.solve.revealed = false;
    state.view = b.dataset.view;
    renderPreview();
    syncUi();
  })
);

// ================== tryb „Rozwiąż” – uczeń rozwiązuje sprawdzian na komputerze ==================
state.solve = { answers: {}, openPoints: {}, finished: false, revealed: false, name: "" };

function resetSolve() {
  state.solve = { answers: {}, openPoints: {}, finished: false, revealed: false, name: state.solve ? state.solve.name : "" };
}

const normAns = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[.,;:!?„”"'()«»–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const half = (x) => Math.round(x * 2) / 2;

/** Wynik jednego zadania: punkty, maksimum, czy liczone automatycznie, poprawność części. */
function solveScore(q) {
  const a = state.solve.answers[q.id];
  const f = fmtOf(q);
  if (f === "abc") {
    const ok = a === q.correct;
    return { auto: true, score: ok ? q.points : 0, parts: [ok] };
  }
  if (f === "tf") {
    const parts = q.statements.map((s, i) => a && a[i] === s.truth);
    return { auto: true, score: half((q.points * parts.filter(Boolean).length) / parts.length), parts };
  }
  if (f === "match") {
    const parts = q.left.map((_, i) => a && a[i] === q.answers[i]);
    return { auto: true, score: half((q.points * parts.filter(Boolean).length) / parts.length), parts };
  }
  if (f === "gap") {
    const parts = q.items.map((g, i) => Boolean(a && normAns(a[i])) && normAns(a[i]) === normAns(g.answer));
    return { auto: true, score: half((q.points * parts.filter(Boolean).length) / parts.length), parts };
  }
  const p = state.solve.openPoints[q.id];
  return { auto: false, score: Number.isFinite(p) ? p : null, parts: [] };
}

function solveTotals() {
  const qs = state.test.questions;
  let closed = 0, closedMax = 0, open = 0, openMax = 0, openGraded = true;
  for (const q of qs) {
    const r = solveScore(q);
    if (r.auto) {
      closed += r.score;
      closedMax += q.points;
    } else {
      openMax += q.points;
      if (r.score == null) openGraded = false;
      else open += r.score;
    }
  }
  return { closed, closedMax, open, openMax, openGraded, total: closed + open, max: closedMax + openMax };
}

function gradeFor(points, max) {
  const r = gradeRanges(max).find((g) => points >= g.lo && points <= g.hi + 0.5);
  return r ? r.grade : "";
}

function mark(ok) {
  return state.solve.finished ? `<span class="s-mark ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span>` : "";
}

function renderSolveTask(q, i) {
  const f = fmtOf(q);
  const a = state.solve.answers[q.id];
  const done = state.solve.finished;
  const rev = state.solve.revealed;
  const r = done ? solveScore(q) : null;
  const dis = done ? "disabled" : "";
  let body = "";
  if (f === "abc") {
    body = `<div class="s-opts">${q.options
      .map((o, k) => {
        const cls = [a === k ? "sel" : "", done && a === k ? (k === q.correct ? "ok" : "bad") : "", rev && k === q.correct ? "right" : ""].join(" ");
        return `<button class="s-opt ${cls}" data-sact="abc" data-idx="${k}" ${dis}><span class="opt-l">${letter(k)}.</span><span>${esc(o)}</span></button>`;
      })
      .join("")}</div>`;
  } else if (f === "tf") {
    body = `<table class="tf s-tf">${q.statements
      .map((s, k) => {
        const v = a ? a[k] : undefined;
        const btn = (val, label) => {
          const cls = [v === val ? "sel" : "", done && v === val ? (val === s.truth ? "ok" : "bad") : "", rev && s.truth === val ? "right" : ""].join(" ");
          return `<td class="pf"><button class="s-pf ${cls}" data-sact="tf" data-idx="${k}" data-val="${val}" ${dis}>${label}</button></td>`;
        };
        return `<tr><td class="n">${k + 1}.</td><td>${esc(s.text)} ${done ? mark(r.parts[k]) : ""}</td>${btn(true, "P")}${btn(false, "F")}</tr>`;
      })
      .join("")}</table>`;
  } else if (f === "match") {
    body = `<div class="match">
      <ol class="m-left">${q.left
        .map((l, k) => {
          const sel = a ? a[k] : undefined;
          return `<li><span class="m-n">${k + 1}.</span><span class="m-t">${esc(l)}</span>
            <select class="s-select" data-sinput="match" data-idx="${k}" ${dis}>
              <option value="">–</option>${q.right.map((_, j) => `<option value="${j}" ${sel === j ? "selected" : ""}>${letter(j)}</option>`).join("")}
            </select>${done ? mark(r.parts[k]) : ""}${rev ? `<span class="s-right">${letter(q.answers[k])}</span>` : ""}</li>`;
        })
        .join("")}</ol>
      <ol class="m-right">${q.right.map((x, j) => `<li><span class="m-n">${letter(j)}.</span><span class="m-t">${esc(x)}</span></li>`).join("")}</ol>
    </div>`;
  } else if (f === "gap") {
    body = `${q.bank ? `<div class="bank">${q.bank.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : ""}
      <ol class="gaps s-gaps">${q.items
        .map((g, k) => {
          const parts = String(g.text).split(BLANK);
          const val = a ? a[k] || "" : "";
          const input = `<input class="s-gap" data-sinput="gap" data-idx="${k}" value="${esc(val)}" ${dis} autocomplete="off" spellcheck="false" />`;
          return `<li>${esc(parts[0])}${input}${esc(parts.slice(1).join(" "))} ${done ? mark(r.parts[k]) : ""}${rev ? `<span class="s-right">${esc(g.answer)}</span>` : ""}</li>`;
        })
        .join("")}</ol>`;
  } else {
    body = `<textarea class="s-open" data-sinput="open" rows="${Math.max(3, q.answer_lines)}" ${dis} placeholder="Napisz odpowiedź…">${esc(a || "")}</textarea>
      ${rev ? `<div class="s-model"><b>Wzorcowa odpowiedź:</b> ${esc(q.model_answer)}</div>
        <div class="s-grade">Punkty za odpowiedź: <input type="number" class="s-pts" data-sinput="openpts" min="0" max="${q.points}" step="0.5" value="${Number.isFinite(state.solve.openPoints[q.id]) ? state.solve.openPoints[q.id] : ""}" /> / ${q.points}</div>` : ""}`;
  }
  const status = done ? (r.auto ? `<span class="s-score ${r.score === q.points ? "ok" : r.score > 0 ? "part" : "bad"}">${r.score} / ${q.points} pkt</span>` : `<span class="s-score wait">${r.score == null ? "do oceny przez rodzica" : `${r.score} / ${q.points} pkt`}</span>`) : `<span class="q-points">(${q.points} pkt)</span>`;
  const figs = (q.figures || []).map((fg) => `<div class="fig" style="width:${figureWidthMm(fg).toFixed(1)}mm"><img src="${fg.cropUrl}" alt="" style="max-height:${figureMaxHeightMm(fg)}mm; width:100%; object-fit:contain" /></div>`).join("");
  return `
    <section class="q s-q" data-qid="${q.id}">
      <div class="q-row">
        <span class="q-num">${i + 1}.</span>
        <div class="q-text">${esc(q.question)} ${f === "abc" && done ? mark(r.parts[0]) : ""}</div>
        ${status}
      </div>
      ${figs ? `<div class="q-figs">${figs}</div>` : ""}
      ${body}
    </section>`;
}

function renderSolve() {
  const t = state.test;
  const s = state.solve;
  const tot = s.finished ? solveTotals() : null;
  const answered = t.questions.filter((q) => {
    const a = s.answers[q.id];
    return a != null && a !== "" && !(typeof a === "object" && !Object.values(a).some((v) => v !== "" && v != null));
  }).length;
  $("#sheet-solve").innerHTML = `
    <div class="t-head">
      <h1 class="t-title">${esc(t.title)}</h1>
      <div class="s-namerow">Imię i nazwisko: <input class="s-name" data-sinput="name" value="${esc(s.name)}" ${s.finished ? "disabled" : ""} placeholder="wpisz swoje imię" /></div>
      <div class="s-help">${s.finished ? "Sprawdzian zakończony." : "Kliknij odpowiedź, wybierz literę albo wpisz tekst. Na koniec kliknij „Zakończ i sprawdź”."} <span class="muted">Odpowiedzi: ${answered} / ${t.questions.length}</span></div>
    </div>
    ${t.questions.map((q, i) => renderSolveTask(q, i)).join("")}
    ${
      !s.finished
        ? `<div class="s-finish"><button class="btn primary big" data-sact="finish">Zakończ i sprawdź</button></div>`
        : `<div class="s-result">
            <h2>Wynik</h2>
            <div class="s-result-grid">
              <div><span>Zadania zamknięte</span><b>${tot.closed} / ${tot.closedMax} pkt</b></div>
              <div><span>Zadania otwarte</span><b>${tot.openMax ? (tot.openGraded ? `${tot.open} / ${tot.openMax} pkt` : "do oceny przez rodzica") : "–"}</b></div>
              <div class="sum"><span>Razem</span><b>${tot.openGraded ? `${tot.total} / ${tot.max} pkt` : `${tot.closed} pkt + zadania otwarte`}</b></div>
              ${tot.openGraded ? `<div class="sum"><span>Ocena</span><b>${esc(gradeFor(tot.total, tot.max))}</b></div>` : ""}
            </div>
            <div class="s-actions">
              ${s.revealed ? `<span class="muted small">Poprawne odpowiedzi są zaznaczone na zielono. Wpisz punkty za zadania otwarte.</span>` : `<button class="btn primary" data-sact="reveal">🔒 Pokaż odpowiedzi i oceń (hasło rodzica)</button>`}
              <button class="btn" data-sact="reset">Rozwiąż od nowa</button>
            </div>
          </div>`
    }`;
}

function renderSolveKeepScroll() {
  const main = $(".main");
  const top = main.scrollTop;
  renderSolve();
  main.scrollTop = top;
}

$("#sheet-solve").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sact]");
  if (!b || b.disabled) return;
  const act = b.dataset.sact;
  const qid = b.closest("[data-qid]")?.dataset.qid;
  const s = state.solve;
  if (act === "abc") s.answers[qid] = +b.dataset.idx;
  if (act === "tf") s.answers[qid] = { ...(s.answers[qid] || {}), [b.dataset.idx]: b.dataset.val === "true" };
  if (act === "finish") {
    const empty = state.test.questions.filter((q) => s.answers[q.id] == null).length;
    if (empty && !(await window.api.confirm("Zakończyć sprawdzian?", `Bez odpowiedzi: ${empty} ${plural(empty, "zadanie", "zadania", "zadań")}. Po zakończeniu nie można już zmieniać odpowiedzi.`, "Zakończ"))) return;
    s.finished = true;
  }
  if (act === "reveal") {
    if (!(await askPassword())) return;
    s.revealed = true;
  }
  if (act === "reset") {
    if (!(await window.api.confirm("Rozwiązać sprawdzian od nowa?", "Wszystkie odpowiedzi i punkty zostaną wyczyszczone.", "Od nowa"))) return;
    resetSolve();
  }
  renderSolveKeepScroll();
  if (act === "finish") $(".main").scrollTop = $(".main").scrollHeight;
});

const onSolveInput = (e) => {
  const el = e.target.closest("[data-sinput]");
  if (!el) return;
  const s = state.solve;
  const kind = el.dataset.sinput;
  if (kind === "name") return void (s.name = el.value);
  const qid = el.closest("[data-qid]")?.dataset.qid;
  if (!qid) return;
  if (kind === "open") s.answers[qid] = el.value;
  if (kind === "gap") s.answers[qid] = { ...(s.answers[qid] || {}), [el.dataset.idx]: el.value };
  if (kind === "match") s.answers[qid] = { ...(s.answers[qid] || {}), [el.dataset.idx]: el.value === "" ? undefined : +el.value };
  if (kind === "openpts") {
    const q = state.test.questions.find((x) => x.id === qid);
    const v = parseFloat(String(el.value).replace(",", "."));
    s.openPoints[qid] = Number.isFinite(v) ? Math.max(0, Math.min(q.points, v)) : undefined;
    if (e.type === "change") renderSolveKeepScroll();
  }
};
$("#sheet-solve").addEventListener("input", onSolveInput);
$("#sheet-solve").addEventListener("change", onSolveInput);

// ================== hasło rodzica ==================
let passResolve = null;
let passMode = "verify";

function setPassMode(mode) {
  passMode = mode;
  const set = mode === "set", change = mode === "change";
  $("#pass-title").textContent = set ? "🔒 Ustaw hasło rodzica" : change ? "🔒 Zmiana hasła rodzica" : "🔒 Klucz odpowiedzi";
  $("#pass-info").textContent = set
    ? "Klucz odpowiedzi będzie chroniony hasłem, żeby dziecko nie podejrzało rozwiązań. Zapamiętaj je – będzie potrzebne przy każdym otwarciu klucza."
    : change
      ? "Podaj obecne hasło i nowe hasło."
      : "Klucz jest chroniony hasłem rodzica. Po powrocie do zakładki „Sprawdzian” zablokuje się ponownie.";
  $("#pass-old-wrap").classList.toggle("hidden", !change);
  $("#pass-2-wrap").classList.toggle("hidden", !(set || change));
  $("#pass-1-label").textContent = set || change ? "Nowe hasło" : "Hasło";
  $("#btn-pass-ok").textContent = set ? "Ustaw i odblokuj" : change ? "Zmień hasło" : "Odblokuj";
  $("#btn-pass-change").classList.toggle("hidden", mode !== "verify");
  for (const id of ["#pass-old", "#pass-1", "#pass-2"]) $(id).value = "";
  $("#pass-error").textContent = "";
  setTimeout(() => (change ? $("#pass-old") : $("#pass-1")).focus(), 30);
}

async function askPassword() {
  const st = await window.api.keyStatus();
  setPassMode(st.hasPassword ? "verify" : "set");
  $("#modal-pass").classList.remove("hidden");
  return new Promise((r) => (passResolve = r));
}

function closePass(ok) {
  $("#modal-pass").classList.add("hidden");
  for (const id of ["#pass-old", "#pass-1", "#pass-2"]) $(id).value = "";
  const r = passResolve;
  passResolve = null;
  r?.(ok);
}

async function submitPass() {
  const err = (m) => ($("#pass-error").textContent = m);
  const p1 = $("#pass-1").value, p2 = $("#pass-2").value;
  if (passMode === "verify") {
    if (await window.api.keyVerify(p1)) return closePass(true);
    $("#pass-1").value = "";
    return err("Nieprawidłowe hasło.");
  }
  if (p1 !== p2) return err("Hasła nie są takie same.");
  const res = await window.api.keySetPassword($("#pass-old").value, p1);
  if (!res.ok) return err(res.error);
  if (passMode === "change") {
    toast("Zmieniono hasło rodzica.");
    return passResolve ? setPassMode("verify") : closePass(false);
  }
  closePass(true);
}

$("#btn-pass-ok").addEventListener("click", submitPass);
$("#btn-pass-cancel").addEventListener("click", () => closePass(false));
$("#btn-pass-change").addEventListener("click", () => setPassMode("change"));
$("#modal-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPass();
  if (e.key === "Escape") closePass(false);
});
$("#opt-points").addEventListener("change", (e) => setOption("showPoints", e.target.checked));
$("#opt-summary").addEventListener("change", (e) => setOption("showSummary", e.target.checked));
$("#opt-lines").addEventListener("change", (e) => setOption("showLines", e.target.checked));

// ================== druk / PDF ==================
async function withPrintMode(fn) {
  document.activeElement?.blur?.();
  const cls = state.view === "key" ? "print-key" : "print-test";
  document.body.classList.add(cls);
  try {
    return await fn();
  } finally {
    document.body.classList.remove(cls);
  }
}

async function exportPdf(which = state.view) {
  if (!state.test) return;
  if (which === "key" && !state.keyUnlocked) {
    if (!(await askPassword())) return;
    state.keyUnlocked = true;
  }
  const prevView = state.view;
  if (which !== state.view) {
    state.view = which;
    renderPreview();
  }
  await withPrintMode(async () => {
    const base = state.test.title || "Sprawdzian";
    const res = await window.api.savePdf(which === "key" ? `${base} - klucz odpowiedzi` : base);
    if (res.ok) toast("Zapisano PDF.");
  });
  if (prevView !== state.view) {
    state.view = prevView;
    if (prevView === "test") state.keyUnlocked = false;
    renderPreview();
  }
}

$("#btn-print").addEventListener("click", () => withPrintMode(() => window.api.print()));
$("#btn-pdf").addEventListener("click", () => exportPdf());

// ================== zapis / odczyt projektu ==================
$("#btn-save").addEventListener("click", async () => {
  if (!state.test) return;
  const pages = state.pages.map(({ id, hash, baseHash, rot, name, url, width, height, selected, analysis }) => ({ id, hash, baseHash, rot, name, url, width, height, selected, analysis }));
  const data = JSON.stringify({ version: 3, settings: state.settings, pages, test: state.test });
  const res = await window.api.saveProject(state.test.title, data);
  if (res.ok) toast("Zapisano sprawdzian.");
});

$("#btn-open").addEventListener("click", async () => {
  const res = await window.api.openProject();
  if (!res.ok) return;
  try {
    const data = JSON.parse(res.data);
    if (!data.test || !Array.isArray(data.pages)) throw new Error("zły format");
    state.pages = data.pages.map((p) => ({ selected: true, status: p.analysis ? "done" : "new", tokens: 0, analysis: null, rot: 0, baseHash: p.hash, ...p }));
    for (const p of state.pages) {
      delete p.ocr;
      delete p.figBoxes;
      if (!p.hash) p.hash = p.baseHash = p.id; // plik z wcześniejszej wersji programu
    }
    state.test = data.test;
    resetSolve();
    Object.assign(state.settings, data.settings || {});
    state.view = "test";
    state.keyUnlocked = false;
    bindSettingsValues();
    renderThumbs();
    queuePages(state.pages.filter((p) => !p.analysis));
    renderPreview();
    toast("Wczytano sprawdzian.");
  } catch {
    toast("To nie jest poprawny plik sprawdzianu.", true);
  }
});

// ================== kadrowanie ==================
let cropResolve = null;
const crop = { pageId: null, box: null, dragStart: null };

function openCropper(fig) {
  const page = (fig && state.pages.find((p) => p.id === fig.pageId)) || state.pages[0];
  if (!page) {
    toast("Strona, z której pochodzi grafika, została usunięta.", true);
    return Promise.resolve(null);
  }
  crop.pageId = page.id;
  crop.box = fig && fig.pageId === page.id ? { ...fig.box } : null;
  $("#crop-pages").innerHTML = state.pages
    .map((p, i) => `<img src="${p.url}" data-id="${p.id}" title="Strona ${i + 1}" class="${p.id === page.id ? "active" : ""}" />`)
    .join("");
  $("#crop-pages").classList.toggle("hidden", state.pages.length < 2);
  showCropPage(page);
  $("#modal-crop").classList.remove("hidden");
  return new Promise((r) => (cropResolve = r));
}

function showCropPage(page) {
  crop.pageId = page.id;
  const img = $("#crop-img");
  img.onload = drawCropRect;
  img.src = page.url;
  document.querySelectorAll("#crop-pages img").forEach((el) => el.classList.toggle("active", el.dataset.id === page.id));
  drawCropRect();
}

function cropScale() {
  const img = $("#crop-img");
  const page = state.pages.find((p) => p.id === crop.pageId);
  return img.clientWidth ? img.clientWidth / page.width : 1;
}

function drawCropRect() {
  const r = $("#crop-rect");
  if (!crop.box) return r.classList.add("hidden");
  const s = cropScale();
  r.classList.remove("hidden");
  r.style.left = crop.box.x0 * s + "px";
  r.style.top = crop.box.y0 * s + "px";
  r.style.width = (crop.box.x1 - crop.box.x0) * s + "px";
  r.style.height = (crop.box.y1 - crop.box.y0) * s + "px";
}

$("#crop-pages").addEventListener("click", (e) => {
  const id = e.target.dataset?.id;
  const page = state.pages.find((p) => p.id === id);
  if (!page || page.id === crop.pageId) return;
  crop.box = null;
  showCropPage(page);
});

function stagePoint(e) {
  const rect = $("#crop-img").getBoundingClientRect();
  const page = state.pages.find((p) => p.id === crop.pageId);
  const s = cropScale();
  const x = Math.max(0, Math.min(page.width, (e.clientX - rect.left) / s));
  const y = Math.max(0, Math.min(page.height, (e.clientY - rect.top) / s));
  return { x: Math.round(x), y: Math.round(y) };
}

$("#crop-stage").addEventListener("mousedown", (e) => {
  e.preventDefault();
  crop.dragStart = stagePoint(e);
  crop.box = { x0: crop.dragStart.x, y0: crop.dragStart.y, x1: crop.dragStart.x, y1: crop.dragStart.y };
  drawCropRect();
});
window.addEventListener("mousemove", (e) => {
  if (!crop.dragStart) return;
  const p = stagePoint(e);
  const a = crop.dragStart;
  crop.box = { x0: Math.min(a.x, p.x), y0: Math.min(a.y, p.y), x1: Math.max(a.x, p.x), y1: Math.max(a.y, p.y) };
  drawCropRect();
});
window.addEventListener("mouseup", () => (crop.dragStart = null));
window.addEventListener("resize", () => !$("#modal-crop").classList.contains("hidden") && drawCropRect());

function closeCropper(result) {
  $("#modal-crop").classList.add("hidden");
  const r = cropResolve;
  cropResolve = null;
  r?.(result);
}
$("#btn-crop-cancel").addEventListener("click", () => closeCropper(null));
$("#btn-crop-save").addEventListener("click", async () => {
  const b = crop.box;
  if (!b || b.x1 - b.x0 < 10 || b.y1 - b.y0 < 10) return toast("Zaznacz myszką prostokąt z grafiką.", true);
  const page = state.pages.find((p) => p.id === crop.pageId);
  closeCropper({ pageId: page.id, box: { ...b }, cropUrl: await cropFigure(page, b, 0) });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-crop").classList.contains("hidden")) closeCropper(null);
});

// ================== okno: pasek aplikacji, menu, panele ==================
function syncChrome() {
  const t = state.test;
  const pts = t ? t.questions.reduce((a, q) => a + q.points, 0) : 0;
  $("#doc-title").textContent = t ? t.title || "Sprawdzian" : "Nowy sprawdzian";
  $("#doc-sub").textContent = t
    ? [`${t.questions.length} ${plural(t.questions.length, "zadanie", "zadania", "zadań")} · ${pts} pkt`, state.settings.grade, t.subject || state.settings.subject].filter(Boolean).join(" · ")
    : "Dodaj zdjęcia stron, wybierz ustawienia i kliknij „Generuj”";
  for (const id of ["#btn-save", "#btn-print", "#btn-pdf"]) $(id).disabled = !t || !t.questions.length;
  document.querySelector('.tab[data-view="key"]').disabled = !t;
  document.querySelector('.tab[data-view="solve"]').disabled = !t || !t.questions.length;
  updateStatusBar();
  syncUi();
}

let uiTimer;
function syncUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(
    () =>
      window.api.setUiState({
        view: state.view,
        showPoints: state.showPoints,
        showLines: state.showLines,
        showSummary: state.showSummary,
        hasTest: Boolean(state.test && state.test.questions.length),
        busy: state.generating,
      }),
    60
  );
}

async function newTest() {
  if (state.test && state.test.questions.length && !(await window.api.confirm("Zacząć nowy sprawdzian?", "Obecny sprawdzian zniknie z podglądu. Jeśli chcesz go zachować, najpierw zapisz go (Plik → Zapisz).", "Nowy sprawdzian"))) return;
  state.test = null;
  state.view = "test";
  state.keyUnlocked = false;
  renderPreview();
  updateGenerateButton();
}

function setOption(key, value) {
  state[key] = value;
  const el = { showPoints: "#opt-points", showLines: "#opt-lines", showSummary: "#opt-summary" }[key];
  if (el) $(el).checked = value;
  renderPreviewKeepScroll();
  syncUi();
}

window.api.onMenu(async (action, arg) => {
  switch (action) {
    case "new":
      return newTest();
    case "open":
      return $("#btn-open").click();
    case "save":
      return $("#btn-save").click();
    case "addPhotos":
      openDialog("dlg-material");
      return addPhotosDialog();
    case "addFolder":
      openDialog("dlg-material");
      return addFolderDialog();
    case "pdf":
      return exportPdf(arg);
    case "print":
      return $("#btn-print").click();
    case "addTask": {
      if (state.view !== "test") document.querySelector('.tab[data-view="test"]').click();
      const b = document.querySelector('#sheet-test [data-act="add-q"]');
      return b && b.click();
    }
    case "generate":
      return generate();
    case "view":
      return document.querySelector(`.tab[data-view="${arg}"]`).click();
    case "toggle":
      return setOption(arg, !state[arg]);
    case "material":
      return openDialog("dlg-material");
    case "settings":
      return openDialog("dlg-settings");
    case "engineSetup":
      return openEngineDialog();
    case "changePassword": {
      const st = await window.api.keyStatus();
      setPassMode(st.hasPassword ? "change" : "set");
      $("#modal-pass").classList.remove("hidden");
      return;
    }
    case "help":
      return $("#modal-help").classList.remove("hidden");
  }
});

$("#btn-help-close").addEventListener("click", () => $("#modal-help").classList.add("hidden"));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  $("#modal-help").classList.add("hidden");
  document.querySelectorAll("[data-dialog]").forEach((d) => d.classList.add("hidden"));
});

// ================== start ==================
(async function init() {
  const prefs = await window.api.getPrefs();
  Object.assign(state.settings, prefs || {});
  bindSettings();
  const ready = await refreshAi();
  renderThumbs();
  renderPreview();
  if (!ready || state.ai.firstRun) openEngineDialog();
})();
