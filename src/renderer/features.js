"use strict";
// Funkcje dodatkowe: powtórka błędów, historia wyników, grupy A/B, podpowiedź oceny z AI, aktualizacje.
// Korzysta ze wspólnego stanu i funkcji z app.js (ładowany po nim).

const baseTitle = (t) => String(t || "Sprawdzian").replace(/^Powtórka – /, "");

/** Strony, z których powstał sprawdzian (albo zaznaczone, jeśli tamtych już nie ma). */
function pagesForTest(t) {
  const hashes = new Set((t && t.pageHashes) || []);
  const own = state.pages.filter((p) => hashes.has(p.hash) && p.analysis);
  return own.length ? own : state.pages.filter((p) => p.selected && p.analysis);
}

/** Kopia zadania z nowym identyfikatorem i przemieszanymi odpowiedziami. */
function cloneShuffled(q) {
  const c = JSON.parse(JSON.stringify(q));
  c.id = newId("q");
  delete c.swapping;
  const f = fmtOf(c);
  if (f === "abc") {
    const right = c.options[c.correct];
    c.options = shuffle(c.options);
    c.correct = c.options.indexOf(right);
  }
  if (f === "tf") c.statements = shuffle(c.statements);
  if (f === "match") {
    const pairs = shuffle(c.left.map((l, i) => ({ l, r: c.right[c.answers[i]] })));
    c.left = pairs.map((p) => p.l);
    c.right = shuffle(pairs.map((p) => p.r));
    c.answers = pairs.map((p) => c.right.indexOf(p.r));
  }
  if (f === "gap") {
    c.items = shuffle(c.items);
    if (c.bank) c.bank = shuffle(c.bank);
  }
  return c;
}

/** Poprawna odpowiedź jako tekst (do polecenia dla AI). */
function answerText(q) {
  const f = fmtOf(q);
  if (f === "abc") return q.options[q.correct];
  if (f === "tf") return q.statements.map((s) => `${s.text} – ${s.truth ? "prawda" : "fałsz"}`).join("; ");
  if (f === "match") return q.left.map((l, i) => `${l} → ${q.right[q.answers[i]]}`).join("; ");
  if (f === "gap") return q.items.map((g) => g.answer).join(", ");
  return q.model_answer || "";
}

// ================== powtórka błędów ==================
function wrongQuestions(s = state.solve, t = state.test) {
  if (!t || !s || !s.finished) return [];
  return t.questions.filter((q) => {
    const r = solveScore(q, s);
    return r.score != null && r.score < q.points;
  });
}

/** Dodatkowe bloki pod wynikiem: propozycje AI do przyjęcia i powtórka błędów. */
function retryHtml() {
  const s = state.solve;
  const pendingAi = state.test.questions.filter((q) => s.aiGrades[q.id] && s.openPoints[q.id] !== s.aiGrades[q.id].points);
  const wrong = wrongQuestions();
  const ungraded = state.test.questions.some((q) => !solveScore(q).auto && solveScore(q).score == null);
  const ai = pendingAi.length
    ? `<div class="s-panel ai"><div><b><svg class=""><use href="#i-spark"/></svg> Propozycje oceny z AI</b><span>${pendingAi.length} ${plural(pendingAi.length, "zadanie czeka", "zadania czekają", "zadań czeka")} na zatwierdzenie. To tylko podpowiedź – decyzja należy do rodzica.</span></div>
        <div class="s-panel-actions"><button class="btn primary" data-sact="ai-accept-all">Przyjmij wszystkie</button></div></div>`
    : "";
  const retry = wrong.length
    ? `<div class="s-panel retry"><div><b>Powtórka błędów</b><span>Do poprawy: ${wrong.length} ${plural(wrong.length, "zadanie", "zadania", "zadań")}${ungraded ? " (zadania otwarte bez oceny nie są liczone)" : ""}. Wynik tego podejścia zostaje w historii.</span></div>
        <div class="s-panel-actions">
          ${typeof explainButtonHtml === "function" ? explainButtonHtml() : ""}
          <button class="btn primary" data-sact="retry-ai"><svg class="ico"><use href="#i-spark"/></svg> Nowe zadania (AI)</button>
          <button class="btn" data-sact="retry-same">Powtórz błędne</button>
        </div></div>`
    : `<div class="s-panel good"><div><b><svg class=""><use href="#i-check-circle"/></svg> Brak błędów${ungraded ? " w zadaniach sprawdzonych" : ""}</b><span>${ungraded ? "Zadania otwarte czekają na ocenę rodzica." : "Wszystkie zadania rozwiązane poprawnie."}</span></div></div>`;
  return ai + retry + `<div class="s-history-link"><button class="btn ghost" data-sact="history"><svg class="ico"><use href="#i-chart"/></svg> Historia wyników</button></div>`;
}

async function confirmReplace(what) {
  return window.api.confirm(`${what}?`, "Obecny sprawdzian zostanie zastąpiony w programie (wynik zostaje w historii). Wrócisz do niego w Bibliotece.", "Dalej");
}

async function retrySame() {
  const wrong = wrongQuestions();
  if (!wrong.length || !(await confirmReplace("Rozwiązać ponownie błędne zadania"))) return;
  const t = state.test;
  state.test = { title: `Powtórka – ${baseTitle(t.title)}`, subject: t.subject, questions: wrong.map(cloneShuffled), pageHashes: t.pageHashes };
  resetSolve();
  state.view = "solve";
  state.keyUnlocked = false;
  renderPreview();
  $(".main").scrollTop = 0;
  syncUi();
}

async function retryAi() {
  const wrong = wrongQuestions();
  if (!wrong.length) return;
  const t = state.test;
  const pages = pagesForTest(t);
  if (!pages.length) {
    toast("Nie ma już stron, z których powstał ten sprawdzian. Wybierz „Rozwiąż jeszcze raz błędne” albo dodaj materiał.", true);
    return;
  }
  if (!(await confirmReplace("Ułożyć nowe zadania z błędów"))) return;
  const plan = wrong.map((q) => ({ type: fmtOf(q), figure: Boolean(q.figures && q.figures.length) }));
  while (plan.length < 3) plan.push({ type: plan[plan.length % wrong.length].type });
  const focus = wrong.map((q) => `„${q.question}” (poprawnie: ${answerText(q)})`).join("; ").slice(0, 2000);
  await generate({
    pages,
    plan,
    settings: { count: plan.length, extra: `POWTÓRKA. Uczeń pomylił się w zadaniach: ${focus}. Ułóż NOWE zadania sprawdzające te same wiadomości (innymi słowami, z innymi przykładami) – nie kopiuj tych pytań` },
    avoid: wrong.map((q) => q.question),
    title: `Powtórka – ${baseTitle(t.title)}`,
    done: () => {
      resetSolve();
      state.view = "solve";
      renderPreview();
      $(".main").scrollTop = 0;
      syncUi();
    },
  });
}

// ================== historia wyników ==================
/** Zapisuje (lub aktualizuje) wynik bieżącego rozwiązania w historii. */
async function recordHistory() {
  const t = state.test, s = state.solve;
  if (!t || !s.finished) return;
  const entry = historyEntry(t, s);
  await window.api.historySave(entry);
  if (typeof afterHistory === "function") await afterHistory(entry, t, s);
}

/** Wpis historii z dowolnego rozwiązania (także ucznia z trybu klasy). */
function historyEntry(t, s) {
  if (!s.historyId) s.historyId = newId("h");
  const tot = solveTotals(s, t);
  const pct = tot.openGraded ? (tot.max ? tot.total / tot.max : 0) : tot.closedMax ? tot.closed / tot.closedMax : 0;
  const byFormat = {};
  for (const q of t.questions) {
    const r = solveScore(q, s);
    if (r.score == null) continue;
    const f = fmtOf(q);
    byFormat[f] = byFormat[f] || { score: 0, max: 0 };
    byFormat[f].score += r.score;
    byFormat[f].max += q.points;
  }
  const end = s.finishedAt || Date.now();
  return {
    id: s.historyId,
    date: new Date(end).toISOString(),
    name: (s.name || "").trim(),
    title: t.title,
    subject: t.subject || state.settings.subject || "",
    group: t.groups ? t.group : "",
    total: tot.total,
    max: tot.max,
    closed: tot.closed,
    closedMax: tot.closedMax,
    openGraded: tot.openGraded,
    pct: Math.round(pct * 1000) / 10,
    mark: tot.openGraded ? gradeFor(tot.total, tot.max) : "",
    byFormat,
    wrong: wrongQuestions(s, t).map((q) => q.question).slice(0, 20),
    seconds: Math.max(0, Math.round((end - (s.startedAt || end)) / 1000)),
    retry: /^Powtórka – /.test(t.title),
    timeLimit: Number(state.settings.timeLimit) || 0,
    timeUp: Boolean(s.timeUp),
    remote: Boolean(s.remote),
    mode: s.mode || (s.paper ? "paper" : "test"),
    ...(typeof historyExtra === "function" ? historyExtra(t, s) : {}),
  };
}

const hist = { all: [], name: "", subject: "" };
const fmtDate = (iso) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
const shortMark = (m) => (String(m).match(/\((\d)\)/) || [])[1] || "";

async function openHistory() {
  hist.all = (await window.api.historyList()).sort((a, b) => a.date.localeCompare(b.date));
  renderHistory();
  openDialog("dlg-history");
}

function histFiltered() {
  return hist.all.filter((e) => (!hist.name || e.name === hist.name) && (!hist.subject || e.subject === hist.subject));
}

function renderHistory() {
  $("#hist-name").closest(".toolbar").classList.toggle("hidden", !hist.all.length);
  const names = [...new Set(hist.all.map((e) => e.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
  const subjects = [...new Set(hist.all.map((e) => e.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
  if (hist.name && !names.includes(hist.name)) hist.name = "";
  if (hist.subject && !subjects.includes(hist.subject)) hist.subject = "";
  $("#hist-name").innerHTML = `<option value="">Wszyscy uczniowie</option>${names.map((n) => `<option ${n === hist.name ? "selected" : ""}>${esc(n)}</option>`).join("")}`;
  $("#hist-subject").innerHTML = `<option value="">Wszystkie przedmioty</option>${subjects.map((n) => `<option ${n === hist.subject ? "selected" : ""}>${esc(n)}</option>`).join("")}`;
  const list = histFiltered();
  $("#hist-info").textContent = hist.all.length ? `${list.length} ${plural(list.length, "podejście", "podejścia", "podejść")}` : "Brak zapisanych wyników";
  $("#btn-hist-clear").disabled = !hist.all.length;
  if (!list.length) {
    $("#hist-body").innerHTML = `<div class="hist-empty"><div class="empty-icon"><svg><use href="#i-chart"/></svg></div><b>Jeszcze nie ma wyników</b><span>Wynik zapisuje się sam, gdy uczeń kliknie „Zakończ i sprawdź” w trybie „Rozwiąż”.</span></div>`;
    return;
  }
  const avg = list.reduce((a, e) => a + e.pct, 0) / list.length;
  const best = Math.max(...list.map((e) => e.pct));
  const last = list[list.length - 1];
  const prev = list.length > 1 ? list[list.length - 2] : null;
  const trend = prev ? last.pct - prev.pct : null;
  // skuteczność w rodzajach zadań
  const fmt = {};
  for (const e of list) for (const [f, v] of Object.entries(e.byFormat || {})) {
    fmt[f] = fmt[f] || { score: 0, max: 0 };
    fmt[f].score += v.score;
    fmt[f].max += v.max;
  }
  const fmtRows = Object.entries(fmt)
    .filter(([, v]) => v.max)
    .map(([f, v]) => ({ f, pct: Math.round((v.score / v.max) * 100) }))
    .sort((a, b) => a.pct - b.pct);
  $("#hist-body").innerHTML = `
    <div class="hist-tiles">
      <div class="tile"><span>Podejścia</span><b>${list.length}</b></div>
      <div class="tile"><span>Średni wynik</span><b>${Math.round(avg)}%</b></div>
      <div class="tile"><span>Najlepszy wynik</span><b>${Math.round(best)}%</b></div>
      <div class="tile"><span>Ostatnio</span><b>${Math.round(last.pct)}%${trend != null ? ` <small class="${trend >= 0 ? "up" : "down"}">${trend >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(trend))} pp</small>` : ""}</b></div>
    </div>
    <div class="hist-card">
      <div class="hist-card-head"><b>Wynik w kolejnych podejściach</b><span class="muted small">% punktów · przerywane linie = progi ocen · puste kółko = zadania otwarte bez oceny</span></div>
      <div class="hist-chart" id="hist-chart">${historyChart(list.slice(-30))}<div class="chart-tip hidden" id="chart-tip"></div></div>
    </div>
    ${fmtRows.length ? `<div class="hist-card"><div class="hist-card-head"><b>Skuteczność w rodzajach zadań</b><span class="muted small">od najsłabszego – tu warto poćwiczyć</span></div>
      <div class="fmt-bars">${fmtRows.map((r) => `<div class="fmt-row"><span>${esc(FORMAT_LABEL[r.f] || r.f)}</span><div class="fmt-track"><div class="fmt-fill" style="width:${Math.max(2, r.pct)}%"></div></div><b>${r.pct}%</b></div>`).join("")}</div></div>` : ""}
    <div class="hist-card">
      <div class="hist-card-head"><b>Wszystkie podejścia</b></div>
      <table class="hist-table">
        <thead><tr><th>Data</th><th>Uczeń</th><th>Sprawdzian</th><th class="r">Punkty</th><th class="r">Wynik</th><th>Ocena</th><th></th></tr></thead>
        <tbody>${list
          .slice()
          .reverse()
          .map(
            (e) => `<tr>
              <td>${fmtDate(e.date)}</td>
              <td>${esc(e.name || "–")}</td>
              <td class="t">${esc(e.title)}${e.group ? ` <span class="badge">gr. ${esc(e.group)}</span>` : ""}${e.retry ? ` <span class="badge retry">powtórka</span>` : ""}${e.remote && e.mode !== "class" ? ` <span class="badge">tablet</span>` : ""}${e.mode === "class" ? ` <span class="badge">klasa</span>` : ""}${e.mode === "paper" ? ` <span class="badge"><svg class=""><use href="#i-camera"/></svg> kartka</span>` : ""}${e.mode === "quiz" ? ` <span class="badge quiz"><svg class=""><use href="#i-game"/></svg> quiz · ${Number(e.quizPoints || 0).toLocaleString("pl-PL")} pkt</span>` : ""}${e.plan ? ` <span class="badge">plan nauki</span>` : ""}${e.timeUp ? ` <span class="badge retry"><svg class=""><use href="#i-clock"/></svg> czas minął</span>` : ""}${e.wrong && e.wrong.length ? `<div class="muted small" title="${esc(e.wrong.join("\n"))}">błędy: ${e.wrong.length}</div>` : ""}</td>
              <td class="r">${e.openGraded ? `${e.total} / ${e.max}` : `${e.closed} / ${e.closedMax}*`}</td>
              <td class="r"><b>${Math.round(e.pct)}%</b></td>
              <td>${esc(e.mark || (e.openGraded ? "" : "otwarte bez oceny"))}</td>
              <td class="r"><button class="icon-btn" data-hdel="${esc(e.id)}" title="Usuń ten wynik"><svg><use href="#i-trash"/></svg></button></td>
            </tr>`
          )
          .join("")}</tbody>
      </table>
      <div class="muted small" style="margin-top:6px">* wynik tylko z zadań zamkniętych – zadania otwarte nie zostały ocenione.</div>
    </div>`;
  bindChartHover(list.slice(-30));
}

/** Wykres liniowy wyniku (%) w kolejnych podejściach – jedna seria, siatka na progach ocen. */
function historyChart(list) {
  const W = 820, H = 260, L = 44, R = 64, T = 14, B = 34;
  const iw = W - L - R, ih = H - T - B;
  const x = (i) => L + (list.length === 1 ? iw / 2 : (i * iw) / (list.length - 1));
  const y = (p) => T + ih - (Math.max(0, Math.min(100, p)) / 100) * ih;
  const ticks = [
    { p: 100, g: "6" },
    { p: 90, g: "5" },
    { p: 75, g: "4" },
    { p: 50, g: "3" },
    { p: 30, g: "2" },
    { p: 0, g: "" },
  ];
  const grid = ticks
    .map((t) => `<line x1="${L}" x2="${L + iw}" y1="${y(t.p)}" y2="${y(t.p)}" class="${t.p === 0 ? "axis" : "grid"}"/>
      <text x="${L - 8}" y="${y(t.p) + 4}" class="tick" text-anchor="end">${t.p}%</text>
      ${t.g ? `<text x="${L + iw + 8}" y="${y(t.p) + 4}" class="tick">ocena ${t.g}</text>` : ""}`)
    .join("");
  // data pod osią przy każdej zmianie dnia (z odstępem, żeby podpisy na siebie nie nachodziły)
  let lastX = -Infinity;
  const xl = list
    .map((e, i) => {
      if (i > 0 && fmtDateShort(e.date) === fmtDateShort(list[i - 1].date)) return "";
      if (x(i) - lastX < 48) return "";
      lastX = x(i);
      return `<text x="${x(i)}" y="${H - 10}" class="tick" text-anchor="middle">${fmtDateShort(e.date)}</text>`;
    })
    .join("");
  const path = list.map((e, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(e.pct).toFixed(1)}`).join(" ");
  const pts = list.map((e, i) => `<circle cx="${x(i)}" cy="${y(e.pct)}" r="5" class="${e.openGraded ? "pt" : "pt open"}"/>`).join("");
  const hits = list.map((e, i) => `<circle cx="${x(i)}" cy="${y(e.pct)}" r="16" class="hit" data-i="${i}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Wykres wyników w kolejnych podejściach">
    ${grid}${xl}<path d="${path}" class="line"/>${pts}<circle class="pt-hover hidden" r="7" id="pt-hover"/>${hits}</svg>`;
}

function bindChartHover(list) {
  const box = $("#hist-chart");
  if (!box) return;
  const tip = $("#chart-tip");
  const ring = $("#pt-hover");
  box.querySelectorAll(".hit").forEach((c) => {
    c.addEventListener("mouseenter", () => {
      const e = list[+c.dataset.i];
      ring.setAttribute("cx", c.getAttribute("cx"));
      ring.setAttribute("cy", c.getAttribute("cy"));
      ring.classList.remove("hidden");
      tip.innerHTML = `<div class="muted small">${fmtDate(e.date)}${e.name ? ` · ${esc(e.name)}` : ""}</div><b>${esc(e.title)}</b><div>${Math.round(e.pct)}% · ${e.openGraded ? `${e.total} / ${e.max} pkt` : `${e.closed} / ${e.closedMax} pkt (zamknięte)`}</div>${e.mark ? `<div>Ocena: ${esc(e.mark)}</div>` : ""}`;
      const svg = box.querySelector("svg").getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const px = ((+c.getAttribute("cx")) / 820) * svg.width + (svg.left - b.left);
      const py = ((+c.getAttribute("cy")) / 260) * svg.height + (svg.top - b.top);
      tip.classList.remove("hidden");
      tip.style.left = `${Math.min(Math.max(px, 110), b.width - 110)}px`;
      tip.style.top = `${py}px`;
      tip.classList.toggle("below", py < 120); // przy górnej krawędzi – pod punktem
    });
    c.addEventListener("mouseleave", () => {
      tip.classList.add("hidden");
      ring.classList.add("hidden");
    });
  });
}

$("#hist-name").addEventListener("change", (e) => ((hist.name = e.target.value), renderHistory()));
$("#hist-subject").addEventListener("change", (e) => ((hist.subject = e.target.value), renderHistory()));
$("#hist-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-hdel]");
  if (!b) return;
  if (!(await window.api.confirm("Usunąć ten wynik z historii?", "", "Usuń"))) return;
  await window.api.historyDelete(b.dataset.hdel);
  hist.all = hist.all.filter((x) => x.id !== b.dataset.hdel);
  renderHistory();
});
$("#btn-hist-clear").addEventListener("click", async () => {
  if (!(await window.api.historyClear())) return;
  hist.all = [];
  renderHistory();
});
$("#btn-history").addEventListener("click", openHistory);

// ================== grupy A i B ==================
function renderGroupSwitch() {
  const t = state.test;
  const box = $("#group-switch");
  if (!box) return;
  if (!t || !t.questions) return void (box.innerHTML = "");
  box.innerHTML = t.groups
    ? `<div class="gswitch">${Object.keys(t.groups)
        .map((g) => `<button class="${g === t.group ? "active" : ""}" data-group="${g}" ${state.generating ? "disabled" : ""}>Grupa ${g}</button>`)
        .join("")}<button class="gx" data-group-act="remove" title="Usuń grupę B" ${state.generating ? "disabled" : ""}><svg class="ico"><use href="#i-x"/></svg></button></div>`
    : "";
}

function switchGroup(g) {
  const t = state.test;
  if (!t.groups || g === t.group || !t.groups[g]) return;
  t.groups[t.group] = t.questions;
  t.group = g;
  t.questions = t.groups[g];
  resetSolve();
  renderPreview();
}

function openGroupB() {
  if (!state.test || !state.test.questions.length) return;
  if (state.test.groups) return toast("Ten sprawdzian ma już grupę B. Usuń ją, aby utworzyć nową.");
  $("#modal-groupb").classList.remove("hidden");
}

function makeGroupBShuffled() {
  const t = state.test;
  const order = { abc: 0, tf: 1, match: 2, gap: 3, open: 4 };
  // zadania tego samego rodzaju w innej kolejności, odpowiedzi przemieszane
  const B = shuffle(t.questions.map(cloneShuffled)).sort((a, b) => order[fmtOf(a)] - order[fmtOf(b)]);
  t.groups = { A: t.questions, B };
  t.group = "B";
  t.questions = B;
  resetSolve();
  renderPreview();
  toast("Gotowe: grupa B ma te same zadania w innej kolejności i z przemieszanymi odpowiedziami.");
}

async function makeGroupBAi() {
  const t = state.test;
  const pages = pagesForTest(t);
  if (!pages.length) return toast("Brak przeczytanych stron, z których powstał sprawdzian – dodaj materiał albo wybierz grupę z przemieszanymi odpowiedziami.", true);
  const A = t.questions;
  const plan = A.map((q) => ({ type: fmtOf(q), figure: Boolean(q.figures && q.figures.length) }));
  await generate({
    pages,
    plan,
    avoid: A.map((q) => q.question),
    settings: { count: plan.length, extra: "To GRUPA B sprawdzianu: ułóż INNE zadania niż w grupie A (lista do pominięcia poniżej), ale z tego samego materiału i o podobnej trudności" },
    begin: () => {
      t.groups = { A, B: [] };
      t.group = "B";
      t.questions = t.groups.B;
    },
    fail: () => {
      t.questions = A;
      delete t.groups;
      delete t.group;
    },
  });
}

$("#modebar-extra").addEventListener("click", async (e) => {
  const g = e.target.closest("[data-group]");
  if (g && !g.disabled) return switchGroup(g.dataset.group);
  const a = e.target.closest("[data-group-act]");
  if (!a || a.disabled) return;
  if (a.dataset.groupAct === "add") return openGroupB();
  if (a.dataset.groupAct === "remove") {
    if (!(await window.api.confirm("Usunąć grupę B?", "Zostanie tylko grupa A.", "Usuń grupę B"))) return;
    const t = state.test;
    t.questions = t.groups.A;
    delete t.groups;
    delete t.group;
    resetSolve();
    renderPreview();
  }
});
$("#modal-groupb").addEventListener("click", (e) => {
  const b = e.target.closest("[data-gb]");
  if (!b) return;
  $("#modal-groupb").classList.add("hidden");
  if (b.dataset.gb === "shuffle") makeGroupBShuffled();
  if (b.dataset.gb === "ai") makeGroupBAi();
});

// ================== podpowiedź oceny z AI (zadania otwarte) ==================
function aiSuggestionHtml(q) {
  const s = state.solve;
  if (s.aiBusy && !s.aiGrades[q.id]) return `<div class="s-ai busy"><span class="spinner small"></span> AI ocenia odpowiedź…</div>`;
  const g = s.aiGrades[q.id];
  if (!g) return "";
  const applied = s.openPoints[q.id] === g.points;
  return `<div class="s-ai"><div><span class="s-ai-badge"><svg class=""><use href="#i-spark"/></svg> AI proponuje: <b>${g.points} / ${q.points} pkt</b></span> <span>${esc(g.comment)}</span></div>
    ${applied ? `<span class="s-ai-ok">✓ przyjęto</span>` : `<button class="btn" data-sact="ai-accept">Przyjmij</button>`}</div>`;
}

async function aiGrade() {
  const s = state.solve;
  if (state.generating) return toast("AI jest teraz zajęte układaniem zadań – spróbuj za chwilę.", true);
  if (!(await refreshAi())) return openAiSetup();
  const open = state.test.questions.filter((q) => fmtOf(q) === "open");
  const items = [];
  for (const q of open) {
    const ans = String(s.answers[q.id] || "").trim();
    if (!ans) s.aiGrades[q.id] = { points: 0, comment: "Brak odpowiedzi." };
    else items.push({ id: q.id, question: q.question, model: q.model_answer, answer: ans, max: q.points });
  }
  if (items.length) {
    s.aiBusy = true;
    renderSolveKeepScroll();
    try {
      const res = await window.api.gradeOpen(items, { subject: state.test.subject || state.settings.subject, grade: state.settings.grade });
      if (!res.ok) toast(res.error, true);
      else {
        for (const g of res.grades) {
          const q = open.find((x) => x.id === g.id);
          if (!q) continue;
          const pts = Math.max(0, Math.min(q.points, Math.round((+g.points || 0) * 2) / 2));
          s.aiGrades[q.id] = { points: pts, comment: cleanText(g.comment).slice(0, 300) };
        }
        const missing = items.filter((it) => !s.aiGrades[it.id]).length;
        toast(missing ? `AI oceniło ${items.length - missing} z ${items.length} odpowiedzi. Resztę oceń samodzielnie.` : "AI zaproponowało punkty – przejrzyj je i kliknij „Przyjmij”.", Boolean(missing), 6000);
      }
    } finally {
      s.aiBusy = false;
    }
  }
  renderSolveKeepScroll();
}

/** Dodatkowe akcje w trybie „Rozwiąż” (wywoływane z app.js). false = app.js nie odświeża widoku. */
async function onSolveAction(act, qid) {
  const s = state.solve;
  if (act === "finish") {
    s.finishedAt = Date.now();
    await recordHistory();
  }
  if (act === "ai-grade") {
    await aiGrade();
    return false;
  }
  if (act === "ai-accept" && s.aiGrades[qid]) {
    s.openPoints[qid] = s.aiGrades[qid].points;
    await recordHistory();
  }
  if (act === "ai-accept-all") {
    for (const [id, g] of Object.entries(s.aiGrades)) s.openPoints[id] = g.points;
    await recordHistory();
  }
  if (act === "explain") return void (typeof explainMistakes === "function" && explainMistakes()) || false;
  if (act === "retry-same") return void retrySame() || false;
  if (act === "retry-ai") return void retryAi() || false;
  if (act === "history") return void openHistory() || false;
}

// ================== aktualizacje ==================
window.api.onUpdateStatus((st) => {
  const bar = $("#update-bar");
  if (st.state === "checking") return toast("Sprawdzam aktualizacje…");
  if (st.state === "none") return toast(`Masz najnowszą wersję programu (${st.version}).`);
  if (st.state === "dev") return toast(`Wersja ${st.version}. Aktualizacje działają w programie zainstalowanym z instalatora.`);
  if (st.state === "error") return toast(st.message, true);
  if (st.state === "downloading") {
    bar.classList.remove("hidden");
    bar.innerHTML = `<span class="spinner small"></span><span>Pobieram nową wersję${st.version ? ` ${esc(st.version)}` : ""}… ${st.percent || 0}%</span>`;
  }
  if (st.state === "ready") {
    bar.classList.remove("hidden");
    bar.innerHTML = `<span class="dot"></span><span><b>Nowa wersja ${esc(st.version)} jest gotowa.</b> Zainstaluje się przy zamknięciu programu.</span>
      <button class="btn primary" id="btn-update-now">Uruchom ponownie teraz</button><button class="icon-btn" id="btn-update-later" title="Później"><svg><use href="#i-x"/></svg></button>`;
    $("#btn-update-now").addEventListener("click", async () => {
      if (state.test && state.test.questions.length && !(await window.api.confirm("Uruchomić program ponownie?", "Niezapisany sprawdzian zniknie. Jeśli chcesz go zachować, najpierw go zapisz.", "Uruchom ponownie"))) return;
      window.api.installUpdate();
    });
    $("#btn-update-later").addEventListener("click", () => bar.classList.add("hidden"));
  }
});

// ================== menu ==================
function onMenuExtra(action) {
  if (action === "history") return openHistory();
  if (action === "groupB") return openGroupB();
}
