// Silnik Codex – przez Codex CLI (`codex exec`), na koncie ChatGPT użytkownika (lub kluczu OpenAI ustawionym w Codex).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { TEST_SCHEMA, buildTestPrompt, normalizeFigures, strictSchema } = require("./common");

// ---------------------------------------------------------------- odszukanie programu codex
function newestFirst(dirs) {
  return dirs
    .map((d) => {
      try {
        return { d, t: fs.statSync(d).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t)
    .map((x) => x.d);
}

function findCodex() {
  const home = os.homedir();
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [];
  if (process.env.CODEX_PATH) candidates.push(process.env.CODEX_PATH);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  // aplikacja Codex dla Windows
  const appBin = path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "OpenAI", "Codex", "bin");
  try {
    for (const d of newestFirst(fs.readdirSync(appBin).map((n) => path.join(appBin, n)))) candidates.push(path.join(d, exe));
  } catch {}
  // npm install -g @openai/codex
  const npmVendor = path.join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "vendor");
  try {
    for (const t of fs.readdirSync(npmVendor)) candidates.push(path.join(npmVendor, t, "codex", exe));
  } catch {}
  // rozszerzenie Codex / ChatGPT w VS Code i pochodnych
  for (const ide of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const extDir = path.join(home, ide, "extensions");
    let dirs = [];
    try {
      dirs = fs.readdirSync(extDir).filter((d) => d.startsWith("openai.chatgpt")).map((d) => path.join(extDir, d));
    } catch {}
    for (const d of newestFirst(dirs)) candidates.push(path.join(d, "bin", "windows-x86_64", exe), path.join(d, "bin", exe));
  }
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}

let cachedPath;
const codexPath = () => (cachedPath === undefined ? (cachedPath = findCodex()) : cachedPath);

function friendlyError(text) {
  const t = String(text || "");
  if (/not logged in|login|unauthori[sz]ed|401|auth/i.test(t)) return "Codex nie jest zalogowany. Uruchom Codex i zaloguj się kontem ChatGPT (lub ustaw klucz OpenAI).";
  if (/usage limit|rate limit|quota|429|plan/i.test(t)) return "Osiągnięto limit Codex dla Twojego planu ChatGPT. Spróbuj później albo wybierz inny silnik (Narzędzia → Silnik AI).";
  if (/ENOTFOUND|ECONNREFUSED|network|stream disconnected|connection/i.test(t)) return "Brak połączenia z internetem – Codex działa w chmurze.";
  return "Codex zwrócił błąd: " + t.slice(-300);
}

/** Jedno zapytanie do Codex. Polecenie idzie przez standardowe wejście, odpowiedź (JSON wg schematu) do pliku. */
function run({ prompt, schema, images = [], effort = "low", signal, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const exe = codexPath();
    if (!exe) return reject(new Error("Nie znaleziono programu Codex."));
    const dir = path.join(os.tmpdir(), "generator-sprawdzianow", "codex-" + crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(dir, { recursive: true });
    const schemaFile = path.join(dir, "schema.json");
    const outFile = path.join(dir, "odpowiedz.json");
    fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(schema)));
    const imgArgs = [];
    images.forEach((b64, i) => {
      const f = path.join(dir, `strona${i + 1}.jpg`);
      fs.writeFileSync(f, Buffer.from(b64, "base64"));
      imgArgs.push("-i", f);
    });
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox", "read-only",
      "--color", "never",
      "-c", `model_reasoning_effort="${effort}"`,
      "-C", dir,
      "--output-schema", schemaFile,
      "-o", outFile,
      ...imgArgs,
      "-",
    ];
    const child = spawn(exe, args, { cwd: dir, windowsHide: true });
    let err = "";
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) {
        cleanup();
        return reject(new Error("aborted"));
      }
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(outFile, "utf8"));
      } catch {}
      cleanup();
      if (!data) return reject(new Error(friendlyError(err || `kod wyjścia ${code}`)));
      resolve({ data });
    });
    child.stdin.end(prompt, "utf8");
  });
}

const PAGE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    text: { type: "string" },
    figures: {
      type: "array",
      items: {
        type: "object",
        properties: { x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" }, caption: { type: "string" }, shows: { type: "string" } },
        required: ["x1", "y1", "x2", "y2", "caption", "shows"],
      },
    },
  },
  required: ["title", "text", "figures"],
};

const pagePrompt = (w, h) => `Załączone zdjęcie to strona (lub rozkładówka) polskiego podręcznika szkolnego, wymiary ${w} × ${h} px. Nie uruchamiaj żadnych poleceń – tylko obejrzyj zdjęcie i odpowiedz.
1. "title": tytuł lekcji widoczny na stronie.
2. "text": przepisz dokładnie tekst podręcznika: akapity, śródtytuły, ramki, opisy przy rysunkach, polecenia. Pomiń numery stron i teksty z sąsiednich stron na brzegach zdjęcia.
3. "figures": ilustracje (zdjęcia, rysunki, schematy, mapy; bez ikonek). Dla każdej prostokąt x1, y1, x2, y2 w pikselach zdjęcia (${w} × ${h}), obejmujący SAM obrazek – bez podpisu i bez tekstu obok; "caption" – podpis przy ilustracji; "shows" – co przedstawia (krótko).`;

async function readPage({ imageB64, width, height, signal }) {
  const { data } = await run({ prompt: pagePrompt(width, height), schema: PAGE_SCHEMA, images: [imageB64], effort: "low", signal, timeoutMs: 300000 });
  return {
    title: String(data.title || "").trim(),
    text: String(data.text || "").trim(),
    figures: normalizeFigures(data.figures, 1000 / width, 1000 / height),
  };
}

async function generateTest({ pages, figures, plan, settings, avoid, signal, onTask }) {
  const prompt = buildTestPrompt({ pages, figures, plan, settings, avoid }) + "\nNie uruchamiaj żadnych poleceń – odpowiedz wyłącznie danymi w wymaganym formacie.";
  const { data } = await run({ prompt, schema: TEST_SCHEMA, effort: "medium", signal, timeoutMs: 480000 });
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  tasks.forEach((t, i) => onTask && onTask(t, i));
  return { title: String(data.title || ""), tasks };
}

function status() {
  const p = codexPath();
  return { installed: Boolean(p), ready: Boolean(p), path: p };
}

module.exports = { status, readPage, generateTest, findCodex };
