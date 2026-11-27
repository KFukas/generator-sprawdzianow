/* Quiz-gra – wspólny silnik dla programu na komputerze i strony na tablecie.
   Pytania po kolei, na czas; szybka odpowiedź = więcej punktów, seria poprawnych odpowiedzi mnoży punkty.
   W Node (serwer tabletu) używane są tylko funkcje sprawdzania i punktacji – poprawne odpowiedzi nie trafiają na tablet. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuizGame = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const norm = (s) =>
    String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[.,;:!?„”"'()«»–-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  /** Odległość edycyjna – literówka w dłuższym słowie nie odbiera punktów. */
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  function isCorrect(item, ans) {
    if (ans == null) return false;
    if (item.kind === "type") {
      const a = norm(ans), b = norm(item.answer);
      return Boolean(a) && (a === b || (b.length >= 5 && lev(a, b) <= 1));
    }
    return ans === item.answer;
  }

  const multiplier = (streak) => (streak >= 5 ? 2 : streak >= 3 ? 1.5 : 1);
  function points(ms, limitMs, streak) {
    const speed = Math.max(0, Math.min(1, 1 - ms / limitMs));
    return Math.round(((500 + 500 * speed) * multiplier(streak)) / 10) * 10;
  }

  /** Licznik gry jednego gracza (na komputerze albo po stronie serwera dla każdego tabletu). */
  function tally(items) {
    const st = { points: 0, correct: 0, answered: 0, total: items.length, streak: 0, best: 0, results: {}, startedAt: Date.now(), finishedAt: 0 };
    return {
      state: st,
      answer(i, ans, ms) {
        const it = items[i];
        if (!it) return null;
        if (st.results[i]) return st.results[i]; // druga odpowiedź na to samo pytanie się nie liczy
        const limit = (it.limit || 20) * 1000;
        ms = Number(ms);
        const late = !Number.isFinite(ms) || ms < 0 || ms > limit + 1500;
        const correct = !late && isCorrect(it, ans);
        st.streak = correct ? st.streak + 1 : 0;
        st.best = Math.max(st.best, st.streak);
        const pts = correct ? points(Math.min(ms, limit), limit, st.streak) : 0;
        st.points += pts;
        st.answered++;
        if (correct) st.correct++;
        if (st.answered >= st.total) st.finishedAt = Date.now();
        return (st.results[i] = { correct, points: pts, total: st.points, streak: st.streak, multiplier: multiplier(st.streak), answer: it.answer, answerText: it.answerText, timeout: ans == null || late });
      },
      summary() {
        return {
          points: st.points,
          correct: st.correct,
          answered: st.answered,
          total: st.total,
          best: st.best,
          seconds: Math.round(((st.finishedAt || Date.now()) - st.startedAt) / 1000),
          results: Object.fromEntries(Object.entries(st.results).map(([k, r]) => [k, r.correct])),
        };
      },
    };
  }

  // ------------------------------------------------------------------ interfejs (tylko w przeglądarce)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  const LETTERS = "ABCD";
  const fmt = (n) => Number(n || 0).toLocaleString("pl-PL");
  const plural = (n, a, b, c) => (n === 1 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? b : c);

  let audio = null;
  function beep(ok, muted) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      (ok ? [660, 880] : [220, 150]).forEach((f, k) => {
        const osc = audio.createOscillator(), g = audio.createGain();
        osc.type = ok ? "triangle" : "sawtooth";
        osc.frequency.value = f;
        const t = audio.currentTime + k * 0.12;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(ok ? 0.2 : 0.08, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(g).connect(audio.destination);
        osc.start(t);
        osc.stop(t + 0.22);
      });
    } catch (e) {}
  }

  /**
   * Uruchamia grę w elemencie root.
   * o: { title, items (bez odpowiedzi), check(i, ans, ms) → Promise<wynik>, name, askName, requireName,
   *      onStart(name), onFinish(summary) → Promise<{rank, of}>, allowReplay, onReplay(), onClose() }
   */
  function mount(root, o) {
    const items = o.items || [];
    const n = items.length;
    let i = 0, locked = false, timer = 0, advance = 0, t0 = 0, total = 0, streak = 0, correct = 0, best = 0, startedAt = 0;
    let name = o.name || "";
    let muted = false;
    let keys = null;
    root.classList.add("qz");

    const top = () =>
      h("div", { class: "qz-top" },
        h("div", { class: "qz-title" }, o.title || "Quiz"),
        h("button", { class: "qz-icon", title: "Dźwięk", onclick: (e) => { muted = !muted; e.currentTarget.textContent = muted ? "🔇" : "🔊"; } }, muted ? "🔇" : "🔊"),
        o.onClose ? h("button", { class: "qz-icon", title: "Zakończ quiz", onclick: () => o.onClose() }, "✕") : null);

    function screen(...kids) {
      clearTimeout(timer);
      clearTimeout(advance);
      root.replaceChildren(top(), h("div", { class: "qz-stage" }, ...kids));
      root.scrollTop = 0;
    }

    function intro() {
      keys = null;
      const err = h("div", { class: "qz-err" });
      const input = o.askName ? h("input", { class: "qz-name", placeholder: "Twoje imię", value: name, maxlength: "40", oninput: (e) => (name = e.target.value), onkeydown: (e) => e.key === "Enter" && go() }) : null;
      async function go() {
        if (o.requireName && !name.trim()) return void (err.textContent = "Wpisz swoje imię.");
        try {
          if (o.onStart) await o.onStart(name.trim());
        } catch (e) {
          return void (err.textContent = "Nie udało się połączyć z programem. Spróbuj jeszcze raz.");
        }
        countdown(3);
      }
      screen(h("div", { class: "qz-card qz-intro" },
        h("div", { class: "qz-badge" }, "🎮 Quiz"),
        h("h1", {}, o.title || "Quiz"),
        h("p", { class: "qz-muted" }, `${n} ${plural(n, "pytanie", "pytania", "pytań")} · na każde masz kilkanaście sekund`),
        h("ul", { class: "qz-rules" },
          h("li", {}, "⚡ Im szybciej odpowiesz, tym więcej punktów."),
          h("li", {}, "🔥 Seria dobrych odpowiedzi mnoży punkty: 3 z rzędu ×1,5, a 5 z rzędu ×2."),
          h("li", {}, "⏱ Gdy skończy się czas, pytanie przepada.")),
        input, err,
        h("button", { class: "qz-btn qz-go", onclick: go }, "Start!")));
      if (input) setTimeout(() => input.focus(), 50);
    }

    function countdown(k) {
      if (k === 0) {
        startedAt = Date.now();
        return question();
      }
      screen(h("div", { class: "qz-count3" }, String(k)));
      timer = setTimeout(() => countdown(k - 1), 650);
    }

    function hud() {
      const mult = streak >= 5 ? 2 : streak >= 3 ? 1.5 : 1;
      return h("div", { class: "qz-hud" },
        h("span", { class: "qz-count" }, `Pytanie ${i + 1} / ${n}`),
        h("span", { class: "qz-streak" + (streak >= 3 ? " hot" : "") }, streak ? `🔥 ${streak}${mult > 1 ? ` · ×${String(mult).replace(".", ",")}` : ""}` : ""),
        h("span", { class: "qz-score" }, `${fmt(total)} pkt`));
    }

    function question() {
      const it = items[i];
      locked = false;
      const fill = h("div", { class: "qz-timefill" });
      const bar = h("div", { class: "qz-timebar" }, fill);
      const q = h("div", { class: "qz-q" }, it.sub ? h("div", { class: "qz-sub" }, it.sub) : null, h("div", { class: "qz-prompt" }, it.prompt), it.figure ? h("img", { class: "qz-fig", src: it.figure, alt: "" }) : null);
      let answers;
      if (it.kind === "type") {
        const inp = h("input", { class: "qz-answer", placeholder: "Wpisz odpowiedź…", autocomplete: "off", autocapitalize: "off", spellcheck: "false", onkeydown: (e) => e.key === "Enter" && answer(inp.value) });
        answers = h("div", { class: "qz-type" }, inp, h("button", { class: "qz-btn", onclick: () => answer(inp.value) }, "Sprawdź"));
        setTimeout(() => inp.focus(), 50);
        keys = null;
      } else {
        const opts = it.kind === "tf" ? ["Prawda", "Fałsz"] : it.options;
        answers = h("div", { class: "qz-tiles" + (it.kind === "tf" ? " tf" : "") },
          opts.map((txt, k) => {
            const val = it.kind === "tf" ? k === 0 : k;
            return h("button", { class: `qz-tile c${it.kind === "tf" ? (k === 0 ? 2 : 3) : k % 4}`, "data-k": String(k), onclick: () => answer(val, k) },
              h("span", { class: "qz-l" }, it.kind === "tf" ? (k === 0 ? "P" : "F") : LETTERS[k]), h("span", { class: "qz-t" }, txt));
          }));
        keys = (e) => {
          const key = e.key.toLowerCase();
          if (it.kind === "tf" && (key === "p" || key === "f")) answer(key === "p", key === "p" ? 0 : 1);
          const k = "1234".indexOf(key) >= 0 ? "1234".indexOf(key) : "abcd".indexOf(key);
          if (it.kind !== "tf" && k >= 0 && k < opts.length) answer(k, k);
        };
      }
      screen(hud(), bar, q, answers, h("div", { class: "qz-slot" }));
      const limit = (it.limit || 20) * 1000;
      t0 = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          fill.style.transition = `width ${limit}ms linear`;
          fill.style.width = "0%";
        }));
      setTimeout(() => !locked && fill.classList.add("low"), limit * 0.7);
      timer = setTimeout(() => answer(null), limit);
    }

    async function answer(val, tileIndex) {
      if (locked) return;
      locked = true;
      keys = null;
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      const fill = root.querySelector(".qz-timefill");
      if (fill) {
        fill.style.width = getComputedStyle(fill).width;
        fill.style.transition = "none";
      }
      const tiles = root.querySelector(".qz-tiles");
      if (tiles && tileIndex != null) tiles.querySelector(`[data-k="${tileIndex}"]`).classList.add("chosen");
      root.querySelectorAll(".qz-tile, .qz-type button, .qz-type input").forEach((b) => (b.disabled = true));
      const slot = root.querySelector(".qz-slot");
      let r;
      for (;;) {
        try {
          r = await o.check(i, val, ms);
          if (r) break;
          throw new Error("brak wyniku");
        } catch (e) {
          slot.replaceChildren(h("div", { class: "qz-fb bad" }, "Brak połączenia z programem", h("div", {}, "Sprawdź Wi-Fi.")));
          await new Promise((res) => slot.append(h("button", { class: "qz-btn ghost", onclick: res }, "Spróbuj ponownie")));
          slot.replaceChildren();
        }
      }
      total = r.total;
      streak = r.streak;
      best = Math.max(best, streak);
      if (r.correct) correct++;
      const it = items[i];
      if (tiles) {
        tiles.classList.add("done");
        const rightK = it.kind === "tf" ? (r.answer ? 0 : 1) : r.answer;
        const rt = tiles.querySelector(`[data-k="${rightK}"]`);
        if (rt) rt.classList.add("right");
        if (tileIndex != null && !r.correct) tiles.querySelector(`[data-k="${tileIndex}"]`).classList.add("wrong");
      } else {
        const inp = root.querySelector(".qz-answer");
        if (inp) inp.classList.add(r.correct ? "right" : "wrong");
      }
      root.querySelector(".qz-hud").replaceWith(hud());
      beep(r.correct, muted);
      const last = i >= n - 1;
      const next = () => {
        clearTimeout(advance);
        i++;
        if (i < n) question();
        else finish();
      };
      slot.replaceChildren(
        h("div", { class: "qz-fb " + (r.correct ? "ok" : "bad") },
          r.correct ? `Dobrze! +${fmt(r.points)}` : r.timeout ? "⏱ Czas minął!" : "Niestety…",
          !r.correct ? h("div", {}, "Poprawnie: ", h("b", {}, r.answerText)) : streak >= 3 ? h("div", {}, `🔥 Seria ${streak}! Punkty ×${String(r.multiplier).replace(".", ",")}`) : null),
        h("button", { class: "qz-btn ghost qz-next", onclick: next }, last ? "Wynik →" : "Dalej →"));
      keys = (e) => (e.key === "Enter" || e.key === " ") && next();
      advance = setTimeout(next, r.correct ? 2200 : 3400);
    }

    async function finish() {
      keys = null;
      const summary = { points: total, correct, total: n, best, seconds: Math.round((Date.now() - startedAt) / 1000), name: name.trim() };
      screen(h("div", { class: "qz-card" }, h("div", { class: "qz-muted" }, "Liczę punkty…")));
      let extra = null;
      try {
        if (o.onFinish) extra = await o.onFinish(summary);
      } catch (e) {}
      const pct = n ? correct / n : 0;
      const stars = pct >= 0.9 ? 3 : pct >= 0.6 ? 2 : pct >= 0.3 ? 1 : 0;
      const min = Math.floor(summary.seconds / 60), sec = summary.seconds % 60;
      screen(h("div", { class: "qz-card qz-end" },
        h("div", { class: "qz-badge" }, pct >= 0.9 ? "🏆 Mistrzostwo!" : pct >= 0.6 ? "🎉 Świetnie!" : "💪 Dobra robota!"),
        h("div", { class: "qz-stars" }, [0, 1, 2].map((k) => h("span", { class: k < stars ? "" : "off" }, "★"))),
        h("div", { class: "qz-big" }, `${fmt(total)} pkt`),
        extra && extra.rank ? h("p", { class: "qz-rank" }, extra.provisional ? `Na razie ${extra.rank}. miejsce z ${extra.of} – inni jeszcze grają` : `Miejsce: ${extra.rank} z ${extra.of}`) : null,
        h("div", { class: "qz-stats" },
          h("div", {}, h("b", {}, `${correct} / ${n}`), h("span", {}, "poprawne")),
          h("div", {}, h("b", {}, `🔥 ${best}`), h("span", {}, "najdłuższa seria")),
          h("div", {}, h("b", {}, `${min}:${String(sec).padStart(2, "0")}`), h("span", {}, "czas"))),
        h("div", { class: "qz-actions" },
          o.allowReplay && o.onReplay ? h("button", { class: "qz-btn", onclick: () => o.onReplay() }, "Zagraj jeszcze raz") : null,
          o.onClose ? h("button", { class: "qz-btn ghost", onclick: () => o.onClose(true) }, "Zakończ") : null)));
    }

    const onKey = (e) => {
      if (keys && !(e.target && e.target.tagName === "INPUT")) keys(e);
    };
    document.addEventListener("keydown", onKey);
    intro();

    return {
      destroy() {
        clearTimeout(timer);
        clearTimeout(advance);
        document.removeEventListener("keydown", onKey);
        root.replaceChildren();
        root.classList.remove("qz");
      },
    };
  }

  return { norm, isCorrect, points, multiplier, tally, mount };
});
