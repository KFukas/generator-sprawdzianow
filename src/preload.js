const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (cb) => {
  const listener = (_e, ...data) => cb(...data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("api", {
  // menu aplikacji i stan interfejsu (zaznaczenia w menu)
  onMenu: listen("menu"),
  setUiState: (s) => ipcRenderer.send("ui:state", s),
  confirm: (message, detail, ok) => ipcRenderer.invoke("confirm", { message, detail, ok }),
  // hasło rodzica
  keyStatus: () => ipcRenderer.invoke("key:status"),
  keyVerify: (pw) => ipcRenderer.invoke("key:verify", pw),
  keySetPassword: (oldPw, newPw) => ipcRenderer.invoke("key:setPassword", { oldPw, newPw }),
  // ustawienia
  getPrefs: () => ipcRenderer.invoke("prefs:get"),
  savePrefs: (prefs) => ipcRenderer.invoke("prefs:save", prefs),
  // silnik AI
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  aiEngines: () => ipcRenderer.invoke("ai:engines"),
  aiAvailability: () => ipcRenderer.invoke("ai:availability"),
  aiSetGeminiKey: (key) => ipcRenderer.invoke("ai:setGeminiKey", key),
  aiSetEngine: (id) => ipcRenderer.invoke("ai:setEngine", id),
  onEngineChanged: listen("ai:engineChanged"),
  aiPull: () => ipcRenderer.invoke("ai:pull"),
  onPullProgress: listen("ai:pullProgress"),
  // biblioteka stron
  libraryEnqueue: (pages) => ipcRenderer.invoke("library:enqueue", pages),
  libraryRetry: (page) => ipcRenderer.invoke("library:retry", page),
  libraryPrioritize: (hashes) => ipcRenderer.invoke("library:prioritize", hashes),
  libraryRemove: (hash) => ipcRenderer.invoke("library:remove", hash),
  libraryForget: (hash) => ipcRenderer.invoke("library:forget", hash),
  onLibraryUpdate: listen("library:update"),
  onLibraryCleared: listen("library:cleared"),
  // sprawdzian
  generate: (payload) => ipcRenderer.invoke("test:generate", payload),
  cancel: () => ipcRenderer.invoke("test:cancel"),
  onTask: listen("test:task"),
  onProgress: listen("test:progress"),
  // OCR wycinka (kontrola, czy na grafice nie ma podpisu)
  ocr: (imageBuffer, opts) => ipcRenderer.invoke("ocr:recognize", imageBuffer, opts),
  // pliki
  pickFolder: (max) => ipcRenderer.invoke("images:pickFolder", { max }),
  pickFiles: (max) => ipcRenderer.invoke("images:pickFiles", { max }),
  savePdf: (defaultName) => ipcRenderer.invoke("pdf:save", { defaultName }),
  print: () => ipcRenderer.invoke("print"),
  saveProject: (defaultName, data) => ipcRenderer.invoke("project:save", { defaultName, data }),
  openProject: () => ipcRenderer.invoke("project:open"),
  // ocena pytań otwartych przez AI (podpowiedź dla rodzica)
  gradeOpen: (items, settings) => ipcRenderer.invoke("ai:gradeOpen", { items, settings }),
  // historia wyników
  historyList: () => ipcRenderer.invoke("history:list"),
  historySave: (entry) => ipcRenderer.invoke("history:save", entry),
  historyDelete: (id) => ipcRenderer.invoke("history:delete", id),
  historyClear: () => ipcRenderer.invoke("history:clear"),
  // aktualizacje
  appVersion: () => ipcRenderer.invoke("app:version"),
  checkUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: listen("update:status"),
  // rozwiązywanie na tablecie
  remoteStart: (test) => ipcRenderer.invoke("remote:start", test),
  remoteStop: () => ipcRenderer.invoke("remote:stop"),
  remoteResult: (id, result) => ipcRenderer.invoke("remote:result", { id, result }),
  onRemoteSubmission: listen("remote:submission"),
  onRemoteEvent: listen("remote:event"),
});
