"use strict";
// Quiz-gra, tryb klasy (wiele tabletów), sprawdzanie wydrukowanej kartki ze zdjęcia, „Wyjaśnij mój błąd”.
// Korzysta ze wspólnego stanu i funkcji z app.js i features*.js (ładowany jako ostatni).

const fmtPts = (n) => Number(n || 0).toLocaleString("pl-PL");
const commaNum = (x) => String(Math.round(x * 10) / 10).replace(".", ",");

// ================== quiz-gra ==================
/** Pytania quizu z zadań zamkniętych: każde zdanie P/F, para i luka to osobne, szybkie pytanie. */
function buildQuizItems(t) {
  const items = [];
  for (const q of t.questions) {
    const f = fmtOf(q);
    const fig = q.figures && q.figures[0] ? q.figures[0].cropUrl : null;
    if (f === "abc") items.push({ kind: "choice", prompt: q.question, options: q.options.slice(), answer: q.correct, answerText: q.options[q.correct], figure: fig, limit: 20 });
    if (f === "tf") for (const s of q.statements) items.push({ kind: "tf", sub: "Prawda czy fałsz?", prompt: s.text, answer: Boolean(s.truth), answerText: s.truth ? "Prawda" : "Fałsz", limit: 12 });
    if (f === "match")
      q.left.forEach((l, i) => {
        const right = q.right[q.answers[i]];
        const options = shuffle([right, ...shuffle(q.right.filter((r) => r !== right)).slice(0, 3)]);
        items.push({ kind: "choice", sub: "Co pasuje?", prompt: l, options, answer: options.indexOf(right), answerText: right, limit: 20 });
      });
    if (f === "gap")
      q.items.forEach((g) => {
        const prompt = String(g.text).replace(BLANK, "_____");
        const others = q.bank ? uniq(q.bank.filter((w) => normAns(w) !== normAns(g.answer))) : [];
        if (others.length) {
          const options = shuffle([g.answer, ...shuffle(others).slice(0, 3)]);
          items.push({ kind: "choice", sub: "Uzupełnij lukę", prompt, options, answer: options.indexOf(g.answer), answerText: g.answer, limit: 20 });
        } else items.push({ kind: "type", sub: "Wpisz brakujące słowo", prompt, answer: g.answer, answerText: g.answer, limit: 30 });
      });
  }
  return shuffle(items).slice(0, 30);
}
/** Pytanie dla tabletu – bez odpowiedzi. */
const publicQuizItem = ({ kind, sub, prompt, options, figure, limit }) => ({ kind, sub, prompt, options, figure, limit });

/** Wynik quizu do historii. */
async function recordQuiz(t, sum, items, extra = {}) {
  const wrong = Object.entries(sum.results || {})
    .filter(([, ok]) => !ok)
    .map(([i]) => items[+i] && items[+i].prompt)
    .filter(Boolean);
  const entry = {
    id: newId("h"),
    date: new Date().toISOString(),
    name: (sum.name || "").trim(),
    title: `Quiz – ${t.title}`,
    subject: t.subject || state.settings.subject || "",
    group: t.groups ? t.group : "",
    total: sum.correct,
    max: sum.total,
    closed: sum.correct,
    closedMax: sum.total,
    openGraded: true,
    pct: sum.total ? Math.round((sum.correct / sum.total) * 1000) / 10 : 0,
    mark: "",
    byFormat: {},
    wrong: wrong.slice(0, 20),
    seconds: sum.seconds || 0,
    retry: false,
    timeLimit: 0,
    timeUp: false,
    remote: Boolean(extra.remote),
    mode: "quiz",
    quizPoints: sum.points,
    bestStreak: sum.best,
    ...historyExtra(t, { name: sum.name, remote: extra.remote, classId: extra.classId }),
  };
  await window.api.historySave(entry);
  await afterHistory(entry, null);
  return entry;
}

let quizGame = null;
function startQuiz() {
  const t = state.test;
  if (!t || !t.questions.length) return toast("Najpierw wygeneruj sprawdzian.", true);
  const items = buildQuizItems(t);
  if (items.length < 3) return toast("Quiz potrzebuje co najmniej 3 pytań zamkniętych (ABC, prawda/fałsz, dopasowanie lub luki).", true);
  const el = $("#quiz-overlay");
  el.classList.remove("hidden");
  const run = () => {
    const tally = QuizGame.tally(items);
    if (quizGame) quizGame.destroy();
    quizGame = QuizGame.mount(el, {
      title: t.title,
      items: items.map(publicQuizItem),
      name: profileName() || state.solve.name || "",
      askName: true,
      check: async (i, a, ms) => tally.answer(i, a, ms),
      onFinish: async (sum) => {
        await recordQuiz(t, { ...tally.summary(), name: sum.name }, items);
        return null;
      },
      allowReplay: true,
      onReplay: run,
      onClose: async (finished) => {
        if (!finished && tally.state.answered && !(await window.api.confirm("Zakończyć quiz?", "Wynik tej gry nie zostanie zapisany.", "Zakończ"))) return;
        closeQuiz();
      },
    });
  };
  run();
}
function closeQuiz() {
  if (quizGame) quizGame.destroy();
  quizGame = null;
  $("#quiz-overlay").classList.add("hidden");
}

// ================== tryb klasy – wiele tabletów naraz ==================
const klasa = { id: null, kind: "test", test: null, group: null, students: [], devices: new Set(), url: "", qr: "", others: [], error: "" };
const classLive = () => Boolean(share && share.audience === "class");
/** Zadania tej grupy, którą udostępniono (nauczyciel może w tym czasie przełączyć grupę w programie). */
function classTest() {
  const t = klasa.test;
  return { ...t, questions: klasa.group && t.groups && t.groups[klasa.group] ? t.groups[klasa.group] : t.questions, group: klasa.group || t.group };
}
function classStudent(cid, name) {
  let st = cid ? klasa.students.find((x) => x.cid === cid) : null;
  if (!st) {
    st = { cid: cid || newId("x"), name: name || "Uczeń", status: "working", joinedAt: Date.now() };
    klasa.students.push(st);
  }
  if (name) st.name = name;
  return st;
}
const studentPoints = (st) => (st.quiz ? st.quiz.points : st.live ? st.live.points : 0);
const classRanking = () => klasa.students.slice().sort((a, b) => studentPoints(b) - studentPoints(a) || (a.quiz ? 0 : 1) - (b.quiz ? 0 : 1));

let classIdleKind = "test";
/** Ekran „Klasa” z paska bocznego: wyniki trwającej sesji albo przycisk rozpoczęcia. */
function showClassView() {
  openDialog("dlg-class");
  if (klasa.test) renderClass();
  else renderClassIdle();
}
function renderClassIdle() {
  const t = state.test;
  const ok = Boolean(t && t.questions && t.questions.length);
  $("#class-idle").classList.remove("hidden");
  $("#class-live").classList.add("hidden");
  document.querySelectorAll("#class-kind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === classIdleKind));
  $("#class-sub").textContent = "Wszyscy uczniowie skanują jeden kod QR i rozwiązują na swoich tabletach. Wyniki widzisz tutaj na bieżąco.";
  $("#class-idle-text").innerHTML = ok
    ? `Uczniowie dostaną: <b>${esc(t.title)}</b>${t.groups ? ` (grupa ${esc(t.group)})` : ""} – ${classIdleKind === "quiz" ? "jako quiz-grę z rankingiem na żywo" : "jako sprawdzian do rozwiązania"}. Tablety muszą być w tej samej sieci Wi-Fi co komputer.`
    : "Najpierw przygotuj sprawdzian (sekcja Sprawdzian) – potem uruchom go tutaj dla całej klasy.";
  $("#btn-class-start").disabled = !ok;
}
$("#btn-class-start").addEventListener("click", () => openClass(classIdleKind));

async function openClass(kind = "test", reopen = false) {
  const t = state.test;
  if (!t || !t.questions.length) return toast("Najpierw wygeneruj sprawdzian.", true);
  openDialog("dlg-class");
  $("#class-idle").classList.add("hidden");
  $("#class-live").classList.remove("hidden");
  if (reopen && classLive()) return renderClass();
  if (classLive() && klasa.students.some((s) => s.status === "done") && !(await window.api.confirm("Zacząć nową sesję klasy?", "Uczniowie zeskanują nowy kod. Dotychczasowe wyniki są zapisane w historii.", "Nowa sesja"))) return renderClass();
  Object.assign(klasa, { id: newId("k"), kind, test: t, group: t.groups ? t.group : null, students: [], devices: new Set(), url: "", qr: "", others: [], error: "" });
  renderClass();
  const res = await startShare(kind, "class");
  if (!res.ok) klasa.error = res.error;
  else Object.assign(klasa, { url: res.url, qr: res.qr, others: res.others || [] });
  renderClass();
}

let classTimer = 0;
function renderClassSoon() {
  if (classTimer) return;
  classTimer = setTimeout(() => {
    classTimer = 0;
    if (!$("#dlg-class").classList.contains("hidden")) renderClass();
    renderShareChip();
  }, 250);
}

function renderClass() {
  const k = klasa;
  if (!k.test) return renderClassIdle();
  $("#class-idle").classList.add("hidden");
  $("#class-live").classList.remove("hidden");
  const live = classLive();
  const t = classTest();
  const done = k.students.filter((s) => s.status === "done");
  document.querySelectorAll("#class-kind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === k.kind));
  $("#class-sub").textContent = `${t.title}${k.group ? ` – grupa ${k.group}` : ""} · ${k.kind === "quiz" ? "quiz-gra z rankingiem na żywo" : "sprawdzian"}`;
  const qr = $("#class-qr");
  if (live && k.qr) qr.src = k.qr;
  else qr.removeAttribute("src");
  $("#class-url").textContent = k.error ? "" : live ? k.url : k.url ? "zatrzymane" : "Uruchamiam…";
  $("#class-status").innerHTML = k.error
    ? `<span class="err">${esc(k.error)}</span>`
    : live
      ? `<span class="ok-dot"></span> Urządzenia: <b>${k.devices.size}</b> · uczniowie: <b>${k.students.length}</b> · ${k.kind === "quiz" ? "skończyli" : "oddali"}: <b>${done.length}</b>`
      : k.url
        ? `Sesja zatrzymana – wyniki zostają poniżej i w historii. <button class="btn" data-cl="restart">Nowa sesja</button>`
        : "";
  $("#class-others").innerHTML = live && k.others.length ? `Inne adresy: ${k.others.map((u) => `<code>${esc(u)}</code>`).join(" ")}` : "";
  $("#btn-class-stop").disabled = !live;
  $("#btn-class-csv").disabled = !done.length;
  const openMax = t.questions.filter((q) => fmtOf(q) === "open").length;
  $("#btn-class-ai").classList.toggle("hidden", k.kind !== "test" || !openMax);
  $("#btn-class-ai").disabled = !done.length || state.generating || k.aiBusy;
  $("#btn-class-ai").innerHTML = k.aiBusy ? `<span class="spinner small"></span> AI ocenia…` : `<svg class="ico"><use href="#i-spark"/></svg> Oceń otwarte z AI`;
  $("#class-table").innerHTML = k.kind === "quiz" ? classQuizTable() : classTestTable(t);
  $("#class-stats").innerHTML = k.kind === "quiz" ? classQuizStats(done) : classTestStats(t, done);
}

function classTestTable(t) {
  if (!klasa.students.length) return `<div class="class-empty">Czekam na uczniów… Każdy skanuje kod, wpisuje imię i rozwiązuje na swoim tablecie.</div>`;
  const rows = klasa.students
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pl"))
    .map((st) => {
      const i = klasa.students.indexOf(st);
      if (st.status !== "done") return `<tr><td><b>${esc(st.name)}</b></td><td><span class="cl-st working"><svg><use href="#i-pen"/></svg> rozwiązuje</span></td><td colspan="5"></td><td></td></tr>`;
      const tot = solveTotals(st.solve, t);
      const pctV = tot.openGraded ? (tot.max ? (tot.total / tot.max) * 100 : 0) : tot.closedMax ? (tot.closed / tot.closedMax) * 100 : 0;
      const min = Math.round(((st.solve.finishedAt || 0) - (st.solve.startedAt || 0)) / 60000);
      return `<tr><td><b>${esc(st.name)}</b></td><td><span class="cl-st done"><svg><use href="#i-check"/></svg> oddane</span>${st.solve.timeUp ? ` <span class="badge retry" title="Czas minął"><svg><use href="#i-clock"/></svg></span>` : ""}</td>
        <td class="r">${commaNum(tot.closed)} / ${tot.closedMax}</td>
        <td class="r">${tot.openMax ? (tot.openGraded ? `${commaNum(tot.open)} / ${tot.openMax}` : `<span class="muted">do oceny</span>`) : "–"}</td>
        <td class="r"><b>${tot.openGraded ? `${commaNum(tot.total)} / ${tot.max}` : `${commaNum(tot.closed)}*`}</b></td>
        <td class="r"><b>${Math.round(pctV)}%</b></td><td>${tot.openGraded ? esc(gradeFor(tot.total, tot.max)) : ""}</td>
        <td class="r muted">${min} min</td><td class="r"><button class="btn ghost" data-cl="review" data-i="${i}">Podgląd</button></td></tr>`;
    })
    .join("");
  const ungraded = klasa.students.some((st) => st.solve && !solveTotals(st.solve, t).openGraded);
  return `<table class="hist-table"><thead><tr><th>Uczeń</th><th>Status</th><th class="r">Zamknięte</th><th class="r">Otwarte</th><th class="r">Razem</th><th class="r">Wynik</th><th>Ocena</th><th class="r">Czas</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${ungraded ? `<div class="muted small" style="margin-top:6px">* tylko zadania zamknięte – otwarte czekają na ocenę (Podgląd albo „Oceń otwarte z AI”).</div>` : ""}`;
}

function classTestStats(t, done) {
  if (!done.length) return "";
  const rows = t.questions
    .map((q, i) => {
      let sum = 0;
      const wrongPick = {};
      for (const st of done) {
        const r = solveScore(q, st.solve);
        sum += r.score == null ? 0 : r.score / q.points;
        const a = st.solve.answers[q.id];
        if (fmtOf(q) === "abc" && a != null && a !== q.correct) wrongPick[a] = (wrongPick[a] || 0) + 1;
      }
      const graded = done.filter((st) => solveScore(q, st.solve).score != null).length;
      const top = Object.entries(wrongPick).sort((a, b) => b[1] - a[1])[0];
      return { i, q, pct: graded ? (sum / graded) * 100 : null, top };
    })
    .filter((r) => r.pct != null)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 8);
  return `<div class="hist-card"><div class="hist-card-head"><b>Najczęstsze błędy</b><span class="muted small">zadania od najtrudniejszego dla klasy – warto je omówić</span></div>
    <div class="fmt-bars">${rows
      .map((r) => `<div class="cl-q"><div class="fmt-row"><span title="${esc(r.q.question)}">Zad. ${r.i + 1} · ${esc(FORMAT_LABEL[fmtOf(r.q)])}</span><div class="fmt-track"><div class="fmt-fill ${r.pct < 50 ? "low" : ""}" style="width:${Math.max(2, r.pct)}%"></div></div><b>${Math.round(r.pct)}%</b></div>
        <div class="muted small cl-qtext">${esc(r.q.question.slice(0, 140))}${r.top ? ` · najczęstsza błędna odpowiedź: <b>${letter(+r.top[0])}. ${esc(r.q.options[+r.top[0]])}</b> (${r.top[1]}×)` : ""}</div></div>`)
      .join("")}</div></div>`;
}

function classQuizTable() {
  if (!klasa.students.length) return `<div class="class-empty">Czekam na graczy… Każdy skanuje kod, wpisuje imię i klika „Start!”.</div>`;
  return `<table class="hist-table rank"><thead><tr><th>#</th><th>Gracz</th><th class="r">Punkty</th><th class="r">Poprawne</th><th class="r">Seria</th><th>Status</th></tr></thead><tbody>${classRanking()
    .map((st, i) => {
      const s = st.quiz || st.live || { points: 0, correct: 0, answered: 0, total: share && share.items ? share.items.length : 0, best: 0 };
      return `<tr class="${i < 3 && s.points ? "top" : ""}"><td class="rk">${s.points && i < 3 ? `<span class="rk-medal m${i + 1}">${i + 1}</span>` : i + 1}</td><td><b>${esc(st.name)}</b></td><td class="r"><b>${fmtPts(s.points)}</b></td><td class="r">${s.correct} / ${s.total}</td><td class="r"><span class="streak-n"><svg><use href="#i-flame"/></svg> ${s.best}</span></td>
        <td>${st.quiz ? `<span class="cl-st done"><svg><use href="#i-check"/></svg> koniec</span>` : `<span class="cl-st working"><svg><use href="#i-game"/></svg> ${s.answered || 0} / ${s.total || "?"}</span>`}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function classQuizStats(done) {
  const items = share && share.items ? share.items : klasa.items || [];
  if (share && share.items) klasa.items = share.items;
  if (!done.length || !items.length) return "";
  const rows = items
    .map((it, i) => {
      const answered = done.filter((st) => st.quiz.results && i in st.quiz.results);
      const ok = answered.filter((st) => st.quiz.results[i]).length;
      return { it, pct: answered.length ? (ok / answered.length) * 100 : null };
    })
    .filter((r) => r.pct != null)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 6);
  return `<div class="hist-card"><div class="hist-card-head"><b>Najtrudniejsze pytania</b><span class="muted small">odsetek poprawnych odpowiedzi w klasie</span></div>
    <div class="fmt-bars">${rows.map((r) => `<div class="cl-q"><div class="fmt-row"><span title="${esc(r.it.prompt)}">${esc(r.it.prompt.slice(0, 40))}${r.it.prompt.length > 40 ? "…" : ""}</span><div class="fmt-track"><div class="fmt-fill ${r.pct < 50 ? "low" : ""}" style="width:${Math.max(2, r.pct)}%"></div></div><b>${Math.round(r.pct)}%</b></div><div class="muted small cl-qtext">poprawnie: <b>${esc(r.it.answerText)}</b></div></div>`).join("")}</div></div>`;
}

/** Odpowiedzi z tabletu w quizie albo w trybie klasy (wywoływane z features2.js). */
async function onShareSubmission(sub) {
  const t = share.test;
  if (share.kind === "quiz") {
    const sum = { ...sub.quiz, name: sub.name };
    const isClass = share.audience === "class";
    const entry = await recordQuiz(isClass ? classTest() : t, sum, share.items, { remote: true, classId: isClass ? klasa.id : null });
    if (isClass) {
      const st = classStudent(sub.client, sub.name);
      Object.assign(st, { quiz: sub.quiz, status: "done", historyId: entry.id });
      renderClassSoon();
      // miejsce według bieżących punktów wszystkich graczy (inni mogą jeszcze grać)
      const ranking = classRanking();
      return { points: sub.quiz.points, rank: ranking.indexOf(st) + 1, of: ranking.length, provisional: ranking.some((x) => !x.quiz) };
    }
    toast(`${sub.name || "Gracz"}: ${fmtPts(sub.quiz.points)} pkt w quizie (${sub.quiz.correct} / ${sub.quiz.total} poprawnych).`, false, 8000);
    setTabletStatus(`<span class="ok-dot"></span> <b>${esc(sub.name || "Gracz")}</b> skończył(a) quiz: ${fmtPts(sub.quiz.points)} pkt, ${sub.quiz.correct} / ${sub.quiz.total} poprawnych.`);
    return { points: sub.quiz.points };
  }
  // sprawdzian w trybie klasy – każdy uczeń osobno, bez przełączania widoku
  const ct = classTest();
  const now = Date.now();
  const sec = Math.max(0, sub.seconds || 0) * 1000;
  const s = { answers: sanitizeAnswers(sub.answers || {}, ct), openPoints: {}, aiGrades: {}, finished: true, revealed: false, name: sub.name || "", historyId: null, startedAt: now - sec, finishedAt: now, timerStartedAt: now - sec, timeUp: Boolean(sub.timeUp), remote: true, mode: "class", classId: klasa.id };
  const entry = historyEntry(ct, s);
  await window.api.historySave(entry);
  await afterHistory(entry, null);
  const st = classStudent(sub.client, sub.name);
  Object.assign(st, { solve: s, status: "done", historyId: entry.id });
  renderClassSoon();
  const marks = {};
  for (const q of ct.questions) {
    const r = solveScore(q, s);
    marks[q.id] = r.auto ? { score: r.score, max: q.points } : null;
  }
  const tot = solveTotals(s, ct);
  return { closed: tot.closed, closedMax: tot.closedMax, openMax: tot.openMax, grade: tot.openGraded ? gradeFor(tot.total, tot.max) : "", marks };
}

window.api.onRemoteEvent((ev) => {
  if (ev.type === "stopped") return renderClassSoon();
  if (!classLive()) return;
  if (ev.type === "opened") klasa.devices.add(ev.ip);
  if (ev.type === "join") classStudent(ev.client, ev.name);
  if (ev.type === "quiz") {
    if (!ev.name) return; // w trybie klasy gracz zawsze podaje imię – anonimowych zapytań nie pokazujemy
    const st = classStudent(ev.client, ev.name);
    st.live = ev.state;
  }
  renderClassSoon();
});

/** Podgląd odpowiedzi jednego ucznia w trybie „Rozwiąż” (ocena zadań otwartych, wyjaśnienia). */
function reviewStudent(i) {
  const st = klasa.students[i];
  if (!st || !st.solve) return;
  const t = klasa.test;
  state.test = t;
  if (t.groups && klasa.group && t.group !== klasa.group) {
    t.groups[t.group] = t.questions;
    t.group = klasa.group;
    t.questions = t.groups[klasa.group];
  }
  state.solve = st.solve;
  state.view = "solve";
  state.keyUnlocked = false;
  closeDialog("dlg-class");
  renderPreview();
  $(".main").scrollTop = 0;
  syncUi();
  toast(`Podgląd: ${st.name}. Zestawienie klasy jest w sekcji „Klasa” w pasku bocznym.`, false, 7000);
}

async function classAiGrade() {
  const t = classTest();
  if (state.generating) return toast("AI jest teraz zajęte – spróbuj za chwilę.", true);
  if (!(await refreshAi())) return openAiSetup();
  const open = t.questions.filter((q) => fmtOf(q) === "open");
  const items = [];
  klasa.students.forEach((st, si) => {
    if (!st.solve) return;
    for (const q of open) {
      const ans = String(st.solve.answers[q.id] || "").trim();
      if (!ans) st.solve.aiGrades[q.id] = { points: 0, comment: "Brak odpowiedzi." };
      else if (!st.solve.aiGrades[q.id]) items.push({ id: `${si}__${q.id}`, question: q.question, model: q.model_answer, answer: ans, max: q.points });
    }
  });
  klasa.aiBusy = true;
  renderClass();
  try {
    for (let i = 0; i < items.length; i += 20) {
      const res = await window.api.gradeOpen(items.slice(i, i + 20), { subject: t.subject || state.settings.subject, grade: state.settings.grade });
      if (!res.ok) {
        toast(res.error, true);
        break;
      }
      for (const g of res.grades) {
        const [si, qid] = String(g.id).split("__");
        const st = klasa.students[+si];
        const q = open.find((x) => x.id === qid);
        if (st && st.solve && q) st.solve.aiGrades[qid] = { points: Math.max(0, Math.min(q.points, Math.round((+g.points || 0) * 2) / 2)), comment: cleanText(g.comment).slice(0, 300) };
      }
    }
  } finally {
    klasa.aiBusy = false;
  }
  const pending = klasa.students.filter((st) => st.solve && Object.keys(st.solve.aiGrades).some((id) => st.solve.openPoints[id] == null));
  if (pending.length && (await window.api.confirm("Wpisać punkty zaproponowane przez AI?", `Propozycje dla ${pending.length} ${plural(pending.length, "ucznia", "uczniów", "uczniów")}. Każdą możesz potem zmienić w podglądzie ucznia.`, "Wpisz punkty"))) {
    for (const st of pending) {
      for (const [id, g] of Object.entries(st.solve.aiGrades)) if (st.solve.openPoints[id] == null) st.solve.openPoints[id] = g.points;
      await window.api.historySave(historyEntry(t, st.solve));
    }
    toast("Punkty za zadania otwarte wpisane.");
  }
  renderClass();
}

function classCsv() {
  const t = classTest();
  const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [];
  if (klasa.kind === "quiz") {
    lines.push(["Miejsce", "Gracz", "Punkty", "Poprawne", "Pytania", "Najdłuższa seria", "Czas (s)"].map(cell).join(";"));
    classRanking()
      .filter((st) => st.quiz)
      .forEach((st, i) => lines.push([i + 1, st.name, st.quiz.points, st.quiz.correct, st.quiz.total, st.quiz.best, st.quiz.seconds].map(cell).join(";")));
  } else {
    lines.push(["Uczeń", ...t.questions.map((q, i) => `Zad. ${i + 1} (${q.points} pkt)`), "Zamknięte", "Otwarte", "Razem", "Maks.", "Wynik %", "Ocena", "Czas (min)"].map(cell).join(";"));
    for (const st of klasa.students.filter((x) => x.solve).sort((a, b) => a.name.localeCompare(b.name, "pl"))) {
      const tot = solveTotals(st.solve, t);
      const per = t.questions.map((q) => {
        const r = solveScore(q, st.solve);
        return r.score == null ? "" : commaNum(r.score);
      });
      const p = tot.openGraded ? (tot.max ? (tot.total / tot.max) * 100 : 0) : tot.closedMax ? (tot.closed / tot.closedMax) * 100 : 0;
      lines.push([st.name, ...per, commaNum(tot.closed), tot.openGraded ? commaNum(tot.open) : "do oceny", tot.openGraded ? commaNum(tot.total) : "", tot.max, Math.round(p), tot.openGraded ? gradeFor(tot.total, tot.max) : "", Math.round(((st.solve.finishedAt || 0) - (st.solve.startedAt || 0)) / 60000)].map(cell).join(";"));
    }
  }
  return lines.join("\r\n");
}

$("#dlg-class").addEventListener("click", async (e) => {
  const kb = e.target.closest("#class-kind [data-kind]");
  if (kb && !klasa.test) {
    classIdleKind = kb.dataset.kind;
    return renderClassIdle();
  }
  if (kb && kb.dataset.kind !== klasa.kind) return openClass(kb.dataset.kind);
  const b = e.target.closest("[data-cl]");
  if (b && b.dataset.cl === "review") return reviewStudent(+b.dataset.i);
  if (b && b.dataset.cl === "restart") return openClass(klasa.kind);
});
$("#btn-class-stop").addEventListener("click", async () => {
  await stopShare();
  renderClass();
  toast("Zatrzymano udostępnianie dla klasy.");
});
$("#btn-class-csv").addEventListener("click", async () => {
  const res = await window.api.saveText(`${klasa.test.title} – wyniki klasy`, "csv", classCsv(), "Arkusz (CSV)");
  if (res.ok) toast("Zapisano zestawienie – otworzysz je w Excelu.");
});
$("#btn-class-ai").addEventListener("click", classAiGrade);

// ================== sprawdzanie wydrukowanej kartki ze zdjęcia ==================
const paper = { files: [], busy: false, error: "" };
function openPaper() {
  const t = state.test;
  if (!t || !t.questions.length) return toast("Najpierw wygeneruj sprawdzian.", true);
  paper.files = [];
  paper.busy = false;
  paper.error = "";
  renderPaper();
  $("#modal-paper").classList.remove("hidden");
}

function renderPaper() {
  const t = state.test;
  $("#paper-group").innerHTML = t.groups
    ? `<label class="field-label">Która grupa jest na kartce?</label><div class="segmented">${Object.keys(t.groups).map((g) => `<button data-pgroup="${g}" class="${g === t.group ? "active" : ""}">Grupa ${g}</button>`).join("")}</div>`
    : "";
  $("#paper-thumbs").innerHTML = paper.files.map((f, i) => `<div class="paper-thumb"><img src="${f.url}" alt="" /><button class="icon-btn" data-prm="${i}" title="Usuń"><svg><use href="#i-x"/></svg></button><span>${i + 1}</span></div>`).join("") + `<button class="paper-add" id="btn-paper-add" ${paper.files.length >= 8 || paper.busy ? "disabled" : ""}><svg><use href="#i-camera"/></svg><span>${paper.files.length ? "Dodaj stronę" : "Wybierz zdjęcia kartki"}</span><small>JPG, PNG lub PDF</small></button>`;
  $("#btn-paper-ok").disabled = !paper.files.length || paper.busy;
  $("#btn-paper-ok").innerHTML = paper.busy ? `<span class="spinner small"></span> AI czyta kartkę…` : "Odczytaj odpowiedzi";
  $("#paper-status").classList.toggle("error-text", Boolean(paper.error) && !paper.busy);
  $("#paper-status").textContent = paper.error && !paper.busy ? `Nie udało się odczytać kartki: ${paper.error}` : paper.busy ? `Odczytuję ${paper.files.length} ${plural(paper.files.length, "zdjęcie", "zdjęcia", "zdjęć")} – to zwykle trwa ${state.ai && state.ai.kind === "ollama" ? "kilkanaście minut" : "do 1–2 minut"}…` : "";
}

/** Zdjęcie kartki dla AI: dłuższy bok do 1600 px (pismo ręczne musi być czytelne). */
async function paperImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const edge = state.ai && state.ai.kind === "ollama" ? 1280 : 1600;
  const { w, h } = fitSize(bmp.width, bmp.height, edge, Infinity);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { name: file.name, url: c.toDataURL("image/jpeg", 0.88) };
}

async function addPaperFiles() {
  const res = await window.api.pickFiles(8 - paper.files.length);
  if (!res.ok) return;
  for (const f of res.files) {
    const file = new File([f.data], f.name, { type: f.type });
    try {
      const list = isPdf(file) ? await pdfToImages(file, 8 - paper.files.length) : [file];
      for (const x of list) if (paper.files.length < 8) paper.files.push(await paperImage(x));
    } catch (e) {
      console.error(e);
      toast(`Nie udało się wczytać pliku ${f.name}.`, true);
    }
  }
  renderPaper();
}

/** Zadania w postaci dla AI (z poprawnymi odpowiedziami tylko przy otwartych – do oceny). */
function paperQuestions(t) {
  return t.questions.map((q) => {
    const f = fmtOf(q);
    const o = { id: q.id, format: f, question: q.question, points: q.points };
    if (f === "abc") o.options = q.options;
    if (f === "tf") o.statements = q.statements.map((s) => s.text);
    if (f === "match") Object.assign(o, { left: q.left, right: q.right });
    if (f === "gap") o.items = q.items.map((g) => g.text);
    if (f === "open") o.model = q.model_answer;
    return o;
  });
}

async function readPaper() {
  const t = state.test;
  if (state.generating) return toast("AI jest teraz zajęte – spróbuj za chwilę.", true);
  if (!(await refreshAi())) return openAiSetup();
  paper.busy = true;
  paper.error = "";
  renderPaper();
  let res;
  try {
    res = await window.api.aiTask("paper", {
      questions: paperQuestions(t),
      pages: paper.files.length,
      settings: { grade: state.settings.grade, subject: t.subject || state.settings.subject },
      images: paper.files.map((f) => f.url.slice(f.url.indexOf(",") + 1)),
    });
  } finally {
    paper.busy = false;
  }
  if (!res.ok) {
    paper.error = res.error;
    return renderPaper();
  }
  const data = res.data || {};
  resetSolve();
  const s = state.solve;
  Object.assign(s, { paper: true, mode: "paper", unclear: [], name: cleanText(data.name) || s.name });
  const L = "ABCDEFGHIJ";
  let read = 0;
  for (const r of data.tasks || []) {
    const q = t.questions.find((x) => x.id === r.id);
    if (!q) continue;
    const f = fmtOf(q);
    const marks = Array.isArray(r.marks) ? r.marks.map((m) => String(m || "").trim()) : [];
    if (r.unclear) s.unclear.push(q.id);
    if (f === "abc") {
      const k = L.indexOf(String(r.choice || "").trim().toUpperCase().charAt(0));
      if (k >= 0 && k < q.options.length) s.answers[q.id] = k;
    }
    if (f === "tf") {
      const a = {};
      q.statements.forEach((_, i) => {
        const m = (marks[i] || "").toUpperCase();
        if (m.startsWith("P") || m === "T") a[i] = true;
        if (m.startsWith("F") || m === "N") a[i] = false;
      });
      if (Object.keys(a).length) s.answers[q.id] = a;
    }
    if (f === "match") {
      const a = {};
      q.left.forEach((_, i) => {
        const k = L.indexOf((marks[i] || "").toUpperCase().charAt(0));
        if (k >= 0 && k < q.right.length) a[i] = k;
      });
      if (Object.keys(a).length) s.answers[q.id] = a;
    }
    if (f === "gap") {
      const a = {};
      q.items.forEach((_, i) => marks[i] && (a[i] = marks[i].slice(0, 200)));
      if (Object.keys(a).length) s.answers[q.id] = a;
    }
    if (f === "open") {
      const txt = String(r.text || "").trim();
      if (txt) s.answers[q.id] = txt.slice(0, 5000);
      s.aiGrades[q.id] = txt ? { points: Math.max(0, Math.min(q.points, Math.round((+r.points || 0) * 2) / 2)), comment: cleanText(r.comment).slice(0, 300) || "—" } : { points: 0, comment: "Brak odpowiedzi na kartce." };
    }
    if (s.answers[q.id] != null) read++;
  }
  $("#modal-paper").classList.add("hidden");
  state.view = "solve";
  state.keyUnlocked = false;
  renderPreview();
  $(".main").scrollTop = 0;
  syncUi();
  toast(`AI odczytało odpowiedzi w ${read} z ${t.questions.length} zadań. Sprawdź je i kliknij „Zakończ i sprawdź”.`, false, 8000);
}

$("#modal-paper").addEventListener("click", (e) => {
  const g = e.target.closest("[data-pgroup]");
  if (g && !paper.busy) {
    switchGroup(g.dataset.pgroup);
    return renderPaper();
  }
  const rm = e.target.closest("[data-prm]");
  if (rm && !paper.busy) {
    paper.files.splice(+rm.dataset.prm, 1);
    return renderPaper();
  }
  if (e.target.closest("#btn-paper-add") && !paper.busy) addPaperFiles();
});
$("#btn-paper-ok").addEventListener("click", readPaper);
$("#btn-paper-cancel").addEventListener("click", () => {
  if (paper.busy) window.api.cancel();
  $("#modal-paper").classList.add("hidden");
});

/** Informacja nad zadaniami po odczycie kartki (wywoływane z app.js). */
function solveBannerHtml() {
  const s = state.solve;
  if (!s.paper) return "";
  if (s.finished)
    return `<div class="s-banner"><svg><use href="#i-camera"/></svg><span>Kartka sprawdzona. ${state.test.questions.some((q) => fmtOf(q) === "open") ? "AI zaproponowało punkty za zadania otwarte – zobaczysz je po kliknięciu „Pokaż odpowiedzi i oceń”." : ""}</span></div>`;
  const unclear = (s.unclear || []).map((id) => state.test.questions.findIndex((q) => q.id === id) + 1).filter((n) => n > 0);
  return `<div class="s-banner warn"><svg><use href="#i-camera"/></svg><span><b>Odpowiedzi odczytane z kartki przez AI.</b> Porównaj je z kartką i popraw, jeśli coś się nie zgadza – potem kliknij „Zakończ i sprawdź”.${unclear.length ? ` <b>Niepewny odczyt: zad. ${unclear.join(", ")}</b> (zaznaczone na żółto).` : ""}</span></div>`;
}
function solveTaskClass(q) {
  const s = state.solve;
  return s.paper && !s.finished && (s.unclear || []).includes(q.id) ? "s-unclear" : "";
}

// ================== „Wyjaśnij mój błąd” ==================
function explainButtonHtml() {
  const s = state.solve;
  if (s.explainBusy) return `<button class="btn" disabled><span class="spinner small"></span> AI wyjaśnia…</button>`;
  const wrong = wrongQuestions();
  if (!wrong.length || wrong.every((q) => (s.explanations || {})[q.id])) return "";
  return `<button class="btn" data-sact="explain"><svg class="ico"><use href="#i-bulb"/></svg> Wyjaśnij moje błędy</button>`;
}

function explainHtml(q) {
  const s = state.solve;
  const e = (s.explanations || {})[q.id];
  if (!e || !s.finished) return "";
  return `<div class="s-explain"><div class="s-ex-head"><svg><use href="#i-bulb"/></svg> Dlaczego?</div><p>${esc(e.why)}</p>
    ${e.remember ? `<div class="s-ex-row"><svg><use href="#i-bookmark"/></svg><span><b>Zapamiętaj:</b> ${esc(e.remember)}</span></div>` : ""}
    ${e.read ? `<div class="s-ex-row"><svg><use href="#i-book"/></svg><span><b>Doczytaj:</b> ${esc(e.read)}</span></div>` : ""}</div>`;
}

/** Treść zadania razem z częściami (zdania P/F, pary, luki) – dla AI. */
function questionText(q) {
  const f = fmtOf(q);
  if (f === "tf") return `${q.question} ${q.statements.map((s, i) => `(${i + 1}) ${s.text}`).join(" ")}`;
  if (f === "match") return `${q.question} Pojęcia: ${q.left.join("; ")}. Opisy: ${q.right.join("; ")}.`;
  if (f === "gap") return `${q.question} ${q.items.map((g, i) => `(${i + 1}) ${g.text}`).join(" ")}`;
  if (f === "abc") return `${q.question} Odpowiedzi: ${q.options.map((o, k) => `${letter(k)}. ${o}`).join("; ")}`;
  return q.question;
}

/** Odpowiedź ucznia jako tekst – przy zadaniach złożonych tylko błędne części. */
function studentAnswerText(q, s = state.solve) {
  const a = s.answers[q.id];
  const f = fmtOf(q);
  if (f === "abc") return a == null ? "(brak odpowiedzi)" : `${letter(a)}. ${q.options[a]}`;
  if (f === "tf") return q.statements.map((st, i) => (a && a[i] === st.truth ? null : `„${st.text}” – uczeń: ${a && a[i] === true ? "prawda" : a && a[i] === false ? "fałsz" : "brak odpowiedzi"}`)).filter(Boolean).join("; ");
  if (f === "match") return q.left.map((l, i) => (a && a[i] === q.answers[i] ? null : `${l} → ${a && a[i] != null ? q.right[a[i]] : "brak odpowiedzi"}`)).filter(Boolean).join("; ");
  if (f === "gap") return q.items.map((g, i) => (a && normAns(a[i]) === normAns(g.answer) ? null : `„${g.text}” – uczeń wpisał: ${(a && a[i]) || "nic"}`)).filter(Boolean).join("; ");
  return String(a || "(brak odpowiedzi)");
}

async function explainMistakes() {
  const s = state.solve;
  const t = state.test;
  const wrong = wrongQuestions().filter((q) => !(s.explanations || {})[q.id]);
  if (!wrong.length) return;
  if (state.generating) return toast("AI jest teraz zajęte – spróbuj za chwilę.", true);
  if (!(await refreshAi())) return openAiSetup();
  s.explainBusy = true;
  renderSolveKeepScroll();
  try {
    const pages = pagesForTest(t);
    const res = await window.api.aiTask("explain", {
      items: wrong.map((q) => ({ id: q.id, question: questionText(q), student: studentAnswerText(q, s), correct: answerText(q) })),
      material: pages.map((p) => ({ title: p.analysis.title, text: (p.analysis.text || "").slice(0, Math.max(1500, Math.floor(8000 / Math.max(1, pages.length)))) })),
      settings: { subject: t.subject || state.settings.subject, grade: state.settings.grade },
    });
    if (!res.ok) return toast(res.error, true);
    s.explanations = s.explanations || {};
    for (const it of res.data.items || []) {
      if (!wrong.some((q) => q.id === it.id)) continue;
      s.explanations[it.id] = { why: cleanText(it.why).slice(0, 900), remember: cleanText(it.remember).slice(0, 400), read: cleanText(it.read).slice(0, 300) };
    }
    const n = Object.keys(s.explanations).length;
    toast(n ? "Wyjaśnienia są pod zadaniami z błędami." : "AI nie przygotowało wyjaśnień – spróbuj jeszcze raz.", !n);
  } finally {
    s.explainBusy = false;
    if (state.solve === s && state.view === "solve") {
      renderSolveKeepScroll();
      const first = document.querySelector("#sheet-solve .s-explain");
      if (first) first.closest(".q").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

// ================== przyciski nad kartką, menu ==================
function renderPlaySlot() {
  const slot = $("#play-slot");
  if (slot) slot.innerHTML = "";
}
$("#modebar-extra").addEventListener("click", (e) => {
  const b = e.target.closest("[data-play]");
  if (!b || b.disabled) return;
  if (b.dataset.play === "quiz") startQuiz();
  if (b.dataset.play === "paper") openPaper();
});

const prevGroupSwitch4 = renderGroupSwitch;
renderGroupSwitch = function () {
  prevGroupSwitch4();
  renderPlaySlot();
};
const prevMenuExtra4 = onMenuExtra;
onMenuExtra = function (action, arg) {
  if (action === "quiz") return startQuiz();
  if (action === "paper") return openPaper();
  if (action === "class") return showClassView();
  return prevMenuExtra4(action, arg);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-paper").classList.contains("hidden") && !paper.busy) $("#modal-paper").classList.add("hidden");
});
