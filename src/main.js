const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ocr = require("./ocr");
const claude = require("./engines/claude");
const ollama = require("./engines/ollama");
const codex = require("./engines/codex");
const geminiFactory = require("./engines/gemini");
const { buildGradePrompt, GRADE_SCHEMA, buildExplainPrompt, EXPLAIN_SCHEMA, buildCardsPrompt, CARDS_SCHEMA, buildPaperPrompt, PAPER_SCHEMA } = require("./engines/common");
const remote = require("./remote");

app.setName("Generator sprawdzianów");

// ================== konfiguracja ==================
const CONFIG_PATH = () => path.join(app.getPath("userData"), "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), "utf8");
}

// ================== silniki AI ==================
const ENGINES = {
  "claude-sonnet": { label: "Claude Sonnet", hint: "subskrypcja Claude Pro/Max · szybki", kind: "claude", imageEdge: 1568, concurrency: 3, secPerPage: 25, secPerTask: 4 },
  "claude-opus": { label: "Claude Opus", hint: "subskrypcja Claude Pro/Max · najdokładniejszy", kind: "claude", imageEdge: 1568, concurrency: 2, secPerPage: 45, secPerTask: 8 },
  codex: { label: "Codex (ChatGPT)", hint: "subskrypcja ChatGPT · szybki", kind: "codex", imageEdge: 1568, concurrency: 2, secPerPage: 35, secPerTask: 6 },
  gemini: { label: "Google Gemini", hint: "DARMOWY klucz z Google AI Studio · dzienny limit", kind: "gemini", imageEdge: 1568, concurrency: 1, secPerPage: 20, secPerTask: 4 },
  ollama: { label: "Model lokalny", hint: "darmowy, offline · szybki tylko z kartą graficzną", kind: "ollama", imageEdge: 1024, concurrency: 1, secPerPage: 720, secPerTask: 90 },
};

// ---------- klucz Gemini (szyfrowany przez system) ----------
function geminiKey() {
  const enc = readConfig().geminiKey;
  if (!enc) return process.env.GEMINI_API_KEY || "";
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, "base64")) : Buffer.from(enc, "base64").toString("utf8");
  } catch {
    return "";
  }
}
function saveGeminiKey(key) {
  const cfg = readConfig();
  if (!key) delete cfg.geminiKey;
  else cfg.geminiKey = (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, "utf8")).toString("base64");
  writeConfig(cfg);
}
const gemini = geminiFactory.makeEngine(geminiKey);
const IMPL = { claude, codex, gemini, ollama };

function engineId() {
  const id = readConfig().engine;
  if (ENGINES[id]) return id;
  if (claude.status().installed) return "claude-sonnet";
  if (codex.status().installed) return "codex";
  if (geminiKey()) return "gemini";
  return "ollama";
}

function engineAvailability() {
  return {
    claude: { installed: claude.status().installed, path: claude.status().path },
    codex: { installed: codex.status().installed, path: codex.status().path },
    gemini: { installed: Boolean(geminiKey()) },
  };
}

async function engineStatus() {
  const id = engineId();
  const e = ENGINES[id];
  const base = { engine: id, label: e.label, hint: e.hint, kind: e.kind, imageEdge: e.imageEdge, secPerPage: e.secPerPage, secPerTask: e.secPerTask, firstRun: !readConfig().engine, available: engineAvailability() };
  if (e.kind === "claude" || e.kind === "codex") {
    const s = IMPL[e.kind].status();
    return { ...base, installed: s.installed, server: true, model: true, ready: s.installed };
  }
  if (e.kind === "gemini") {
    const has = Boolean(geminiKey());
    return { ...base, installed: has, server: true, model: true, ready: has };
  }
  const s = await ollama.status();
  return { ...base, ...s, ready: s.installed && s.server && s.model };
}

function setEngine(id) {
  if (!ENGINES[id]) return;
  writeConfig({ ...readConfig(), engine: id });
  buildMenu();
  send("ai:engineChanged", id);
  pump();
}

// ================== motyw (jasny / ciemny / systemowy) ==================
const THEMES = { system: "Jak w systemie", light: "Jasny", dark: "Ciemny" };
function applyTheme() {
  const t = readConfig().theme;
  nativeTheme.themeSource = THEMES[t] ? t : "system";
}
function setTheme(t) {
  if (!THEMES[t]) return;
  writeConfig({ ...readConfig(), theme: t });
  applyTheme();
  buildMenu();
}

// ================== aktualizacje (GitHub Releases) ==================
let updater = null;
let updateManual = false;
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch (e) {
    console.error("electron-updater", e);
    return;
  }
  updater.autoDownload = true; // nowa wersja pobiera się w tle…
  updater.autoInstallOnAppQuit = true; // …i instaluje przy zamknięciu programu
  updater.on("update-available", (info) => send("update:status", { state: "downloading", version: info.version, percent: 0 }));
  updater.on("update-not-available", () => updateManual && send("update:status", { state: "none", version: app.getVersion() }));
  updater.on("download-progress", (p) => send("update:status", { state: "downloading", percent: Math.round(p.percent || 0) }));
  updater.on("update-downloaded", (info) => send("update:status", { state: "ready", version: info.version }));
  updater.on("error", (e) => {
    console.error("aktualizacja", e);
    if (updateManual) send("update:status", { state: "error", message: "Nie udało się sprawdzić aktualizacji. Sprawdź połączenie z internetem." });
  });
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 6000);
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
}
function checkUpdatesManually() {
  if (!updater) return send("update:status", { state: "dev", version: app.getVersion() });
  updateManual = true;
  send("update:status", { state: "checking" });
  updater.checkForUpdates().catch(() => {});
}
ipcMain.handle("update:check", () => checkUpdatesManually());
ipcMain.handle("update:install", () => {
  if (updater) setImmediate(() => updater.quitAndInstall(true, true));
  return true;
});
ipcMain.handle("app:version", () => app.getVersion());

// ================== rozwiązywanie na tablecie (sieć domowa + kod QR) ==================
const pendingSubmits = new Map();
remote.setHandlers(
  (payload) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomBytes(8).toString("hex");
      const timer = setTimeout(() => (pendingSubmits.delete(id), reject(new Error("timeout"))), 15000);
      pendingSubmits.set(id, (result) => (clearTimeout(timer), pendingSubmits.delete(id), resolve(result)));
      send("remote:submission", { id, ...payload });
    }),
  (event) => send("remote:event", event)
);
ipcMain.handle("remote:result", (_e, { id, result }) => {
  const done = pendingSubmits.get(id);
  if (done) done(result);
  return true;
});
ipcMain.handle("remote:start", async (_e, payload) => {
  try {
    const { url, others } = await remote.start(payload && payload.test ? payload.test : payload, payload && payload.key);
    const qr = await require("qrcode").toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M", color: { dark: "#0f172a", light: "#ffffff" } });
    return { ok: true, url, others, qr };
  } catch (err) {
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  }
});
ipcMain.handle("remote:stop", () => {
  remote.stop();
  return true;
});

// ================== historia wyników ==================
const HISTORY_PATH = () => path.join(app.getPath("userData"), "historia.json");
function readHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_PATH(), "utf8"));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}
function writeHistory(h) {
  fs.mkdirSync(path.dirname(HISTORY_PATH()), { recursive: true });
  fs.writeFileSync(HISTORY_PATH(), JSON.stringify(h.slice(-500), null, 1), "utf8");
}
ipcMain.handle("history:list", () => readHistory());
ipcMain.handle("history:save", (_e, entry) => {
  if (!entry || typeof entry.id !== "string") return false;
  const h = readHistory();
  const i = h.findIndex((x) => x.id === entry.id);
  if (i >= 0) h[i] = entry;
  else h.push(entry);
  writeHistory(h);
  return true;
});
ipcMain.handle("history:delete", (_e, id) => {
  writeHistory(readHistory().filter((x) => x.id !== id));
  return true;
});
ipcMain.handle("history:clear", async () => {
  const { response } = await dialog.showMessageBox(win, { type: "warning", buttons: ["Usuń całą historię", "Anuluj"], defaultId: 1, cancelId: 1, title: "Historia wyników", message: "Usunąć całą historię wyników?", detail: "Tej operacji nie można cofnąć." });
  if (response !== 0) return false;
  writeHistory([]);
  return true;
});

// ================== dane nauki: profile dzieci, plany nauki, fiszki ==================
function jsonFile(name, fallback) {
  const p = () => path.join(app.getPath("userData"), name);
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(p(), "utf8"));
      } catch {
        return fallback();
      }
    },
    write(v) {
      fs.mkdirSync(path.dirname(p()), { recursive: true });
      fs.writeFileSync(p() + ".tmp", JSON.stringify(v), "utf8");
      fs.renameSync(p() + ".tmp", p());
    },
  };
}
const STORES = {
  profiles: jsonFile("profile.json", () => ({ profiles: [], active: null, activity: [] })),
  plans: jsonFile("plany.json", () => []),
  decks: jsonFile("fiszki.json", () => ({ decks: [], progress: {} })),
};
ipcMain.handle("store:get", (_e, name) => (STORES[name] ? STORES[name].read() : null));
ipcMain.handle("store:set", (_e, name, value) => {
  if (!STORES[name] || value == null || typeof value !== "object") return false;
  if (name === "profiles" && Array.isArray(value.activity)) value.activity = value.activity.slice(-3000);
  STORES[name].write(value);
  return true;
});

// ================== biblioteka sprawdzianów (zapis automatyczny) i obrazy stron ==================
const TESTS_DIR = () => path.join(app.getPath("userData"), "sprawdziany");
const IMG_DIR = () => path.join(app.getPath("userData"), "strony");
const SAFE_ID = /^[a-z0-9_-]{1,64}$/i;
const testsIndex = jsonFile(path.join("sprawdziany", "index.json"), () => []);

ipcMain.handle("tests:list", () => testsIndex.read());
ipcMain.handle("tests:save", (_e, { meta, data }) => {
  if (!meta || !SAFE_ID.test(meta.id) || typeof data !== "string") return false;
  fs.mkdirSync(TESTS_DIR(), { recursive: true });
  fs.writeFileSync(path.join(TESTS_DIR(), meta.id + ".json"), data, "utf8");
  const idx = testsIndex.read().filter((x) => x.id !== meta.id);
  idx.push(meta);
  testsIndex.write(idx);
  return true;
});
ipcMain.handle("tests:load", (_e, id) => {
  if (!SAFE_ID.test(id)) return null;
  try {
    return fs.readFileSync(path.join(TESTS_DIR(), id + ".json"), "utf8");
  } catch {
    return null;
  }
});
ipcMain.handle("tests:delete", (_e, ids) => {
  ids = (Array.isArray(ids) ? ids : [ids]).filter((id) => SAFE_ID.test(id));
  for (const id of ids) fs.rmSync(path.join(TESTS_DIR(), id + ".json"), { force: true });
  const idx = testsIndex.read().filter((x) => !ids.includes(x.id));
  testsIndex.write(idx);
  // obrazy stron, do których nie odwołuje się już żaden sprawdzian
  const used = new Set(idx.flatMap((x) => x.pageHashes || []));
  try {
    for (const f of fs.readdirSync(IMG_DIR())) if (!used.has(f.replace(/\.jpg$/, ""))) fs.rmSync(path.join(IMG_DIR(), f), { force: true });
  } catch {}
  return true;
});
ipcMain.handle("pageimg:missing", (_e, hashes) => (hashes || []).filter((h) => SAFE_ID.test(h) && !fs.existsSync(path.join(IMG_DIR(), h + ".jpg"))));
ipcMain.handle("pageimg:put", (_e, hash, b64) => {
  if (!SAFE_ID.test(hash) || typeof b64 !== "string") return false;
  fs.mkdirSync(IMG_DIR(), { recursive: true });
  fs.writeFileSync(path.join(IMG_DIR(), hash + ".jpg"), Buffer.from(b64, "base64"));
  return true;
});
ipcMain.handle("pageimg:get", (_e, hashes) =>
  (hashes || [])
    .filter((h) => SAFE_ID.test(h))
    .map((h) => {
      try {
        return { hash: h, url: "data:image/jpeg;base64," + fs.readFileSync(path.join(IMG_DIR(), h + ".jpg")).toString("base64") };
      } catch {
        return { hash: h, url: null };
      }
    }));
// odczyty stron z biblioteki stron (tekst) – do planu nauki i fiszek, gdy strony nie są otwarte w programie
ipcMain.handle("library:get", (_e, hashes) => (hashes || []).map((h) => ({ hash: h, analysis: libGet(h) })));

ipcMain.handle("file:saveText", async (_e, { defaultName, ext, filterName, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Zapisz plik",
    defaultPath: path.join(app.getPath("documents"), sanitize(defaultName) + "." + ext),
    filters: [{ name: filterName || ext.toUpperCase(), extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, (ext === "csv" ? "﻿" : "") + content, "utf8");
  return { ok: true, filePath };
});

// ================== okno ==================
let win;
let uiState = { view: "test", showPoints: true, showLines: true, showSummary: true, hasTest: false, busy: false };

function send(channel, ...args) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: "Generator sprawdzianów",
    backgroundColor: "#f3f4f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  buildMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // narzędzia deweloperskie tylko w trybie deweloperskim (inaczej dałoby się podejrzeć klucz)
  if (process.env.GENERATOR_DEV !== "1") win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
}

// ================== menu aplikacji ==================
function buildMenu() {
  const act = (action, arg) => () => send("menu", action, arg);
  const id = engineId();
  const hasTest = uiState.hasTest;
  const template = [
    {
      label: "&Plik",
      submenu: [
        { label: "Nowy sprawdzian", accelerator: "CmdOrCtrl+N", click: act("new") },
        { label: "Biblioteka sprawdzianów…", accelerator: "CmdOrCtrl+B", click: act("library") },
        { label: "Otwórz sprawdzian z pliku…", accelerator: "CmdOrCtrl+O", click: act("open") },
        { label: "Zapisz sprawdzian…", accelerator: "CmdOrCtrl+S", enabled: hasTest, click: act("save") },
        { type: "separator" },
        { label: "Materiał – strony podręcznika…", accelerator: "CmdOrCtrl+M", click: act("material") },
        { label: "Dodaj zdjęcia stron…", accelerator: "CmdOrCtrl+I", click: act("addPhotos") },
        { label: "Dodaj folder ze zdjęciami…", accelerator: "CmdOrCtrl+Shift+I", click: act("addFolder") },
        { type: "separator" },
        { label: "Eksportuj sprawdzian do PDF…", accelerator: "CmdOrCtrl+E", enabled: hasTest, click: act("pdf", "test") },
        { label: "Eksportuj klucz odpowiedzi do PDF…", enabled: hasTest, click: act("pdf", "key") },
        { label: "Drukuj…", accelerator: "CmdOrCtrl+P", enabled: hasTest, click: act("print") },
        { type: "separator" },
        { label: "Zakończ", role: "quit" },
      ],
    },
    {
      label: "&Edycja",
      submenu: [
        { label: "Cofnij", role: "undo" },
        { label: "Ponów", role: "redo" },
        { type: "separator" },
        { label: "Wytnij", role: "cut" },
        { label: "Kopiuj", role: "copy" },
        { label: "Wklej", role: "paste" },
        { label: "Zaznacz wszystko", role: "selectAll" },
        { type: "separator" },
        { label: "Ustawienia sprawdzianu…", accelerator: "CmdOrCtrl+,", click: act("settings") },
        { label: "Dodaj zadanie", accelerator: "CmdOrCtrl+Shift+N", enabled: hasTest, click: act("addTask") },
        { label: "Generuj sprawdzian", accelerator: "CmdOrCtrl+G", enabled: !uiState.busy, click: act("generate") },
      ],
    },
    {
      label: "&Widok",
      submenu: [
        { label: "Sprawdzian (druk i edycja)", type: "radio", checked: uiState.view === "test", accelerator: "CmdOrCtrl+1", click: act("view", "test") },
        { label: "Klucz odpowiedzi (hasło)", type: "radio", checked: uiState.view === "key", accelerator: "CmdOrCtrl+2", click: act("view", "key") },
        { label: "Rozwiąż na komputerze", type: "radio", checked: uiState.view === "solve", accelerator: "CmdOrCtrl+3", click: act("view", "solve") },
        { type: "separator" },
        { label: "Punktacja przy zadaniach", type: "checkbox", checked: uiState.showPoints, click: act("toggle", "showPoints") },
        { label: "Linie na odpowiedź", type: "checkbox", checked: uiState.showLines, click: act("toggle", "showLines") },
        { label: "Podsumowanie na końcu", type: "checkbox", checked: uiState.showSummary, click: act("toggle", "showSummary") },
        { type: "separator" },
        {
          label: "Motyw",
          submenu: Object.entries(THEMES).map(([key, label]) => ({ label, type: "radio", checked: (readConfig().theme || "system") === key, click: () => setTheme(key) })),
        },
        { type: "separator" },
        { label: "Powiększ", role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { label: "Pomniejsz", role: "zoomOut" },
        { label: "Rzeczywisty rozmiar", role: "resetZoom" },
        { label: "Pełny ekran", role: "togglefullscreen" },
      ],
    },
    {
      label: "&Narzędzia",
      submenu: [
        {
          label: "Silnik AI",
          submenu: [
            ...Object.entries(ENGINES).map(([key, e]) => ({
              label: `${e.label} – ${e.hint}`,
              type: "radio",
              checked: key === id,
              enabled: e.kind === "ollama" || (engineAvailability()[e.kind] || {}).installed,
              click: () => setEngine(key),
            })),
            { type: "separator" },
            { label: "Konfiguracja silników AI…", click: act("engineSetup") },
          ],
        },
        { type: "separator" },
        { label: "Profile dzieci i odznaki…", click: act("profiles") },
        { label: "Historia wyników…", accelerator: "CmdOrCtrl+H", click: act("history") },
        { label: "Nauka: plan i fiszki…", accelerator: "CmdOrCtrl+L", click: act("learn") },
        { type: "separator" },
        { label: "Quiz-gra z tego sprawdzianu", accelerator: "CmdOrCtrl+J", enabled: hasTest, click: act("quiz") },
        { label: "Sprawdź kartkę ze zdjęcia…", accelerator: "CmdOrCtrl+K", enabled: hasTest, click: act("paper") },
        { label: "Grupa B sprawdzianu…", enabled: hasTest, click: act("groupB") },
        { label: "Rozwiąż na tablecie lub telefonie…", accelerator: "CmdOrCtrl+T", enabled: hasTest, click: act("tablet") },
        { label: "Tryb klasy – wiele tabletów…", enabled: hasTest, click: act("class") },
        { type: "separator" },
        { label: "Zmień hasło rodzica…", click: act("changePassword") },
        { type: "separator" },
        { label: "Otwórz folder biblioteki stron", click: () => shell.openPath((fs.mkdirSync(LIB_DIR(), { recursive: true }), LIB_DIR())) },
        { label: "Wyczyść bibliotekę stron…", click: clearLibrary },
      ],
    },
    {
      label: "Po&moc",
      submenu: [
        { label: "Jak korzystać", accelerator: "F1", click: act("help") },
        { label: "Sprawdź aktualizacje…", click: checkUpdatesManually },
        {
          label: "O programie",
          click: () =>
            dialog.showMessageBox(win, {
              type: "info",
              title: "O programie",
              message: "Generator sprawdzianów",
              detail: `Sprawdziany i kartkówki ze zdjęć stron podręcznika.\n\nSilnik AI: ${ENGINES[id].label} (${ENGINES[id].hint}).\nClaude Code: ${claude.status().path || "nie znaleziono"}\nCodex: ${codex.status().path || "nie znaleziono"}\nBiblioteka stron: ${LIB_DIR()}\n\nWersja ${app.getVersion()}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on("ui:state", (_e, s) => {
  uiState = { ...uiState, ...s };
  buildMenu();
});

app.whenReady().then(() => {
  applyTheme();
  createWindow();
  setupUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  remote.stop();
  queue.length = 0;
  for (const r of inflight.values()) r.ctl.abort();
  if (genCtl) genCtl.abort();
  ocr.shutdown().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});

// ================== hasło rodzica do klucza odpowiedzi ==================
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}

ipcMain.handle("key:status", () => ({ hasPassword: Boolean(readConfig().keyPassword) }));

ipcMain.handle("key:verify", (_e, pw) => {
  const kp = readConfig().keyPassword;
  if (!kp) return false;
  const h = Buffer.from(hashPassword(pw, kp.salt), "hex");
  return crypto.timingSafeEqual(h, Buffer.from(kp.hash, "hex"));
});

ipcMain.handle("key:setPassword", (_e, { oldPw, newPw }) => {
  const cfg = readConfig();
  if (cfg.keyPassword) {
    const h = Buffer.from(hashPassword(oldPw || "", cfg.keyPassword.salt), "hex");
    if (!crypto.timingSafeEqual(h, Buffer.from(cfg.keyPassword.hash, "hex"))) return { ok: false, error: "Obecne hasło jest nieprawidłowe." };
  }
  if (!newPw || String(newPw).length < 4) return { ok: false, error: "Hasło musi mieć co najmniej 4 znaki." };
  const salt = crypto.randomBytes(16).toString("hex");
  cfg.keyPassword = { salt, hash: hashPassword(newPw, salt) };
  writeConfig(cfg);
  return { ok: true };
});

ipcMain.handle("prefs:get", () => readConfig().prefs || {});

ipcMain.handle("prefs:save", (_e, prefs) => {
  const cfg = readConfig();
  cfg.prefs = prefs;
  writeConfig(cfg);
  return true;
});

// ================== silnik AI: status, wybór, pobranie modelu lokalnego ==================
ipcMain.handle("ai:status", () => engineStatus());
ipcMain.handle("ai:setEngine", (_e, id) => {
  setEngine(id);
  return engineStatus();
});
ipcMain.handle("ai:engines", () => {
  const av = engineAvailability();
  return Object.entries(ENGINES).map(([id, e]) => ({ id, ...e, available: e.kind === "ollama" || (av[e.kind] || {}).installed }));
});
ipcMain.handle("ai:availability", async () => ({ ...engineAvailability(), ollama: await ollama.status() }));
ipcMain.handle("ai:setGeminiKey", async (_e, key) => {
  key = String(key || "").trim();
  if (!key) {
    saveGeminiKey("");
    return { ok: true };
  }
  const res = await gemini.check(key);
  if (res.ok) saveGeminiKey(key);
  return res;
});

ipcMain.handle("ai:pull", async () => {
  try {
    await ollama.pullModel((p) => send("ai:pullProgress", p));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ================== biblioteka stron: każde zdjęcie czytane raz, w tle, wynik zapamiętany na dysku ==================
const LIB_DIR = () => path.join(app.getPath("userData"), "library");
const libFile = (hash) => path.join(LIB_DIR(), hash.replace(/[^a-z0-9_-]/gi, "") + ".json");
function libGet(hash) {
  try {
    return JSON.parse(fs.readFileSync(libFile(hash), "utf8"));
  } catch {
    return null;
  }
}
function libSet(hash, data) {
  fs.mkdirSync(LIB_DIR(), { recursive: true });
  fs.writeFileSync(libFile(hash), JSON.stringify(data), "utf8");
}

async function clearLibrary() {
  const r = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Wyczyść", "Anuluj"],
    defaultId: 1,
    cancelId: 1,
    title: "Biblioteka stron",
    message: "Usunąć zapamiętane odczyty wszystkich stron?",
    detail: "Strony trzeba będzie przeczytać ponownie. Zdjęcia na dysku i zapisane sprawdziany nie zostaną usunięte.",
  });
  if (r.response !== 0) return;
  fs.rmSync(LIB_DIR(), { recursive: true, force: true });
  send("library:cleared");
}

const queue = []; // {hash, name, image, width, height}
const inflight = new Map(); // hash → {ctl, item}
let generating = 0;

function emitLib(update) {
  send("library:update", update);
}

function pump() {
  const id = engineId();
  const e = ENGINES[id];
  // model lokalny zajmuje cały procesor – podczas układania sprawdzianu nie czytamy stron
  if (e.kind === "ollama" && generating) return;
  while (queue.length && inflight.size < e.concurrency) {
    const item = queue.shift();
    const ctl = new AbortController();
    inflight.set(item.hash, { ctl, item });
    emitLib({ hash: item.hash, status: "reading", tokens: 0 });
    IMPL[e.kind]
      .readPage({
        imageB64: item.image,
        width: item.width,
        height: item.height,
        engine: id,
        signal: ctl.signal,
        onProgress: (p) => emitLib({ hash: item.hash, status: "reading", tokens: p.tokens }),
      })
      .then((data) => {
        data.name = item.name;
        data.engine = id;
        data.readAt = new Date().toISOString();
        libSet(item.hash, data);
        emitLib({ hash: item.hash, status: "done", data });
      })
      .catch((err) => {
        if (ctl.signal.aborted) {
          if (!item.removed) {
            queue.push(item); // przerwane – wróci do kolejki
            emitLib({ hash: item.hash, status: "queued" });
          }
        } else {
          console.error("readPage", err);
          emitLib({ hash: item.hash, status: "error", error: String(err.message || err) });
        }
      })
      .finally(() => {
        inflight.delete(item.hash);
        pump();
      });
  }
}

ipcMain.handle("library:enqueue", (_e, pages) => {
  for (const p of pages) {
    const cached = libGet(p.hash);
    if (cached) {
      emitLib({ hash: p.hash, status: "done", data: cached });
      continue;
    }
    if (inflight.has(p.hash) || queue.some((q) => q.hash === p.hash)) continue;
    queue.push({ hash: p.hash, name: p.name, image: p.image, width: p.width, height: p.height });
    emitLib({ hash: p.hash, status: "queued" });
  }
  pump();
  return true;
});

ipcMain.handle("library:retry", (_e, page) => {
  if (inflight.has(page.hash) || queue.some((q) => q.hash === page.hash)) return true;
  queue.unshift({ hash: page.hash, name: page.name, image: page.image, width: page.width, height: page.height });
  emitLib({ hash: page.hash, status: "queued" });
  pump();
  return true;
});

ipcMain.handle("library:prioritize", (_e, hashes) => {
  const set = new Set(hashes);
  queue.sort((a, b) => (set.has(b.hash) ? 1 : 0) - (set.has(a.hash) ? 1 : 0));
  // przy modelu lokalnym (jedna strona naraz) przerwij czytanie strony spoza wybranych
  if (ENGINES[engineId()].kind === "ollama")
    for (const [h, r] of inflight) if (!set.has(h) && queue.some((q) => set.has(q.hash))) r.ctl.abort();
  pump();
  return true;
});

ipcMain.handle("library:remove", (_e, hash) => {
  const i = queue.findIndex((q) => q.hash === hash);
  if (i >= 0) queue.splice(i, 1);
  const r = inflight.get(hash);
  if (r) {
    r.item.removed = true;
    r.ctl.abort();
  }
  return true;
});

ipcMain.handle("library:forget", (_e, hash) => {
  try {
    fs.unlinkSync(libFile(hash));
  } catch {}
  return true;
});

// ================== układanie sprawdzianu ==================
let genCtl = null;

ipcMain.handle("test:generate", async (event, payload) => {
  const id = engineId();
  const e = ENGINES[id];
  generating++;
  genCtl = new AbortController();
  if (e.kind === "ollama") for (const r of inflight.values()) r.ctl.abort(); // procesor potrzebny do układania zadań
  const reply = (ch, data) => !event.sender.isDestroyed() && event.sender.send(ch, data);
  try {
    const res = await IMPL[e.kind].generateTest({
      ...payload,
      engine: id,
      signal: genCtl.signal,
      onTask: (task, index) => reply("test:task", { task, index }),
      onProgress: (p) => reply("test:progress", p),
    });
    return { ok: true, ...res };
  } catch (err) {
    if (genCtl && genCtl.signal.aborted) return { ok: false, error: "Anulowano." };
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  } finally {
    genCtl = null;
    generating--;
    pump();
  }
});

/** Jedno zapytanie do silnika AI z odpowiedzią w JSON (ocena, wyjaśnienia, fiszki, odczyt kartki). */
async function askAi({ prompt, schema, images }) {
  const id = engineId();
  const e = ENGINES[id];
  if (!IMPL[e.kind].ask) return { ok: false, error: "Ten silnik nie obsługuje tej funkcji." };
  const ctl = new AbortController();
  genCtl = ctl;
  generating++;
  try {
    return { ok: true, data: await IMPL[e.kind].ask({ prompt, schema, images, engine: id, signal: ctl.signal }) };
  } catch (err) {
    if (ctl.signal.aborted) return { ok: false, error: "Anulowano." };
    console.error(err);
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (genCtl === ctl) genCtl = null;
    generating--;
    pump();
  }
}

ipcMain.handle("ai:gradeOpen", async (_e, { items, settings }) => {
  const res = await askAi({ prompt: buildGradePrompt(items, settings || {}), schema: GRADE_SCHEMA });
  return res.ok ? { ok: true, grades: Array.isArray(res.data && res.data.grades) ? res.data.grades : [] } : res;
});

const AI_TASKS = {
  explain: (d) => ({ prompt: buildExplainPrompt(d), schema: EXPLAIN_SCHEMA }),
  cards: (d) => ({ prompt: buildCardsPrompt(d), schema: CARDS_SCHEMA }),
  paper: (d) => ({ prompt: buildPaperPrompt(d), schema: PAPER_SCHEMA, images: (d.images || []).filter((x) => typeof x === "string").slice(0, 8) }),
};
ipcMain.handle("ai:task", async (_e, task, data) => {
  if (!AI_TASKS[task]) return { ok: false, error: "Nieznane zadanie." };
  return askAi(AI_TASKS[task](data || {}));
});

ipcMain.handle("test:cancel", () => {
  if (genCtl) genCtl.abort();
  return true;
});

ipcMain.handle("ocr:recognize", async (_e, imageBuffer, opts) => {
  try {
    return { ok: true, data: await ocr.recognize(imageBuffer, opts) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "Nie udało się rozpoznać tekstu: " + (err && err.message ? err.message : String(err)) };
  }
});

// ================== pliki ==================
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|pdf)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", bmp: "image/bmp", gif: "image/gif", pdf: "application/pdf" };

function readImages(paths, max) {
  return paths.slice(0, max).map((p) => ({
    name: path.basename(p),
    type: MIME[p.split(".").pop().toLowerCase()] || "image/jpeg",
    data: fs.readFileSync(p),
  }));
}

ipcMain.handle("images:pickFolder", async (_e, { max }) => {
  const cfg = readConfig();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Wybierz folder ze zdjęciami stron",
    defaultPath: cfg.lastFolder && fs.existsSync(cfg.lastFolder) ? cfg.lastFolder : app.getPath("pictures"),
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const dir = filePaths[0];
  writeConfig({ ...readConfig(), lastFolder: dir });
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile());
  const collator = new Intl.Collator("pl", { numeric: true, sensitivity: "base" });
  const images = entries.map((d) => d.name).filter((n) => IMAGE_EXT.test(n)).sort(collator.compare);
  const heic = entries.filter((d) => /\.(heic|heif)$/i.test(d.name)).length;
  return { ok: true, folder: path.basename(dir), files: readImages(images.map((n) => path.join(dir, n)), max), total: images.length, heic };
});

ipcMain.handle("images:pickFiles", async (_e, { max }) => {
  const cfg = readConfig();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Wybierz zdjęcia stron",
    defaultPath: cfg.lastFolder && fs.existsSync(cfg.lastFolder) ? cfg.lastFolder : app.getPath("pictures"),
    filters: [{ name: "Zdjęcia stron i PDF", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif", "pdf"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  writeConfig({ ...readConfig(), lastFolder: path.dirname(filePaths[0]) });
  return { ok: true, files: readImages(filePaths, max), total: filePaths.length };
});

ipcMain.handle("pdf:save", async (event, { defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Zapisz PDF",
    defaultPath: path.join(app.getPath("documents"), sanitize(defaultName) + ".pdf"),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const data = await event.sender.printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(filePath, data);
  shell.openPath(filePath);
  return { ok: true, filePath };
});

ipcMain.handle("print", (event) => {
  return new Promise((resolve) => {
    event.sender.print({ printBackground: true }, (success, reason) => resolve({ ok: success, reason }));
  });
});

ipcMain.handle("project:save", async (_e, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Zapisz sprawdzian",
    defaultPath: path.join(app.getPath("documents"), sanitize(defaultName) + ".sprawdzian.json"),
    filters: [{ name: "Sprawdzian", extensions: ["json"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, data, "utf8");
  return { ok: true, filePath };
});

ipcMain.handle("project:open", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Otwórz sprawdzian",
    defaultPath: app.getPath("documents"),
    filters: [{ name: "Sprawdzian", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return { ok: true, data: fs.readFileSync(filePaths[0], "utf8") };
});

ipcMain.handle("confirm", async (_e, { message, detail, ok = "OK" }) => {
  const r = await dialog.showMessageBox(win, { type: "question", buttons: [ok, "Anuluj"], defaultId: 0, cancelId: 1, message, detail });
  return r.response === 0;
});

function sanitize(name) {
  return (name || "sprawdzian").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}
