// Снимает страницы запущенного Rechiv через Chrome DevTools Protocol, без зависимостей.
//
//   node scripts/screenshots/capture.mjs <адрес приложения> <id созвона> <тема> <каталог>

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base, sessionId, theme, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error("использование: capture.mjs <адрес> <id созвона> <light|dark> <каталог>");
  process.exit(2);
}

const WIDTH = 1280;
const HEIGHT = 800;
const SCALE = 2;

const shots = [
  { name: "history", path: "/", ready: "#sessions .session-title" },
  { name: "transcript", path: `/transcript.html?sessionId=${sessionId}`, ready: "#segments .segment" },
  {
    name: "summary",
    path: `/transcript.html?sessionId=${sessionId}`,
    ready: "#segments .segment",
    action: `document.querySelector('[data-tab="summary"]').click()`,
    after: "#summary-content:not(.hidden) h1",
  },
  {
    name: "onboarding",
    path: "/onboarding.html",
    ready: "#extension-dir:not([hidden])",
    action: `document.getElementById("extension-dir").textContent = "~/Library/Application Support/Rechiv/extension";
      document.getElementById("btn-open-extensions").textContent = "Открыть расширения в Google Chrome";`,
    after: "#steps",
  },
];

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("не нашёл Chrome или Brave, укажите CHROME");
  return found;
}

function launch() {
  const profile = mkdtempSync(join(tmpdir(), "rechiv-shots-"));
  const browser = spawn(findChrome(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  const endpoint = new Promise((resolve, reject) => {
    let log = "";
    browser.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    browser.on("exit", () => reject(new Error(`браузер завершился:\n${log}`)));
  });
  return { browser, profile, endpoint };
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return new Promise((resolve) => socket.addEventListener("open", () => resolve({ socket, send })));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(send, session, selector) {
  for (let i = 0; i < 100; i++) {
    const { result } = await send(
      "Runtime.evaluate",
      { expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`, returnByValue: true },
      session,
    );
    if (result.value) return;
    await sleep(100);
  }
  throw new Error(`не дождался ${selector}`);
}

const { browser, profile, endpoint } = launch();
try {
  const { socket, send } = await connect(await endpoint);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, page);
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false }, page);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, page);

  for (const shot of shots) {
    await send("Page.navigate", { url: base + shot.path }, page);
    await waitFor(send, page, shot.ready);
    if (shot.action) {
      await send("Runtime.evaluate", { expression: shot.action }, page);
      await waitFor(send, page, shot.after);
    }
    // Шрифты и переходы тем.
    await sleep(800);
    const { data } = await send("Page.captureScreenshot", { format: "png" }, page);
    const file = join(outDir, `${shot.name}-${theme}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
  }
  socket.close();
} finally {
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  browser.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
