// На странице онбординга (meta-тег) будим service worker, чтобы он поздоровался
// с приложением: fetch отсюда шёл бы с http-origin страницы, а не от расширения.

const MARKER = 'meta[name="rechiv-onboarding"]';

if (document.querySelector(MARKER)) {
  chrome.runtime.sendMessage({ action: "announcePresence" }).catch(() => {
    // Worker не поднялся — страница опросит приложение сама.
  });
}
