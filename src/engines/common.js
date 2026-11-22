// Wspólne elementy silników AI: schemat zadań, polecenie dla modelu, parsowanie odpowiedzi.

function salvageJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    // odpowiedź ucięta – ratujemy tytuł i tekst
    const grab = (key) => {
      const m = content.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
      if (!m) return "";
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    };
    return { title: grab("title"), text: grab("text"), figures: [] };
  }
}

/** Ramki ilustracji → współrzędne 0–1000 (niezależne od rozdzielczości zdjęcia). */
function normalizeFigures(figs, scaleX = 1, scaleY = 1) {
  return (figs || [])
    .map((f) => {
      const raw = Array.isArray(f.bbox_2d) ? f.bbox_2d : [f.x1, f.y1, f.x2, f.y2];
      if (raw.length !== 4 || raw.some((v) => !Number.isFinite(+v))) return null;
      const [a, b, c, d] = raw.map((v, i) => Math.max(0, Math.min(1000, Math.round(+v * (i % 2 ? scaleY : scaleX)))));
      return { box: { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) }, caption: String(f.caption || "").trim(), shows: String(f.shows || "").trim(), labels: (Array.isArray(f.labels) ? f.labels : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 12) };
    })
    .filter((f) => f && f.box.x1 - f.box.x0 >= 30 && f.box.y1 - f.box.y0 >= 30);
}

const TASK_ITEM = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["open", "abc", "tf", "match", "gap"] },
    q: { type: "string" },
    figure: { type: "integer" },
    points: { type: "integer" },
    options: { type: "array", items: { type: "string" } },
    correct: { type: "integer" },
    statements: { type: "array", items: { type: "object", properties: { t: { type: "string" }, p: { type: "boolean" } }, required: ["t", "p"] } },
    pairs: { type: "array", items: { type: "object", properties: { l: { type: "string" }, r: { type: "string" } }, required: ["l", "r"] } },
    gaps: { type: "array", items: { type: "object", properties: { t: { type: "string" }, a: { type: "string" } }, required: ["t", "a"] } },
    answer: { type: "string" },
  },
  required: ["type", "q", "figure", "points", "options", "correct", "statements", "pairs", "gaps", "answer"],
};
const TEST_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, tasks: { type: "array", items: TASK_ITEM } },
  required: ["title", "tasks"],
};

const TYPE_RULES = {
  open: `"open" – pytanie otwarte. W "q" treść pytania, w "answer" wzorcowa odpowiedź (1–3 zdania). Pozostałe tablice puste.`,
  abc: `"abc" – zadanie zamknięte. W "q" pytanie, w "options" dokładnie 4 RÓŻNE odpowiedzi (krótkie, w tej samej formie gramatycznej), w "correct" numer poprawnej (0–3). Błędne odpowiedzi mają być wiarygodne, ale jednoznacznie błędne.`,
  tf: `"tf" – prawda/fałsz. W "q" wpisz: "Oceń, czy zdania są prawdziwe. Zaznacz P lub F.", w "statements" 4 RÓŻNE zdania (pole "t") z oceną "p" (true = prawda). Dwa zdania prawdziwe, dwa fałszywe – fałszywe mają brzmieć wiarygodnie.`,
  match: `"match" – dopasowanie. W "q" polecenie (np. "Połącz pojęcia z ich opisami."), w "pairs" 4 pary: "l" – pojęcie, "r" – pasujący do niego opis.`,
  gap: `"gap" – uzupełnianie luk. W "q" polecenie "Uzupełnij zdania.", w "gaps" 4 zdania z tekstu, w których brakujące słowo zastąpiono znakami "___" (pole "t"), a w "a" brakujące słowo w poprawnej formie.`,
};

const LEVELS = {
  latwy: "łatwy – pytania o definicje, fakty i nazwy wprost z tekstu",
  sredni: "średni – oprócz faktów także wyjaśnianie, porównywanie, przykłady",
  trudny: "trudny – głównie zrozumienie: przyczyny i skutki, porównania, zastosowanie wiedzy w nowej sytuacji (ale tylko w zakresie materiału)",
};

function buildTestPrompt({ pages, figures, plan, settings, avoid }) {
  const kind = settings.kind === "sprawdzian" ? "sprawdzian" : "kartkówkę";
  const material = pages.map((p, i) => `--- STRONA ${i + 1}${p.title ? ` (${p.title})` : ""} ---\n${p.text}`).join("\n\n");
  const figs = figures.length
    ? figures.map((f, i) => `[${i}] ${f.shows || "ilustracja"}${f.caption ? ` (podpis w podręczniku: „${f.caption}”)` : ""}${f.labels && f.labels.length ? ` – napisy widoczne na obrazku: ${f.labels.map((l) => `„${l}”`).join(", ")}` : ""}`).join("\n")
    : "(brak)";
  const planText = plan.map((p, i) => `${i + 1}. ${p.type}${p.figure ? " – dotyczy ilustracji (wybierz numer w polu figure)" : ""}`).join("\n");
  const used = new Set(plan.map((p) => p.type));
  return `Jesteś doświadczonym nauczycielem. Przygotuj ${kind} po polsku${settings.grade ? ` dla ucznia: ${settings.grade}` : ""}${settings.subject ? `, przedmiot: ${settings.subject}` : ""}.
Poziom trudności: ${LEVELS[settings.difficulty] || LEVELS.sredni}.

ZASADY:
- Zadania dotyczą WYŁĄCZNIE materiału poniżej. Uczeń nie ma podręcznika – nie pisz „w tekście”, „na stronie”.
- Każde zadanie sprawdza inną informację. Nie powtarzaj pytań.
- Fragmenty tekstu, które wyglądają na błędnie odczytane lub bez sensu, pomiń.
- Pole "figure": numer ilustracji z listy albo -1, jeśli zadanie nie dotyczy ilustracji. Uczeń zobaczy SAM obrazek, bez podpisu – pytanie może więc dotyczyć tego, co przedstawia. Odpowiedź NIE może dać się przeczytać z napisów widocznych na obrazku (lista przy ilustracji) – np. nie pytaj „która część rośliny jest w glebie”, jeśli na obrazku jest napis „korzeń”; zapytaj wtedy o funkcję, zależność albo coś, czego na obrazku nie napisano.
- "points": 1 za proste zadanie, 2–3 za trudniejsze; dla tf, match, gap – 2.
${settings.extra ? `- Skup się zwłaszcza na: ${settings.extra}.\n` : ""}${avoid && avoid.length ? `- NIE powtarzaj tych pytań: ${avoid.map((a) => `„${a}”`).join("; ")}.\n` : ""}
RODZAJE ZADAŃ:
${[...used].map((t) => "- " + TYPE_RULES[t]).join("\n")}

UŁÓŻ DOKŁADNIE ${plan.length} ZADAŃ W TEJ KOLEJNOŚCI:
${planText}

ILUSTRACJE:
${figs}

MATERIAŁ Z PODRĘCZNIKA:
${material}

Odpowiedz w JSON: {"title": "tytuł sprawdzianu (np. Kartkówka – Biologia jako nauka)", "tasks": [...]}.`;
}

/** Wyciąga z niepełnego JSON-a już zakończone obiekty z tablicy "tasks" – zadania pokazujemy na bieżąco. */
function completedTasks(content) {
  const start = content.indexOf("[", content.indexOf('"tasks"'));
  if (start < 0) return [];
  const out = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(content.slice(objStart, i + 1)));
        } catch {}
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

/** Schemat w trybie ścisłym (wymagany przez modele OpenAI): każdy obiekt bez dodatkowych pól, wszystkie pola wymagane. */
function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)])) : strictSchema(v);
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

module.exports = { TEST_SCHEMA, buildTestPrompt, completedTasks, salvageJson, normalizeFigures, strictSchema };
