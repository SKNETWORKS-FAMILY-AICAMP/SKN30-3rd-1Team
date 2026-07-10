import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const APP_URL = "http://127.0.0.1:1420/";
const LEGACY_STORAGE_KEY = "paim.chatSessions.v2";
const PROJECT_STORAGE_KEY = "paim.projects.v8";
const SIDEBAR_STORAGE_KEY = "paim.sidebarCollapsed.v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "paim.sidebarWidth.v1";
const PROJECT_PANEL_COLLAPSED_STORAGE_KEY = "paim.projectPanelCollapsed.v2";
const PROJECT_PANEL_WIDTH_STORAGE_KEY = "paim.projectPanelWidth.v1";
const PROJECT_COLLAPSED_STORAGE_KEY = "paim.projectCollapsed.v1";
const GITHUB_CLIENT_ID_STORAGE_KEY = "paim.githubClientId.v1";
const VITE_BIN = "node_modules/vite/bin/vite.js";
const DEBUG_PORT = 9336;
const USER_DATA_DIR = "/tmp/paim-layout-smoke";

const BROWSER_CANDIDATES = [
  process.env.PAIM_BROWSER_PATH,
  "/Applications/Whale.app/Contents/MacOS/Whale",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

const scenarios = [
  { width: 1280, height: 820, collapsed: false, dragActive: false },
  { width: 1280, height: 820, collapsed: true, dragActive: false },
  { width: 960, height: 680, collapsed: false, dragActive: false },
  { width: 960, height: 680, collapsed: true, dragActive: false },
  { width: 960, height: 680, collapsed: true, dragActive: true },
  { width: 820, height: 680, collapsed: false, dragActive: true },
  { width: 520, height: 680, collapsed: false, dragActive: false },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROJECT_PANEL_TAB_ADD_SELECTOR = 'button.project-panel-tab-add[aria-label="패널 탭 추가"]';
const PROJECT_PANEL_TAB_MENU_ITEM_SELECTOR = '[role="menuitem"]';
const DEBUG_LAYOUT = process.env.PAIM_LAYOUT_DEBUG === "1";

function debugLayout(label, value) {
  if (!DEBUG_LAYOUT) {
    return;
  }

  console.log(`DEBUG ${label} ${JSON.stringify(value, null, 2)}`);
}

function createPaimApiMockScript() {
  return `
    (() => {
      if (window.__paimLayoutApiMockInstalled) {
        return;
      }

      window.__paimLayoutApiMockInstalled = true;
      window.__paimLayoutApiCalls = [];
      const originalFetch = window.fetch.bind(window);
      const serverSessionsByProject = new Map();
      let nextProjectId = 1000;
      let nextSessionId = 1000;

      const json = (payload, status = 200) =>
        Promise.resolve(new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        }));
      const empty = () => Promise.resolve(new Response(null, { status: 204 }));
      const readJson = async (init) => {
        try {
          return JSON.parse(init?.body || "{}");
        } catch {
          return {};
        }
      };
      const readStoredServerProjects = () => {
        try {
          const savedState = JSON.parse(
            localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || "{}",
          );
          return (savedState.projects || [])
            .filter((project) => typeof project.apiProjectId === "number" && !project.serverMissing)
            .map((project) => ({
              id: project.apiProjectId,
              name: project.name || "Smoke Project",
              created_at: new Date(project.createdAt || Date.now()).toISOString(),
            }));
        } catch {
          return [];
        }
      };

      window.fetch = async (input, init = {}) => {
        const rawUrl = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        let url;

        try {
          url = new URL(rawUrl, window.location.origin);
        } catch {
          return originalFetch(input, init);
        }

        const method = String(
          init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"),
        ).toUpperCase();

        if (url.hostname !== "127.0.0.1" || url.port !== "8000") {
          return originalFetch(input, init);
        }

        window.__paimLayoutApiCalls.push(method + " " + url.pathname + url.search);
        if (window.__paimLayoutApiCalls.length > 80) {
          window.__paimLayoutApiCalls.shift();
        }

        if (url.pathname === "/health") {
          return json({ status: "ok" });
        }

        if (url.pathname === "/api/v1/projects") {
          if (method === "GET") {
            return json(readStoredServerProjects());
          }

          if (method === "POST") {
            const body = await readJson(init);
            const id = nextProjectId;
            nextProjectId += 1;
            return json({ id, name: body.name || "Smoke Project" });
          }
        }

        const projectSessionMatch = url.pathname.match(/^\\/api\\/v1\\/projects\\/(\\d+)\\/sessions$/);
        if (projectSessionMatch && method === "GET") {
          return json(serverSessionsByProject.get(Number(projectSessionMatch[1])) || []);
        }

        if (projectSessionMatch && method === "POST") {
          const body = await readJson(init);
          const projectId = Number(projectSessionMatch[1]);
          const id = "smoke-session-" + nextSessionId;
          nextSessionId += 1;
          const session = {
            id,
            project_id: projectId,
            title: body.title || "New Chat",
          };
          serverSessionsByProject.set(projectId, [
            ...(serverSessionsByProject.get(projectId) || []),
            session,
          ]);
          return json(session);
        }

        const sessionPathMatch = url.pathname.match(
          /^\\/api\\/v1\\/projects\\/(\\d+)\\/sessions\\/([^/]+)$/,
        );
        if (sessionPathMatch && method === "PATCH") {
          const body = await readJson(init);
          return json({
            id: decodeURIComponent(sessionPathMatch[2]),
            project_id: Number(sessionPathMatch[1]),
            title: body.title || "New Chat",
          });
        }

        if (sessionPathMatch && method === "DELETE") {
          return empty();
        }

        if (/^\\/api\\/v1\\/projects\\/\\d+\\/sessions\\/[^/]+\\/messages$/.test(url.pathname)) {
          return json([]);
        }

        if (/^\\/api\\/v1\\/projects\\/\\d+\\/query$/.test(url.pathname) && method === "POST") {
          const body = await readJson(init);
          const question = body.question || "";
          const answer = question.includes("프로젝트의 목적")
            ? "프로젝트 설명: 분석 시작 테스트용 프로젝트 설명\\n다음 액션을 정리했습니다."
            : "좋아요. 이 내용을 프로젝트 메모로 정리할 수 있습니다.";

          return json({ answer, sources: [], route: "smoke" });
        }

        const memoryPathMatch = url.pathname.match(/^\\/api\\/v1\\/projects\\/(\\d+)\\/memory$/);
        if (memoryPathMatch && method === "GET") {
          const projectId = Number(memoryPathMatch[1]);
          return json([
            {
              id: 1,
              project_id: projectId,
              doc_id: 1,
              category: "decision",
              content: "프로젝트 메모리는 FastAPI에서 조회한다",
              topic: "아키텍처",
              owner: "PM",
              source: "meeting.md",
            },
            {
              id: 2,
              project_id: projectId,
              doc_id: 1,
              category: "action",
              content: "API 연결 상태를 확인한다",
              owner: "백엔드",
              source: "meeting.md",
            },
            {
              id: 3,
              project_id: projectId,
              doc_id: 1,
              category: "issue",
              content: "서버 미연결 상태에서는 메모리를 숨긴다",
              source: "meeting.md",
            },
            {
              id: 4,
              project_id: projectId,
              doc_id: 1,
              category: "risk",
              content: "프론트 임시 데이터가 실제 메모리처럼 보일 수 있다",
              source: "meeting.md",
            },
          ]);
        }

        if (/^\\/api\\/v1\\/projects\\/\\d+\\/suggestions$/.test(url.pathname)) {
          return json([]);
        }

        const projectPathMatch = url.pathname.match(/^\\/api\\/v1\\/projects\\/(\\d+)$/);
        if (projectPathMatch && method === "PATCH") {
          const body = await readJson(init);
          return json({
            id: Number(projectPathMatch[1]),
            name: body.name || "Smoke Project",
          });
        }

        if (projectPathMatch && method === "DELETE") {
          return empty();
        }

        if (/^\\/api\\/v1\\/projects\\/\\d+\\/documents$/.test(url.pathname)) {
          return json([]);
        }

        if (/^\\/api\\/v1\\/projects\\/\\d+\\/repositories$/.test(url.pathname)) {
          return json([]);
        }

        if (/^\\/api\\/v1\\/projects\\/\\d+\\/delta/.test(url.pathname)) {
          return json({
            summary: "",
            decisions: [],
            actions: [],
            risks: [],
            due_soon: [],
            overdue: [],
          });
        }

        return originalFetch(input, init);
      };
    })();
  `;
}

async function installPaimApiMock(send) {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: createPaimApiMockScript(),
  });
}

// 테스트 세션을 실제 앱 저장 구조인 프로젝트 단위 state로 감싼다.
function createProjectStorageState(projects, selectedProjectId, selectedSessionId) {
  return JSON.stringify({
    projects,
    selectedProjectId,
    selectedSessionId,
  });
}

function createProjectStorage(
  projectId,
  projectName,
  sessions,
  selectedSessionId = sessions[0]?.id,
  files = [],
  extraProjectFields = {},
) {
  return createProjectStorageState(
    [
      {
        ...extraProjectFields,
        id: projectId,
        name: projectName,
        files,
        createdAt: Date.now(),
        sessions,
      },
    ],
    projectId,
    selectedSessionId,
  );
}

async function openAppWithProject(send) {
  const seededProjectState = createProjectStorage(
    "project-smoke",
    "Smoke Project",
    [
      {
        id: "session-smoke",
        title: "Smoke Chat",
        createdAt: Date.now(),
        messages: [
          {
            id: "assistant-smoke",
            role: "assistant",
            content: "저장된 응답입니다.",
          },
        ],
      },
    ],
    "session-smoke",
    [],
    { apiProjectId: 1 },
  );

  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_COLLAPSED_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_WIDTH_STORAGE_KEY)}, '360'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
}

async function openAppWithoutProjects(send) {
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.removeItem(${JSON.stringify(PROJECT_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_COLLAPSED_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_WIDTH_STORAGE_KEY)}, '360'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
}

// 테스트에 사용할 Chromium 계열 브라우저 실행 파일을 찾는다.
function findBrowserPath() {
  const browserPath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));

  if (!browserPath) {
    throw new Error("No supported Chromium browser found. Set PAIM_BROWSER_PATH.");
  }

  return browserPath;
}

// Vite 서버가 요청을 받을 수 있을 때까지 기다린다.
async function waitForHttp(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // 서버가 뜨는 중이면 다음 polling에서 다시 확인한다.
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}`);
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

// 요소가 viewport 좌우 경계를 넘지 않는지 검사한다.
function assertInside(name, box, width, failures) {
  if (box.left < -0.5) {
    failures.push(`${name} left overflow: ${box.left}`);
  }

  if (box.right > width + 0.5) {
    failures.push(`${name} right overflow: ${box.right} > ${width}`);
  }
}

// 주어진 viewport와 UI 상태에서 프롬프트/버튼 레이아웃을 측정한다.
async function measureScenario(send, scenario) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: scenario.width,
    height: scenario.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);
  await send("Runtime.evaluate", {
    expression: `localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false')`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  if (scenario.collapsed) {
    await send("Runtime.evaluate", {
      expression: "document.querySelector('.sidebar-rail-avatar[data-active=\"true\"]')?.click()",
    });
    await sleep(200);
  }

  if (scenario.dragActive) {
    await send("Runtime.evaluate", {
      expression: "document.querySelector('.app-shell')?.setAttribute('data-drag-active', 'true')",
    });
  }

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const projectPanel = document.querySelector('.project-panel');
      const sidebarRail = document.querySelector('.sidebar-rail');
      const sidebarRailBox = sidebarRail?.getBoundingClientRect();
      const prompt = rect('.prompt');
      const actions = rect('.prompt-actions');
      const buttons = Array.from(document.querySelectorAll('.prompt-actions button')).map((button) => {
        const box = button.getBoundingClientRect();
        return {
          label: button.getAttribute('aria-label') || button.textContent.trim(),
          left: box.left,
          right: box.right,
          width: box.width,
        };
      });

      return {
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        prompt,
        actions,
        buttons,
        projectPanelVisible: Boolean(projectPanel) && getComputedStyle(projectPanel).display !== 'none',
        projectPanelMenuButtons: document.querySelectorAll('.project-panel-menu button').length,
        sidebarRailVisible: Boolean(sidebarRailBox?.width && sidebarRailBox?.height),
        settingsExists: Boolean(document.querySelector('.settings-float')),
      };
    })()`,
  });

  const value = result.result.value;
  const failures = [];

  if (value.scrollWidth > scenario.width) {
    failures.push(`document horizontal overflow: ${value.scrollWidth} > ${scenario.width}`);
  }

  if (value.bodyScrollWidth > scenario.width) {
    failures.push(`body horizontal overflow: ${value.bodyScrollWidth} > ${scenario.width}`);
  }

  assertInside("prompt", value.prompt, scenario.width, failures);
  assertInside("prompt actions", value.actions, scenario.width, failures);
  value.buttons.forEach((button) => assertInside(`button ${button.label}`, button, scenario.width, failures));

  if (value.actions.left < value.prompt.left - 0.5 || value.actions.right > value.prompt.right + 0.5) {
    failures.push("prompt actions exceed prompt bounds");
  }

  if (scenario.width > 860 && (!value.projectPanelVisible || value.projectPanelMenuButtons < 2)) {
    failures.push("project panel menu should be visible beside the chat");
  }

  if (scenario.width <= 860 && value.projectPanelVisible) {
    failures.push("project panel should collapse away on narrow layouts");
  }

  if (!value.sidebarRailVisible) {
    failures.push("sidebar rail should stay visible in narrow zoom-like layouts");
  }

  if (value.settingsExists) {
    failures.push("settings floating button should not exist");
  }

  return { scenario, value, failures };
}

// 저장 세션에서 이미지 data URL 미리보기가 제거되는지 확인한다.
async function verifyStorageSanitization(send) {
  const seededSessions = [
    {
      id: "session-storage-smoke",
      title: "Storage smoke",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-storage-smoke",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-storage-smoke",
          role: "user",
          content: "첨부 저장 테스트",
          attachments: [
            {
              id: "attachment-storage-smoke",
              name: "preview.png",
              path: "/tmp/preview.png",
              previewUrl: "data:image/png;base64,AAAA",
            },
          ],
        },
      ],
    },
  ];

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  const seededProjectState = createProjectStorage(
    "project-storage-smoke",
    "Storage Smoke",
    seededSessions,
  );
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedValue = localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || "";
      return {
        containsPreviewUrl: savedValue.includes("previewUrl"),
        containsDataUrl: savedValue.includes("data:image"),
        attachmentVisible: document.body.textContent.includes("preview.png"),
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.containsPreviewUrl || value.containsDataUrl) {
    failures.push("stored sessions should not include attachment preview data URLs");
  }

  if (!value.attachmentVisible) {
    failures.push("stored attachment name should remain visible after sanitization");
  }

  return { value, failures };
}

// 아이콘 버튼은 접근성 라벨과 hover tooltip을 함께 가져야 한다.
async function verifyIconButtonTooltips(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('button[aria-label]'))
      .map((button) => ({
        label: button.getAttribute('aria-label') || '',
      }))
      .filter((button) => button.label.trim().length === 0)`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.length > 0) {
    failures.push(`icon buttons missing accessible label: ${value.length}`);
  }

  return { value, failures };
}

// 첫 실행 빈 화면과 사이드바 기본 톤을 확인한다.
async function verifySidebarBrandTypography(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithoutProjects(send);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        };
      };
      const fontSize = (selector) => {
        const element = document.querySelector(selector);
        return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
      };
      const sidebar = box('.sidebar');
      const rail = box('.sidebar-rail');
      const panel = box('.sidebar-panel');
      const shell = box('.app-shell');
      const chromeHeight = Number.parseFloat(
        getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--chrome-height'),
      );
      const projectCreate = box('.sidebar-rail .project-create-trigger');
      const watermark = box('.project-start-watermark');

      return {
        rootFont: getComputedStyle(document.documentElement).fontFamily,
        codeFont: getComputedStyle(document.documentElement).getPropertyValue('--code-font-family'),
        hasSidebarBrand: Boolean(document.querySelector('.sidebar-brand')),
        hasPrompt: Boolean(document.querySelector('.prompt')),
        hasMessage: Boolean(document.querySelector('.message')),
        watermark,
        watermarkAlt: document.querySelector('.project-start-watermark')?.getAttribute('alt') || "",
        startButtonText: document.querySelector('.project-start-button')?.textContent.trim() || "",
        rail,
        panel,
        projectCreate,
        shell,
        chromeHeight,
        sidebar,
        railFontSize: fontSize('.sidebar-rail-avatar'),
        navFontSize: fontSize('.history-item'),
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.rootFont.includes("Geist Sans")) {
    failures.push(`Geist Sans should be the first configured app font: ${value.rootFont}`);
  }

  if (!value.codeFont.includes("Geist Mono")) {
    failures.push(`Geist Mono should be the first configured code font: ${value.codeFont}`);
  }

  if (value.hasSidebarBrand) {
    failures.push("sidebar should not render the watermark logo");
  }

  if (value.hasPrompt || value.hasMessage) {
    failures.push("empty first-run state should not render chat UI");
  }

  if (value.watermarkAlt !== "PaiM AI Project Manager" || value.watermark.width < 180) {
    failures.push("empty first-run state should center the app watermark");
  }

  if (!value.startButtonText.includes("새 프로젝트 시작하기")) {
    failures.push("empty first-run state should render the start project button");
  }

  if (Math.abs(value.rail.width - 52) > 1 || value.rail.left < value.sidebar.left) {
    failures.push("sidebar rail should own the compact project switcher column");
  }

  if (value.panel.top < value.shell.top + value.chromeHeight - 1) {
    failures.push("sidebar panel should start below the app chrome, not under macOS traffic lights");
  }

  if (value.projectCreate.left < value.rail.left || value.projectCreate.right > value.rail.right) {
    failures.push("new project action should stay inside the rail");
  }

  if (value.railFontSize !== null && value.railFontSize > 11) {
    failures.push("sidebar rail avatar text should stay compact");
  }

  if (value.navFontSize !== null && value.navFontSize > 13.5) {
    failures.push("sidebar panel text should stay compact");
  }

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-start-button')?.click()`,
  });
  await sleep(250);
  const afterStartResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);
      const selectedSession = activeProject?.sessions.find(
        (session) => session.id === savedState.selectedSessionId,
      );
      return {
        projectCount: savedState.projects?.length ?? 0,
        activeProjectName: document.querySelector('.chrome-project-switch span')?.textContent.trim() || "",
        activeSessionCount: activeProject?.sessions.length ?? 0,
        selectedSessionMessageCount: selectedSession?.messages.length ?? -1,
        selectedSessionId: savedState.selectedSessionId ?? null,
        hasPrompt: Boolean(document.querySelector('.prompt')),
        messageCount: document.querySelectorAll('.message').length,
        emptyTitle: document.querySelector('.chat-empty h1')?.textContent.trim() || "",
        hasProjectHome: Boolean(document.querySelector('.project-home')),
        uploadText: document.querySelector('.project-home-canvas-empty')?.textContent.trim() || "",
        analysisDisabled: Boolean(document.querySelector('.project-home-primary')?.disabled),
        panelMenuTexts: Array.from(document.querySelectorAll('.project-panel-menu button'))
          .map((button) => button.textContent.trim()),
        hasProjectOverview: Boolean(document.querySelector('.project-overview')),
        hasProjectPanel: Boolean(document.querySelector('.project-panel')),
        hasOverviewPrompt: Boolean(document.querySelector('input[aria-label="프로젝트 질문 입력"]')),
      };
    })()`,
  });
  value.afterStart = afterStartResult.result.value;

  if (value.afterStart.projectCount !== 1 ||
      value.afterStart.activeProjectName !== "New Project 1" ||
      value.afterStart.activeSessionCount !== 0 ||
      value.afterStart.selectedSessionMessageCount !== -1 ||
      value.afterStart.selectedSessionId !== null ||
      value.afterStart.hasPrompt ||
      value.afterStart.messageCount !== 0 ||
      value.afterStart.emptyTitle !== "" ||
      !value.afterStart.hasProjectHome ||
      !value.afterStart.uploadText.includes("자료를 여기에 끌어다 놓으세요") ||
      !value.afterStart.analysisDisabled ||
      value.afterStart.panelMenuTexts.some((text) => text.includes("메모리")) ||
      value.afterStart.hasProjectOverview ||
      value.afterStart.hasProjectPanel ||
      value.afterStart.hasOverviewPrompt) {
    failures.push("start project button should create the first project and enter project home");
  }

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-home textarea')?.focus()`,
  });
  await send("Input.insertText", { text: "설명 입력 테스트" });
  await sleep(250);
  const descriptionInputResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);

      return {
        hasProjectHome: Boolean(document.querySelector('.project-home')),
        storedDescription: activeProject?.description || "",
        textareaValue: document.querySelector('.project-home textarea')?.value || "",
      };
    })()`,
  });
  value.descriptionInput = descriptionInputResult.result.value;

  if (!value.descriptionInput.hasProjectHome ||
      value.descriptionInput.storedDescription !== "설명 입력 테스트" ||
      value.descriptionInput.textareaValue !== "설명 입력 테스트") {
    failures.push("project description input should update state without crashing");
  }

  value.afterStartTabAddMenuTexts = [];

  return { value, failures };
}

// 응답 복사 버튼이 성공 피드백 상태로 바뀌는지 확인한다.
async function verifyCopyFeedback(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);
  await send("Runtime.evaluate", {
    expression: `Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__paimCopiedText = text;
        },
      },
    })`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.copy-button')?.click()`,
  });
  await sleep(120);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const copiedButton = document.querySelector('.copy-button[data-copied="true"]');
      return {
        hasCopiedState: Boolean(copiedButton),
        copiedLabel: copiedButton?.getAttribute('aria-label') || "",
        copiedText: window.__paimCopiedText || "",
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.hasCopiedState) {
    failures.push("copy button should enter the copied state");
  }

  if (value.copiedLabel !== "복사됨") {
    failures.push("copy button should expose copied feedback label");
  }

  if (!value.copiedText.includes("저장된 응답입니다.")) {
    failures.push("copy action should write the assistant response text");
  }

  return { value, failures };
}

// 공백 없는 긴 프로젝트명/파일명/메시지가 전체 가로 레이아웃을 밀지 않는지 확인한다.
async function verifyLongContentLayout(send) {
  const longToken =
    "PAIM_SUPER_LONG_PROJECT_IDENTIFIER_WITHOUT_BREAKS_1234567890_".repeat(5);
  const seededSessions = [
    {
      id: "session-long-content",
      title: longToken,
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-long-content",
          role: "assistant",
          content: `${longToken}\n${longToken}`,
        },
        {
          id: "user-long-content",
          role: "user",
          content: longToken,
          attachments: [
            {
              id: "attachment-long-content",
              name: `${longToken}.png`,
              path: `/tmp/${longToken}.png`,
            },
          ],
        },
      ],
    },
  ];

  await send("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  const seededProjectState = createProjectStorage(
    "project-long-content",
    longToken,
    seededSessions,
  );
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const overflowingMessages = Array.from(document.querySelectorAll('.message-content'))
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          role: element.closest('.message')?.getAttribute('data-role') || "",
          messageWidth: element.closest('.message')?.getBoundingClientRect().width ?? 0,
          conversationWidth: document.querySelector('.conversation')?.getBoundingClientRect().width ?? 0,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          text: element.textContent.slice(0, 24),
        }));

      return {
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        overflowingMessages,
        historyWidth: document.querySelector('.history-item')?.getBoundingClientRect().width ?? 0,
        attachmentVisible: document.body.textContent.includes('.png'),
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.scrollWidth > 820) {
    failures.push(`document horizontal overflow with long content: ${value.scrollWidth} > 820`);
  }

  if (value.bodyScrollWidth > 820) {
    failures.push(`body horizontal overflow with long content: ${value.bodyScrollWidth} > 820`);
  }

  if (value.overflowingMessages.length > 0) {
    failures.push(
      `message content should wrap long unbroken text: ${JSON.stringify(value.overflowingMessages)}`,
    );
  }

  if (!value.attachmentVisible) {
    failures.push("long attachment name should remain represented in the message");
  }

  return { value, failures };
}

// 채팅 세션이 전역 목록이 아니라 선택된 프로젝트 안에서만 관리되는지 확인한다.
async function verifyProjectScopedSessions(send) {
  const alphaSessions = [
    {
      id: "session-alpha",
      title: "Alpha Kickoff",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-alpha",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-alpha",
          role: "user",
          content: "Alpha 프로젝트 일정 확인",
        },
      ],
    },
  ];
  const betaSessions = [
    {
      id: "session-beta",
      title: "Beta Risk Review",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-beta",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-beta",
          role: "user",
          content: "Beta 프로젝트 리스크 확인",
        },
      ],
    },
  ];
  const seededProjectState = createProjectStorageState(
    [
      {
        id: "project-alpha",
        name: "Alpha Project",
        createdAt: Date.now(),
        sessions: alphaSessions,
      },
      {
        id: "project-beta",
        name: "Beta Project",
        createdAt: Date.now() - 1,
        sessions: betaSessions,
      },
    ],
    "project-alpha",
    "session-alpha",
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const initialResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      projectNames: Array.from(document.querySelectorAll('.sidebar-rail-avatar')).map((item) => item.getAttribute('title') || item.textContent.trim()),
      visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
      activeProject: document.querySelector('.sidebar-rail-avatar[data-active="true"]')?.getAttribute('title') || "",
      activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
    }))()`,
  });

  await send("Input.insertText", { text: "프로젝트 전환 후 비워져야 하는 초안" });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sidebar-rail-avatar[title="Beta Project"]')?.click()`,
  });
  await sleep(250);

  const switchResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
      activeProject: document.querySelector('.sidebar-rail-avatar[data-active="true"]')?.getAttribute('title') || "",
      activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
      selectedSessionId: JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}').selectedSessionId ?? null,
      hasPrompt: Boolean(document.querySelector('.prompt')),
      hasProjectOverview: Boolean(document.querySelector('.project-overview')),
      conversationText: document.querySelector('.conversation')?.textContent || "",
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sidebar-section-head .project-chat-create-button')?.click()`,
  });
  await sleep(250);

  const newChatResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const alpha = savedState.projects.find((project) => project.id === 'project-alpha');
      const beta = savedState.projects.find((project) => project.id === 'project-beta');

      return {
        alphaCount: alpha?.sessions.length ?? 0,
        betaCount: beta?.sessions.length ?? 0,
        betaHasNewChat: Boolean(beta?.sessions.some((session) => session.title === 'New Chat')),
        visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        activeProject: document.querySelector('.sidebar-rail-avatar[data-active="true"]')?.getAttribute('title') || "",
        activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
      };
    })()`,
  });

  const initialValue = initialResult.result.value;
  const switchValue = switchResult.result.value;
  const newChatValue = newChatResult.result.value;
  const failures = [];

  if (!initialValue.projectNames.some((name) => name.includes("Alpha Project")) ||
      !initialValue.projectNames.some((name) => name.includes("Beta Project"))) {
    failures.push("project list should render both saved projects");
  }

  if (initialValue.activeProject !== "Alpha Project") {
    failures.push("saved selected project should be active on load");
  }

  if (!initialValue.visibleTitles.includes("Alpha Kickoff") ||
      initialValue.visibleTitles.includes("Beta Risk Review")) {
    failures.push("project panel should show only the selected project's chats");
  }

  if (initialValue.activeTitle !== "Alpha Kickoff") {
    failures.push("saved selected chat should be active on load");
  }

  if (switchValue.activeProject !== "Beta Project") {
    failures.push("project switch should activate the clicked project");
  }

  if (switchValue.activeTitle !== "Beta Risk Review" ||
      switchValue.selectedSessionId !== "session-beta" ||
      !switchValue.hasPrompt ||
      switchValue.hasProjectOverview) {
    failures.push("project switch should enter the clicked project's active chat");
  }

  if (!switchValue.visibleTitles.includes("Beta Risk Review") ||
      switchValue.visibleTitles.includes("Alpha Kickoff")) {
    failures.push("project panel should replace visible chats after switching projects");
  }

  if (!switchValue.conversationText.includes("Beta 프로젝트 리스크 확인") ||
      switchValue.conversationText.includes("Alpha 프로젝트 일정 확인")) {
    failures.push("project switch should show only the clicked project's chat");
  }

  if (newChatValue.alphaCount !== 1 || newChatValue.betaCount !== 2 || !newChatValue.betaHasNewChat) {
    failures.push("new chat should be created inside the selected project only");
  }

  if (newChatValue.activeProject !== "Beta Project" ||
      newChatValue.activeTitle !== "New Chat" ||
      !newChatValue.visibleTitles.includes("New Chat")) {
    failures.push("new project-scoped chat should appear as the active chat in the project tree");
  }

  return { value: { initialValue, switchValue, newChatValue }, failures };
}

// 새 프로젝트가 생성 즉시 선택되고 빈 채팅 세션을 포함하는지 확인한다.
async function verifyProjectCreationFlow(send) {
  const seededSessions = [
    {
      id: "session-existing-project",
      title: "Existing Planning",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-existing-project",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-existing-project",
          role: "user",
          content: "기존 프로젝트 계획",
        },
      ],
    },
  ];
  const seededProjectState = createProjectStorage(
    "project-existing",
    "Existing Project",
    seededSessions,
    "session-existing-project",
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  await send("Input.insertText", { text: "새 프로젝트 생성 후 남으면 안 되는 초안" });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-create-trigger')?.click()`,
  });
  await sleep(250);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProjectName = document.querySelector('.chrome-project-switch span')?.textContent.trim() || "";
      const activeProject = savedState.projects.find((project) => project.id === savedState.selectedProjectId);
      const selectedSession = activeProject?.sessions.find(
        (session) => session.id === savedState.selectedSessionId,
      );

      return {
        projectCount: savedState.projects.length,
        activeProjectName,
        activeProjectStoredName: activeProject?.name || "",
        activeProjectSessionCount: activeProject?.sessions.length ?? 0,
        selectedSessionMessageCount: selectedSession?.messages.length ?? -1,
        selectedSessionId: savedState.selectedSessionId ?? null,
        selectedSessionTitle: selectedSession?.title || "",
        visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        promptValue: document.querySelector('.prompt textarea')?.value ?? "",
        hasPrompt: Boolean(document.querySelector('.prompt')),
        messageCount: document.querySelectorAll('.message').length,
        emptyTitle: document.querySelector('.chat-empty h1')?.textContent.trim() || "",
        hasProjectHome: Boolean(document.querySelector('.project-home')),
        uploadText: document.querySelector('.project-home-canvas-empty')?.textContent.trim() || "",
        analysisDisabled: Boolean(document.querySelector('.project-home-primary')?.disabled),
        hasProjectOverview: Boolean(document.querySelector('.project-overview')),
        hasProjectPanel: Boolean(document.querySelector('.project-panel')),
        hasOverviewPrompt: Boolean(document.querySelector('input[aria-label="프로젝트 질문 입력"]')),
        hasCreateTrigger: Boolean(document.querySelector('.project-create-trigger')),
        hasCreateMenu: Boolean(document.querySelector('.project-create-menu')),
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.hasCreateTrigger) {
    failures.push("sidebar should expose a New Project trigger");
  }

  if (value.projectCount !== 2) {
    failures.push(`creating a project should add one project: ${value.projectCount}`);
  }

  if (value.activeProjectName !== "New Project 1" || value.activeProjectStoredName !== "New Project 1") {
    failures.push("newly created project should become the active project");
  }

  if (value.activeProjectSessionCount !== 0 ||
      value.selectedSessionMessageCount !== -1 ||
      value.selectedSessionId !== null ||
      value.selectedSessionTitle !== "") {
    failures.push("new project should be created without an automatic starter chat");
  }

  if (value.messageCount !== 0 ||
      value.emptyTitle !== "" ||
      !value.hasProjectHome ||
      !value.uploadText.includes("자료를 여기에 끌어다 놓으세요") ||
      !value.analysisDisabled) {
    failures.push("new project should show the project home upload step");
  }

  if (value.hasCreateMenu) {
    failures.push("project create menu should close after creating a project");
  }

  if (value.visibleTitles.includes("New Chat")) {
    failures.push("project tree should not add a starter chat before chat starts");
  }

  if (value.hasPrompt ||
      value.hasProjectOverview ||
      value.hasProjectPanel ||
      value.hasOverviewPrompt) {
    failures.push("new project should enter project home without chat or right panel");
  }

  if (value.promptValue !== "") {
    failures.push("draft text should clear when creating a project");
  }

  return { value, failures };
}

// 분석 시작은 숨겨진 사용자 프롬프트를 만들지 않고 브리핑 응답만 채팅에 연결해야 한다.
async function verifyProjectBriefingStartsWithoutVisiblePrompt(send) {
  const seededProjectState = createProjectStorage(
    "project-briefing",
    "Briefing Project",
    [],
    null,
    [],
    { description: "분석 시작 테스트용 프로젝트 설명" },
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-home-primary')?.click()`,
  });
  await sleep(1300);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);
      const selectedSession = activeProject?.sessions.find(
        (session) => session.id === savedState.selectedSessionId,
      );
      const storedMessages = selectedSession?.messages ?? [];

      return {
        selectedSessionTitle: selectedSession?.title || "",
        storedMessageCount: storedMessages.length,
        storedRoles: storedMessages.map((message) => message.role),
        storedText: storedMessages.map((message) => message.content).join("\\n"),
        visibleUserMessages: document.querySelectorAll('.message[data-role="user"]').length,
        visibleAssistantMessages: document.querySelectorAll('.message[data-role="assistant"]').length,
        hasBriefingCard: Boolean(document.querySelector('.message[data-briefing="true"]')),
        hasContextBar: Boolean(document.querySelector('.chat-context-bar')),
        hasProjectHome: Boolean(document.querySelector('.project-home')),
        hasPrompt: Boolean(document.querySelector('.prompt')),
        thinkingVisible: Boolean(document.querySelector('.thinking')),
        apiCalls: window.__paimLayoutApiCalls || [],
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.selectedSessionTitle !== "Project Briefing" ||
      value.storedMessageCount !== 1 ||
      value.storedRoles[0] !== "assistant" ||
      !value.storedText.includes("프로젝트 설명: 분석 시작 테스트용 프로젝트 설명")) {
    failures.push("project briefing should store only the assistant briefing response");
  }

  if (value.visibleUserMessages !== 0 ||
      value.visibleAssistantMessages !== 1 ||
      !value.hasBriefingCard ||
      !value.hasContextBar ||
      value.hasProjectHome ||
      !value.hasPrompt) {
    failures.push("project briefing should enter chat without rendering the generated user prompt");
  }

  debugLayout("project briefing", value);
  return { value, failures };
}

// ... 메뉴에서 프로젝트명과 채팅명을 변경할 수 있는지 확인한다.
async function verifyActionMenuRenameFlow(send) {
  const seededProjectState = createProjectStorage(
    "project-rename",
    "Rename Project",
    [
      {
        id: "session-rename",
        title: "Rename Chat",
        createdAt: Date.now(),
        messages: [
          {
            id: "assistant-rename",
            role: "assistant",
            content: "저장된 응답입니다.",
          },
        ],
      },
    ],
    "session-rename",
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.chrome-project-switch')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 56 })
    )`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `window.__projectActionMenuBox = (() => {
      const menu = document.querySelector('.item-action-menu');
      const shell = document.querySelector('.app-shell');
      if (!menu || !shell) return null;
      const menuRect = menu.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      return {
        left: menuRect.left,
        right: menuRect.right,
        top: menuRect.top,
        bottom: menuRect.bottom,
        shellLeft: shellRect.left,
        shellRight: shellRect.right,
        shellTop: shellRect.top,
        shellBottom: shellRect.bottom,
      };
    })()`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="rename-project"]')?.click()`,
  });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.chrome-project-rename-input input');
      input?.focus();
      input?.select();
    })()`,
  });
  await send("Input.insertText", { text: "Renamed Project" });
  await sleep(80);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(160);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.history-row[data-active="true"]')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 210, clientY: 245 })
    )`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="rename-session"]')?.click()`,
  });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.history-rename-editor .rename-input');
      input?.focus();
      input?.select();
    })()`,
  });
  await send("Input.insertText", { text: "Renamed Chat" });
  await sleep(80);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(160);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const project = savedState.projects.find((item) => item.id === 'project-rename');
      const session = project?.sessions.find((item) => item.id === 'session-rename');
      return {
        storedProjectName: project?.name || "",
        storedSessionTitle: session?.title || "",
        visibleProjectName: document.querySelector('.chrome-project-switch span')?.textContent.trim() || "",
        visibleSessionTitle: document.querySelector('.history-title')?.textContent.trim() || "",
        menuOpen: Boolean(document.querySelector('.item-action-menu')),
        projectMenuBox: window.__projectActionMenuBox,
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.storedProjectName !== "Renamed Project" ||
      value.visibleProjectName !== "Renamed Project") {
    failures.push("project action menu should rename the project");
  }

  if (value.storedSessionTitle !== "Renamed Chat" ||
      value.visibleSessionTitle !== "Renamed Chat") {
    failures.push("session action menu should rename the chat");
  }

  if (value.menuOpen) {
    failures.push("action menu should close after rename");
  }

  if (!value.projectMenuBox ||
      value.projectMenuBox.left < value.projectMenuBox.shellLeft ||
      value.projectMenuBox.right > value.projectMenuBox.shellRight ||
      value.projectMenuBox.top < value.projectMenuBox.shellTop ||
      value.projectMenuBox.bottom > value.projectMenuBox.shellBottom) {
    failures.push("project action menu should render inside the app shell bounds");
  }

  return { value, failures };
}

// 프로젝트 삭제 후 마지막 프로젝트까지 제거 가능한지 확인한다.
async function verifyProjectDeleteFlow(send) {
  const alphaSessions = [
    {
      id: "session-delete-project-alpha",
      title: "Alpha Delete Scope",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-delete-project-alpha",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
      ],
    },
  ];
  const betaSessions = [
    {
      id: "session-delete-project-beta",
      title: "Beta Delete Scope",
      createdAt: Date.now() - 1,
      messages: [
        {
          id: "assistant-delete-project-beta",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
      ],
    },
  ];
  const seededProjectState = createProjectStorageState(
    [
      {
        id: "project-delete-alpha",
        name: "Delete Alpha",
        createdAt: Date.now(),
        sessions: alphaSessions,
      },
      {
        id: "project-delete-beta",
        name: "Delete Beta",
        createdAt: Date.now() - 1,
        sessions: betaSessions,
      },
    ],
    "project-delete-beta",
    "session-delete-project-beta",
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  await send("Input.insertText", { text: "프로젝트 삭제 후 남으면 안 되는 초안" });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.chrome-project-menu-button')?.click()`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-project"]')?.click()`,
  });
  await sleep(120);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-project"]')?.click()`,
  });
  await sleep(250);
  const afterActiveDeleteResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      return {
        projectNames: savedState.projects.map((project) => project.name),
        selectedProjectId: savedState.selectedProjectId,
        selectedSessionId: savedState.selectedSessionId,
        activeProjectName: document.querySelector('.chrome-project-switch span')?.textContent.trim() || "",
        activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
        visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        promptValue: document.querySelector('.prompt textarea')?.value ?? "",
        hasProjectOverview: Boolean(document.querySelector('.project-overview')),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.chrome-project-menu-button')?.click()`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-project"]')?.click()`,
  });
  await sleep(120);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-project"]')?.click()`,
  });
  await sleep(250);
  const readEmptyProjectStateExpression = `(() => {
    const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
    const projects = savedState.projects || [];
    const textarea = document.querySelector('.prompt textarea');
    return {
      projectCount: projects.length,
      selectedProjectId: savedState.selectedProjectId ?? null,
      selectedSessionId: savedState.selectedSessionId ?? null,
      visibleProjectNames: Array.from(document.querySelectorAll('.project-name')).map((item) => item.textContent.trim()),
      visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
      hasPrompt: Boolean(textarea),
      hasMessage: Boolean(document.querySelector('.message')),
      hasProjectStart: Boolean(document.querySelector('.project-start')),
      startButtonText: document.querySelector('.project-start-button')?.textContent.trim() || "",
    };
  })()`;
  const afterLastDeleteResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: readEmptyProjectStateExpression,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  const afterReloadResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: readEmptyProjectStateExpression,
  });
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(PROJECT_STORAGE_KEY)}); localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)})`,
  });
  const value = {
    afterActiveDelete: afterActiveDeleteResult.result.value,
    afterLastDelete: afterLastDeleteResult.result.value,
    afterReload: afterReloadResult.result.value,
  };
  const failures = [];

  if (value.afterActiveDelete.projectNames.includes("Delete Beta")) {
    failures.push("deleted active project should be removed from storage");
  }

  if (value.afterActiveDelete.selectedProjectId !== "project-delete-alpha" ||
      value.afterActiveDelete.selectedSessionId !== "session-delete-project-alpha") {
    failures.push("selection should move to the remaining project's active chat after deleting the active project");
  }

  if (value.afterActiveDelete.activeProjectName !== "Delete Alpha" ||
      value.afterActiveDelete.activeTitle !== "Alpha Delete Scope" ||
      value.afterActiveDelete.hasProjectOverview) {
    failures.push("remaining project should become active and show chat");
  }

  if (value.afterActiveDelete.visibleTitles.includes("Beta Delete Scope")) {
    failures.push("deleted project's chats should disappear from the tree");
  }

  if (value.afterActiveDelete.promptValue !== "") {
    failures.push("draft text should clear after deleting the active project");
  }

  if (value.afterLastDelete.projectCount !== 0 ||
      value.afterLastDelete.selectedProjectId !== null ||
      value.afterLastDelete.selectedSessionId !== null) {
    failures.push("deleting the last project should leave no selected project");
  }

  if (value.afterLastDelete.visibleProjectNames.length !== 0 ||
      value.afterLastDelete.visibleTitles.length !== 0) {
    failures.push("deleted last project should disappear from the sidebar tree");
  }

  if (value.afterLastDelete.hasPrompt ||
      value.afterLastDelete.hasMessage ||
      !value.afterLastDelete.hasProjectStart ||
      !value.afterLastDelete.startButtonText.includes("새 프로젝트 시작하기")) {
    failures.push("empty project state should hide chat input and render the start screen");
  }

  if (value.afterReload.projectCount !== 0 ||
      value.afterReload.selectedProjectId !== null ||
      value.afterReload.selectedSessionId !== null) {
    failures.push("empty project state should persist after reload");
  }

  return { value, failures };
}

// 전송 전 첨부가 많아져도 프롬프트와 액션 버튼이 화면 안에 남는지 확인한다.
async function verifyDraftAttachmentTrayLayout(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const prompt = document.querySelector('.prompt');
      const actions = document.querySelector('.prompt-actions');
      const sampleImage =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

      if (!prompt || !actions) {
        return { hasPrompt: false };
      }

      const draft = document.createElement('div');
      draft.className = 'draft-attachments';
      draft.innerHTML = '<div class="attachment-list" aria-label="전송할 첨부 파일">' +
        Array.from({ length: 12 }, (_, index) =>
          '<div class="attachment-preview">' +
            '<img src="' + sampleImage + '" alt="첨부 미리보기" />' +
            '<span>very-long-project-attachment-preview-name-' + index + '.png</span>' +
            '<button class="remove-attachment-button" type="button" aria-label="첨부 제거">x</button>' +
          '</div>'
        ).join('') +
        '</div>';

      prompt.insertBefore(draft, actions);

      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        };
      };
      const promptBox = box(prompt);
      const draftBox = box(draft);
      const actionsBox = box(actions);
      const overflowingPreviews = Array.from(draft.querySelectorAll('.attachment-preview'))
        .filter((preview) => {
          const previewBox = preview.getBoundingClientRect();
          return previewBox.left < draftBox.left - 0.5 || previewBox.right > draftBox.right + 0.5;
        })
        .length;

      return {
        hasPrompt: true,
        scrollWidth: document.documentElement.scrollWidth,
        prompt: promptBox,
        draft: draftBox,
        actions: actionsBox,
        draftClientHeight: draft.clientHeight,
        draftScrollHeight: draft.scrollHeight,
        overflowingPreviews,
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.hasPrompt) {
    failures.push("prompt should render before draft attachment layout check");
    return { value, failures };
  }

  if (value.scrollWidth > 960) {
    failures.push(`document horizontal overflow with draft attachments: ${value.scrollWidth} > 960`);
  }

  if (value.prompt.top < 0 || value.prompt.bottom > 680) {
    failures.push(
      `prompt should remain inside viewport with draft attachments: ${value.prompt.top}-${value.prompt.bottom}`,
    );
  }

  if (value.draftClientHeight > 124) {
    failures.push(`draft attachment tray should stay compact: ${value.draftClientHeight} > 124`);
  }

  if (value.draftScrollHeight <= value.draftClientHeight) {
    failures.push("draft attachment tray should scroll internally when previews overflow");
  }

  if (value.actions.left < value.prompt.left - 0.5 || value.actions.right > value.prompt.right + 0.5) {
    failures.push("prompt actions should remain inside prompt with draft attachments");
  }

  if (value.overflowingPreviews > 0) {
    failures.push("draft attachment previews should not overflow the tray horizontally");
  }

  return { value, failures };
}

// 채팅 입력이 textarea이며 Enter/Shift+Enter 동작이 유지되는지 확인한다.
async function verifyMultilineInput(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);
  const initialResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const input = document.querySelector('.prompt textarea');
      const initialMessages = document.querySelectorAll('.message').length;

      if (!input) {
        return { hasTextarea: false };
      }

      input.focus();
      return { hasTextarea: true, initialMessages };
    })()`,
  });
  const initialValue = initialResult.result.value;
  const failures = [];

  if (!initialValue.hasTextarea) {
    failures.push("message input should render as textarea");
    return { value: initialValue, failures };
  }

  await send("Input.insertText", { text: "첫 줄" });
  await send("Input.insertText", { text: "\n둘째 줄" });
  await sleep(100);

  const newlineResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.querySelector('.prompt textarea').value`,
  });
  const afterShiftEnterValue = newlineResult.result.value;

  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(700);

  const submitResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const input = document.querySelector('.prompt textarea');
      return {
        afterShiftEnterValue: ${JSON.stringify(afterShiftEnterValue)},
        messagesAfterEnter: document.querySelectorAll('.message').length,
        textAfterEnter: input.value,
        userTextVisible: document.body.textContent.includes('첫 줄') &&
          document.body.textContent.includes('둘째 줄'),
        demoReplyVisible: document.body.textContent.includes('좋아요. 이 내용을 프로젝트 메모로 정리할 수 있습니다.'),
        runtimeErrorVisible: document.body.textContent.includes('응답 실패') ||
          document.body.textContent.includes('응답을 받지 못했습니다'),
        runtimeStatusVisible: Boolean(document.querySelector('.runtime-status')),
        initialMessages: ${initialValue.initialMessages},
      };
    })()`,
  });
  const value = submitResult.result.value;

  if (!afterShiftEnterValue.includes("\n")) {
    failures.push("Shift+Enter should keep a newline in the textarea");
  }

  if (value.messagesAfterEnter <= value.initialMessages) {
    failures.push("Enter should submit a new message");
  }

  if (value.textAfterEnter !== "") {
    failures.push("textarea should clear after submit");
  }

  if (!value.userTextVisible) {
    failures.push("submitted multiline text should be visible in the conversation");
  }

  if (!value.demoReplyVisible) {
    failures.push("frontend demo reply should appear without a local runtime");
  }

  if (value.runtimeErrorVisible) {
    failures.push("chat demo should not show a local runtime error");
  }

  if (value.runtimeStatusVisible) {
    failures.push("chat submit should not add a sidebar runtime status");
  }

  debugLayout("multiline input", value);
  return { value, failures };
}

// 우측 패널 메뉴가 프로젝트 보조 정보를 상세 화면으로 전환하는지 확인한다.
async function verifyProjectPanelMenu(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/projects/1/memory')) {
          return Promise.resolve(new Response(JSON.stringify([
            {
              id: 1,
              project_id: 1,
              doc_id: 1,
              category: 'decision',
              content: '프로젝트 메모리는 FastAPI에서 조회한다',
              topic: '아키텍처',
              owner: 'PM',
              source: 'meeting.md',
            },
            {
              id: 2,
              project_id: 1,
              doc_id: 1,
              category: 'action',
              content: 'API 연결 상태를 확인한다',
              owner: '백엔드',
              source: 'meeting.md',
            },
            {
              id: 3,
              project_id: 1,
              doc_id: 1,
              category: 'issue',
              content: '서버 미연결 상태에서는 메모리를 숨긴다',
              source: 'meeting.md',
            },
            {
              id: 4,
              project_id: 1,
              doc_id: 1,
              category: 'risk',
              content: '프론트 임시 데이터가 실제 메모리처럼 보일 수 있다',
              source: 'meeting.md',
            },
          ]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return originalFetch(input, init);
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.project-panel-menu button'))
      .find((button) => button.textContent.includes('메모리'))?.click()`,
  });
  await sleep(350);

  const memoryResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
	      hasPrompt: Boolean(document.querySelector('.prompt')),
	      hasOverview: Boolean(document.querySelector('.project-overview')),
	      summaryStats: document.querySelectorAll('.project-panel .project-memory-stat').length,
	      summaryActionRows: document.querySelectorAll('.project-panel .project-memory-summary-action').length,
	      summarySections: document.querySelectorAll('.project-panel .project-memory-summary-section').length,
	      text: document.querySelector('.project-panel')?.textContent || "",
	      tabText: document.querySelector('.project-panel-tab[data-active="true"] > span')?.textContent.trim() || "",
	      hasCloseButton: Boolean(document.querySelector('button[aria-label="프로젝트 메모리 탭 닫기"]')),
	      hasAddButton: Boolean(document.querySelector(${JSON.stringify(PROJECT_PANEL_TAB_ADD_SELECTOR)})),
	      modelSelectorExists: Boolean(document.querySelector('.model-pill')),
	    }))()`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="프로젝트 메모리 패널 최대화"]')?.click()`,
  });
  await sleep(120);
  const memoryMaximizeResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      maximized: document.querySelector('.app-shell')?.getAttribute('data-project-panel-maximized') === 'true',
      detailStats: document.querySelectorAll('.project-panel .project-memory-stats [data-tone]').length,
      detailCards: document.querySelectorAll('.project-panel .project-memory-manage-item').length,
    }))()`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="프로젝트 메모리 패널 축소"]')?.click()`,
  });
	  await sleep(120);
	  await send("Runtime.evaluate", {
	    expression: `document.querySelector(${JSON.stringify(PROJECT_PANEL_TAB_ADD_SELECTOR)})?.click()`,
	  });
	  await sleep(100);
	  await send("Runtime.evaluate", {
	    expression: `Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_PANEL_TAB_MENU_ITEM_SELECTOR)}))
	      .find((item) => item.textContent.includes('GitHub'))?.click()`,
	  });
  await sleep(200);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="GitHub 패널 최대화"]')?.click()`,
  });
  await sleep(120);
  const githubMaximizeResult = await send("Runtime.evaluate", {
    returnByValue: true,
	    expression: `(() => ({
	      maximized: document.querySelector('.app-shell')?.getAttribute('data-project-panel-maximized') === 'true',
	      tabText: document.querySelector('.project-panel-tab[data-active="true"] > span')?.textContent.trim() || "",
	      tabLabels: Array.from(document.querySelectorAll('.project-panel-tab > span')).map((item) => item.textContent.trim()),
	    }))()`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="GitHub 패널 축소"]')?.click()`,
  });
	  await sleep(120);
	  await send("Runtime.evaluate", {
	    expression: `document.querySelector('button[aria-label="GitHub 탭 닫기"]')?.click()`,
	  });
  await sleep(100);
  const menuResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      hasMenu: Boolean(document.querySelector('.project-panel-menu')),
      activeTabText: document.querySelector('.project-panel-tab[data-active="true"] > span')?.textContent.trim() || "",
      tabLabels: Array.from(document.querySelectorAll('.project-panel-tab > span')).map((item) => item.textContent.trim()),
    }))()`,
  });
  for (let index = 0; index < 2; index += 1) {
    await send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(PROJECT_PANEL_TAB_ADD_SELECTOR)})?.click()`,
    });
    await sleep(80);
    await send("Runtime.evaluate", {
      expression: `Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_PANEL_TAB_MENU_ITEM_SELECTOR)}))
        .find((item) => item.textContent.includes('자료'))?.click()`,
    });
    await sleep(120);
  }
  const duplicateTabsResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      fileTabs: Array.from(document.querySelectorAll('.project-panel-tab > span'))
        .filter((item) => item.textContent.trim() === '자료').length,
      activeTabText: document.querySelector('.project-panel-tab[data-active="true"] > span')?.textContent.trim() || "",
    }))()`,
  });
  const value = {
    memory: memoryResult.result.value,
    memoryMaximize: memoryMaximizeResult.result.value,
    githubMaximize: githubMaximizeResult.result.value,
    menu: menuResult.result.value,
    duplicateTabs: duplicateTabsResult.result.value,
  };
  const failures = [];

  if (!value.memory.hasPrompt || value.memory.hasOverview) {
    failures.push("project panel should not replace the chat surface");
  }

	  if (value.memory.summaryStats !== 4 ||
	      value.memory.summaryActionRows < 1 ||
	      value.memory.summarySections !== 4 ||
	      !value.memory.text.includes("프로젝트 메모리는 FastAPI에서 조회한다") ||
	      !value.memory.text.includes("API 연결 상태를 확인한다") ||
	      !value.memory.tabText.includes("프로젝트 메모리") ||
	      !value.memory.hasCloseButton ||
	      !value.memory.hasAddButton) {
	    failures.push("project panel memory view should render FastAPI memory rows");
	  }

	  if (!value.memoryMaximize.maximized ||
	      value.memoryMaximize.detailStats !== 4 ||
	      value.memoryMaximize.detailCards !== 4 ||
	      !value.githubMaximize.maximized ||
	      !value.githubMaximize.tabText.includes("GitHub") ||
	      !value.githubMaximize.tabLabels.includes("프로젝트 메모리") ||
	      !value.githubMaximize.tabLabels.includes("GitHub")) {
	    failures.push("memory and GitHub panels should support maximize and tab switching");
	  }

  if (value.menu.hasMenu ||
      !value.menu.activeTabText.includes("프로젝트 메모리") ||
      value.menu.tabLabels.includes("GitHub")) {
	    failures.push("project panel tabs should keep existing tabs and close only the selected tab");
	  }

	  if (value.duplicateTabs.fileTabs !== 2 ||
	      value.duplicateTabs.activeTabText !== "자료") {
	    failures.push("project panel should allow duplicate file tabs");
	  }

  if (value.memory.modelSelectorExists) {
    failures.push("model selector should not render in the prompt");
  }

  debugLayout("project panel menu", value);
  return { value, failures };
}

// 새 구조에서는 기본 채팅 입력이 바로 데모 응답 흐름으로 이어진다.
async function verifyProjectChatQuestion(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.prompt textarea');
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

      valueSetter?.call(input, '이번 주 액션 알려줘');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="메시지 보내기"]')?.click()`,
  });
  await sleep(1200);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);
      const activeSession = activeProject?.sessions.find((session) => session.id === savedState.selectedSessionId);

      return {
        sessionCount: activeProject?.sessions.length ?? 0,
          activeTitle: activeSession?.title || "",
          hasPrompt: Boolean(document.querySelector('.prompt')),
          hasOverview: Boolean(document.querySelector('.project-overview')),
        conversationText: document.querySelector('.conversation')?.textContent || "",
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.sessionCount !== 1 || value.activeTitle !== "Smoke Chat") {
    failures.push("chat question should stay in the active chat session");
  }

    if (!value.hasPrompt || value.hasOverview) {
      failures.push("chat question should stay in the chat view");
    }

  if (!value.conversationText.includes("이번 주 액션 알려줘") ||
        !value.conversationText.includes("좋아요. 이 내용을 프로젝트 메모로 정리할 수 있습니다.")) {
      failures.push("chat question should submit through the demo chat flow");
    }

  debugLayout("project chat question", value);
  return { value, failures };
}

// 파일 패널은 프로젝트 폴더 트리를 검색, 접기/펼치기, 최대화 상태로 보여줘야 한다.
async function verifyProjectOverviewFiles(send) {
  const projectFiles = [
    {
      id: "root-desktop",
	      name: "desktop",
	      path: "/mock/desktop",
	      kind: "directory",
		      uploadedAt: 86400000,
      childrenLoaded: true,
      isExpanded: true,
      children: [
        {
          id: "dir-src",
          name: "src",
          path: "/mock/desktop/src",
          kind: "directory",
          childrenLoaded: true,
          isExpanded: false,
          children: [
            {
              id: "file-app",
              name: "App.tsx",
              path: "/mock/desktop/src/App.tsx",
              kind: "file",
            },
            {
              id: "file-style",
              name: "styles.css",
              path: "/mock/desktop/src/styles.css",
              kind: "file",
            },
          ],
        },
        {
          id: "file-package",
          name: "package.json",
          path: "/mock/desktop/package.json",
          kind: "file",
        },
        {
          id: "file-long-notebook",
          name: "02_RAG_Load_Documents(튜터용).ipynb",
          path: "/mock/desktop/data/02_RAG/02_RAG_Load_Documents(튜터용).ipynb",
          kind: "file",
        },
      ],
    },
	    {
	      id: "root-backend",
	      name: "backend",
	      path: "/mock/backend",
	      kind: "directory",
	      uploadedAt: 60000,
      childrenLoaded: true,
      isExpanded: false,
      children: [
        {
          id: "file-main",
          name: "main.py",
          path: "/mock/backend/main.py",
          kind: "file",
	        },
	      ],
	    },
	    {
	      id: "root-readme",
	      name: "README.md",
	      path: "/mock/README.md",
	      kind: "file",
		      uploadedAt: 86460000,
	    },
	  ];
  const seededProjectState = createProjectStorage(
    "project-files",
    "Files Project",
    [
      {
        id: "session-files",
        title: "Files Chat",
        createdAt: Date.now(),
        messages: [],
      },
    ],
    "session-files",
    projectFiles,
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_COLLAPSED_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_WIDTH_STORAGE_KEY)}, '360'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
    await send("Page.navigate", { url: APP_URL });
    await sleep(700);
    await send("Runtime.evaluate", {
      expression: `Array.from(document.querySelectorAll('.project-panel-menu button'))
        .find((button) => button.textContent.includes('자료'))?.click()`,
    });
    await sleep(200);

	    const libraryResult = await send("Runtime.evaluate", {
	      returnByValue: true,
	      expression: `(() => ({
	        hasSourcesPanel: Boolean(document.querySelector('.project-sources-panel')),
	        sourceNames: Array.from(document.querySelectorAll('.project-source-body strong')).map((item) => item.textContent.trim()),
	        hasTreeBeforeDetail: Boolean(document.querySelector('.project-file-tree')),
	        hasOriginalView: Array.from(document.querySelectorAll('.project-sources-secondary'))
	          .some((button) => button.textContent.includes('원본 보기')),
	        sourceSearchPlaceholder: document.querySelector('.project-sources-search input')?.getAttribute('placeholder') || "",
	        uploadButtons: Array.from(document.querySelectorAll('.project-files-open-button')).map((button) => button.textContent.trim()),
	        timeLabels: Array.from(document.querySelectorAll('.project-source-time-label')).map((item) => item.textContent.trim()),
	        sourceMenuCount: document.querySelectorAll('.project-source-actions button[aria-label$="관리"]').length,
	        hasVisibleDeleteButton: Array.from(document.querySelectorAll('.project-source-actions > button'))
	          .some((button) => button.textContent.includes('삭제') || button.textContent.includes('제거')),
	      }))()`,
	    });

	    await send("Runtime.evaluate", {
	      expression: `(() => {
	        const input = document.querySelector('.project-sources-search input');
	        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
	        setter.call(input, 'backend');
	        input.dispatchEvent(new Event('input', { bubbles: true }));
	      })()`,
	    });
	    await sleep(200);

	    const librarySearchResult = await send("Runtime.evaluate", {
	      returnByValue: true,
	      expression: `Array.from(document.querySelectorAll('.project-source-body strong')).map((item) => item.textContent.trim())`,
	    });

	    await send("Runtime.evaluate", {
	      expression: `(() => {
	        const input = document.querySelector('.project-sources-search input');
	        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
	        setter.call(input, '');
	        input.dispatchEvent(new Event('input', { bubbles: true }));
	      })()`,
	    });
	    await sleep(120);

	    await send("Runtime.evaluate", {
	      expression: `Array.from(document.querySelectorAll('.project-source-card'))
	        .find((card) => card.textContent.includes('README.md'))?.click()`,
	    });
	    await sleep(200);

	    const singleFileSourceResult = await send("Runtime.evaluate", {
	      returnByValue: true,
	      expression: `(() => ({
	        dataSingleFile: document.querySelector('.project-files-panel')?.getAttribute('data-single-file') || "",
	        hasTreePane: Boolean(document.querySelector('.project-files-tree-pane')),
	        hasTreeToggle: Boolean(document.querySelector('button[aria-label="파일 트리 접기"]')),
	        hasTreeSearch: Boolean(document.querySelector('.project-files-tree-pane .project-files-search')),
	        previewTab: document.querySelector('.project-panel-tab[data-active="true"] > span')?.textContent.trim() || "",
	        rootText: document.querySelector('.project-files-root')?.textContent.trim() || "",
	      }))()`,
	    });

	    await send("Runtime.evaluate", {
	      expression: `Array.from(document.querySelectorAll('.project-sources-secondary'))
	        .find((button) => button.textContent.includes('자료함'))?.click()`,
	    });
	    await sleep(120);

	    await send("Runtime.evaluate", {
	      expression: `Array.from(document.querySelectorAll('.project-source-card'))
	        .find((card) => card.textContent.includes('desktop'))?.click()`,
	    });
	    await sleep(200);

    const initialResult = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        fileNames: Array.from(document.querySelectorAll('.project-file-name')).map((item) => item.textContent.trim()),
        fileCountText: document.querySelector('.project-files-count')?.textContent.trim() || "",
	        rootText: document.querySelector('.project-files-root')?.textContent.trim() || "",
	        uploadButtons: Array.from(document.querySelectorAll('.project-files-header .project-files-open-button')).map((button) => button.textContent.trim()),
	        searchPlaceholder: document.querySelector('.project-files-search input')?.getAttribute('placeholder') || "",
        treeOverflow: getComputedStyle(document.querySelector('.project-file-tree')).overflowY,
        hasPrompt: Boolean(document.querySelector('.prompt')),
        hasOverview: Boolean(document.querySelector('.project-overview')),
        hasPanel: Boolean(document.querySelector('.project-panel')),
      }))()`,
    });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="src 펼치기"]')?.click()`,
  });
  await sleep(180);

  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.project-files-search input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'App');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await sleep(180);

  const afterFilterResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      visibleFileNames: Array.from(document.querySelectorAll('.project-file-name')).map((item) => item.textContent.trim()),
        appIconColor: (() => {
          const nameElement = Array.from(document.querySelectorAll('.project-file-name'))
            .find((item) => item.textContent.trim() === "App.tsx");
          return nameElement?.closest('.project-file-row')?.querySelector('.project-file-icon')?.style.color || "";
        })(),
        hasPreviewEmpty: Boolean(document.querySelector('.project-files-preview-empty')),
        hasTreeResizeHandle: Boolean(document.querySelector('.project-files-tree-resize-handle')),
        hasTreeToggle: Boolean(document.querySelector('button[aria-label="파일 트리 접기"]')),
        hasFileHeader: Boolean(document.querySelector('.project-files-header')),
        headerBorderBottom: getComputedStyle(document.querySelector('.project-files-header')).borderBottomWidth,
        panelWidth: document.querySelector('.project-panel')?.getBoundingClientRect().width ?? 0,
        previewWidth: document.querySelector('.project-files-main')?.getBoundingClientRect().width ?? 0,
        treeWidth: document.querySelector('.project-files-tree-pane')?.getBoundingClientRect().width ?? 0,
        panelGridTransition: getComputedStyle(document.querySelector('.project-files-panel')).transitionProperty,
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="자료 패널 최대화"]')?.click()`,
  });
  await sleep(180);

  const afterMaximizeResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const panel = document.querySelector('.project-panel').getBoundingClientRect();
      const sidebarElement = document.querySelector('.sidebar');
      const sidebar = sidebarElement.getBoundingClientRect();
      const sidebarStyle = getComputedStyle(sidebarElement);
      const chat = document.querySelector('.chat').getBoundingClientRect();

      return {
        maximized: shell?.getAttribute('data-project-panel-maximized') === 'true',
        sidebarCollapsed: shell?.getAttribute('data-sidebar-collapsed') === 'true',
        panelLeft: panel.left,
        panelTop: panel.top,
        panelBottom: panel.bottom,
        panelHeight: panel.height,
        chatLeft: chat.left,
        chatTop: chat.top,
        chatBottom: chat.bottom,
        chatHeight: chat.height,
        sidebarRight: sidebar.right,
        sidebarZIndex: Number(sidebarStyle.zIndex) || 0,
        treeWidth: document.querySelector('.project-files-tree-pane')?.getBoundingClientRect().width ?? 0,
        hasTreeResizeHandle: Boolean(document.querySelector('.project-files-tree-resize-handle')),
        hasTreeToggle: Boolean(document.querySelector('button[aria-label="파일 트리 접기"]')),
        hasPreviewEmpty: Boolean(document.querySelector('.project-files-preview-empty')),
        hasTree: Boolean(document.querySelector('.project-file-tree')),
      };
    })()`,
  });

  const maxTreeResizeStartResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const handle = document.querySelector('.project-files-tree-resize-handle')?.getBoundingClientRect();
      const tree = document.querySelector('.project-files-tree-pane')?.getBoundingClientRect();

      return {
        x: (handle?.left ?? 0) + 3,
        y: (handle?.top ?? 0) + ((handle?.height ?? 0) / 2),
        width: tree?.width ?? 0,
      };
    })()`,
  });
  const maxTreeDragStart = maxTreeResizeStartResult.result.value;

  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: maxTreeDragStart.x,
    y: maxTreeDragStart.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: maxTreeDragStart.x - 72,
    y: maxTreeDragStart.y,
    button: "left",
  });
  const duringMaxTreeResizeResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      transitionDuration: getComputedStyle(document.querySelector('.project-files-panel')).transitionDuration,
    }))()`,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: maxTreeDragStart.x - 72,
    y: maxTreeDragStart.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(220);

  const afterMaxTreeResizeResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const tree = document.querySelector('.project-files-tree-pane')?.getBoundingClientRect();
      const handle = document.querySelector('.project-files-tree-resize-handle');

      return {
        treeWidth: tree?.width ?? 0,
        ariaValue: Number(handle?.getAttribute('aria-valuenow') || 0),
        resizing: shell?.getAttribute('data-project-panel-resizing') || "",
        treeResizing: shell?.getAttribute('data-project-file-tree-resizing') || "",
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="파일 트리 접기"]')?.click()`,
  });
  await sleep(180);

  const afterMaxTreeCollapseResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const treePane = document.querySelector('.project-files-tree-pane');
      const search = document.querySelector('.project-files-search');
      const tree = document.querySelector('.project-file-tree');
      const handle = document.querySelector('.project-files-tree-resize-handle');

      return {
        collapsed: document.querySelector('.project-files-panel')?.getAttribute('data-tree-collapsed') === 'true',
        treeWidth: treePane?.getBoundingClientRect().width ?? 0,
        searchDisplay: search ? getComputedStyle(search).display : "",
        treeDisplay: tree ? getComputedStyle(tree).display : "",
        handleDisplay: handle ? getComputedStyle(handle).display : "",
        hasOpenButton: Boolean(document.querySelector('button[aria-label="파일 트리 펼치기"]')),
      };
    })()`,
  });

  const collapsedTreeResizeStartResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const handle = document.querySelector('.project-files-tree-resize-handle')?.getBoundingClientRect();

      return {
        x: (handle?.left ?? 0) + 3,
        y: (handle?.top ?? 0) + ((handle?.height ?? 0) / 2),
      };
    })()`,
  });
  const collapsedTreeDragStart = collapsedTreeResizeStartResult.result.value;

  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: collapsedTreeDragStart.x,
    y: collapsedTreeDragStart.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: collapsedTreeDragStart.x - 72,
    y: collapsedTreeDragStart.y,
    button: "left",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: collapsedTreeDragStart.x - 72,
    y: collapsedTreeDragStart.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(220);

  const afterCollapsedTreeResizeResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const treePane = document.querySelector('.project-files-tree-pane');
      const search = document.querySelector('.project-files-search');

      return {
        collapsed: document.querySelector('.project-files-panel')?.getAttribute('data-tree-collapsed') === 'true',
        treeWidth: treePane?.getBoundingClientRect().width ?? 0,
        searchDisplay: search ? getComputedStyle(search).display : "",
        treeResizing: shell?.getAttribute('data-project-file-tree-resizing') || "",
        hasCloseButton: Boolean(document.querySelector('button[aria-label="파일 트리 접기"]')),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="파일 트리 접기"]')?.click()`,
  });
  await sleep(180);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="파일 트리 펼치기"]')?.click()`,
  });
  await sleep(180);

  const afterMaxTreeExpandResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const treePane = document.querySelector('.project-files-tree-pane');
      const search = document.querySelector('.project-files-search');

      return {
        collapsed: document.querySelector('.project-files-panel')?.getAttribute('data-tree-collapsed') === 'true',
        treeWidth: treePane?.getBoundingClientRect().width ?? 0,
        searchDisplay: search ? getComputedStyle(search).display : "",
        hasCloseButton: Boolean(document.querySelector('button[aria-label="파일 트리 접기"]')),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="프로젝트 패널 접기"]')?.click()`,
  });
  await sleep(220);

  const afterWholePanelCollapseResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');

      return {
        collapsed: shell?.getAttribute('data-project-panel-collapsed') === 'true',
        maximized: shell?.getAttribute('data-project-panel-maximized') === 'true',
        hasRailButton: Boolean(document.querySelector('.project-panel-rail-toggle')),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-panel-rail-toggle')?.click()`,
  });
  await sleep(220);

  const afterWholePanelReopenResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const panel = document.querySelector('.project-panel').getBoundingClientRect();
      const sidebarElement = document.querySelector('.sidebar');
      const sidebar = sidebarElement.getBoundingClientRect();
      const sidebarStyle = getComputedStyle(sidebarElement);
      const chat = document.querySelector('.chat').getBoundingClientRect();

      return {
        collapsed: shell?.getAttribute('data-project-panel-collapsed') === 'true',
        maximized: shell?.getAttribute('data-project-panel-maximized') === 'true',
        sidebarCollapsed: shell?.getAttribute('data-sidebar-collapsed') === 'true',
        panelLeft: panel.left,
        sidebarRight: sidebar.right,
        sidebarZIndex: Number(sidebarStyle.zIndex) || 0,
        chatLeft: chat.left,
        hasPreviewEmpty: Boolean(document.querySelector('.project-files-preview-empty')),
        hasTree: Boolean(document.querySelector('.project-file-tree')),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.project-files-search input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await sleep(120);

  await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.project-file-name'))
      .find((item) => item.textContent.includes('02_RAG_Load_Documents'))?.closest('.project-file-row')?.click()`,
  });
  await sleep(220);

  const afterLongPreviewResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const main = document.querySelector('.project-files-main')?.getBoundingClientRect();
      const path = document.querySelector('.project-file-preview-path')?.getBoundingClientRect();

      return {
        hasPreview: Boolean(document.querySelector('.project-file-preview')),
        selectedName: document.querySelector('.project-panel-tab[data-active="true"] > span')?.textContent.trim() || "",
        selectedRow: Boolean(document.querySelector('.project-file-row[data-selected="true"]')),
        mainRight: main?.right ?? 0,
        pathRight: path?.right ?? 0,
        mainOverflow: getComputedStyle(document.querySelector('.project-files-main')).overflow,
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="App.tsx 제거"]')?.click()`,
  });
  await sleep(120);

  const afterDeleteArmResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      visibleFileNames: Array.from(document.querySelectorAll('.project-file-name')).map((item) => item.textContent.trim()),
      hasConfirmButton: Boolean(document.querySelector('button[aria-label="App.tsx 제거 확인"]')),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="App.tsx 제거 확인"]')?.click()`,
  });
  await sleep(200);

  const afterDeleteResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);

      return {
        storedState: activeProject?.files ?? [],
        visibleFileNames: Array.from(document.querySelectorAll('.project-file-name')).map((item) => item.textContent.trim()),
      };
    })()`,
  });

    await send("Runtime.evaluate", {
      expression: `document.querySelector('.project-files-open-button')?.click()`,
    });
  await sleep(200);

  const afterAddClickResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);

      return {
          sessionCount: activeProject?.sessions?.length ?? 0,
          selectedSessionId: savedState.selectedSessionId ?? null,
          hasChatPrompt: Boolean(document.querySelector('.prompt')),
          hasOverview: Boolean(document.querySelector('.project-overview')),
          hasPanel: Boolean(document.querySelector('.project-panel')),
        };
    })()`,
  });

	  const value = {
	    library: libraryResult.result.value,
	    librarySearch: librarySearchResult.result.value,
	    singleFileSource: singleFileSourceResult.result.value,
		    initial: initialResult.result.value,
		    afterFilter: afterFilterResult.result.value,
		    afterMaximize: afterMaximizeResult.result.value,
	    duringMaxTreeResize: duringMaxTreeResizeResult.result.value,
    afterMaxTreeResize: afterMaxTreeResizeResult.result.value,
    afterMaxTreeCollapse: afterMaxTreeCollapseResult.result.value,
    afterCollapsedTreeResize: afterCollapsedTreeResizeResult.result.value,
    afterMaxTreeExpand: afterMaxTreeExpandResult.result.value,
    afterWholePanelCollapse: afterWholePanelCollapseResult.result.value,
    afterWholePanelReopen: afterWholePanelReopenResult.result.value,
    afterLongPreview: afterLongPreviewResult.result.value,
    afterDeleteArm: afterDeleteArmResult.result.value,
    afterDelete: afterDeleteResult.result.value,
    afterAddClick: afterAddClickResult.result.value,
  };
  const failures = [];

	  if (!value.library.hasSourcesPanel ||
	      !value.library.sourceNames.includes("desktop") ||
	      !value.library.sourceNames.includes("backend") ||
	      value.library.sourceNames[0] !== "README.md" ||
	      value.library.hasTreeBeforeDetail ||
	      value.library.hasOriginalView ||
	      value.library.sourceSearchPlaceholder !== "자료 검색..." ||
	      !value.library.uploadButtons.includes("업로드") ||
	      value.library.timeLabels.length < 2 ||
	      value.library.sourceMenuCount < 3 ||
	      value.library.hasVisibleDeleteButton) {
	    failures.push("sources view should show upload, search, and project sources before opening a source");
	  }

	  if (!value.librarySearch.includes("backend") || value.librarySearch.includes("desktop")) {
	    failures.push("sources search should filter uploaded sources");
	  }

	  if (value.singleFileSource.dataSingleFile !== "true" ||
	      value.singleFileSource.hasTreePane ||
	      value.singleFileSource.hasTreeToggle ||
	      value.singleFileSource.hasTreeSearch ||
	      value.singleFileSource.previewTab !== "README.md" ||
	      value.singleFileSource.rootText !== "README.md") {
	    failures.push("single file sources should open a preview without the side tree");
	  }

	  if (!value.initial.fileNames.includes("desktop") ||
	      !value.initial.fileNames.includes("src") ||
	      !value.initial.fileNames.includes("package.json") ||
	      value.initial.fileNames.includes("backend") ||
	      value.initial.fileCountText !== "6") {
	    failures.push("file panel should render only the selected source tree and item count");
	  }

	  if (value.initial.rootText !== "desktop" ||
	      value.initial.searchPlaceholder !== "파일 필터링..." ||
	      value.initial.uploadButtons.length !== 0) {
	    failures.push("file panel should show Codex-like root path and filter input");
	  }

  if (!value.initial.hasPrompt || value.initial.hasOverview || !value.initial.hasPanel) {
    failures.push("project files should render in the right panel beside chat");
  }

  if (!value.afterFilter.visibleFileNames.includes("App.tsx") ||
      value.afterFilter.visibleFileNames.includes("package.json")) {
    failures.push("file filter should keep matching files and their parent folders only");
  }

  if (!value.afterFilter.appIconColor) {
    failures.push("file panel should apply file-type icon colors");
  }

  if (!value.afterFilter.hasPreviewEmpty ||
      !value.afterFilter.hasTreeResizeHandle ||
      !value.afterFilter.hasTreeToggle ||
      value.afterFilter.panelWidth > 380 ||
      value.afterFilter.previewWidth < 90 ||
      value.afterFilter.treeWidth < 170 ||
      !value.afterFilter.hasFileHeader ||
      value.afterFilter.headerBorderBottom === "0px" ||
      !value.afterFilter.panelGridTransition.includes("grid-template-columns")) {
    failures.push("file panel should use the split preview/tree layout before maximizing");
  }

  if (!value.afterMaximize.maximized ||
      (value.afterMaximize.sidebarCollapsed
        ? value.afterMaximize.panelLeft > 2 ||
          value.afterMaximize.sidebarZIndex < 61
        : value.afterMaximize.panelLeft < value.afterMaximize.sidebarRight - 2) ||
      value.afterMaximize.panelTop > value.afterMaximize.chatTop + 4 ||
      value.afterMaximize.panelBottom < value.afterMaximize.chatBottom - 4 ||
      value.afterMaximize.panelHeight < value.afterMaximize.chatHeight - 4 ||
      !value.afterMaximize.hasTreeResizeHandle ||
      !value.afterMaximize.hasTreeToggle ||
      !value.afterMaximize.hasPreviewEmpty ||
      !value.afterMaximize.hasTree) {
    failures.push("file panel maximize should cover the chat area while preserving the left rail");
  }

  if (value.afterMaxTreeResize.treeWidth < value.afterMaximize.treeWidth + 40 ||
      value.afterMaxTreeResize.ariaValue < value.afterMaximize.treeWidth + 40 ||
      value.afterMaxTreeResize.resizing !== "false" ||
      value.afterMaxTreeResize.treeResizing !== "false") {
    failures.push("maximized file tree pane should resize by dragging the divider");
  }

  if (value.duringMaxTreeResize.transitionDuration !== "0s") {
    failures.push("file tree drag should not wait on column transition");
  }

  if (!value.afterMaxTreeCollapse.collapsed ||
      value.afterMaxTreeCollapse.treeWidth > 70 ||
      value.afterMaxTreeCollapse.searchDisplay !== "none" ||
      value.afterMaxTreeCollapse.treeDisplay !== "none" ||
      value.afterMaxTreeCollapse.handleDisplay === "none" ||
      !value.afterMaxTreeCollapse.hasOpenButton) {
    failures.push("maximized file tree pane should collapse to a reopen rail");
  }

  if (value.afterCollapsedTreeResize.collapsed ||
      value.afterCollapsedTreeResize.treeWidth < 250 ||
      value.afterCollapsedTreeResize.searchDisplay === "none" ||
      value.afterCollapsedTreeResize.treeResizing !== "false" ||
      !value.afterCollapsedTreeResize.hasCloseButton) {
    failures.push("collapsed file tree pane should resize open by dragging the divider");
  }

  if (value.afterMaxTreeExpand.collapsed ||
      value.afterMaxTreeExpand.treeWidth < value.afterCollapsedTreeResize.treeWidth - 4 ||
      value.afterMaxTreeExpand.searchDisplay === "none" ||
      !value.afterMaxTreeExpand.hasCloseButton) {
    failures.push("collapsed file tree pane should reopen to the resized width");
  }

  if (!value.afterWholePanelCollapse.collapsed ||
      !value.afterWholePanelCollapse.maximized ||
      !value.afterWholePanelCollapse.hasRailButton) {
    failures.push("collapsing the whole right panel should preserve maximized file state");
  }

  if (value.afterWholePanelReopen.collapsed ||
      !value.afterWholePanelReopen.maximized ||
      (value.afterWholePanelReopen.sidebarCollapsed
        ? value.afterWholePanelReopen.panelLeft > 2 ||
          value.afterWholePanelReopen.sidebarZIndex < 61
        : value.afterWholePanelReopen.panelLeft < value.afterWholePanelReopen.sidebarRight - 2) ||
      !value.afterWholePanelReopen.hasPreviewEmpty ||
      !value.afterWholePanelReopen.hasTree) {
    failures.push("reopening the whole right panel should restore the maximized file layout");
  }

  if (!value.afterLongPreview.hasPreview ||
      !value.afterLongPreview.selectedName.includes("02_RAG_Load_Documents") ||
      !value.afterLongPreview.selectedRow ||
      value.afterLongPreview.mainOverflow !== "hidden" ||
      value.afterLongPreview.pathRight > value.afterLongPreview.mainRight + 1) {
    failures.push("long file preview headers should stay clipped inside the preview pane");
  }

  if (!value.afterDeleteArm.visibleFileNames.includes("App.tsx") ||
      !value.afterDeleteArm.hasConfirmButton) {
    failures.push("file tree delete should require a second confirmation click");
  }

  const storedAfterDelete = JSON.stringify(value.afterDelete.storedState);

  if (storedAfterDelete.includes("App.tsx") ||
      value.afterDelete.visibleFileNames.includes("App.tsx")) {
    failures.push("file tree delete should remove nested entries");
  }

  if (value.afterAddClick.sessionCount !== 1 ||
      !value.afterAddClick.selectedSessionId ||
      !value.afterAddClick.hasChatPrompt ||
      value.afterAddClick.hasOverview ||
      !value.afterAddClick.hasPanel) {
    failures.push("panel file add should keep the active chat and panel");
  }

  debugLayout("project overview files", value);
  return { value, failures };
}

// GitHub 섹션은 로그인, repo 선택, 연결 상태, timeline을 한 패널에서 보여준다.
async function verifyGithubTimelineState(send) {
  const now = Date.now();
  const unlinkedState = createProjectStorage(
    "project-github-unlinked",
    "GitHub Unlinked",
    [
      {
        id: "session-github-unlinked",
        title: "GitHub Chat",
        createdAt: now,
        messages: [],
      },
    ],
    "session-github-unlinked",
  );

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_COLLAPSED_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(PROJECT_PANEL_WIDTH_STORAGE_KEY)}, '360'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(GITHUB_CLIENT_ID_STORAGE_KEY)}, 'smoke-client'); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(unlinkedState)})`,
  });
    await send("Page.navigate", { url: APP_URL });
    await sleep(700);
    await send("Runtime.evaluate", {
      expression: `Array.from(document.querySelectorAll('.project-panel-menu button'))
        .find((button) => button.textContent.includes('GitHub'))?.click()`,
    });
    await sleep(200);

    const unlinkedResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
        stateText: document.querySelector('.overview-github-state')?.textContent.trim() || "",
        hasLoginCard: Boolean(document.querySelector('.overview-github-login-card')),
        hasLoginTitle: document.body.textContent.includes('GitHub 연결'),
        hasTimelineCopy: document.body.textContent.includes('PR · 이슈'),
        hasLoginButton: Boolean(Array.from(document.querySelectorAll('.overview-github-primary-button')).find((button) => button.textContent.includes('GitHub 로그인'))),
      hasUrlInput: Boolean(document.querySelector('.overview-github-connect-form input')),
      hasConnectedCard: Boolean(document.querySelector('.overview-github-connected-card')),
      hasTimelineRows: Boolean(document.querySelector('.overview-timeline-row')),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `(() => {
      window.__paimOriginalFetch = window.fetch.bind(window);
      window.fetch = async (input) => {
        if (String(input).includes('github.com/login/device/code')) {
          throw new Error('Load failed');
        }

        return window.__paimOriginalFetch(input);
      };
      document.querySelector('.overview-github-primary-button')?.click();
    })()`,
  });
  await sleep(250);

  const failedLoginResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
        const githubPanel = document.querySelector('.project-panel');
        const githubStatus = githubPanel?.querySelector('.runtime-status');
      const status = document.querySelector('.runtime-status');
      return {
        githubPanelHasStatus: Boolean(githubStatus),
        githubStatusText: githubStatus?.textContent.trim() ?? "",
        sidebarHasRuntimeStatus: Boolean(document.querySelector('.sidebar .runtime-status')),
        runtimeStatusCount: document.querySelectorAll('.runtime-status').length,
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `(() => {
      window.open = (url) => {
        window.__paimOpenedUrl = String(url);
        return null;
      };
      window.fetch = async (input, init) => {
        const url = String(input);

        if (url.includes('github.com/login/device/code') && init?.method === 'POST') {
          return new Response(JSON.stringify({
            device_code: 'smoke-device',
            user_code: 'SMOKE-123',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return window.__paimOriginalFetch(input, init);
      };
      document.querySelector('.overview-github-primary-button')?.click();
    })()`,
  });
  await sleep(800);

  const authingResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      stateText: document.querySelector('.overview-github-state')?.textContent.trim() || "",
      openedUrl: window.__paimOpenedUrl || "",
      hasAuthCard: Boolean(document.querySelector('.overview-github-auth-card')),
      hasWaitingText: document.body.textContent.includes('브라우저에서 GitHub 연결을 완료해 주세요'),
      hasCheckButton: Boolean(Array.from(document.querySelectorAll('.overview-github-auth-card button')).find((button) => button.textContent.includes('로그인 완료했어요'))),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `(() => {
      const events = [
        {
          id: 'github-pr',
          type: 'pull_request',
          title: 'PR #18 프로젝트 Overview 연결',
          status: 'open',
          createdAt: ${now - 1000 * 60 * 30},
        },
        {
          id: 'github-issue',
          type: 'issue',
          title: 'issue #21 파일 목록 스크롤',
          status: 'open',
          createdAt: ${now - 1000 * 60 * 60 * 3},
        },
        {
          id: 'github-commit',
          type: 'commit',
          title: 'feat: project file management',
          createdAt: ${now - 1000 * 60 * 60 * 8},
        },
      ];

      window.fetch = async (input, init) => {
        const url = String(input);

        if (url.includes('github.com/login/oauth/access_token') && init?.method === 'POST') {
          return new Response(JSON.stringify({
            access_token: 'smoke-token',
            token_type: 'bearer',
            scope: 'repo read:user',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('api.github.com/user/repos')) {
          return new Response(JSON.stringify([
            {
              full_name: 'j3s30p/Stampy',
              name: 'Stampy',
              private: true,
              default_branch: 'main',
              html_url: 'https://github.com/j3s30p/Stampy',
            },
            {
              full_name: 'j3s30p/PaiM',
              name: 'PaiM',
              private: false,
              default_branch: 'main',
              html_url: 'https://github.com/j3s30p/PaiM',
            },
          ]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url === 'https://api.github.com/user') {
          return new Response(JSON.stringify({
            avatar_url: '',
            html_url: 'https://github.com/j3s30p',
            login: 'j3s30p',
            name: 'Smoke User',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('api.github.com/repos/j3s30p/Stampy/commits')) {
          return new Response(JSON.stringify([
            {
              html_url: 'https://github.com/j3s30p/Stampy/commit/smoke',
              sha: 'abcdef123456',
              commit: {
                author: { date: new Date(${now - 1000 * 60 * 60 * 8}).toISOString() },
                message: 'feat: project file management',
              },
            },
          ]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('api.github.com/repos/j3s30p/Stampy/issues')) {
          return new Response(JSON.stringify([
            {
              html_url: 'https://github.com/j3s30p/Stampy/issues/21',
              number: 21,
              title: '파일 목록 스크롤',
              state: 'open',
              updated_at: new Date(${now - 1000 * 60 * 60 * 3}).toISOString(),
            },
          ]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('api.github.com/repos/j3s30p/Stampy/pulls')) {
          return new Response(JSON.stringify([
            {
              html_url: 'https://github.com/j3s30p/Stampy/pull/18',
              number: 18,
              title: '프로젝트 Overview 연결',
              state: 'open',
              updated_at: new Date(${now - 1000 * 60 * 30}).toISOString(),
            },
          ]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('api.github.com/repos/j3s30p/Stampy')) {
          return new Response(JSON.stringify({
            default_branch: 'main',
            full_name: 'j3s30p/Stampy',
            html_url: 'https://github.com/j3s30p/Stampy',
            name: 'Stampy',
            private: true,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('/github/sync')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return window.__paimOriginalFetch(input, init);
      };
      Array.from(document.querySelectorAll('.overview-github-auth-card button'))
        .find((button) => button.textContent.includes('로그인 완료했어요'))?.click();
    })()`,
  });
  await sleep(800);

  const reposResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      stateText: document.querySelector('.overview-github-state')?.textContent.trim() || "",
      hasReposCard: Boolean(document.querySelector('.overview-github-repos-card')),
      hasSearchInput: Boolean(document.querySelector('.overview-github-search input')),
      repoNames: Array.from(document.querySelectorAll('.overview-github-repo-copy p')).map((item) => item.textContent.trim()),
      visibilityLabels: Array.from(document.querySelectorAll('.overview-github-repo-visibility')).map((item) => item.textContent.trim()),
      hasLogoutButton: Boolean(Array.from(document.querySelectorAll('.overview-github-toolbar button')).find((button) => button.textContent.includes('로그아웃'))),
      hasUrlInput: Boolean(document.querySelector('.overview-github-connect-form input')),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.overview-github-repo-row button'))
      .find((button) => button.textContent.includes('연결'))?.click()`,
  });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.overview-github-more-menu')?.click()`,
  });
  await sleep(80);

  const linkedResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      titles: Array.from(document.querySelectorAll('.overview-timeline-row p')).map((item) => item.textContent.trim()),
      meta: Array.from(document.querySelectorAll('.overview-timeline-row small')).map((item) => item.textContent.trim()),
      labels: Array.from(document.querySelectorAll('.overview-timeline-label')).map((item) => item.textContent.trim()),
      repoName: document.querySelector('.overview-github-repo-name')?.textContent.trim() || "",
      repoMeta: document.querySelector('.overview-github-meta')?.textContent.trim() || "",
      stateText: document.querySelector('.overview-github-state')?.textContent.trim() || "",
      visibleIconCount: Array.from(document.querySelectorAll('.overview-timeline-icon .tabler-icon')).filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width >= 12 && rect.height >= 12;
      }).length,
      boxedIconCount: Array.from(document.querySelectorAll('.overview-timeline-icon .tabler-icon')).filter((item) => (
        getComputedStyle(item).backgroundColor !== 'rgba(0, 0, 0, 0)'
      )).length,
      hasConnectedCard: Boolean(document.querySelector('.overview-github-connected-card')),
      hasSyncButton: Boolean(document.querySelector('button[aria-label="GitHub 동기화"]')),
      hasChangeButton: Boolean(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent.includes('repo 변경'))),
      hasDisconnectButton: Boolean(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent.includes('연결 해제'))),
    }))()`,
  });

  const value = {
    unlinked: unlinkedResult.result.value,
    failedLogin: failedLoginResult.result.value,
    authing: authingResult.result.value,
    repos: reposResult.result.value,
    linked: linkedResult.result.value,
  };
  const failures = [];

  if (value.unlinked.stateText !== "미연결" ||
        !value.unlinked.hasLoginCard ||
        !value.unlinked.hasLoginTitle ||
        !value.unlinked.hasTimelineCopy ||
      !value.unlinked.hasLoginButton ||
      value.unlinked.hasUrlInput ||
      value.unlinked.hasConnectedCard ||
      value.unlinked.hasTimelineRows) {
    failures.push("unlinked GitHub panel should show the reference login card only");
  }

  if (!value.failedLogin.githubPanelHasStatus ||
      !value.failedLogin.githubStatusText.includes("GitHub 로그인 서버에 연결할 수 없습니다") ||
      value.failedLogin.sidebarHasRuntimeStatus ||
      value.failedLogin.runtimeStatusCount !== 1) {
    failures.push("GitHub login failure status should render inside the GitHub panel only");
  }

  if (value.authing.stateText !== "로그인 중" ||
      !value.authing.openedUrl.includes("github.com/login/device") ||
      !value.authing.hasAuthCard ||
      !value.authing.hasWaitingText ||
      !value.authing.hasCheckButton) {
    failures.push("GitHub authing state should render the browser login waiting card");
  }

  if (value.repos.stateText !== "로그인됨" ||
      !value.repos.hasReposCard ||
      !value.repos.hasSearchInput ||
      !value.repos.repoNames.includes("j3s30p/Stampy") ||
      !value.repos.repoNames.includes("j3s30p/PaiM") ||
      !value.repos.visibilityLabels.includes("PRIVATE") ||
      !value.repos.visibilityLabels.includes("PUBLIC") ||
      !value.repos.hasLogoutButton ||
      value.repos.hasUrlInput) {
    failures.push("GitHub repos state should render searchable repositories without the old URL form");
  }

  if (value.linked.stateText !== "연결됨" ||
      !value.linked.hasConnectedCard ||
      !value.linked.hasChangeButton ||
      !value.linked.hasDisconnectButton ||
      !value.linked.titles.includes("프로젝트 Overview 연결") ||
      !value.linked.titles.includes("파일 목록 스크롤") ||
      !value.linked.titles.includes("feat: project file management")) {
    failures.push("linked GitHub timeline should render issue, PR, and commit events");
  }

  if (!value.linked.labels.includes("PR #18") ||
      !value.linked.labels.includes("ISSUE #21") ||
      !value.linked.labels.includes("COMMIT")) {
    failures.push("linked GitHub timeline should label event types");
  }

  if (value.linked.visibleIconCount !== 3) {
    failures.push("linked GitHub timeline should render visible event icons");
  }

  if (value.linked.boxedIconCount !== 0) {
    failures.push("linked GitHub timeline icons should not render boxed backgrounds");
  }

  if (!value.linked.repoName.includes("Stampy") ||
      !value.linked.repoMeta.includes("main") ||
      !value.linked.repoMeta.includes("j3s30p")) {
    failures.push("linked GitHub timeline should show repository metadata");
  }

  debugLayout("github timeline", value);
  return { value, failures };
}

// 접은 사이드바 상태가 reload 이후에도 유지되는지 확인한다.
async function verifySidebarPersistence(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sidebar-rail-avatar[data-active="true"]')?.click()`,
  });
  await sleep(200);
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const prompt = document.querySelector('.prompt').getBoundingClientRect();
      return {
        collapsed: shell?.getAttribute('data-sidebar-collapsed') === 'true',
        stored: localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}) || "",
        scrollWidth: document.documentElement.scrollWidth,
        prompt: {
          left: prompt.left,
          right: prompt.right,
        },
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.collapsed) {
    failures.push("sidebar collapsed state should persist after reload");
  }

  if (value.stored !== "true") {
    failures.push("sidebar collapsed state should be stored in localStorage");
  }

  if (value.scrollWidth > 960) {
    failures.push(`collapsed reload should not overflow horizontally: ${value.scrollWidth} > 960`);
  }

  assertInside("prompt after collapsed reload", value.prompt, 960, failures);

  return { value, failures };
}

// 확대처럼 CSS viewport가 좁아진 상태에서도 펼침 버튼이 실제 사이드바를 열어야 한다.
async function verifyNarrowSidebarToggle(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 520,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);
  await send("Runtime.evaluate", {
    expression: `localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'true')`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sidebar-rail-avatar[data-active="true"]')?.click()`,
  });
  await sleep(200);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const panel = document.querySelector('.sidebar-panel').getBoundingClientRect();
      const chromeHeight = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--chrome-height'));
      const projects = getComputedStyle(document.querySelector('.projects')).display;
      const resizeHandle = getComputedStyle(document.querySelector('.sidebar-resize-handle')).display;
      return {
        expanded: shell?.getAttribute('data-sidebar-collapsed') === 'false',
        sidebarWidth: sidebar.width,
        panelTop: panel.top,
        shellTop: shell.getBoundingClientRect().top,
        chromeHeight,
        projectsVisible: projects !== 'none',
        resizeHandleHidden: resizeHandle === 'none',
        stored: localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}) || "",
        scrollWidth: document.documentElement.scrollWidth,
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.expanded || value.stored !== "false") {
    failures.push("narrow sidebar rail action should switch to expanded state");
  }

  if (!value.projectsVisible || value.sidebarWidth < 220) {
    failures.push("narrow sidebar rail action should reveal sidebar content");
  }

  if (value.panelTop < value.shellTop + value.chromeHeight - 1) {
    failures.push("narrow expanded sidebar panel should start below the app chrome");
  }

  if (!value.resizeHandleHidden) {
    failures.push("narrow sidebar should use toggle only, without resize handle");
  }

  if (value.scrollWidth > 520) {
    failures.push(`narrow sidebar overlay should not overflow horizontally: ${value.scrollWidth} > 520`);
  }

  return { value, failures };
}

// 사이드바 드래그 리사이즈와 선택 프로젝트 채팅 유지 여부를 확인한다.
async function verifySidebarResizeAndProjectContext(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  const dragStartResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      return { x: sidebar.right - 2, y: sidebar.top + 120, width: sidebar.width };
    })()`,
  });
  const dragStart = dragStartResult.result.value;

  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: dragStart.x,
    y: dragStart.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: dragStart.x + 64,
    y: dragStart.y,
    button: "left",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: dragStart.x + 64,
    y: dragStart.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(220);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      return {
        resizedWidth: sidebar.width,
        storedWidth: Number(localStorage.getItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}) || 0),
        sessionCountAfterResize: document.querySelectorAll('.history-row').length,
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.resizedWidth < dragStart.width + 40) {
    failures.push(`sidebar drag should widen the sidebar: ${value.resizedWidth} <= ${dragStart.width}`);
  }

  if (value.storedWidth < dragStart.width + 40) {
    failures.push("resized sidebar width should be stored in localStorage");
  }

  if (value.sessionCountAfterResize !== 1) {
    failures.push("selected project sessions should remain visible after sidebar resize");
  }

  return { value, failures };
}

// 우측 프로젝트 패널이 드래그로 넓어지고 폭이 저장되는지 확인한다.
async function verifyProjectPanelResize(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  const dragStartResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const panel = document.querySelector('.project-panel').getBoundingClientRect();
      const handle = document.querySelector('.project-panel-resize-handle').getBoundingClientRect();
      return {
        x: handle.left + handle.width / 2,
        y: handle.top + 120,
        width: panel.width,
      };
    })()`,
  });
  const dragStart = dragStartResult.result.value;

  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: dragStart.x,
    y: dragStart.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: dragStart.x - 72,
    y: dragStart.y,
    button: "left",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: dragStart.x - 72,
    y: dragStart.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(220);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const panel = document.querySelector('.project-panel').getBoundingClientRect();
      const handle = document.querySelector('.project-panel-resize-handle');
      return {
        resizedWidth: panel.width,
        storedWidth: Number(localStorage.getItem(${JSON.stringify(PROJECT_PANEL_WIDTH_STORAGE_KEY)}) || 0),
        ariaValue: Number(handle?.getAttribute('aria-valuenow') || 0),
        resizing: shell?.getAttribute('data-project-panel-resizing') || "",
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.resizedWidth < dragStart.width + 40) {
    failures.push(`project panel drag should widen the panel: ${value.resizedWidth} <= ${dragStart.width}`);
  }

  if (value.storedWidth < dragStart.width + 40) {
    failures.push("resized project panel width should be stored in localStorage");
  }

  if (value.ariaValue < dragStart.width + 40) {
    failures.push("project panel resize handle should expose the current width");
  }

  if (value.resizing !== "false") {
    failures.push("project panel resizing state should clear after mouse release");
  }

  return { value, failures };
}

// 우측 프로젝트 패널 접기 버튼이 채팅 화면을 유지한 채 접고 펼치는지 확인한다.
async function verifyProjectPanelCollapse(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  const initialResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      hasCollapseButton: Boolean(document.querySelector('.project-panel-collapse-toggle')),
      hasMaximizeButton: Boolean(document.querySelector('.project-panel-maximize-toggle')),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-panel-collapse-toggle')?.click()`,
  });
  await sleep(180);

  const collapsedResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const panel = document.querySelector('.project-panel').getBoundingClientRect();
      return {
        collapsed: shell?.getAttribute('data-project-panel-collapsed') === 'true',
        panelWidth: panel.width,
        hasRailButton: Boolean(document.querySelector('.project-panel-rail-toggle')),
        hasPrompt: Boolean(document.querySelector('.prompt')),
        stored: localStorage.getItem(${JSON.stringify(PROJECT_PANEL_COLLAPSED_STORAGE_KEY)}) || "",
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-panel-rail-toggle')?.click()`,
  });
  await sleep(180);

  const expandedResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const panel = document.querySelector('.project-panel').getBoundingClientRect();
      return {
        collapsed: shell?.getAttribute('data-project-panel-collapsed') === 'true',
        panelWidth: panel.width,
        menuButtons: document.querySelectorAll('.project-panel-menu button').length,
        stored: localStorage.getItem(${JSON.stringify(PROJECT_PANEL_COLLAPSED_STORAGE_KEY)}) || "",
      };
    })()`,
  });

  const value = {
    initial: initialResult.result.value,
    collapsed: collapsedResult.result.value,
    expanded: expandedResult.result.value,
  };
  const failures = [];

  if (!value.initial.hasCollapseButton || !value.initial.hasMaximizeButton) {
    failures.push("project panel menu should expose both collapse and maximize buttons");
  }

  if (!value.collapsed.collapsed || value.collapsed.stored !== "true") {
    failures.push("project panel collapsed state should be stored after clicking collapse");
  }

  if (value.collapsed.panelWidth > 70 || !value.collapsed.hasRailButton) {
    failures.push(`collapsed project panel should become a narrow rail: ${value.collapsed.panelWidth}`);
  }

  if (!value.collapsed.hasPrompt) {
    failures.push("collapsing the project panel should keep the chat prompt visible");
  }

  if (value.expanded.collapsed || value.expanded.stored !== "false") {
    failures.push("project panel should expand again from the rail button");
  }

  if (value.expanded.panelWidth < 300 || value.expanded.menuButtons !== 3) {
    failures.push("expanded project panel should restore its menu content");
  }

  debugLayout("project panel collapse", value);
  return { value, failures };
}

// 초기 진입, 프로젝트 내부 새 채팅, 전송 후에 입력창 포커스가 유지되는지 확인한다.
async function verifyPromptFocusFlow(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  const initialFocusResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.activeElement === document.querySelector('.prompt textarea')`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sidebar-section-head .project-chat-create-button')?.click()`,
  });
  await sleep(200);
  const newChatFocusResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.activeElement === document.querySelector('.prompt textarea')`,
  });

  await send("Input.insertText", { text: "포커스 테스트" });
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(400);
  const afterSubmitFocusResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.activeElement === document.querySelector('.prompt textarea')`,
  });
  const value = {
    initialFocused: initialFocusResult.result.value,
    newChatFocused: newChatFocusResult.result.value,
    afterSubmitFocused: afterSubmitFocusResult.result.value,
  };
  const failures = [];

  if (!value.initialFocused) {
    failures.push("prompt should be focused on initial load");
  }

  if (!value.newChatFocused) {
    failures.push("prompt should stay focused after creating a project chat");
  }

  if (!value.afterSubmitFocused) {
    failures.push("prompt should refocus after submit");
  }

  return { value, failures };
}

// 세션 전환과 프로젝트 내부 새 채팅에서 이전 초안이 다음 채팅으로 새지 않는지 확인한다.
async function verifyDraftClearsOnSessionChange(send) {
  const seededSessions = [
    {
      id: "session-draft-a",
      title: "Draft A",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-draft-a",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
      ],
    },
    {
      id: "session-draft-b",
      title: "Draft B",
      createdAt: Date.now() - 1,
      messages: [
        {
          id: "assistant-draft-b",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-draft-b",
          role: "user",
          content: "이전 대화",
        },
      ],
    },
  ];

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  const seededProjectState = createProjectStorage(
    "project-draft-smoke",
    "Draft Smoke",
    seededSessions,
  );
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  await send("Input.insertText", { text: "다른 세션으로 새면 안 되는 초안" });
  await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.history-item')).find((item) => item.textContent.includes('Draft B'))?.click()`,
  });
  await sleep(200);
  const afterHistoryClickResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.querySelector('.prompt textarea').value`,
  });

  await send("Input.insertText", { text: "새 채팅으로 새면 안 되는 초안" });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sidebar-section-head .project-chat-create-button')?.click()`,
  });
  await sleep(200);
  const afterNewChatResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.querySelector('.prompt textarea').value`,
  });
  const value = {
    afterHistoryClick: afterHistoryClickResult.result.value,
    afterNewChat: afterNewChatResult.result.value,
  };
  const failures = [];

  if (value.afterHistoryClick !== "") {
    failures.push("draft text should clear when selecting another session");
  }

  if (value.afterNewChat !== "") {
    failures.push("draft text should clear when creating a project chat");
  }

  return { value, failures };
}

// 히스토리에서 세션을 삭제하고 마지막 세션 삭제 시 새 채팅이 남는지 확인한다.
async function verifyDeleteSessionFlow(send) {
  const seededSessions = [
    {
      id: "session-delete-a",
      title: "Delete A",
      createdAt: Date.now(),
      messages: [
        {
          id: "assistant-delete-a",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-delete-a",
          role: "user",
          content: "삭제될 대화",
        },
      ],
    },
    {
      id: "session-delete-b",
      title: "Delete B",
      createdAt: Date.now() - 1,
      messages: [
        {
          id: "assistant-delete-b",
          role: "assistant",
          content: "저장된 응답입니다.",
        },
        {
          id: "user-delete-b",
          role: "user",
          content: "남을 대화",
        },
      ],
    },
  ];

  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  const seededProjectState = createProjectStorage(
    "project-delete-smoke",
    "Delete Smoke",
    seededSessions,
  );
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  await send("Input.insertText", { text: "삭제 후 남으면 안 되는 초안" });
  await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.history-row')).find((item) => item.textContent.includes('Delete A'))?.querySelector('.history-action-menu-button')?.click()`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-session"]')?.click()`,
  });
  await sleep(250);
  const afterFirstDeleteResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const titles = Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim());
      const activeTitle = document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "";
      return {
        titles,
        activeTitle,
        textAfterDelete: document.querySelector('.prompt textarea')?.value ?? "",
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.history-row')).find((item) => item.textContent.includes('Delete B'))?.querySelector('.history-action-menu-button')?.click()`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-session"]')?.click()`,
  });
  await sleep(250);
  const afterLastDeleteResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects.find((project) => project.id === savedState.selectedProjectId);
      const selectedSession = activeProject?.sessions.find(
        (session) => session.id === savedState.selectedSessionId,
      );
      return {
        titles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        sessionCount: activeProject?.sessions.length ?? 0,
        selectedSessionMessageCount: selectedSession?.messages.length ?? -1,
        selectedSessionId: savedState.selectedSessionId ?? null,
        hasPrompt: Boolean(document.querySelector('.prompt')),
        messageCount: document.querySelectorAll('.message').length,
        emptyTitle: document.querySelector('.chat-empty h1')?.textContent.trim() || "",
        hasProjectHome: Boolean(document.querySelector('.project-home')),
        uploadText: document.querySelector('.project-home-upload-card')?.textContent.trim() || "",
        hasProjectOverview: Boolean(document.querySelector('.project-overview')),
        hasOverviewPrompt: Boolean(document.querySelector('input[aria-label="프로젝트 질문 입력"]')),
      };
    })()`,
  });
  const value = {
    afterFirstDelete: afterFirstDeleteResult.result.value,
    afterLastDelete: afterLastDeleteResult.result.value,
  };
  const failures = [];

  if (value.afterFirstDelete.titles.includes("Delete A")) {
    failures.push("deleted session should disappear from history");
  }

  if (!value.afterFirstDelete.titles.includes("Delete B")) {
    failures.push("remaining session should stay in history");
  }

  if (value.afterFirstDelete.activeTitle !== "Delete B") {
    failures.push("selection should move to the next session after deleting the active session");
  }

  if (value.afterFirstDelete.textAfterDelete !== "") {
    failures.push("draft text should clear after deleting the active session");
  }

    if (value.afterLastDelete.titles.length !== 1 ||
        !value.afterLastDelete.titles.includes("New Chat") ||
        value.afterLastDelete.sessionCount !== 1 ||
        value.afterLastDelete.selectedSessionMessageCount !== 0 ||
        !value.afterLastDelete.selectedSessionId) {
      failures.push("deleting the last session should create a replacement empty chat");
    }

    if (!value.afterLastDelete.hasPrompt ||
        value.afterLastDelete.messageCount !== 0 ||
        !value.afterLastDelete.emptyTitle.includes("Delete Smoke") ||
        value.afterLastDelete.hasProjectHome ||
        value.afterLastDelete.uploadText !== "" ||
        value.afterLastDelete.hasProjectOverview ||
        value.afterLastDelete.hasOverviewPrompt) {
      failures.push("project should stay in chat after deleting the last session");
    }

  return { value, failures };
}

const browserPath = findBrowserPath();
rmSync(USER_DATA_DIR, { recursive: true, force: true });

const vite = spawn(process.execPath, [VITE_BIN, "--host", "127.0.0.1", "--port", "1420", "--strictPort", "--force"], {
  env: { ...process.env, VITE_GITHUB_CLIENT_ID: "smoke-client" },
  stdio: "ignore",
});

const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${USER_DATA_DIR}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], {
  stdio: "ignore",
});

try {
  await waitForHttp(APP_URL);
  await waitForDebuggingPort();

  const tab = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${APP_URL}`, {
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
  await installPaimApiMock(send);

  let hasFailures = false;
  const storageResult = await verifyStorageSanitization(send);

  if (storageResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL storage sanitization");
    storageResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS storage sanitization excludes preview data URLs");
  }

  const iconTooltipResult = await verifyIconButtonTooltips(send);

  if (iconTooltipResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL icon button tooltips");
    iconTooltipResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS icon buttons expose hover tooltips");
  }

  const sidebarBrandTypographyResult = await verifySidebarBrandTypography(send);

  if (sidebarBrandTypographyResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL empty first-run project start");
    sidebarBrandTypographyResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS empty first-run state shows project start screen");
  }

  const copyFeedbackResult = await verifyCopyFeedback(send);

  if (copyFeedbackResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL copy feedback");
    copyFeedbackResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS copy button exposes copied feedback");
  }

  const longContentResult = await verifyLongContentLayout(send);

  if (longContentResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL long content layout");
    longContentResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS long content stays inside the layout");
  }

  const projectScopedSessionsResult = await verifyProjectScopedSessions(send);

  if (projectScopedSessionsResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project-scoped sessions");
    projectScopedSessionsResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS chat sessions are scoped to the active project");
  }

  const projectCreationResult = await verifyProjectCreationFlow(send);

  if (projectCreationResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project creation flow");
    projectCreationResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS new projects are created as active workspaces");
  }

  const projectBriefingResult = await verifyProjectBriefingStartsWithoutVisiblePrompt(send);

  if (projectBriefingResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project briefing start flow");
    projectBriefingResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project briefing enters chat without exposing the generated prompt");
  }

  const actionMenuRenameResult = await verifyActionMenuRenameFlow(send);

  if (actionMenuRenameResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL action menu rename flow");
    actionMenuRenameResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS action menus rename projects and chats");
  }

  const projectDeleteResult = await verifyProjectDeleteFlow(send);

  if (projectDeleteResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project delete flow");
    projectDeleteResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS projects can be deleted down to an empty state");
  }

  const draftAttachmentTrayResult = await verifyDraftAttachmentTrayLayout(send);

  if (draftAttachmentTrayResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL draft attachment tray layout");
    draftAttachmentTrayResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS draft attachment tray stays compact inside the prompt");
  }

  const multilineInputResult = await verifyMultilineInput(send);

  if (multilineInputResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL multiline input");
    multilineInputResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS multiline input supports Enter submit and Shift+Enter newline");
  }

  const projectPanelMenuResult = await verifyProjectPanelMenu(send);

  if (projectPanelMenuResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project panel menu");
    projectPanelMenuResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project panel menu opens detail views");
  }

  const chatQuestionResult = await verifyProjectChatQuestion(send);

  if (chatQuestionResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project chat question");
    chatQuestionResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project chat question uses the demo response flow");
  }

  const overviewFilesResult = await verifyProjectOverviewFiles(send);

  if (overviewFilesResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project overview files");
    overviewFilesResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project overview files can be managed");
  }

  const githubTimelineResult = await verifyGithubTimelineState(send);

  if (githubTimelineResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL GitHub timeline state");
    githubTimelineResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS GitHub timeline switches between connect and events");
  }

  const sidebarPersistenceResult = await verifySidebarPersistence(send);

  if (sidebarPersistenceResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL sidebar persistence");
    sidebarPersistenceResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS sidebar collapsed state persists after reload");
  }

  const narrowSidebarToggleResult = await verifyNarrowSidebarToggle(send);

  if (narrowSidebarToggleResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL narrow sidebar toggle");
    narrowSidebarToggleResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS narrow sidebar toggle opens sidebar content");
  }

  const sidebarResizeCollapseResult = await verifySidebarResizeAndProjectContext(send);

  if (sidebarResizeCollapseResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL sidebar resize and project context");
    sidebarResizeCollapseResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS sidebar resizes and keeps project context");
  }

  const projectPanelResizeResult = await verifyProjectPanelResize(send);

  if (projectPanelResizeResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project panel resize");
    projectPanelResizeResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project panel resizes and stores width");
  }

  const projectPanelCollapseResult = await verifyProjectPanelCollapse(send);

  if (projectPanelCollapseResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project panel collapse");
    projectPanelCollapseResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project panel collapses and reopens");
  }

  const promptFocusResult = await verifyPromptFocusFlow(send);

  if (promptFocusResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL prompt focus flow");
    promptFocusResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS prompt focus is restored for demo typing flow");
  }

  const draftClearResult = await verifyDraftClearsOnSessionChange(send);

  if (draftClearResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL draft clear on session change");
    draftClearResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS draft clears on session changes");
  }

  const deleteSessionResult = await verifyDeleteSessionFlow(send);

  if (deleteSessionResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL delete session flow");
    deleteSessionResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS chat sessions can be deleted");
  }

  for (const scenario of scenarios) {
    const result = await measureScenario(send, scenario);
    const state = [
      `${scenario.width}x${scenario.height}`,
      scenario.collapsed ? "collapsed" : "open",
      scenario.dragActive ? "drag" : "normal",
    ].join(" ");

    if (result.failures.length > 0) {
      hasFailures = true;
      console.log(`FAIL ${state}`);
      result.failures.forEach((failure) => console.log(`  - ${failure}`));
      continue;
    }

    console.log(
      `PASS ${state} prompt=${result.value.prompt.left.toFixed(1)}-${result.value.prompt.right.toFixed(1)} scroll=${result.value.scrollWidth}`,
    );
  }

  ws.close();

  if (hasFailures) {
    process.exitCode = 1;
  }
} finally {
  browser.kill("SIGTERM");
  vite.kill("SIGTERM");
  setTimeout(() => browser.kill("SIGKILL"), 1000).unref();
  setTimeout(() => vite.kill("SIGKILL"), 1000).unref();
}
