const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ocr = require("./ocr");
const claude = require("./engines/claude");
const ollama = require("./engines/ollama");
const codex = require("./engines/codex");
const geminiFactory = require("./engines/gemini");

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
    backgroundColor: "#f6f7f9",
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
        { label: "Otwórz sprawdzian…", accelerator: "CmdOrCtrl+O", click: act("open") },
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
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

ipcMain.handle("test:cancel", () => {
  if (genCtl) genCtl.abort();
  return true;
});

ipcMain.handle("ocr:recognize", async (_e, imageBuffer) => {
  try {
    return { ok: true, data: await ocr.recognize(imageBuffer) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "Nie udało się rozpoznać tekstu: " + (err && err.message ? err.message : String(err)) };
  }
});

// ================== pliki ==================
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", bmp: "image/bmp", gif: "image/gif" };

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
    filters: [{ name: "Zdjęcia", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
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
