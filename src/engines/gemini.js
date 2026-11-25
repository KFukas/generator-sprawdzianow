// Silnik Gemini – Google Gemini API z bezpłatnym kluczem z Google AI Studio (https://aistudio.google.com/apikey).
// Darmowy poziom ma dzienny limit zapytań; dane z darmowego poziomu Google może wykorzystywać do ulepszania usług.
const { TEST_SCHEMA, buildTestPrompt, normalizeFigures } = require("./common");

const API = "https://generativelanguage.googleapis.com/v1beta";
// kolejność preferencji – nazwy modeli Gemini często się zmieniają, więc i tak sprawdzamy listę dostępnych
const PREFERRED = [/^gemini-flash-latest$/, /^gemini-\d+(\.\d+)?-flash$/, /^gemini-\d+(\.\d+)?-flash-preview/, /^gemini-flash-lite-latest$/, /^gemini-\d+(\.\d+)?-flash-lite$/, /flash/];

let modelsCache = null; // { key, models: [...] }

async function api(key, method, url, body, signal) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || text.slice(0, 300);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

function friendlyError(e) {
  if (e.name === "AbortError") return "aborted";
  const s = e.status;
  if (s === 400 && /api key/i.test(e.message)) return "Nieprawidłowy klucz Gemini. Sprawdź go w Narzędzia → Silnik AI.";
  if (s === 401 || s === 403) return "Klucz Gemini nie ma dostępu. Utwórz nowy klucz na aistudio.google.com/apikey.";
  if (s === 429) return "Wyczerpano darmowy limit Gemini (na minutę lub na dzień). Spróbuj za chwilę lub jutro, albo wybierz inny silnik.";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(e.message)) return "Brak połączenia z internetem – Gemini działa w chmurze.";
  return "Gemini zwrócił błąd: " + e.message.slice(0, 300);
}

/** Modele dostępne dla klucza, od najbardziej pożądanego. */
async function candidateModels(key) {
  if (modelsCache && modelsCache.key === key) return modelsCache.models;
  const data = await api(key, "GET", "/models?pageSize=200");
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini/.test(n) && !/(tts|image|audio|live|embedding|thinking|computer|robotics)/.test(n));
  const ranked = [];
  for (const re of PREFERRED) for (const n of names.sort().reverse()) if (re.test(n) && !ranked.includes(n)) ranked.push(n);
  modelsCache = { key, models: ranked.slice(0, 6) };
  return modelsCache.models;
}

/** Zapytanie z JSON-em wg schematu; przy limicie lub niedostępnym modelu próbuje kolejnego modelu. */
async function generate(key, { parts, schema, signal }) {
  const models = await candidateModels(key);
  if (!models.length) throw Object.assign(new Error("Brak dostępnych modeli Gemini dla tego klucza."), { status: 404 });
  let lastErr;
  for (const model of models) {
    for (const schemaField of ["responseJsonSchema", null]) {
      try {
        const body = {
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", ...(schemaField ? { [schemaField]: schema } : {}) },
        };
        const res = await api(key, "POST", `/models/${encodeURIComponent(model)}:generateContent`, body, signal);
        const text = ((res.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("");
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("pusta odpowiedź");
        return { data: JSON.parse(m[0]), model };
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;
        // nieobsługiwane pole schematu → spróbuj bez niego; limit / brak modelu → następny model
        if (e.status === 400 && schemaField && /schema|field|unknown/i.test(e.message)) continue;
        break;
      }
    }
    if (lastErr && ![429, 404, 503, 500].includes(lastErr.status)) break;
  }
  throw lastErr;
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
        properties: { x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" }, caption: { type: "string" }, shows: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
        required: ["x1", "y1", "x2", "y2", "caption", "shows", "labels"],
      },
    },
  },
  required: ["title", "text", "figures"],
};

const pagePrompt = `To zdjęcie strony (lub rozkładówki) polskiego podręcznika szkolnego.
1. "title": tytuł lekcji widoczny na stronie.
2. "text": przepisz dokładnie tekst podręcznika: akapity, śródtytuły, ramki, opisy przy rysunkach, polecenia. Pomiń numery stron i teksty z sąsiednich stron na brzegach zdjęcia.
3. "figures": ilustracje (zdjęcia, rysunki, schematy, mapy; bez ikonek). Dla każdej prostokąt x1, y1, x2, y2 we współrzędnych 0–1000 względem całego zdjęcia (0,0 = lewy górny róg), obejmujący SAM obrazek – bez podpisu i bez tekstu obok; "caption" – podpis przy ilustracji; "shows" – co przedstawia (krótko); "labels" – wszystkie napisy umieszczone NA ilustracji (etykiety, strzałki z opisami), dokładnie jak na obrazku; pusta lista, jeśli brak.
Odpowiedz w JSON.`;

function makeEngine(getKey) {
  async function readPage({ imageB64, signal }) {
    try {
      const { data } = await generate(getKey(), { parts: [{ inlineData: { mimeType: "image/jpeg", data: imageB64 } }, { text: pagePrompt }], schema: PAGE_SCHEMA, signal });
      return { title: String(data.title || "").trim(), text: String(data.text || "").trim(), figures: normalizeFigures(data.figures) };
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  async function generateTest({ pages, figures, plan, settings, avoid, signal, onTask }) {
    const prompt = buildTestPrompt({ pages, figures, plan, settings, avoid });
    try {
      const { data } = await generate(getKey(), { parts: [{ text: prompt }], schema: TEST_SCHEMA, signal });
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      tasks.forEach((t, i) => onTask && onTask(t, i));
      return { title: String(data.title || ""), tasks };
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  /** Dowolne zapytanie z odpowiedzią w JSON wg schematu (np. ocena odpowiedzi ucznia). */
  async function ask({ prompt, schema, signal }) {
    try {
      const { data } = await generate(getKey(), { parts: [{ text: prompt }], schema, signal });
      return data;
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  /** Szybka kontrola klucza (lista modeli). */
  async function check(key) {
    try {
      modelsCache = null;
      const models = await candidateModels(key);
      return models.length ? { ok: true, model: models[0] } : { ok: false, error: "Klucz działa, ale nie ma dostępnych modeli Gemini." };
    } catch (e) {
      return { ok: false, error: friendlyError(e) };
    }
  }

  return { readPage, generateTest, ask, check };
}

module.exports = { makeEngine };
