// Silnik Claude – przez Claude Code w trybie bezgłowym (`claude -p`), na subskrypcji użytkownika.
// Nie wymaga klucza API: korzysta z konta, na które zalogowany jest Claude Code na tym komputerze.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { TEST_SCHEMA, buildTestPrompt, normalizeFigures } = require("./common");

const MODELS = { "claude-sonnet": "sonnet", "claude-opus": "opus" };

// ---------------------------------------------------------------- odszukanie programu claude
function versionKey(dir) {
  const m = dir.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? +m[1] * 1e6 + +m[2] * 1e3 + +m[3] : 0;
}

function findClaude() {
  const home = os.homedir();
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [];
  if (process.env.CLAUDE_CODE_PATH) candidates.push(process.env.CLAUDE_CODE_PATH);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  candidates.push(path.join(home, ".local", "bin", exe), path.join(home, ".claude", "local", exe));
  // wersja dołączona do rozszerzenia Claude Code w VS Code / Cursor / Windsurf
  for (const ide of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const extDir = path.join(home, ide, "extensions");
    let dirs = [];
    try {
      dirs = fs.readdirSync(extDir).filter((d) => d.startsWith("anthropic.claude-code"));
    } catch {}
    dirs.sort((a, b) => versionKey(b) - versionKey(a));
    for (const d of dirs) candidates.push(path.join(extDir, d, "resources", "native-binary", exe));
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
const claudePath = () => (cachedPath === undefined ? (cachedPath = findClaude()) : cachedPath);

// ---------------------------------------------------------------- uruchomienie
function friendlyError(text) {
  const t = String(text || "");
  if (/login|log in|authenticat|api key|credential|oauth/i.test(t)) return "Claude Code nie jest zalogowany. Otwórz Claude Code (np. w VS Code) i zaloguj się swoim kontem Claude.";
  if (/usage limit|rate limit|limit reached|overloaded|529|429/i.test(t)) return "Osiągnięto limit użycia subskrypcji Claude lub serwer jest przeciążony. Spróbuj za jakiś czas albo przełącz silnik na lokalny (Narzędzia → Silnik AI).";
  if (/ENOTFOUND|ECONNREFUSED|network|fetch failed|getaddrinfo/i.test(t)) return "Brak połączenia z internetem – Claude działa w chmurze. Sprawdź internet albo przełącz silnik na lokalny.";
  return "Claude zwrócił błąd: " + t.slice(0, 300);
}

/** Jedno zapytanie do Claude Code. Polecenie idzie przez standardowe wejście (bez ograniczeń długości wiersza poleceń). */
function run({ prompt, schema, tools = "", cwd, model, signal, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const exe = claudePath();
    if (!exe) return reject(new Error("Nie znaleziono programu Claude Code."));
    const args = [
      "-p",
      "--model", model,
      "--output-format", "json",
      "--no-session-persistence",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--tools", tools,
    ];
    if (tools) args.push("--allowedTools", tools);
    if (schema) args.push("--json-schema", JSON.stringify(schema));
    const child = spawn(exe, args, { cwd: cwd || os.tmpdir(), windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-generator-sprawdzianow" } });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) return reject(new Error("aborted"));
      let j;
      try {
        j = JSON.parse(out);
      } catch {
        return reject(new Error(friendlyError(err || out || `kod wyjścia ${code}`)));
      }
      if (j.is_error) return reject(new Error(friendlyError(j.result || j.api_error_status || j.subtype)));
      let data = j.structured_output;
      if (!data && typeof j.result === "string") {
        const m = j.result.match(/\{[\s\S]*\}/);
        try {
          data = m ? JSON.parse(m[0]) : null;
        } catch {}
      }
      if (!data) return reject(new Error("Claude nie zwrócił danych w oczekiwanym formacie."));
      resolve({ data, seconds: Math.round((j.duration_ms || 0) / 1000) });
    });
    child.stdin.end(prompt, "utf8");
  });
}

// ---------------------------------------------------------------- czytanie strony
const PAGE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    text: { type: "string" },
    figures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" },
          caption: { type: "string" }, shows: { type: "string" },
        },
        required: ["x1", "y1", "x2", "y2", "caption", "shows"],
      },
    },
  },
  required: ["title", "text", "figures"],
};

const pagePrompt = (w, h) => `Obejrzyj plik strona.jpg – zdjęcie strony (lub rozkładówki) polskiego podręcznika szkolnego, wymiary ${w} × ${h} px.
1. "title": tytuł lekcji widoczny na stronie.
2. "text": przepisz dokładnie tekst podręcznika: akapity, śródtytuły, ramki („Czy wiesz, że…”, „Zapamiętaj” itp.), opisy przy rysunkach, polecenia. Pomiń numery stron i teksty z sąsiednich, ledwo widocznych stron na brzegach zdjęcia.
3. "figures": ilustracje (zdjęcia, rysunki, schematy, mapy, wykresy; bez ikonek i ozdobników). Dla każdej prostokąt x1, y1, x2, y2 w pikselach tego zdjęcia (${w} × ${h}), obejmujący SAM obrazek – bez podpisu i bez tekstu obok; "caption" – podpis lub opis przy ilustracji; "shows" – co przedstawia (krótko).
Odpowiedz wyłącznie danymi w wymaganym formacie.`;

async function readPage({ imageB64, width, height, engine, signal }) {
  const dir = path.join(os.tmpdir(), "generator-sprawdzianow", crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "strona.jpg"), Buffer.from(imageB64, "base64"));
    const { data, seconds } = await run({ prompt: pagePrompt(width, height), schema: PAGE_SCHEMA, tools: "Read", cwd: dir, model: MODELS[engine] || "sonnet", signal, timeoutMs: 240000 });
    return {
      title: String(data.title || "").trim(),
      text: String(data.text || "").trim(),
      figures: normalizeFigures(data.figures, 1000 / width, 1000 / height),
      seconds,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- układanie zadań
async function generateTest({ pages, figures, plan, settings, avoid, engine, signal, onTask }) {
  const prompt = buildTestPrompt({ pages, figures, plan, settings, avoid }) + "\nOdpowiedz wyłącznie danymi w wymaganym formacie.";
  const { data } = await run({ prompt, schema: TEST_SCHEMA, tools: "", model: MODELS[engine] || "sonnet", signal, timeoutMs: 420000 });
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  tasks.forEach((t, i) => onTask && onTask(t, i));
  return { title: String(data.title || ""), tasks };
}

function status() {
  const p = claudePath();
  return { installed: Boolean(p), ready: Boolean(p), path: p };
}

module.exports = { status, readPage, generateTest, findClaude };
