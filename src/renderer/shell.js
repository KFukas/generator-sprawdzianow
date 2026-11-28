"use strict";
// Pasek boczny (sekcje programu) i menu nad kartką. Ładowany jako ostatni.

// sekcje bez własnej obsługi kliknięcia (Nauka, Biblioteka i Historia mają ją w features*.js)
$("#nav-test").addEventListener("click", () => showView("test"));
$("#nav-class").addEventListener("click", () => showClassView());
$("#nav-profiles").addEventListener("click", () => openProfiles());

// ---------- menu rozwijane ----------
const MENU_ACTIONS = {
  tablet: () => openTablet(),
  quiz: () => startQuiz(),
  class: () => showClassView(),
  paper: () => openPaper(),
  groupb: () => openGroupB(),
  new: () => newTest(),
};

function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.classList.add("hidden"));
  document.querySelectorAll("[data-menu]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[data-menu]");
  if (trigger) {
    const menu = document.getElementById(trigger.dataset.menu);
    const willOpen = menu.classList.contains("hidden");
    closeMenus();
    if (willOpen) {
      menu.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
    }
    return;
  }
  const item = e.target.closest(".menu button");
  closeMenus();
  if (!item || item.disabled) return;
  const act = item.dataset.act;
  if (act && MENU_ACTIONS[act]) {
    if (state.generating && act !== "new") return toast("Poczekaj, aż AI skończy układać zadania.", true);
    MENU_ACTIONS[act]();
  }
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenus());

// Grupa B w menu „⋯” – nieaktywna, gdy sprawdzian ma już dwie grupy
const prevSyncChromeShell = syncChrome;
syncChrome = function () {
  prevSyncChromeShell();
  const t = state.test;
  const gb = document.querySelector('#more-menu [data-act="groupb"]');
  if (gb) gb.disabled = !t || !t.questions.length || Boolean(t.groups);
  document.querySelectorAll('#share-menu button').forEach((b) => (b.disabled = !t || !t.questions.length));
};
syncChrome();
