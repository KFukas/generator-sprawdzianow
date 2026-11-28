"use strict";
// Profile dzieci (odznaki, seria dni nauki), biblioteka sprawdzianów (zapis automatyczny), fiszki z powtórkami, plan nauki.
// Korzysta ze wspólnego stanu i funkcji z app.js, features.js i features2.js (ładowany po nich).

// ================== wspólne ==================
const DAY = 86400000;
const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const startOfDay = (d = Date.now()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};
const parseDay = (k) => {
  const [y, m, d] = String(k).split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};
const daysFromToday = (k) => Math.round((parseDay(k) - startOfDay()) / DAY);
function fmtDay(k) {
  const diff = daysFromToday(k);
  const base = new Date(parseDay(k)).toLocaleDateString("pl-PL", { weekday: "short", day: "2-digit", month: "2-digit" });
  return diff === 0 ? `Dziś · ${base}` : diff === 1 ? `Jutro · ${base}` : diff === -1 ? `Wczoraj · ${base}` : base;
}
const pct = (x) => `${Math.round(x)}%`;

// strony z biblioteki stron, które nie są otwarte w programie (sam tekst – bez zdjęć)
const virtualPages = new Map();
const prevPagesForTest = pagesForTest;
pagesForTest = function (t) {
  const hashes = new Set((t && t.pageHashes) || []);
  const own = state.pages.filter((p) => hashes.has(p.hash) && p.analysis);
  if (own.length) return own;
  const virt = [...hashes].map((h) => virtualPages.get(h)).filter(Boolean);
  return virt.length ? virt : prevPagesForTest(t);
};

/** Strony do nauki: otwarte w programie (ze zdjęciami) albo odczyty z biblioteki stron (sam tekst). */
async function pagesByHash(hashes) {
  const out = [];
  const missing = [];
  for (const h of hashes) {
    const p = state.pages.find((x) => x.hash === h && x.analysis) || virtualPages.get(h);
    if (p) out.push(p);
    else missing.push(h);
  }
  if (missing.length) {
    for (const r of await window.api.libraryGet(missing)) {
      if (!r.analysis) continue;
      const p = { id: newId("p"), hash: r.hash, name: r.analysis.name || "", analysis: { ...r.analysis, figures: [] }, selected: false, status: "done" };
      virtualPages.set(r.hash, p);
      out.push(p);
    }
  }
  return hashes.map((h) => out.find((p) => p.hash === h)).filter(Boolean);
}

// ================== profile dzieci ==================
const PCOLORS = ["#1e3a8a", "#0e7490", "#15803d", "#b45309", "#b91c1c", "#be185d", "#6d28d9", "#334155"];
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const avatarHtml = (p, cls = "") => `<span class="avatar ${cls}" style="background:${esc(p.color || PCOLORS[0])}">${esc(initials(p.name))}</span>`;
let prof = { profiles: [], active: null, activity: [] };
const activeProfile = () => prof.profiles.find((p) => p.id === prof.active) || null;
function profileName() {
  const p = activeProfile();
  return p ? p.name : "";
}
const saveProfiles = () => window.api.storeSet("profiles", prof);
function logActivity(type, n = 1) {
  prof.activity.push({ d: new Date().toISOString(), p: prof.active || null, t: type, n });
  saveProfiles();
}
const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
function profileIdFor(name, useActive) {
  const p = name && name.trim() ? prof.profiles.find((x) => sameName(x.name, name)) : null;
  return p ? p.id : useActive && !(name && name.trim()) ? prof.active : null;
}

/** Dodatkowe pola wpisu historii (wywoływane z features.js). */
function historyExtra(t, s) {
  const pid = s.profileId !== undefined ? s.profileId : profileIdFor(s.name, !s.remote);
  const out = { profileId: pid || null };
  const p = prof.profiles.find((x) => x.id === pid);
  if (p && !(s.name || "").trim()) out.name = p.name;
  if (t.libId) out.libId = t.libId;
  if (t.planRef) out.plan = true;
  if (s.classId) out.classId = s.classId;
  return out;
}

const BADGES = [
  { id: "first", icon: "target", name: "Pierwszy krok", desc: "Rozwiąż pierwszy sprawdzian albo quiz.", ok: (s) => s.attempts >= 1 },
  { id: "ten", icon: "book", name: "Pilny uczeń", desc: "10 rozwiązanych sprawdzianów lub quizów.", ok: (s) => s.attempts >= 10, prog: (s) => [s.attempts, 10] },
  { id: "fifty", icon: "library", name: "Mol książkowy", desc: "50 rozwiązanych sprawdzianów lub quizów.", ok: (s) => s.attempts >= 50, prog: (s) => [s.attempts, 50] },
  { id: "five", icon: "star", name: "Piątka!", desc: "Co najmniej 90% punktów w sprawdzianie.", ok: (s) => s.best >= 90 },
  { id: "perfect", icon: "check-circle", name: "Bez błędów", desc: "Sprawdzian na 100%.", ok: (s) => s.perfect >= 1 },
  { id: "streak3", icon: "flame", name: "Trzy dni z rzędu", desc: "Ucz się 3 dni pod rząd.", ok: (s) => s.bestStreak >= 3, prog: (s) => [s.streak, 3] },
  { id: "streak7", icon: "medal", name: "Tydzień nauki", desc: "Ucz się 7 dni pod rząd.", ok: (s) => s.bestStreak >= 7, prog: (s) => [s.streak, 7] },
  { id: "comeback", icon: "repeat", name: "Nie poddaję się", desc: "Rozwiąż powtórkę błędów.", ok: (s) => s.retries >= 1 },
  { id: "gamer", icon: "game", name: "Gracz", desc: "Zagraj w quiz-grę.", ok: (s) => s.quizzes >= 1 },
  { id: "combo", icon: "bolt", name: "Błyskawica", desc: "Seria 5 dobrych odpowiedzi w quizie.", ok: (s) => s.bestCombo >= 5 },
  { id: "cards", icon: "cards", name: "Fiszkomaniak", desc: "5 sesji z fiszkami.", ok: (s) => s.cardSessions >= 5, prog: (s) => [s.cardSessions, 5] },
  { id: "plan", icon: "calendar", name: "Plan wykonany", desc: "Zalicz wszystkie dni planu nauki.", ok: (s) => s.plansDone >= 1 },
  { id: "early", icon: "sunrise", name: "Ranny ptaszek", desc: "Ucz się przed ósmą rano.", ok: (s) => s.early },
];

function profileStats(p, hist) {
  const mine = hist.filter((e) => e.profileId === p.id || (!e.profileId && e.name && sameName(e.name, p.name)));
  const acts = prof.activity.filter((a) => a.p === p.id);
  const days = new Set([...mine.map((e) => dayKey(e.date)), ...acts.map((a) => dayKey(a.d))]);
  let streak = 0;
  let d = startOfDay();
  if (!days.has(dayKey(d))) d -= DAY; // seria trwa, jeśli dziecko uczyło się wczoraj
  while (days.has(dayKey(d))) {
    streak++;
    d -= DAY;
  }
  let bestStreak = 0, run = 0, prev = null;
  for (const k of [...days].sort()) {
    const t = parseDay(k);
    run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prev = t;
  }
  const tests = mine.filter((e) => e.mode !== "quiz");
  const quizzes = mine.filter((e) => e.mode === "quiz");
  return {
    attempts: mine.length,
    avg: mine.length ? mine.reduce((a, e) => a + e.pct, 0) / mine.length : 0,
    best: Math.max(0, ...tests.filter((e) => e.openGraded).map((e) => e.pct)),
    perfect: tests.filter((e) => e.openGraded && e.pct >= 100).length,
    retries: mine.filter((e) => e.retry).length,
    quizzes: quizzes.length,
    bestCombo: Math.max(0, ...quizzes.map((e) => e.bestStreak || 0)),
    cardSessions: acts.filter((a) => a.t === "fiszki").length,
    plansDone: acts.filter((a) => a.t === "plan").length,
    early: [...mine.map((e) => e.date), ...acts.map((a) => a.d)].some((x) => new Date(x).getHours() < 8),
    streak,
    bestStreak,
    learnedToday: days.has(dayKey(Date.now())),
  };
}

/** Sprawdza, czy ktoś zdobył nową odznakę – i gratuluje. */
async function checkBadges() {
  if (!prof.profiles.length) return;
  const hist = await window.api.historyList();
  const fresh = [];
  for (const p of prof.profiles) {
    const st = profileStats(p, hist);
    const earned = BADGES.filter((b) => b.ok(st)).map((b) => b.id);
    const had = new Set(p.badges || []);
    for (const id of earned) if (!had.has(id)) fresh.push({ p, b: BADGES.find((x) => x.id === id) });
    p.badges = [...new Set([...had, ...earned])];
  }
  if (fresh.length) {
    await saveProfiles();
    const f = fresh[0];
    toast(`${f.p.name} zdobywa odznakę „${f.b.name}”${fresh.length > 1 ? ` (i ${fresh.length - 1} więcej)` : ""}. Gratulacje!`, false, 8000);
  }
  renderProfileChip();
}

function renderProfileChip() {
  const p = activeProfile();
  const chip = $("#profile-chip");
  chip.innerHTML = p
    ? `${avatarHtml(p)}<span class="pinfo"><b>${esc(p.name)}</b><small>profil dziecka</small></span><svg class="ico"><use href="#i-chevron"/></svg>`
    : `<span class="avatar empty"><svg><use href="#i-user"/></svg></span><span class="pinfo"><b>Bez profilu</b><small>wybierz dziecko</small></span><svg class="ico"><use href="#i-chevron"/></svg>`;
  chip.title = p ? `Profil: ${p.name} – kliknij, aby zmienić` : "Profile dzieci – osobna historia, odznaki i seria dni nauki";
}

const profUi = { editing: null }; // null | "new" | id
async function openProfiles() {
  profUi.editing = prof.profiles.length ? null : "new";
  await renderProfiles();
  openDialog("dlg-profiles");
}

async function renderProfiles() {
  const hist = await window.api.historyList();
  const ed = profUi.editing;
  const editorFor = (p) => {
    const cur = p || { name: "", color: PCOLORS[prof.profiles.length % PCOLORS.length] };
    return `<div class="prof-editor" data-pid="${p ? esc(p.id) : ""}">
      <label class="field-label">Imię dziecka</label>
      <input type="text" id="prof-name" value="${esc(cur.name)}" maxlength="30" placeholder="np. Ola" />
      <label class="field-label">Kolor</label>
      <div class="color-grid">${PCOLORS.map((c) => `<button class="${c === cur.color ? "active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</div>
      <div class="modal-actions"><button class="btn ghost" data-pact="cancel">Anuluj</button><button class="btn primary" data-pact="save">Zapisz</button></div>
    </div>`;
  };
  const cards = prof.profiles
    .map((p) => {
      if (ed === p.id) return `<div class="prof-card editing">${editorFor(p)}</div>`;
      const st = profileStats(p, hist);
      const earned = BADGES.filter((b) => (p.badges || []).includes(b.id) || b.ok(st));
      const active = p.id === prof.active;
      return `<div class="prof-card ${active ? "active" : ""}">
        <div class="prof-top">${avatarHtml(p, "big")}
          <div><b>${esc(p.name)}</b><div class="streak ${st.streak ? "on" : ""}">${st.streak ? `<svg><use href="#i-flame"/></svg> ${st.streak} ${plural(st.streak, "dzień", "dni", "dni")} nauki z rzędu${st.learnedToday ? "" : " – ucz się dziś, by nie przerwać"}` : "Seria nauki: zacznij już dziś"}</div></div></div>
        <div class="prof-stats"><span><b>${st.attempts}</b> podejść</span><span><b>${st.attempts ? pct(st.avg) : "–"}</b> średnio</span><span><b>${earned.length}</b> / ${BADGES.length} odznak</span></div>
        <div class="badge-row">${earned.map((b) => `<span class="bi-s" title="${esc(b.name)} – ${esc(b.desc)}"><svg><use href="#i-${b.icon}"/></svg></span>`).join("") || `<span class="muted small">Pierwsza odznaka czeka – rozwiąż sprawdzian.</span>`}</div>
        <div class="prof-actions">
          ${active ? `<span class="tag active">aktywny</span>` : `<button class="btn primary" data-pact="use" data-pid="${esc(p.id)}">Wybierz</button>`}
          <button class="btn ghost" data-pact="edit" data-pid="${esc(p.id)}">Edytuj</button>
          <button class="icon-btn" data-pact="delete" data-pid="${esc(p.id)}" title="Usuń profil"><svg><use href="#i-trash"/></svg></button>
        </div>
      </div>`;
    })
    .join("");
  const add = ed === "new" ? `<div class="prof-card editing">${editorFor(null)}</div>` : `<button class="prof-card add" data-pact="new"><svg><use href="#i-plus"/></svg><b>Dodaj dziecko</b><span>osobna historia, odznaki i seria dni</span></button>`;
  const ap = activeProfile();
  let badges = "";
  if (ap) {
    const st = profileStats(ap, hist);
    badges = `<div class="hist-card"><div class="hist-card-head"><b>Odznaki – ${esc(ap.name)}</b><span class="muted small">zdobywane za regularną naukę i dobre wyniki</span></div>
      <div class="badge-grid">${BADGES.map((b) => {
        const got = (ap.badges || []).includes(b.id) || b.ok(st);
        const pr = !got && b.prog ? b.prog(st) : null;
        return `<div class="badge-item ${got ? "got" : ""}"><span class="bi"><svg><use href="#i-${b.icon}"/></svg></span><div><b>${esc(b.name)}</b><span>${esc(b.desc)}</span>${pr ? `<div class="mini-bar"><div style="width:${Math.min(100, (pr[0] / pr[1]) * 100)}%"></div></div><span class="muted small">${Math.min(pr[0], pr[1])} / ${pr[1]}</span>` : ""}</div></div>`;
      }).join("")}</div></div>`;
  }
  $("#prof-body").innerHTML = `<div class="prof-grid">${cards}${add}</div>${badges}`;
  $("#btn-prof-none").classList.toggle("hidden", !prof.active);
  const nameEl = $("#prof-name");
  if (nameEl) setTimeout(() => nameEl.focus(), 30);
}

$("#prof-body").addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-avatar], [data-color]");
  if (pick) {
    const grid = pick.parentElement;
    grid.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === pick));
    return;
  }
  const b = e.target.closest("[data-pact]");
  if (!b) return;
  const act = b.dataset.pact;
  const pid = b.dataset.pid;
  if (act === "new") profUi.editing = "new";
  if (act === "edit") profUi.editing = pid;
  if (act === "cancel") profUi.editing = null;
  if (act === "use") await setActiveProfile(pid);
  if (act === "delete") {
    const p = prof.profiles.find((x) => x.id === pid);
    if (!(await window.api.confirm(`Usunąć profil „${p.name}”?`, "Wyniki zostają w historii, ale odznaki i postęp fiszek tego profilu zostaną usunięte.", "Usuń"))) return;
    prof.profiles = prof.profiles.filter((x) => x.id !== pid);
    if (prof.active === pid) prof.active = null;
    delete decks.progress[pid];
    await saveDecks();
    await saveProfiles();
    renderProfileChip();
  }
  if (act === "save") {
    const box = b.closest(".prof-editor");
    const name = $("#prof-name").value.trim();
    if (!name) return toast("Wpisz imię dziecka.", true);
    if (prof.profiles.some((x) => sameName(x.name, name) && x.id !== box.dataset.pid)) return toast("Jest już profil o tym imieniu.", true);
    const color = box.querySelector("[data-color].active")?.dataset.color || PCOLORS[0];
    let p = prof.profiles.find((x) => x.id === box.dataset.pid);
    if (p) Object.assign(p, { name, color });
    else {
      p = { id: newId("u"), name, color, badges: [], createdAt: new Date().toISOString() };
      prof.profiles.push(p);
      if (!prof.active) prof.active = p.id;
    }
    profUi.editing = null;
    await saveProfiles();
    await checkBadges();
    if (p.id === prof.active && !state.solve.finished) state.solve.name = p.name;
    renderProfileChip();
  }
  await renderProfiles();
});
$("#prof-body").addEventListener("keydown", (e) => e.key === "Enter" && e.target.id === "prof-name" && $('[data-pact="save"]').click());

async function setActiveProfile(id) {
  prof.active = id || null;
  await saveProfiles();
  renderProfileChip();
  const p = activeProfile();
  if (!state.solve.finished) {
    state.solve.name = p ? p.name : "";
    if (state.view === "solve" && state.test) renderSolveKeepScroll();
  }
  if (!$("#dlg-learn").classList.contains("hidden")) renderLearn();
  renderTodayCard();
  toast(p ? `Profil: ${p.name}` : "Pracujesz bez profilu.");
}
$("#btn-prof-none").addEventListener("click", async () => {
  await setActiveProfile(null);
  await renderProfiles();
});
$("#profile-chip").addEventListener("click", openProfiles);

// ================== biblioteka sprawdzianów (zapis automatyczny) ==================
const lib = { list: [], q: "", subject: "", all: false };
let libTimer = 0;
let libLast = "";
let libSaving = Promise.resolve();

/** Wywoływane po każdej zmianie sprawdzianu – zapis do biblioteki z małym opóźnieniem. */
function onTestChanged() {
  const t = state.test;
  if (!t || !t.questions || !t.questions.length || state.generating || t.libDeleted) return;
  clearTimeout(libTimer);
  libTimer = setTimeout(() => (libSaving = libSaving.then(saveToLibrary).catch((e) => console.error("biblioteka", e))), 1500);
}
/** Zapisuje od razu (np. przed otwarciem innego sprawdzianu). */
async function flushLibrary() {
  if (libTimer) {
    clearTimeout(libTimer);
    libTimer = 0;
    libSaving = libSaving.then(saveToLibrary).catch((e) => console.error("biblioteka", e));
  }
  await libSaving;
}

function testOrigin(t) {
  return t.planRef ? "plan" : /^Powtórka – /.test(t.title || "") ? "retry" : "main";
}

async function saveToLibrary() {
  libTimer = 0;
  const t = state.test;
  if (!t || !t.questions.length || state.generating || t.libDeleted) return;
  if (!t.libId) t.libId = newId("t");
  if (!t.createdAt) t.createdAt = new Date().toISOString();
  const all = t.groups ? Object.values(t.groups).filter(Array.isArray).flat() : t.questions;
  const hashes = new Set(t.pageHashes || []);
  const figPages = new Set(all.flatMap((q) => (q.figures || []).map((f) => f.pageId)));
  const pages = state.pages.filter((p) => hashes.has(p.hash) || figPages.has(p.id));
  for (const h of hashes) if (!pages.some((p) => p.hash === h) && virtualPages.has(h)) pages.push(virtualPages.get(h));
  const test = t.groups ? { ...t, groups: Object.fromEntries(Object.entries(t.groups).map(([g, qs]) => [g, g === t.group ? null : qs])) } : t;
  const data = JSON.stringify({ version: 3, settings: state.settings, pages: pages.map(({ id, hash, baseHash, rot, name, width, height, analysis }) => ({ id, hash, baseHash, rot, name, width, height, selected: true, analysis })), test });
  if (data === libLast) return;
  const withImg = pages.filter((p) => p.url);
  for (const h of await window.api.pageImgMissing(withImg.map((p) => p.hash))) {
    const p = withImg.find((x) => x.hash === h);
    await window.api.pageImgPut(h, p.url.slice(p.url.indexOf(",") + 1));
  }
  const topics = [...new Set(pages.map((p) => p.analysis && p.analysis.title).filter(Boolean))].slice(0, 6);
  const fmts = {};
  for (const q of t.questions) fmts[fmtOf(q)] = (fmts[fmtOf(q)] || 0) + 1;
  const meta = {
    id: t.libId,
    title: t.title || "Sprawdzian",
    subject: t.subject || state.settings.subject || "",
    grade: state.settings.grade || "",
    n: t.questions.length,
    points: t.questions.reduce((a, q) => a + q.points, 0),
    topics,
    formats: fmts,
    groups: Boolean(t.groups),
    origin: testOrigin(t),
    createdAt: t.createdAt,
    updatedAt: new Date().toISOString(),
    pageHashes: pages.map((p) => p.hash),
    search: [t.title, t.subject, state.settings.subject, ...topics, ...t.questions.map((q) => q.question)].join(" ").toLowerCase().slice(0, 4000),
  };
  await window.api.testsSave(meta, data);
  libLast = data;
}

async function openLibrary() {
  await flushLibrary();
  lib.list = (await window.api.testsList()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  lib.hist = await window.api.historyList();
  renderLibrary();
  openDialog("dlg-library");
  setTimeout(() => $("#lib-q").focus(), 30);
}

function renderLibrary() {
  const subjects = [...new Set(lib.list.map((x) => x.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
  if (lib.subject && !subjects.includes(lib.subject)) lib.subject = "";
  $("#lib-subject").innerHTML = `<option value="">Wszystkie przedmioty</option>${subjects.map((s) => `<option ${s === lib.subject ? "selected" : ""}>${esc(s)}</option>`).join("")}`;
  const words = lib.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = lib.list.filter((x) => (lib.all || x.origin === "main") && (!lib.subject || x.subject === lib.subject) && words.every((w) => (x.search || x.title.toLowerCase()).includes(w)));
  const hidden = lib.list.filter((x) => x.origin !== "main").length;
  $("#lib-info").textContent = lib.list.length ? `${list.length} z ${lib.list.length} · każdy wygenerowany sprawdzian zapisuje się tu sam` : "Każdy wygenerowany sprawdzian zapisze się tu sam";
  $("#lib-all-wrap").classList.toggle("hidden", !hidden);
  const lastBy = new Map();
  for (const e of lib.hist || []) if (e.libId && e.mode !== "quiz") lastBy.set(e.libId, e);
  const cur = state.test && state.test.libId;
  $("#lib-body").innerHTML = list.length
    ? `<div class="lib-grid">${list
        .map((x) => {
          const last = lastBy.get(x.id);
          return `<div class="lib-card ${x.id === cur ? "current" : ""}" data-lid="${esc(x.id)}">
            <div class="lib-top"><b class="lib-title">${esc(x.title)}</b>${x.id === cur ? `<span class="tag active">otwarty</span>` : ""}</div>
            <div class="muted small">${[x.subject, x.grade, new Date(x.updatedAt).toLocaleDateString("pl-PL")].filter(Boolean).map(esc).join(" · ")}</div>
            <div class="lib-chips"><span class="badge">${x.n} ${plural(x.n, "zadanie", "zadania", "zadań")} · ${x.points} pkt</span>${x.groups ? `<span class="badge">grupy A/B</span>` : ""}${x.origin === "retry" ? `<span class="badge retry">powtórka</span>` : ""}${x.origin === "plan" ? `<span class="badge">plan nauki</span>` : ""}</div>
            ${x.topics && x.topics.length ? `<div class="lib-topics">${x.topics.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
            <div class="lib-foot">
              <span class="muted small">${last ? `ostatni wynik: <b>${pct(last.pct)}</b>${last.name ? ` (${esc(last.name)})` : ""}` : "jeszcze nierozwiązany"}</span>
              <span class="lib-actions"><button class="icon-btn" data-lact="delete" title="Usuń z biblioteki"><svg><use href="#i-trash"/></svg></button><button class="btn primary" data-lact="open">Otwórz</button></span>
            </div>
          </div>`;
        })
        .join("")}</div>`
    : `<div class="hist-empty"><div class="empty-icon"><svg><use href="#i-library"/></svg></div><b>${lib.list.length ? "Nic nie pasuje do wyszukiwania" : "Biblioteka jest jeszcze pusta"}</b><span>${lib.list.length ? "Zmień wyszukiwane słowa albo przedmiot." : "Każdy wygenerowany sprawdzian zapisze się tutaj automatycznie – razem ze stronami i grafikami."}</span></div>`;
}

$("#lib-q").addEventListener("input", (e) => ((lib.q = e.target.value), renderLibrary()));
$("#lib-subject").addEventListener("change", (e) => ((lib.subject = e.target.value), renderLibrary()));
$("#lib-all").addEventListener("change", (e) => ((lib.all = e.target.checked), renderLibrary()));
$("#lib-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-lact]");
  const id = e.target.closest("[data-lid]")?.dataset.lid;
  if (!b || !id) return;
  if (b.dataset.lact === "open") return openFromLibrary(id);
  if (b.dataset.lact === "delete") {
    const x = lib.list.find((y) => y.id === id);
    if (!(await window.api.confirm(`Usunąć „${x.title}” z biblioteki?`, "Wyniki w historii zostaną. Tej operacji nie można cofnąć.", "Usuń"))) return;
    await window.api.testsDelete(id);
    if (state.test && state.test.libId === id) state.test.libDeleted = true;
    lib.list = lib.list.filter((y) => y.id !== id);
    renderLibrary();
  }
});

async function openFromLibrary(id) {
  if (state.generating) return toast("Poczekaj, aż AI skończy układać zadania.", true);
  await flushLibrary();
  const raw = await window.api.testsLoad(id);
  if (!raw) return toast("Nie udało się wczytać sprawdzianu z biblioteki.", true);
  try {
    const data = JSON.parse(raw);
    const imgs = new Map((await window.api.pageImgGet(data.pages.map((p) => p.hash))).map((x) => [x.hash, x.url]));
    const pages = [];
    for (const p of data.pages) {
      if (imgs.get(p.hash)) pages.push({ ...p, url: imgs.get(p.hash) });
      else if (p.analysis) virtualPages.set(p.hash, { id: p.id, hash: p.hash, name: p.name, analysis: { ...p.analysis, figures: [] }, selected: false, status: "done" });
    }
    loadProjectData({ ...data, pages });
    libLast = raw;
    closeDialog("dlg-library");
    toast(`Otwarto: ${data.test.title}`);
  } catch (e) {
    console.error(e);
    toast("Ten wpis biblioteki jest uszkodzony.", true);
  }
}
$("#btn-library").addEventListener("click", openLibrary);

// ================== fiszki (powtórki rozłożone w czasie) ==================
let decks = { decks: [], progress: {} };
let decksTimer = 0;
const saveDecks = () => window.api.storeSet("decks", decks);
const saveDecksSoon = () => {
  clearTimeout(decksTimer);
  decksTimer = setTimeout(saveDecks, 600);
};
const pkey = () => prof.active || "_";
const cardState = (card) => (decks.progress[pkey()] || {})[card.id] || null;
function setCardState(card, st) {
  (decks.progress[pkey()] = decks.progress[pkey()] || {})[card.id] = st;
}
function deckStats(deck) {
  const now = Date.now();
  let fresh = 0, due = 0, learned = 0, nextDue = Infinity;
  for (const c of deck.cards) {
    const st = cardState(c);
    if (!st) fresh++;
    else {
      if (st.due <= now) due++;
      else nextDue = Math.min(nextDue, st.due);
      if (st.iv >= 7) learned++;
    }
  }
  return { total: deck.cards.length, fresh, due, learned, learning: deck.cards.length - fresh - learned, nextDue, today: due + Math.min(fresh, 15) };
}

/** Uproszczony algorytm SM-2: 1 – nie wiem, 2 – trudne, 3 – wiem, 4 – łatwe. */
function schedule(st, r) {
  const s = st ? { ...st } : { iv: 0, ease: 2.5, reps: 0, lapses: 0 };
  if (r === 1) {
    s.lapses++;
    s.iv = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.due = Date.now() + 60000;
    return s;
  }
  if (r === 2) {
    s.iv = s.iv ? Math.max(1, Math.round(s.iv * 1.2)) : 1;
    s.ease = Math.max(1.3, s.ease - 0.15);
  }
  if (r === 3) s.iv = s.iv ? Math.max(s.iv + 1, Math.round(s.iv * s.ease)) : 1;
  if (r === 4) {
    s.iv = s.iv ? Math.max(s.iv + 2, Math.round(s.iv * s.ease * 1.3)) : 3;
    s.ease += 0.15;
  }
  s.reps++;
  s.due = startOfDay() + s.iv * DAY;
  return s;
}
function ivLabel(st, r) {
  if (r === 1) return "za chwilę";
  const iv = schedule(st, r).iv;
  return iv === 1 ? "jutro" : `za ${iv} ${plural(iv, "dzień", "dni", "dni")}`;
}

async function createDeck(pages, count) {
  if (!pages.length) return toast("Najpierw dodaj i zaznacz przeczytane strony w Materiale.", true), null;
  if (!(await refreshAi())) return openAiSetup(), null;
  if (state.generating) return toast("AI jest teraz zajęte – spróbuj za chwilę.", true), null;
  const res = await window.api.aiTask("cards", {
    pages: pages.map((p) => ({ title: p.analysis.title, text: (p.analysis.text || "").slice(0, Math.max(1500, Math.floor(10000 / pages.length))) })),
    count,
    settings: { grade: state.settings.grade, subject: state.settings.subject },
  });
  if (!res.ok) return toast(res.error, true), null;
  const cards = uniq(
    (res.data.cards || []).map((c) => ({ front: cleanText(c.front).slice(0, 200), back: cleanText(c.back).slice(0, 500) })).filter((c) => c.front && c.back),
    (c) => c.front.toLowerCase()
  ).map((c) => ({ id: newId("c"), ...c }));
  if (!cards.length) return toast("AI nie przygotowało fiszek – spróbuj jeszcze raz.", true), null;
  const deck = { id: newId("d"), title: cleanText(res.data.title) || pages[0].analysis.title || "Fiszki", subject: state.settings.subject || "", createdAt: new Date().toISOString(), pageHashes: pages.map((p) => p.hash), cards };
  decks.decks.unshift(deck);
  await saveDecks();
  return deck;
}

// ---------- sesja nauki ----------
let study = null;
function startStudy(deckId, extra = false) {
  const deck = decks.decks.find((d) => d.id === deckId);
  if (!deck) return;
  const now = Date.now();
  let queue;
  if (extra) queue = shuffle(deck.cards);
  else {
    const due = deck.cards.filter((c) => cardState(c) && cardState(c).due <= now).sort((a, b) => cardState(a).due - cardState(b).due);
    queue = [...due, ...deck.cards.filter((c) => !cardState(c)).slice(0, 15)];
  }
  study = { deck, queue, pos: 0, flipped: false, extra, seen: 0, good: 0, again: 0 };
  $("#study-overlay").classList.remove("hidden");
  renderStudy();
}

function renderStudy() {
  const s = study;
  const el = $("#study-overlay");
  const head = `<div class="st-top"><div class="st-title"><svg><use href="#i-cards"/></svg> ${esc(s.deck.title)}${s.extra ? ` <span class="badge">dodatkowo</span>` : ""}</div><div class="st-prog">${Math.min(s.pos + 1, s.queue.length)} / ${s.queue.length}</div><button class="icon-btn st-x" data-st="close" title="Zakończ (Esc)"><svg><use href="#i-x"/></svg></button></div>`;
  if (!s.queue.length) {
    const st = deckStats(s.deck);
    el.innerHTML = `${head}<div class="st-stage"><div class="st-done"><div class="done-ico"><svg><use href="#i-check"/></svg></div><h2>Wszystko powtórzone</h2><p class="muted">Następna powtórka: ${Number.isFinite(st.nextDue) ? fmtDay(dayKey(st.nextDue)).toLowerCase() : "–"}. Regularne krótkie powtórki działają najlepiej.</p>
      <div class="st-actions"><button class="btn" data-st="extra">Ucz się dodatkowo</button><button class="btn primary" data-st="close">Zamknij</button></div></div></div>`;
    return;
  }
  if (s.pos >= s.queue.length) return finishStudy();
  const card = s.queue[s.pos];
  const st = cardState(card);
  el.innerHTML = `${head}
    <div class="st-bar"><div style="width:${(s.pos / s.queue.length) * 100}%"></div></div>
    <div class="st-stage">
      <button class="st-card ${s.flipped ? "flipped" : ""}" data-st="flip">
        <div class="st-face st-front"><span class="st-label">${st ? "powtórka" : "nowa fiszka"}</span><div class="st-text">${esc(card.front)}</div><span class="st-hint">kliknij albo naciśnij spację, aby zobaczyć odpowiedź</span></div>
        <div class="st-face st-back"><span class="st-label">odpowiedź</span><div class="st-q">${esc(card.front)}</div><div class="st-text">${esc(card.back)}</div></div>
      </button>
      <div class="st-rate ${s.flipped ? "" : "hidden"}">
        <span class="muted">Jak Ci poszło?</span>
        <button class="r1" data-rate="1"><b>Nie wiem</b><span>${ivLabel(st, 1)}</span></button>
        <button class="r2" data-rate="2"><b>Trudne</b><span>${ivLabel(st, 2)}</span></button>
        <button class="r3" data-rate="3"><b>Wiem</b><span>${ivLabel(st, 3)}</span></button>
        <button class="r4" data-rate="4"><b>Łatwe</b><span>${ivLabel(st, 4)}</span></button>
      </div>
      ${s.flipped ? "" : `<div class="st-keys muted small">Skróty: spacja – odwróć · 1–4 – ocena · Esc – zakończ</div>`}
    </div>`;
}

function rateCard(r) {
  const s = study;
  const card = s.queue[s.pos];
  if (!s.extra) setCardState(card, schedule(cardState(card), r));
  s.seen++;
  if (r >= 3) s.good++;
  if (r === 1) {
    s.again++;
    s.queue.splice(Math.min(s.queue.length, s.pos + 4), 0, card); // wróci za chwilę
  }
  s.pos++;
  s.flipped = false;
  saveDecksSoon();
  renderStudy();
}

async function finishStudy() {
  const s = study;
  if (s.seen) logActivity("fiszki", s.seen);
  await saveDecks();
  const st = deckStats(s.deck);
  $("#study-overlay").innerHTML = `<div class="st-top"><div class="st-title"><svg><use href="#i-cards"/></svg> ${esc(s.deck.title)}</div><button class="icon-btn st-x" data-st="close"><svg><use href="#i-x"/></svg></button></div>
    <div class="st-stage"><div class="st-done"><div class="done-ico"><svg><use href="#i-check"/></svg></div><h2>Sesja zakończona</h2>
      <div class="st-sum"><div><b>${s.seen}</b><span>odpowiedzi</span></div><div><b>${s.good}</b><span>wiem / łatwe</span></div><div><b>${st.learned}</b><span>opanowane fiszki</span></div></div>
      <p class="muted">${st.due ? `Do powtórki zostało jeszcze ${st.due}.` : `Następna powtórka: ${Number.isFinite(st.nextDue) ? fmtDay(dayKey(st.nextDue)).toLowerCase() : "gdy dodasz nowe fiszki"}.`}</p>
      <div class="st-actions"><button class="btn" data-st="extra">Jeszcze raz (dodatkowo)</button><button class="btn primary" data-st="close">Zamknij</button></div></div></div>`;
  study.pos = study.queue.length;
  study.finished = true;
  checkBadges();
  renderTodayCard();
  if (!$("#dlg-learn").classList.contains("hidden")) renderLearn();
}

function closeStudy() {
  const s = study;
  $("#study-overlay").classList.add("hidden");
  study = null;
  if (s && !s.finished && s.seen) {
    logActivity("fiszki", s.seen);
    saveDecks();
    checkBadges();
  }
  renderTodayCard();
  if (!$("#dlg-learn").classList.contains("hidden")) renderLearn();
}

$("#study-overlay").addEventListener("click", (e) => {
  const r = e.target.closest("[data-rate]");
  if (r && study && study.flipped) return rateCard(+r.dataset.rate);
  const b = e.target.closest("[data-st]");
  if (!b || !study) return;
  if (b.dataset.st === "flip") {
    study.flipped = !study.flipped;
    renderStudy();
  }
  if (b.dataset.st === "close") closeStudy();
  if (b.dataset.st === "extra") startStudy(study.deck.id, true);
});
document.addEventListener("keydown", (e) => {
  if (!study || $("#study-overlay").classList.contains("hidden")) return;
  if (e.key === "Escape") return closeStudy();
  if (study.finished || study.pos >= study.queue.length) return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    study.flipped = !study.flipped;
    renderStudy();
  }
  if (study.flipped && /^[1-4]$/.test(e.key)) rateCard(+e.key);
});

// ================== plan nauki przed sprawdzianem ==================
let plans = [];
const savePlans = () => window.api.storeSet("plans", plans);
const myPlans = () => plans.filter((p) => !prof.active || !p.profileId || p.profileId === prof.active);

/** Dni nauki: od dziś do dnia przed sprawdzianem (najwyżej 14); ostatni dzień – próbny sprawdzian z całości. */
function planDays(examKey, hashes) {
  const n = daysFromToday(examKey);
  if (n < 1) return null;
  const count = Math.min(n, 14);
  const first = parseDay(examKey) - count * DAY;
  const practice = count - 1;
  const days = [];
  for (let i = 0; i < count; i++) {
    const date = dayKey(first + i * DAY + DAY / 2);
    if (i === count - 1) days.push({ date, type: "mock", hashes: hashes.slice(), done: false });
    else {
      let hs;
      if (hashes.length <= practice) hs = [hashes[i % hashes.length]];
      else {
        const per = Math.ceil(hashes.length / practice);
        hs = hashes.slice(i * per, i * per + per);
        if (!hs.length) hs = [hashes[i % hashes.length]];
      }
      days.push({ date, type: "quiz", hashes: hs, done: false });
    }
  }
  return days;
}

const planUi = { tab: "plan", creating: false, source: "selected", busy: false };
function openLearn(tab) {
  if (tab) planUi.tab = tab;
  renderLearn();
  openDialog("dlg-learn");
}

function learnSources() {
  const selected = state.pages.filter((p) => p.selected && p.analysis && (p.analysis.text || "").length > 40);
  const fromTest = state.test ? pagesForTest(state.test) : [];
  return { selected, fromTest };
}

function renderLearn() {
  document.querySelectorAll("#learn-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.ltab === planUi.tab));
  $("#learn-body").innerHTML = planUi.tab === "plan" ? planTabHtml() : cardsTabHtml();
  const d = $("#plan-date");
  if (d && !d.value) {
    const t = new Date(Date.now() + DAY);
    d.min = dayKey(t);
    const fri = new Date(startOfDay());
    do fri.setDate(fri.getDate() + 1);
    while (fri.getDay() !== 5 || daysFromToday(dayKey(fri)) < 2);
    d.value = dayKey(fri);
  }
}

function sourcePicker(name) {
  const { selected, fromTest } = learnSources();
  if (planUi.source === "selected" && !selected.length && fromTest.length) planUi.source = "test";
  const opt = (val, label, pages) => `<label class="src-opt ${pages.length ? "" : "disabled"}"><input type="radio" name="${name}" value="${val}" ${planUi.source === val ? "checked" : ""} ${pages.length ? "" : "disabled"} />
    <span><b>${label} (${pages.length})</b><small>${pages.length ? esc(pages.map((p) => p.analysis.title).filter(Boolean).slice(0, 4).join(" · ")) : "brak przeczytanych stron"}</small></span></label>`;
  return `<div class="src-list">${opt("selected", "Strony zaznaczone w Materiale", selected)}${opt("test", "Strony bieżącego sprawdzianu", fromTest)}</div>`;
}
const pickedPages = () => (planUi.source === "test" ? learnSources().fromTest : learnSources().selected);

function planTabHtml() {
  const list = myPlans().sort((a, b) => (a.finished === b.finished ? a.examDate.localeCompare(b.examDate) : a.finished ? 1 : -1));
  const form = `<div class="plan-form">
      <h3>Nowy plan nauki</h3>
      <p class="muted">Wpisz, kiedy jest sprawdzian. Program codziennie przygotuje krótką kartkówkę z kolejnej części materiału (z naciskiem na wcześniejsze błędy), a dzień przed sprawdzianem – próbny sprawdzian z całości.</p>
      <div class="form-row"><div><label class="field-label" for="plan-date">Kiedy sprawdzian?</label><input type="date" id="plan-date" class="date" /></div>
        <div><label class="field-label" for="plan-title">Nazwa</label><input type="text" id="plan-title" placeholder="np. Biologia – rośliny" value="${esc([state.settings.subject, (learnSources().selected[0] || learnSources().fromTest[0] || { analysis: {} }).analysis.title].filter(Boolean).join(" – "))}" /></div></div>
      <label class="field-label">Z jakiego materiału?</label>${sourcePicker("plan-src")}
      <div class="form-row"><div><label class="field-label">Zadań dziennie</label><div class="segmented" id="plan-per"><button data-v="5" class="active">5 · ok. 10 min</button><button data-v="8">8 · ok. 15 min</button></div></div>
        <div><label class="field-label">Fiszki</label><label class="check"><input type="checkbox" id="plan-cards" checked /> codziennie fiszki z tego materiału</label></div></div>
      <div class="modal-actions">${list.length ? `<button class="btn ghost" data-plan="cancel">Anuluj</button>` : ""}<button class="btn primary" data-plan="create" ${planUi.busy ? "disabled" : ""}>${planUi.busy ? `<span class="spinner small"></span> Przygotowuję…` : "Utwórz plan"}</button></div>
    </div>`;
  if (planUi.creating || !list.length) return form;
  return `<div class="learn-actions"><button class="btn primary" data-plan="new"><svg class="ico"><use href="#i-plus"/></svg> Nowy plan nauki</button></div>${list.map(planCardHtml).join("")}`;
}

function planCardHtml(p) {
  const done = p.days.filter((d) => d.done).length;
  const left = daysFromToday(p.examDate);
  const deck = p.deckId ? decks.decks.find((d) => d.id === p.deckId) : null;
  const ds = deck ? deckStats(deck) : null;
  const owner = prof.profiles.find((x) => x.id === p.profileId);
  const rows = p.days
    .map((d, i) => {
      const diff = daysFromToday(d.date);
      const titles = d.type === "mock" ? "cały materiał" : d.hashes.map((h) => (p.titles || {})[h]).filter(Boolean).join(", ") || "część materiału";
      const status = d.done
        ? `<span class="plan-ok"><svg><use href="#i-check"/></svg> ${pct(d.pct || 0)}</span><button class="btn ghost" data-plan="start" data-pid="${esc(p.id)}" data-day="${i}">Jeszcze raz</button>`
        : diff <= 0
          ? `<button class="btn ${diff === 0 ? "primary" : ""}" data-plan="start" data-pid="${esc(p.id)}" data-day="${i}">${diff < 0 ? "Nadrób" : "Zacznij"}</button>`
          : `<span class="muted small">czeka</span>`;
      return `<div class="plan-day ${diff === 0 ? "today" : ""} ${d.done ? "done" : ""}">
        <span class="pd-date">${fmtDay(d.date)}</span>
        <span class="pd-what">${d.type === "mock" ? '<svg><use href="#i-target"/></svg>' : '<svg><use href="#i-doc"/></svg>'}<span><b>${d.type === "mock" ? "Próbny sprawdzian" : `Kartkówka · ${p.perDay} zadań`}</b><small>${esc(titles)}</small></span></span>
        <span class="pd-status">${status}</span></div>`;
    })
    .join("");
  return `<div class="plan-card ${p.finished ? "finished" : ""}">
    <div class="plan-head">
      <div><b class="plan-title">${esc(p.title)}</b><div class="muted small">${owner ? `${esc(owner.name)} · ` : ""}sprawdzian: ${new Date(parseDay(p.examDate)).toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" })}${left > 0 ? ` (za ${left} ${plural(left, "dzień", "dni", "dni")})` : left === 0 ? " – dziś, powodzenia!" : ""}</div></div>
      <div class="plan-prog"><div class="mini-bar"><div style="width:${(done / p.days.length) * 100}%"></div></div><span class="muted small">${done} / ${p.days.length} dni</span></div>
      <button class="icon-btn" data-plan="delete" data-pid="${esc(p.id)}" title="Usuń plan"><svg><use href="#i-trash"/></svg></button>
    </div>
    ${p.finished ? `<div class="s-panel good"><div><b><svg><use href="#i-check-circle"/></svg> Plan wykonany</b><span>Wszystkie dni zaliczone – powodzenia na sprawdzianie.</span></div></div>` : ""}
    ${rows}
    ${deck ? `<div class="plan-day cards"><span class="pd-date">Codziennie</span><span class="pd-what"><svg><use href="#i-cards"/></svg><span><b>Fiszki · ${esc(deck.title)}</b><small>${ds.today ? `${ds.today} do powtórki dziś` : "na dziś wszystko powtórzone"} · opanowane ${ds.learned} z ${ds.total}</small></span></span><span class="pd-status"><button class="btn ${ds.today ? "primary" : "ghost"}" data-deck="study" data-did="${esc(deck.id)}">Powtórz</button></span></div>` : ""}
  </div>`;
}

function cardsTabHtml() {
  const list = decks.decks;
  const create = `<div class="plan-form">
      <h3>Nowe fiszki z materiału</h3>
      <p class="muted">AI wybierze najważniejsze pojęcia i definicje. Fiszki powtarzasz w odstępach – te, które sprawiają kłopot, wracają częściej, a opanowane rzadziej.</p>
      <label class="field-label">Z jakiego materiału?</label>${sourcePicker("cards-src")}
      <label class="field-label">Ile fiszek?</label><div class="segmented" id="cards-count"><button data-v="10">10</button><button data-v="15" class="active">15</button><button data-v="20">20</button><button data-v="25">25</button></div>
      <div class="modal-actions">${list.length ? `<button class="btn ghost" data-deck="cancel">Anuluj</button>` : ""}<button class="btn primary" data-deck="create" ${planUi.busy ? "disabled" : ""}>${planUi.busy ? `<span class="spinner small"></span> AI przygotowuje fiszki…` : "✨ Przygotuj fiszki"}</button></div>
    </div>`;
  if (planUi.editDeck) {
    const d = decks.decks.find((x) => x.id === planUi.editDeck);
    if (d)
      return `<div class="learn-actions"><button class="btn ghost" data-deck="back">← Wszystkie zestawy</button><input type="text" class="deck-title" data-did="${esc(d.id)}" value="${esc(d.title)}" /></div>
        <div class="deck-edit">${d.cards.map((c, i) => `<div class="deck-row" data-cid="${esc(c.id)}"><span class="muted">${i + 1}.</span><textarea data-side="front" rows="2">${esc(c.front)}</textarea><textarea data-side="back" rows="2">${esc(c.back)}</textarea><button class="icon-btn" data-deck="del-card" title="Usuń fiszkę"><svg><use href="#i-trash"/></svg></button></div>`).join("")}</div>
        <button class="add-q" data-deck="add-card"><svg class="ico"><use href="#i-plus"/></svg> Dodaj fiszkę</button>`;
  }
  if (planUi.creating || !list.length) return create;
  return `<div class="learn-actions"><button class="btn primary" data-deck="new"><svg class="ico"><use href="#i-plus"/></svg> Nowe fiszki z materiału</button><span class="muted small">Postęp liczy się osobno dla każdego profilu dziecka.</span></div>
    <div class="deck-grid">${list
      .map((d) => {
        const st = deckStats(d);
        return `<div class="deck-card"><b>${esc(d.title)}</b><div class="muted small">${[d.subject, `${st.total} fiszek`].filter(Boolean).map(esc).join(" · ")}</div>
          <div class="deck-bars"><div class="seg learned" style="flex:${st.learned}"></div><div class="seg learning" style="flex:${st.learning}"></div><div class="seg fresh" style="flex:${st.fresh}"></div></div>
          <div class="deck-legend"><span><i class="learned"></i>opanowane ${st.learned}</span><span><i class="learning"></i>w nauce ${st.learning}</span><span><i class="fresh"></i>nowe ${st.fresh}</span></div>
          <div class="deck-foot"><span class="${st.today ? "due" : "muted"} small">${st.today ? `${st.today} na dziś` : "na dziś gotowe ✓"}</span>
            <span><button class="icon-btn" data-deck="delete" data-did="${esc(d.id)}" title="Usuń zestaw"><svg><use href="#i-trash"/></svg></button><button class="btn ghost" data-deck="edit" data-did="${esc(d.id)}">Edytuj</button><button class="btn primary" data-deck="study" data-did="${esc(d.id)}">Ucz się</button></span></div></div>`;
      })
      .join("")}</div>`;
}

$("#learn-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ltab]");
  if (!b) return;
  planUi.tab = b.dataset.ltab;
  planUi.creating = false;
  planUi.editDeck = null;
  renderLearn();
});

$("#learn-body").addEventListener("change", (e) => {
  if (e.target.name === "plan-src" || e.target.name === "cards-src") planUi.source = e.target.value;
});
$("#learn-body").addEventListener("input", (e) => {
  const row = e.target.closest("[data-cid]");
  const d = decks.decks.find((x) => x.id === planUi.editDeck);
  if (e.target.classList.contains("deck-title") && d) {
    d.title = e.target.value;
    saveDecksSoon();
  }
  if (row && d && e.target.dataset.side) {
    const c = d.cards.find((x) => x.id === row.dataset.cid);
    if (c) c[e.target.dataset.side] = e.target.value;
    saveDecksSoon();
  }
});

$("#learn-body").addEventListener("click", async (e) => {
  const seg = e.target.closest(".segmented button");
  if (seg) {
    seg.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === seg));
    return;
  }
  const b = e.target.closest("[data-plan], [data-deck]");
  if (!b || b.disabled) return;
  const pa = b.dataset.plan, da = b.dataset.deck;
  if (pa === "new" || da === "new") planUi.creating = true;
  if (pa === "cancel" || da === "cancel") planUi.creating = false;
  if (pa === "create") return createPlanFromForm();
  if (pa === "start") return startPlanDay(b.dataset.pid, +b.dataset.day);
  if (pa === "delete") {
    if (!(await window.api.confirm("Usunąć plan nauki?", "Wyniki zostają w historii.", "Usuń"))) return;
    plans = plans.filter((p) => p.id !== b.dataset.pid);
    await savePlans();
  }
  if (da === "create") return createDeckFromForm();
  if (da === "study") return startStudy(b.dataset.did);
  if (da === "edit") planUi.editDeck = b.dataset.did;
  if (da === "back") planUi.editDeck = null;
  if (da === "delete") {
    const d = decks.decks.find((x) => x.id === b.dataset.did);
    if (!(await window.api.confirm(`Usunąć zestaw „${d.title}”?`, "Postęp nauki tego zestawu też zostanie usunięty.", "Usuń"))) return;
    decks.decks = decks.decks.filter((x) => x !== d);
    for (const p of Object.values(decks.progress)) for (const c of d.cards) delete p[c.id];
    await saveDecks();
  }
  if (da === "add-card" || da === "del-card") {
    const d = decks.decks.find((x) => x.id === planUi.editDeck);
    if (da === "add-card") d.cards.push({ id: newId("c"), front: "", back: "" });
    else d.cards = d.cards.filter((c) => c.id !== b.closest("[data-cid]").dataset.cid);
    await saveDecks();
  }
  renderLearn();
  if (da === "add-card") {
    const rows = document.querySelectorAll(".deck-row textarea[data-side=front]");
    rows[rows.length - 1]?.focus();
  }
});

async function createDeckFromForm() {
  const pages = pickedPages();
  const count = +($("#cards-count .active")?.dataset.v || 15);
  planUi.busy = true;
  renderLearn();
  try {
    const deck = await createDeck(pages, count);
    if (deck) {
      planUi.creating = false;
      toast(`Gotowe: ${deck.cards.length} fiszek „${deck.title}”.`);
    }
  } finally {
    planUi.busy = false;
    renderLearn();
  }
}

async function createPlanFromForm() {
  const examDate = $("#plan-date").value;
  const pages = pickedPages();
  if (!examDate) return toast("Wybierz datę sprawdzianu.", true);
  if (!pages.length) return toast("Najpierw dodaj zdjęcia stron w Materiale (AI musi je przeczytać).", true);
  const days = planDays(examDate, pages.map((p) => p.hash));
  if (!days) return toast("Data sprawdzianu musi być najwcześniej jutro.", true);
  const perDay = +($("#plan-per .active")?.dataset.v || 5);
  const withCards = $("#plan-cards").checked;
  const title = $("#plan-title").value.trim() || pages[0].analysis.title || "Plan nauki";
  planUi.busy = true;
  renderLearn();
  try {
    let deckId = null;
    if (withCards) {
      const same = decks.decks.find((d) => d.pageHashes && d.pageHashes.length === pages.length && pages.every((p) => d.pageHashes.includes(p.hash)));
      const deck = same || (await createDeck(pages, Math.min(25, 8 + pages.length * 4)));
      deckId = deck ? deck.id : null;
    }
    const plan = {
      id: newId("pl"),
      title,
      subject: state.settings.subject || "",
      examDate,
      createdAt: new Date().toISOString(),
      profileId: prof.active || null,
      perDay,
      titles: Object.fromEntries(pages.map((p) => [p.hash, p.analysis.title || p.name || ""])),
      deckId,
      days,
      finished: false,
    };
    for (const p of pages) if (!state.pages.includes(p)) virtualPages.set(p.hash, p);
    plans.push(plan);
    await savePlans();
    planUi.creating = false;
    toast(`Plan gotowy: ${days.length} ${plural(days.length, "dzień", "dni", "dni")} nauki do ${new Date(parseDay(examDate)).toLocaleDateString("pl-PL")}.`);
  } finally {
    planUi.busy = false;
    renderLearn();
    renderTodayCard();
  }
}

async function startPlanDay(planId, idx) {
  const plan = plans.find((p) => p.id === planId);
  const day = plan && plan.days[idx];
  if (!day) return;
  if (state.generating) return toast("AI jest teraz zajęte – spróbuj za chwilę.", true);
  const pages = await pagesByHash(day.hashes);
  if (!pages.length) return toast("Nie znaleziono odczytu stron z tego planu. Dodaj te strony ponownie w Materiale.", true);
  const wrongBefore = plan.days.slice(0, idx).flatMap((d) => d.wrong || []).slice(-8);
  const mock = day.type === "mock";
  const topic = mock ? plan.title : pages.map((p) => p.analysis.title).filter(Boolean).join(", ") || plan.title;
  const extra = wrongBefore.length
    ? `Uczeń mylił się wcześniej w pytaniach: ${wrongBefore.map((q) => `„${q}”`).join("; ")}. Sprawdź te zagadnienia innymi pytaniami`
    : state.settings.extra;
  closeDialog("dlg-learn");
  await generate({
    pages,
    settings: { count: mock ? Math.max(8, Math.min(12, plan.perDay * 2)) : plan.perDay, kind: mock ? "sprawdzian" : "kartkowka", figures: pages.every((p) => p.url) ? state.settings.figures : "brak", extra },
    title: `${mock ? "Próbny sprawdzian" : `Plan nauki – dzień ${idx + 1} z ${plan.days.length}`} – ${topic}`,
    done: () => {
      state.test.planRef = { planId, day: idx };
      resetSolve();
      state.view = "solve";
      renderPreview();
      $(".main").scrollTop = 0;
      syncUi();
    },
  });
}

/** Po zapisaniu wyniku (wywoływane z features.js): plan nauki, odznaki. */
async function afterHistory(entry, t) {
  if (t && t.planRef) {
    const plan = plans.find((p) => p.id === t.planRef.planId);
    const day = plan && plan.days[t.planRef.day];
    if (day) {
      const first = !day.done;
      day.done = true;
      day.pct = Math.max(day.pct || 0, entry.pct);
      day.historyId = entry.id;
      day.wrong = (entry.wrong || []).slice(0, 10);
      const all = plan.days.every((d) => d.done);
      if (all && !plan.finished) {
        plan.finished = true;
        logActivity("plan");
        toast("Plan nauki wykonany w całości. Powodzenia na sprawdzianie!", false, 9000);
      } else if (first) toast(`Dzień ${t.planRef.day + 1} z ${plan.days.length} planu nauki zaliczony.`, false, 6000);
      await savePlans();
      renderTodayCard();
    }
  }
  await checkBadges();
}

// ---------- „Dziś w planie” na ekranie startowym ----------
function todayTasks() {
  const out = [];
  for (const p of myPlans()) {
    if (p.finished) continue;
    p.days.forEach((d, i) => {
      if (!d.done && daysFromToday(d.date) <= 0) out.push({ plan: p, day: d, i });
    });
  }
  const dueCards = decks.decks.reduce((a, d) => a + deckStats(d).due, 0);
  return { plan: out, dueCards };
}
function renderTodayCard() {
  const el = $("#today-card");
  if (!el) return;
  const { plan, dueCards } = todayTasks();
  const p = activeProfile();
  const items = [
    ...plan.slice(0, 3).map((x) => `<button class="today-item" data-today-plan="${esc(x.plan.id)}" data-day="${x.i}"><span class="ti-ico">${x.day.type === "mock" ? '<svg><use href="#i-target"/></svg>' : '<svg><use href="#i-doc"/></svg>'}</span><span><b>${esc(x.plan.title)}</b><small>${x.day.type === "mock" ? "próbny sprawdzian" : "kartkówka dnia"}${daysFromToday(x.day.date) < 0 ? " · zaległa" : ""}</small></span><span class="go">Zacznij →</span></button>`),
    dueCards ? `<button class="today-item" data-today-cards><span class="ti-ico"><svg><use href="#i-cards"/></svg></span><span><b>Fiszki do powtórki</b><small>${dueCards} ${plural(dueCards, "fiszka", "fiszki", "fiszek")}</small></span><span class="go">Powtórz →</span></button>` : "",
  ].filter(Boolean);
  el.classList.toggle("hidden", !items.length);
  el.innerHTML = items.length ? `<div class="today-head"><svg><use href="#i-calendar"/></svg> Dziś w planie nauki${p ? ` – ${esc(p.name)}` : ""}</div><div class="today-items">${items.join("")}</div>` : "";
  const badge = $("#nav-learn-count");
  if (badge) {
    badge.textContent = items.length;
    badge.classList.toggle("hidden", !items.length);
  }
}
$("#today-card").addEventListener("click", (e) => {
  const pl = e.target.closest("[data-today-plan]");
  if (pl) return startPlanDay(pl.dataset.todayPlan, +pl.dataset.day);
  if (e.target.closest("[data-today-cards]")) {
    const d = decks.decks.find((x) => deckStats(x).due);
    if (d) startStudy(d.id);
  }
});

$("#btn-learn").addEventListener("click", () => openLearn());

// ================== menu, start ==================
const prevMenuExtra3 = onMenuExtra;
onMenuExtra = function (action, arg) {
  if (action === "library") return openLibrary();
  if (action === "profiles") return openProfiles();
  if (action === "learn") return openLearn();
  return prevMenuExtra3(action, arg);
};

(async function initLearning() {
  const [p, pl, dk] = await Promise.all([window.api.storeGet("profiles"), window.api.storeGet("plans"), window.api.storeGet("decks")]);
  prof = { profiles: [], active: null, activity: [], ...(p || {}) };
  plans = Array.isArray(pl) ? pl : [];
  decks = { decks: [], progress: {}, ...(dk || {}) };
  renderProfileChip();
  renderTodayCard();
  if (!state.solve.name && profileName() && !state.solve.finished) state.solve.name = profileName();
  const { plan } = todayTasks();
  if (plan.length) setTimeout(() => toast(`Dziś w planie nauki: ${plan[0].plan.title}. Zadanie czeka na ekranie „Nowy sprawdzian” i w sekcji Nauka.`, false, 8000), 1500);
})();
