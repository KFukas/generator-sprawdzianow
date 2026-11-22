// Silnik lokalny: Ollama + Qwen3-VL na tym komputerze – działa offline, ale na słabym komputerze bardzo wolno.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const { TEST_SCHEMA, buildTestPrompt, completedTasks, salvageJson, normalizeFigures } = require("./common");

const HOST = "127.0.0.1";
const PORT = 11434;
const MODEL = "qwen3-vl:4b-instruct";

// ---------------------------------------------------------------- serwer Ollama
function ollamaExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Ollama", "ollama.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function request(method, urlPath, body, { onLine, signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
      (res) => {
        let buf = "";
        let last = null;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          if (!onLine) return;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              last = JSON.parse(line);
              onLine(last);
            } catch {
              /* niepełna linia */
            }
          }
        });
        res.on("end", () => {
          if (onLine) {
            if (buf.trim()) {
              try {
                last = JSON.parse(buf.trim());
                onLine(last);
              } catch {}
            }
            return resolve(last);
          }
          try {
            resolve(buf ? JSON.parse(buf) : null);
          } catch {
            resolve(buf);
          }
        });
      }
    );
    // przy strumieniu nie ma limitu czasu – czytanie strony na słabym komputerze trwa kilkanaście minut
    if (!onLine) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) return req.destroy(new Error("aborted"));
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    if (data) req.write(data);
    req.end();
  });
}

async function serverUp() {
  try {
    await request("GET", "/api/version", null, { timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) return true;
  const exe = ollamaExe();
  if (!exe) return false;
  const child = spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverUp()) return true;
  }
  return false;
}

async function status() {
  const installed = Boolean(ollamaExe()) || (await serverUp());
  if (!installed) return { installed: false, server: false, model: false, modelName: MODEL };
  const server = await ensureServer();
  let model = false;
  if (server) {
    try {
      const tags = await request("GET", "/api/tags");
      model = (tags.models || []).some((m) => m.name === MODEL || m.model === MODEL);
    } catch {}
  }
  return { installed, server, model, modelName: MODEL };
}

async function pullModel(onProgress, signal) {
  await ensureServer();
  let err = null;
  await request("POST", "/api/pull", { model: MODEL, stream: true }, {
    signal,
    onLine: (j) => {
      if (j.error) err = j.error;
      if (onProgress) onProgress({ status: j.status, completed: j.completed || 0, total: j.total || 0 });
    },
  });
  if (err) throw new Error(err);
}

/** Rozmowa z modelem – strumieniowo, z licznikiem tokenów. */
async function chat({ prompt, images, format, numPredict = 2000, numCtx = 8192, temperature = 0.2, signal, onToken }) {
  await ensureServer();
  let content = "";
  let tokens = 0;
  let firstAt = 0;
  let done = null;
  let error = null;
  await request(
    "POST",
    "/api/chat",
    {
      model: MODEL,
      stream: true,
      think: false,
      format,
      keep_alive: "10m",
      options: { temperature, num_ctx: numCtx, num_predict: numPredict, repeat_penalty: 1.05 },
      messages: [{ role: "user", content: prompt, ...(images ? { images } : {}) }],
    },
    {
      signal,
      onLine: (j) => {
        if (j.error) error = j.error;
        if (j.message && j.message.content) {
          if (!firstAt) firstAt = Date.now();
          content += j.message.content;
          tokens++;
          if (onToken) onToken({ tokens, content });
        }
        if (j.done) done = j;
      },
    }
  );
  if (error) throw new Error(error);
  return { content, tokens, truncated: done && done.done_reason === "length", stats: done };
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
          bbox_2d: { type: "array", items: { type: "integer" } },
          caption: { type: "string" },
          shows: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["bbox_2d", "caption", "shows", "labels"],
      },
    },
  },
  required: ["title", "text", "figures"],
};

const PAGE_PROMPT = `To jest zdjęcie strony (lub rozkładówki) z polskiego podręcznika szkolnego.
1. W polu "title" podaj tytuł lekcji widoczny na stronie.
2. W polu "text" przepisz dokładnie tekst podręcznika: akapity, śródtytuły, ramki („Czy wiesz, że…”, „Zapamiętaj” itp.), opisy przy rysunkach. Zachowaj polską pisownię. Pomiń numery stron i teksty z sąsiednich, ledwo widocznych stron na brzegach zdjęcia.
3. W polu "figures" wypisz ilustracje (fotografie, rysunki, schematy) – maksymalnie 6, bez ikonek i ozdobników. Dla każdej:
   - bbox_2d: [x1, y1, x2, y2] we współrzędnych 0–1000 względem całego zdjęcia. Ramka ma obejmować SAM obrazek, BEZ podpisu i bez tekstu obok,
   - caption: podpis lub opis wydrukowany przy ilustracji (pusty, jeśli brak),
   - shows: krótko, co przedstawia ilustracja,
   - labels: napisy umieszczone NA ilustracji (etykiety), pusta lista, jeśli brak.
Odpowiedz w JSON.`;

async function readPage({ imageB64, signal, onProgress }) {
  const t0 = Date.now();
  const res = await chat({
    prompt: PAGE_PROMPT,
    images: [imageB64],
    format: PAGE_SCHEMA,
    numPredict: 2000,
    numCtx: 4096, // obraz 1024 px ≈ 800 tokenów + odpowiedź
    temperature: 0,
    signal,
    onToken: ({ tokens }) => onProgress && onProgress({ phase: "writing", tokens }),
  });
  const page = salvageJson(res.content);
  page.figures = normalizeFigures(page.figures);
  page.text = (page.text || "").trim();
  page.title = (page.title || "").trim();
  page.seconds = Math.round((Date.now() - t0) / 1000);
  page.truncated = res.truncated;
  return page;
}

// ---------------------------------------------------------------- układanie zadań
function ctxFor(prompt, numPredict) {
  const est = Math.ceil(prompt.length / 3) + numPredict + 256; // polski tekst: ok. 3 znaki na token
  return Math.min(8192, Math.max(3072, Math.ceil(est / 512) * 512));
}

async function generateTest({ pages, figures, plan, settings, avoid, signal, onTask, onProgress }) {
  const prompt = buildTestPrompt({ pages, figures, plan, settings, avoid });
  let emitted = 0;
  const numPredict = 300 + plan.length * 230;
  const res = await chat({
    prompt,
    format: TEST_SCHEMA,
    numPredict,
    // okno kontekstu dopasowane do tekstu – większe zajmuje dużo pamięci, a przy 8 GB RAM to spowalnia wszystko
    numCtx: ctxFor(prompt, numPredict),
    temperature: 0.4,
    signal,
    onToken: ({ tokens, content }) => {
      if (onProgress) onProgress({ tokens });
      const done = completedTasks(content);
      while (emitted < done.length) onTask && onTask(done[emitted], emitted++);
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    parsed = { title: "", tasks: completedTasks(res.content) };
  }
  const tasks = parsed.tasks || [];
  while (emitted < tasks.length) onTask && onTask(tasks[emitted], emitted++);
  return { title: parsed.title || "", tasks };
}

module.exports = { MODEL, status, ensureServer, pullModel, readPage, generateTest };
