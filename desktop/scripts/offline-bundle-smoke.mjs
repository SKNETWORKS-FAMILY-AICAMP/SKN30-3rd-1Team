import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIST_INDEX = resolve("dist/index.html");
const DEBUG_PORT = 9341;
const USER_DATA_DIR = "/tmp/paim-offline-bundle-smoke";

const BROWSER_CANDIDATES = [
  process.env.PAIM_BROWSER_PATH,
  "/Applications/Whale.app/Contents/MacOS/Whale",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// 테스트에 사용할 Chromium 계열 브라우저 실행 파일을 찾는다.
function findBrowserPath() {
  const browserPath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));

  if (!browserPath) {
    throw new Error("No supported Chromium browser found. Set PAIM_BROWSER_PATH.");
  }

  return browserPath;
}

// Chrome DevTools Protocol 포트가 열릴 때까지 기다린다.
async function waitForDebuggingPort() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // 브라우저가 뜨는 중이면 다음 polling에서 다시 확인한다.
    }

    await sleep(100);
  }

  throw new Error("Timed out waiting for headless browser debugging port");
}

// CDP 요청/응답을 Promise 형태로 보낸다.
function createCdpClient(ws) {
  let nextId = 1;

  return function send(method, params = {}) {
    const id = nextId;
    nextId += 1;
    ws.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const message = JSON.parse(event.data.toString());
        if (message.id !== id) {
          return;
        }

        ws.removeEventListener("message", onMessage);

        if (message.error) {
          reject(new Error(`${method}: ${message.error.message}`));
          return;
        }

        resolve(message.result);
      };

      ws.addEventListener("message", onMessage);
    });
  };
}

// 빌드 HTML이 서버 루트 경로 대신 상대 asset 경로를 사용하는지 확인한다.
function assertRelativeAssets() {
  const indexHtml = readFileSync(DIST_INDEX, "utf8");

  if (indexHtml.includes('src="/assets/') || indexHtml.includes('href="/assets/')) {
    throw new Error("dist/index.html should use relative asset paths for offline loading");
  }
}

const browserPath = findBrowserPath();

if (!existsSync(DIST_INDEX)) {
  throw new Error("dist/index.html does not exist. Run npm run build first.");
}

assertRelativeAssets();
rmSync(USER_DATA_DIR, { recursive: true, force: true });

const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--allow-file-access-from-files",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${USER_DATA_DIR}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], {
  stdio: "ignore",
});

try {
  await waitForDebuggingPort();

  const fileUrl = pathToFileURL(DIST_INDEX).href;
  const tab = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${fileUrl}`, {
    method: "PUT",
  }).then((response) => response.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const send = createCdpClient(ws);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: fileUrl });
  await sleep(900);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      protocol: location.protocol,
      hasShell: Boolean(document.querySelector('.app-shell')),
      hasPrompt: Boolean(document.querySelector('.prompt')),
      hasSidebar: Boolean(document.querySelector('.sidebar')),
      hasProjectStart: Boolean(document.querySelector('.project-start')),
      watermarkAlt: document.querySelector('.project-start-watermark')?.getAttribute('alt') || '',
      startButtonText: document.querySelector('.project-start-button')?.textContent.trim() || '',
      text: document.body.textContent,
      scrollWidth: document.documentElement.scrollWidth,
    }))()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.protocol !== "file:") {
    failures.push(`offline smoke should load file://, got ${value.protocol}`);
  }

  if (!value.hasShell || !value.hasSidebar) {
    failures.push("offline bundle should render the app shell and sidebar");
  }

  if (value.hasPrompt) {
    failures.push("offline bundle should not render chat prompt before a project exists");
  }

  if (
    !value.hasProjectStart ||
    value.watermarkAlt !== "PaiM AI Project Manager" ||
    !value.startButtonText.includes("새 프로젝트 시작하기") ||
    !value.text.includes("New Project")
  ) {
    failures.push("offline bundle should render the empty first-run project start UI");
  }

  if (value.scrollWidth > 1280) {
    failures.push(`offline bundle should not overflow horizontally: ${value.scrollWidth} > 1280`);
  }

  ws.close();

  if (failures.length > 0) {
    console.log("FAIL offline bundle smoke");
    failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exitCode = 1;
  } else {
    console.log("PASS offline bundle loads from file:// without a dev server");
  }
} finally {
  browser.kill("SIGTERM");
  setTimeout(() => browser.kill("SIGKILL"), 1000).unref();
}
