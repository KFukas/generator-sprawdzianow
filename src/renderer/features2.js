"use strict";
// Wczytywanie PDF, limit czasu na rozwiązanie, rozwiązywanie na tablecie lub telefonie (kod QR).

// ================== PDF → strony ==================
let pdfjsLib = null;
const PDF_BASE = "../../node_modules/pdfjs-dist/";
async function loadPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDF_BASE + "build/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(PDF_BASE + "build/pdf.worker.min.mjs", location.href).href;
  }
  return pdfjsLib;
}

/** „1-3, 5, 8-9” → [1,2,3,5,8,9] (w granicach 1..n). */
function parseRange(str, n) {
  const out = new Set();
  for (const part of String(str).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) return null;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

let pdfResolve = null;
function askPdfPages(name, n, room) {
  $("#pdf-name").textContent = name;
  $("#pdf-info").textContent = `${n} ${plural(n, "strona", "strony", "stron")}. Możesz dodać jeszcze ${room} ${plural(room, "stronę", "strony", "stron")}.`;
  $("#pdf-range").value = n <= Math.min(room, 10) ? `1-${n}` : "";
  $("#pdf-error").textContent = "";
  $("#modal-pdf").classList.remove("hidden");
  setTimeout(() => $("#pdf-range").focus(), 50);
  return new Promise((r) => (pdfResolve = (v) => ((pdfResolve = null), $("#modal-pdf").classList.add("hidden"), r(v))));
}
$("#btn-pdf-ok").addEventListener("click", () => {
  const n = +$("#pdf-range").dataset.n || 0;
  const pages = parseRange($("#pdf-range").value, n);
  if (!pages || !pages.length) return ($("#pdf-error").textContent = "Wpisz numery stron, np. 12-15 albo 3, 7, 9.");
  pdfResolve && pdfResolve(pages);
});
$("#btn-pdf-cancel").addEventListener("click", () => pdfResolve && pdfResolve(null));
$("#pdf-range").addEventListener("keydown", (e) => e.key === "Enter" && $("#btn-pdf-ok").click());

const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** Zamienia pliki PDF na obrazy stron (pozostałe pliki bez zmian). */
async function expandPdfs(files) {
  if (!files.some(isPdf)) return files;
  const out = [];
  for (const f of files) {
    if (!isPdf(f)) {
      out.push(f);
      continue;
    }
    const room = MAX_PAGES - state.pages.length - out.length;
    if (room <= 0) {
      toast(`Można dodać maksymalnie ${MAX_PAGES} stron.`, true);
      break;
    }
    let doc;
    try {
      const lib = await loadPdfJs();
      doc = await lib.getDocument({
        data: new Uint8Array(await f.arrayBuffer()),
        isEvalSupported: false,
        wasmUrl: PDF_BASE + "wasm/",
        standardFontDataUrl: PDF_BASE + "standard_fonts/",
        cMapUrl: PDF_BASE + "cmaps/",
        iccUrl: PDF_BASE + "iccs/",
      }).promise;
    } catch (e) {
      console.error(e);
      toast(/password/i.test(String(e && e.name)) ? `Plik ${f.name} jest zabezpieczony hasłem.` : `Nie udało się otworzyć pliku ${f.name}.`, true);
      continue;
    }
    try {
      const n = doc.numPages;
      $("#pdf-range").dataset.n = n;
      let pages = n === 1 ? [1] : await askPdfPages(f.name, n, room);
      if (!pages) continue;
      if (pages.length > room) {
        toast(`Wczytuję pierwsze ${room} z wybranych stron (limit ${MAX_PAGES} stron).`, true);
        pages = pages.slice(0, room);
      }
      const base = f.name.replace(/\.pdf$/i, "");
      for (const [i, p] of pages.entries()) {
        toast(`PDF „${base}”: przygotowuję stronę ${i + 1} z ${pages.length}…`, false, 60000);
        const page = await doc.getPage(p);
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(4, 2200 / Math.max(v1.width, v1.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
        out.push(new File([blob], `${base} – str. ${p}.jpg`, { type: "image/jpeg" }));
        page.cleanup();
      }
      $("#toast").classList.add("hidden");
    } catch (e) {
      console.error(e);
      toast(`Nie udało się przygotować stron z pliku ${f.name}.`, true);
    } finally {
      doc.destroy();
    }
  }
  return out;
}

// ================== limit czasu na rozwiązanie (opcjonalny) ==================
const timeLimit = () => Number(state.settings.timeLimit) || 0;
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
function timeLeft() {
  const s = state.solve;
  return timeLimit() && s.timerStartedAt ? Math.max(0, timeLimit() * 60 - Math.floor((Date.now() - s.timerStartedAt) / 1000)) : null;
}

/** Przed startem odliczania – ekran „Zaczynam”. true = zadania jeszcze ukryte. */
function solveGate() {
  const s = state.solve;
  if (!timeLimit() || s.finished || s.timerStartedAt) return false;
  const t = state.test;
  $("#sheet-solve").innerHTML = `
    <div class="s-gate">
      <div class="empty-icon"><svg><use href="#i-clock"/></svg></div>
      <h1>${esc(t.title)}</h1>
      <p>${t.questions.length} ${plural(t.questions.length, "zadanie", "zadania", "zadań")} · limit czasu</p>
      <div class="s-gate-time">${timeLimit()} min</div>
      <p class="muted">Czas zacznie płynąć po kliknięciu „Zaczynam”. Gdy minie, sprawdzian zakończy się sam.</p>
      <div class="s-namerow">Imię: <input class="s-name" data-sinput="name" value="${esc(s.name)}" placeholder="wpisz swoje imię" /></div>
      <button class="btn primary cta" data-gate="start">Zaczynam</button>
    </div>`;
  return true;
}

function timerHtml() {
  const left = timeLeft();
  if (left == null || state.solve.finished) return state.solve.timeUp ? `<div class="s-timer up">⏱ Czas minął – sprawdzian zakończył się automatycznie.</div>` : "";
  return `<div class="s-timer ${left <= 60 ? "low" : ""}" id="s-timer">⏱ Zostało ${mmss(left)}</div>`;
}

$("#sheet-solve").addEventListener("click", (e) => {
  if (!e.target.closest('[data-gate="start"]')) return;
  state.solve.timerStartedAt = state.solve.startedAt = Date.now();
  renderSolve();
});

setInterval(() => {
  const s = state.solve;
  if (!state.test || !timeLimit() || !s.timerStartedAt || s.finished) return;
  const left = timeLeft();
  const el = $("#s-timer");
  if (el) {
    el.textContent = `⏱ Zostało ${mmss(left)}`;
    el.classList.toggle("low", left <= 60);
  }
  if (left <= 0) {
    s.finished = true;
    s.timeUp = true;
    s.finishedAt = Date.now();
    recordHistory();
    if (state.view === "solve") renderSolveKeepScroll();
    toast("⏱ Czas minął – sprawdzian zakończył się automatycznie.", false, 7000);
  }
}, 1000);

// ================== rozwiązywanie na tablecie / telefonie ==================
let share = null; // { test, group, url }

/** Sprawdzian dla tabletu – BEZ poprawnych odpowiedzi. */
function studentTest() {
  const t = state.test;
  return {
    id: newId("r"),
    title: t.title + (t.groups ? ` – grupa ${t.group}` : ""),
    subject: t.subject || state.settings.subject || "",
    timeLimit: timeLimit(),
    questions: t.questions.map((q) => {
      const f = fmtOf(q);
      const o = { id: q.id, format: f, question: q.question, points: q.points, figures: (q.figures || []).map((fg) => fg.cropUrl) };
      if (f === "abc") o.options = q.options;
      if (f === "tf") o.statements = q.statements.map((s) => s.text);
      if (f === "match") Object.assign(o, { left: q.left, right: q.right });
      if (f === "gap") {
        o.items = q.items.map((g) => {
          const [before, ...rest] = String(g.text).split(BLANK);
          return { before, after: rest.join(" ") };
        });
        o.bank = q.bank || null;
      }
      return o;
    }),
  };
}

function setTabletStatus(html) {
  $("#tablet-status").innerHTML = html;
}

async function openTablet() {
  const t = state.test;
  if (!t || !t.questions.length) return toast("Najpierw wygeneruj sprawdzian.", true);
  $("#modal-tablet").classList.remove("hidden");
  $("#tablet-qr").removeAttribute("src");
  $("#tablet-url").textContent = "Uruchamiam…";
  setTabletStatus("");
  const res = await window.api.remoteStart(studentTest());
  if (!res.ok) {
    $("#tablet-url").textContent = "";
    setTabletStatus(`<span class="err">${esc(res.error)}</span>`);
    return;
  }
  share = { test: t, group: t.group || null, url: res.url };
  $("#tablet-qr").src = res.qr;
  $("#tablet-url").textContent = res.url;
  $("#tablet-others").innerHTML = res.others.length ? `Jeśli tablet nie otwiera strony, spróbuj: ${res.others.map((u) => `<code>${esc(u)}</code>`).join(" ")}` : "";
  setTabletStatus(`<span class="spinner small"></span> Czekam, aż tablet otworzy sprawdzian…`);
  renderShareChip();
}

function renderShareChip() {
  const slot = $("#tablet-slot");
  if (!slot) return;
  slot.innerHTML = state.test && state.test.questions.length
    ? `<button class="gadd ${share ? "live" : ""}" data-tablet="open" title="Rozwiąż na tablecie lub telefonie (Ctrl+T)"><svg class="ico"><use href="#i-phone"/></svg>${share ? "Na tablecie · aktywne" : "Na tablecie"}</button>`
    : "";
}

async function stopShare() {
  await window.api.remoteStop();
  share = null;
  renderShareChip();
}

$("#btn-tablet-stop").addEventListener("click", async () => {
  await stopShare();
  $("#modal-tablet").classList.add("hidden");
  toast("Zatrzymano udostępnianie na tablecie.");
});
$("#btn-tablet-close").addEventListener("click", () => $("#modal-tablet").classList.add("hidden"));
$("#btn-tablet-refresh").addEventListener("click", openTablet);
$("#modebar-extra").addEventListener("click", (e) => {
  if (e.target.closest('[data-tablet="open"]')) openTablet();
});

window.api.onRemoteEvent((ev) => {
  if (ev.type === "opened") setTabletStatus(`<span class="ok-dot"></span> Tablet otworzył sprawdzian. Czekam na odpowiedzi…`);
  if (ev.type === "stopped") {
    share = null;
    renderShareChip();
  }
});

/** Bezpieczne odczytanie odpowiedzi z tabletu (tylko znane zadania i typy). */
function sanitizeAnswers(raw) {
  const out = {};
  for (const q of state.test.questions) {
    const a = raw[q.id];
    if (a == null) continue;
    const f = fmtOf(q);
    const obj = (fn) => (typeof a === "object" && !Array.isArray(a) ? Object.fromEntries(Object.entries(a).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [k, fn(v)]).filter(([, v]) => v !== undefined)) : undefined);
    if (f === "abc" && Number.isInteger(a) && a >= 0 && a < q.options.length) out[q.id] = a;
    if (f === "tf") out[q.id] = obj((v) => (typeof v === "boolean" ? v : undefined));
    if (f === "match") out[q.id] = obj((v) => (Number.isInteger(v) && v >= 0 && v < q.right.length ? v : undefined));
    if (f === "gap") out[q.id] = obj((v) => (typeof v === "string" ? v.slice(0, 200) : undefined));
    if (f === "open" && typeof a === "string") out[q.id] = a.slice(0, 5000);
  }
  return out;
}

window.api.onRemoteSubmission(async (sub) => {
  try {
    if (!share || state.test !== share.test) {
      toast("Przyszły odpowiedzi z tabletu, ale ten sprawdzian nie jest już otwarty w programie.", true);
      return window.api.remoteResult(sub.id, { error: "closed" });
    }
    if (state.test.groups && share.group && state.test.group !== share.group) switchGroup(share.group);
    const now = Date.now();
    state.solve = {
      answers: sanitizeAnswers(sub.answers || {}),
      openPoints: {},
      aiGrades: {},
      finished: true,
      revealed: false,
      name: sub.name || "",
      historyId: null,
      startedAt: now - Math.max(0, sub.seconds || 0) * 1000,
      finishedAt: now,
      timerStartedAt: now - Math.max(0, sub.seconds || 0) * 1000,
      timeUp: Boolean(sub.timeUp),
      remote: true,
    };
    await recordHistory();
    const marks = {};
    for (const q of state.test.questions) {
      const r = solveScore(q);
      marks[q.id] = r.auto ? { score: r.score, max: q.points } : null;
    }
    const tot = solveTotals();
    await window.api.remoteResult(sub.id, { closed: tot.closed, closedMax: tot.closedMax, openMax: tot.openMax, grade: tot.openGraded ? gradeFor(tot.total, tot.max) : "", marks });
    state.view = "solve";
    state.keyUnlocked = false;
    renderPreview();
    syncUi();
    $(".main").scrollTop = $(".main").scrollHeight;
    const who = sub.name ? sub.name : "Uczeń";
    setTabletStatus(`<span class="ok-dot"></span> <b>${esc(who)}</b> przesłał(a) odpowiedzi: ${String(tot.closed).replace(".", ",")} / ${tot.closedMax} pkt za zadania zamknięte${tot.openMax ? " + zadania otwarte do oceny" : ""}.`);
    toast(`📱 ${who}: odpowiedzi z tabletu – ${String(tot.closed).replace(".", ",")} / ${tot.closedMax} pkt za zadania zamknięte.${tot.openMax ? " Oceń zadania otwarte." : ""}`, false, 9000);
  } catch (e) {
    console.error(e);
    window.api.remoteResult(sub.id, { error: "internal" });
  }
});

// ================== menu, odświeżanie ==================
const prevMenuExtra = onMenuExtra;
onMenuExtra = function (action, arg) {
  if (action === "tablet") return openTablet();
  return prevMenuExtra(action, arg);
};
const prevGroupSwitch = renderGroupSwitch;
renderGroupSwitch = function () {
  prevGroupSwitch();
  renderShareChip();
};
