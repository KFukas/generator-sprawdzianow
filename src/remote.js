// Rozwiązywanie na tablecie lub telefonie: mały serwer w sieci domowej (Wi-Fi), adres z losowym kluczem, kod QR.
// Tablet dostaje treść zadań BEZ poprawnych odpowiedzi; odpowiedzi wracają do programu, który je sprawdza.
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PAGE = path.join(__dirname, "remote", "tablet.html");
const MAX_BODY = 512 * 1024;
const AUTO_STOP_MS = 3 * 3600 * 1000;

let server = null;
let session = null; // { token, test, url, stopTimer }
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

function handle(req, res) {
  const m = req.url.match(/^\/t\/([a-f0-9]{32})(\/[a-z.]*)?$/);
  if (!session || !m || !crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(session.token))) return send(res, 404, "text/plain; charset=utf-8", "Nie znaleziono. Zeskanuj nowy kod QR z programu.");
  const sub = m[2] || "/";
  if (req.method === "GET" && sub === "/") {
    const html = fs.readFileSync(PAGE, "utf8");
    return send(res, 200, "text/html; charset=utf-8", html, {
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
  }
  if (req.method === "GET" && sub === "/test.json") {
    if (onEvent) onEvent({ type: "opened", ip: req.socket.remoteAddress });
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(session.test));
  }
  if (req.method === "POST" && sub === "/submit") {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "Nieprawidłowe dane." }));
      }
      try {
        const result = onSubmit ? await onSubmit({ name: String(data.name || "").slice(0, 80), answers: data.answers && typeof data.answers === "object" ? data.answers : {}, seconds: Number(data.seconds) || 0, timeUp: Boolean(data.timeUp) }) : null;
        if (result && result.error) return send(res, 409, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "Ten sprawdzian nie jest już otwarty w programie." }));
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, result }));
      } catch (e) {
        send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "Program nie przyjął odpowiedzi. Spróbuj jeszcze raz." }));
      }
    });
    return;
  }
  send(res, 405, "text/plain; charset=utf-8", "Niedozwolone.");
}

/** Uruchamia (lub odświeża) udostępnianie sprawdzianu. */
async function start(test) {
  const addrs = lanAddresses();
  if (!addrs.length) throw new Error("Komputer nie jest połączony z siecią lokalną (Wi-Fi lub kabel). Tablet musi być w tej samej sieci.");
  if (!server) {
    server = http.createServer(handle);
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
  if (onEvent) onEvent({ type: "stopped" });
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
