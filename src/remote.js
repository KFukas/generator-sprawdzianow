// Rozwiązywanie na tablecie lub telefonie: mały serwer w sieci domowej (Wi-Fi), adres z losowym kluczem, kod QR.
// Tablet dostaje treść zadań BEZ poprawnych odpowiedzi; odpowiedzi wracają do programu, który je sprawdza.
// Quiz-gra: każdą odpowiedź sprawdza serwer (klucz zostaje na komputerze), także przy wielu tabletach naraz (tryb klasy).
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const quizCore = require("./remote/quiz.js");

const DIR = path.join(__dirname, "remote");
const FILES = {
  "/": ["tablet.html", "text/html; charset=utf-8"],
  "/quiz.js": ["quiz.js", "text/javascript; charset=utf-8"],
  "/quiz.css": ["quiz.css", "text/css; charset=utf-8"],
};
const CSP = "default-src 'none'; img-src data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const MAX_BODY = 512 * 1024;
const MAX_CLIENTS = 200;
const AUTO_STOP_MS = 3 * 3600 * 1000;
const CLIENT_RE = /^[a-f0-9]{16,40}$/;

let server = null;
let session = null; // { token, test, key, clients, urls, stopTimer }
let onSubmit = null; // (payload) => Promise<result>
let onEvent = null; // (event) => void – informacja dla okna programu

/** Adresy IPv4 w sieci lokalnej (najpierw typowe sieci domowe). */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // brak DHCP
      const virtual = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier/i.test(name);
      const score = (/^192\.168\./.test(a.address) ? 3 : /^10\./.test(a.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 0) - (virtual ? 5 : 0);
      out.push({ address: a.address, name, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));
const emit = (ev) => onEvent && onEvent(ev);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("za duże"));
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Stan jednego urządzenia (gracza) – imię i licznik quizu. */
function client(id) {
  if (!CLIENT_RE.test(String(id || ""))) return null;
  let c = session.clients.get(id);
  if (!c) {
    if (session.clients.size >= MAX_CLIENTS) return null;
    c = { name: "", tally: session.key ? quizCore.tally(session.key) : null };
    session.clients.set(id, c);
  }
  return c;
}
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);

async function handle(req, res) {
  const m = req.url.match(/^\/t\/([a-f0-9]{32})(\/[a-z.]*)?$/);
  if (!session || !m || !crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(session.token))) return send(res, 404, "text/plain; charset=utf-8", "Nie znaleziono. Zeskanuj nowy kod QR z programu.");
  const sub = m[2] || "/";
  if (req.method === "GET" && FILES[sub]) {
    const [file, type] = FILES[sub];
    return send(res, 200, type, fs.readFileSync(path.join(DIR, file)), sub === "/" ? { "Content-Security-Policy": CSP } : {});
  }
  if (req.method === "GET" && sub === "/test.json") {
    emit({ type: "opened", ip: req.socket.remoteAddress });
    return json(res, 200, session.test);
  }
  if (req.method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "Niedozwolone.");
  let data;
  try {
    data = await readBody(req);
  } catch {
    return json(res, 400, { ok: false, error: "Nieprawidłowe dane." });
  }
  if (!session) return json(res, 410, { ok: false, error: "Udostępnianie zostało zatrzymane." });

  if (sub === "/hello") {
    const c = client(data.c);
    if (!c) return json(res, 400, { ok: false });
    c.name = cleanName(data.name);
    emit({ type: "join", client: data.c, name: c.name });
    return json(res, 200, { ok: true });
  }

  if (sub === "/check") {
    if (!session.key) return json(res, 404, { ok: false });
    const c = client(data.c);
    const i = Number(data.i);
    const a = data.a;
    const okType = a === null || typeof a === "boolean" || (typeof a === "number" && Number.isInteger(a)) || (typeof a === "string" && a.length <= 200);
    if (!c || !Number.isInteger(i) || !okType) return json(res, 400, { ok: false });
    const r = c.tally.answer(i, a, data.ms);
    if (!r) return json(res, 400, { ok: false });
    const s = c.tally.summary();
    emit({ type: "quiz", client: data.c, name: c.name, state: { points: s.points, correct: s.correct, answered: s.answered, total: s.total, best: s.best } });
    return json(res, 200, { ok: true, result: r });
  }

  if (sub === "/submit") {
    try {
      const c = data.c ? client(data.c) : null;
      const payload = { name: cleanName(data.name) || (c && c.name) || "", answers: data.answers && typeof data.answers === "object" ? data.answers : {}, seconds: Number(data.seconds) || 0, timeUp: Boolean(data.timeUp), client: c ? data.c : null };
      if (session.key) {
        if (!c) return json(res, 400, { ok: false, error: "Nieprawidłowe dane." });
        payload.quiz = c.tally.summary(); // punkty liczy serwer, nie tablet
      }
      const result = onSubmit ? await onSubmit(payload) : null;
      if (result && result.error) return json(res, 409, { ok: false, error: "Ten sprawdzian nie jest już otwarty w programie." });
      return json(res, 200, { ok: true, result });
    } catch (e) {
      return json(res, 500, { ok: false, error: "Program nie przyjął odpowiedzi. Spróbuj jeszcze raz." });
    }
  }
  send(res, 405, "text/plain; charset=utf-8", "Niedozwolone.");
}

/** Uruchamia (lub odświeża) udostępnianie. test – treść dla tabletu (bez odpowiedzi), key – klucz quizu (zostaje tutaj). */
async function start(test, key = null) {
  const addrs = lanAddresses();
  if (!addrs.length) throw new Error("Komputer nie jest połączony z siecią lokalną (Wi-Fi lub kabel). Tablet musi być w tej samej sieci.");
  if (!server) {
    server = http.createServer((req, res) =>
      handle(req, res).catch(() => {
        try {
          send(res, 500, "text/plain; charset=utf-8", "Błąd.");
        } catch {}
      }));
    server.requestTimeout = 30000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
  }
  if (session && session.stopTimer) clearTimeout(session.stopTimer);
  const token = crypto.randomBytes(16).toString("hex");
  const port = server.address().port;
  session = {
    token,
    test,
    key: Array.isArray(key) && key.length ? key : null,
    clients: new Map(),
    urls: addrs.map((a) => `http://${a.address}:${port}/t/${token}/`),
    stopTimer: setTimeout(stop, AUTO_STOP_MS),
  };
  return { url: session.urls[0], others: session.urls.slice(1) };
}

function stop() {
  if (session && session.stopTimer) clearTimeout(session.stopTimer);
  session = null;
  if (server) {
    server.close();
    server.closeAllConnections && server.closeAllConnections();
    server = null;
  }
  emit({ type: "stopped" });
}

module.exports = {
  start,
  stop,
  active: () => Boolean(session),
  setHandlers: (submit, event) => {
    onSubmit = submit;
    onEvent = event;
  },
};
