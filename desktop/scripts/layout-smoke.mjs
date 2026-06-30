import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const APP_URL = "http://127.0.0.1:1420/";
const LEGACY_STORAGE_KEY = "paim.chatSessions.v2";
const PROJECT_STORAGE_KEY = "paim.projects.v1";
const SIDEBAR_STORAGE_KEY = "paim.sidebarCollapsed.v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "paim.sidebarWidth.v1";
const PROJECT_COLLAPSED_STORAGE_KEY = "paim.projectCollapsed.v1";
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
            content: "안녕하세요! 😊",
          },
        ],
      },
    ],
    "session-smoke",
  );

  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
}

async function openAppWithoutProjects(send) {
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.removeItem(${JSON.stringify(PROJECT_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)})`,
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
      expression: "document.querySelector('.sidebar-toggle')?.click()",
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
      const overviewButton = document.querySelector('button[aria-label="프로젝트 개요"]');
      const sidebarToggle = document.querySelector('.sidebar-toggle');
      const sidebarToggleBox = sidebarToggle?.getBoundingClientRect();
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
        overviewButtonExists: Boolean(overviewButton),
        overviewButtonDisabled: overviewButton?.disabled ?? true,
        sidebarToggleVisible: Boolean(sidebarToggleBox?.width && sidebarToggleBox?.height),
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

  if (!value.overviewButtonExists || value.overviewButtonDisabled) {
    failures.push("project overview button should be enabled in the prompt");
  }

  if (!value.sidebarToggleVisible) {
    failures.push("sidebar toggle should stay visible in narrow zoom-like layouts");
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
          content: "안녕하세요! 😊",
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
        title: button.getAttribute('title') || '',
      }))
      .filter((button) => button.title.trim().length === 0)`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.length > 0) {
    failures.push(`icon buttons missing title: ${value.map((button) => button.label).join(", ")}`);
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
      const fontSize = (selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      const sidebar = box('.sidebar');
      const toggle = box('.sidebar-toggle');
      const projectCreate = box('.project-create-trigger');
      const watermark = box('.project-start-watermark');

      return {
        rootFont: getComputedStyle(document.documentElement).fontFamily,
        hasSidebarBrand: Boolean(document.querySelector('.sidebar-brand')),
        hasSidebarFooter: Boolean(document.querySelector('.sidebar-footer')),
        hasPrompt: Boolean(document.querySelector('.prompt')),
        hasMessage: Boolean(document.querySelector('.message')),
        watermark,
        watermarkAlt: document.querySelector('.project-start-watermark')?.getAttribute('alt') || "",
        startButtonText: document.querySelector('.project-start-button')?.textContent.trim() || "",
        toggle,
        projectCreate,
        sidebar,
        navFontSize: fontSize('.sidebar-nav button'),
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.rootFont.includes("D2Coding") && !value.rootFont.includes("D2 Coding")) {
    failures.push(`D2Coding should be the first configured app font: ${value.rootFont}`);
  }

  if (value.hasSidebarBrand || value.hasSidebarFooter) {
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

  if (value.toggle.right < value.sidebar.right - 42 || value.toggle.top > value.sidebar.top + 18) {
    failures.push("sidebar toggle should sit at the sidebar top-right");
  }

  if (value.projectCreate.top > value.sidebar.top + 48) {
    failures.push("new project action should stay near the top of the sidebar");
  }

  if (value.navFontSize > 13.5) {
    failures.push("sidebar text should stay compact");
  }

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-start-button')?.click()`,
  });
  await sleep(250);
  const afterStartResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      return {
        projectCount: savedState.projects?.length ?? 0,
        activeProjectName: document.querySelector('.project-item[data-active="true"] .project-name')?.textContent.trim() || "",
        activeSessionCount: savedState.projects?.find((project) => project.id === savedState.selectedProjectId)?.sessions.length ?? 0,
        selectedSessionId: savedState.selectedSessionId ?? null,
        hasPrompt: Boolean(document.querySelector('.prompt')),
        hasProjectOverview: Boolean(document.querySelector('.project-overview')),
        overviewTitle: document.querySelector('.project-overview h1')?.textContent.trim() || "",
        hasOverviewPrompt: Boolean(document.querySelector('input[aria-label="프로젝트 질문 입력"]')),
      };
    })()`,
  });
  value.afterStart = afterStartResult.result.value;

  if (value.afterStart.projectCount !== 1 ||
      value.afterStart.activeProjectName !== "New Project" ||
      value.afterStart.activeSessionCount !== 0 ||
      value.afterStart.selectedSessionId !== null ||
      value.afterStart.hasPrompt ||
      !value.afterStart.hasProjectOverview ||
      value.afterStart.overviewTitle !== "New Project" ||
      !value.afterStart.hasOverviewPrompt) {
    failures.push("start project button should create the first project and show overview");
  }

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
        copiedTitle: copiedButton?.getAttribute('title') || "",
        copiedText: window.__paimCopiedText || "",
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (!value.hasCopiedState) {
    failures.push("copy button should enter the copied state");
  }

  if (value.copiedLabel !== "복사됨" || value.copiedTitle !== "복사됨") {
    failures.push("copy button should expose copied feedback labels");
  }

  if (!value.copiedText.includes("안녕하세요")) {
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
          content: "안녕하세요! 😊",
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
          content: "안녕하세요! 😊",
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
      projectNames: Array.from(document.querySelectorAll('.project-item')).map((item) => item.textContent.trim()),
      visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
      activeProject: document.querySelector('.project-item[data-active="true"] .project-name')?.textContent.trim() || "",
      activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
    }))()`,
  });

  await send("Input.insertText", { text: "프로젝트 전환 후 비워져야 하는 초안" });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-item[data-project-id="project-beta"]')?.click()`,
  });
  await sleep(250);

  const switchResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
      activeProject: document.querySelector('.project-item[data-active="true"] .project-name')?.textContent.trim() || "",
      activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
      selectedSessionId: JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}').selectedSessionId ?? null,
      hasPrompt: Boolean(document.querySelector('.prompt')),
      overviewTitle: document.querySelector('.project-overview h1')?.textContent.trim() || "",
      conversationText: document.querySelector('.conversation')?.textContent || "",
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-group[data-project-id="project-beta"] .project-chat-create-button')?.click()`,
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
        activeProject: document.querySelector('.project-item[data-active="true"] .project-name')?.textContent.trim() || "",
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
      !initialValue.visibleTitles.includes("Beta Risk Review")) {
    failures.push("project tree should show chats under every saved project");
  }

  if (initialValue.activeTitle !== "Alpha Kickoff") {
    failures.push("saved selected chat should be active on load");
  }

  if (switchValue.activeProject !== "Beta Project") {
    failures.push("project switch should activate the clicked project");
  }

  if (switchValue.activeTitle !== "" ||
      switchValue.selectedSessionId !== null ||
      switchValue.hasPrompt ||
      switchValue.overviewTitle !== "Beta Project") {
    failures.push("project switch should show the clicked project's overview");
  }

  if (!switchValue.visibleTitles.includes("Beta Risk Review") ||
      !switchValue.visibleTitles.includes("Alpha Kickoff")) {
    failures.push("project tree should keep every project's chats visible after switching");
  }

  if (switchValue.conversationText !== "") {
    failures.push("project overview should hide the previous chat conversation");
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
          content: "안녕하세요! 😊",
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
  await sleep(120);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-create-option[data-source="folder"]')?.click()`,
  });
  await sleep(250);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProjectName = document.querySelector('.project-item[data-active="true"] .project-name')?.textContent.trim() || "";
      const activeProject = savedState.projects.find((project) => project.id === savedState.selectedProjectId);
      const selectedSession = activeProject?.sessions.find(
        (session) => session.id === savedState.selectedSessionId,
      );

      return {
        projectCount: savedState.projects.length,
        activeProjectName,
        activeProjectStoredName: activeProject?.name || "",
        activeProjectSessionCount: activeProject?.sessions.length ?? 0,
        selectedSessionId: savedState.selectedSessionId ?? null,
        selectedSessionTitle: selectedSession?.title || "",
        visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        promptValue: document.querySelector('textarea[aria-label="메시지 입력"]')?.value ?? "",
        hasPrompt: Boolean(document.querySelector('.prompt')),
        hasProjectOverview: Boolean(document.querySelector('.project-overview')),
        overviewTitle: document.querySelector('.project-overview h1')?.textContent.trim() || "",
        hasOverviewPrompt: Boolean(document.querySelector('input[aria-label="프로젝트 질문 입력"]')),
        hasCreateTrigger: Boolean(Array.from(document.querySelectorAll('.project-create-trigger')).find((button) => button.textContent.includes('New Project'))),
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

  if (value.activeProjectName !== "New Project" || value.activeProjectStoredName !== "New Project") {
    failures.push("newly created project should become the active project");
  }

  if (value.activeProjectSessionCount !== 0 ||
      value.selectedSessionId !== null ||
      value.selectedSessionTitle !== "") {
    failures.push("new project should be created without a chat session");
  }

  if (value.hasCreateMenu) {
    failures.push("project create menu should close after creating a project");
  }

  if (value.visibleTitles.includes("New Chat") || !value.visibleTitles.includes("Existing Planning")) {
    failures.push("project tree should not add a chat until the user starts one");
  }

  if (value.hasPrompt ||
      !value.hasProjectOverview ||
      value.overviewTitle !== "New Project" ||
      !value.hasOverviewPrompt) {
    failures.push("new project without chats should show the project overview");
  }

  if (value.promptValue !== "") {
    failures.push("draft text should clear when creating a project");
  }

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
            content: "안녕하세요! 😊",
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
    expression: `document.querySelector('.project-group[data-project-id="project-rename"] .project-action-menu-button')?.click()`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `window.__projectActionMenuBox = (() => {
      const menu = document.querySelector('.item-action-menu');
      const sidebar = document.querySelector('.sidebar');
      if (!menu || !sidebar) return null;
      const menuRect = menu.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      return {
        left: menuRect.left,
        right: menuRect.right,
        top: menuRect.top,
        bottom: menuRect.bottom,
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
        sidebarTop: sidebarRect.top,
        sidebarBottom: sidebarRect.bottom,
      };
    })()`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="rename-project"]')?.click()`,
  });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.project-rename-editor .rename-input');
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
    expression: `document.querySelector('.history-row[data-active="true"] .history-action-menu-button')?.click()`,
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
        visibleProjectName: document.querySelector('.project-name')?.textContent.trim() || "",
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
      value.projectMenuBox.left < value.projectMenuBox.sidebarLeft ||
      value.projectMenuBox.right > value.projectMenuBox.sidebarRight ||
      value.projectMenuBox.top < value.projectMenuBox.sidebarTop ||
      value.projectMenuBox.bottom > value.projectMenuBox.sidebarBottom) {
    failures.push("project action menu should render inside the sidebar bounds");
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
          content: "안녕하세요! 😊",
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
          content: "안녕하세요! 😊",
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
    expression: `document.querySelector('.project-group[data-project-id="project-delete-beta"] .project-action-menu-button')?.click()`,
  });
  await sleep(80);
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
        activeProjectName: document.querySelector('.project-item[data-active="true"] .project-name')?.textContent.trim() || "",
        activeTitle: document.querySelector('.history-row[data-active="true"] .history-title')?.textContent.trim() || "",
        visibleTitles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        promptValue: document.querySelector('textarea[aria-label="메시지 입력"]')?.value ?? "",
        overviewTitle: document.querySelector('.project-overview h1')?.textContent.trim() || "",
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-group[data-project-id="project-delete-alpha"] .project-action-menu-button')?.click()`,
  });
  await sleep(80);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.item-action-menu [data-action="delete-project"]')?.click()`,
  });
  await sleep(250);
  const readEmptyProjectStateExpression = `(() => {
    const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
    const projects = savedState.projects || [];
    const textarea = document.querySelector('textarea[aria-label="메시지 입력"]');
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
      value.afterActiveDelete.selectedSessionId !== null) {
    failures.push("selection should move to the remaining project's overview after deleting the active project");
  }

  if (value.afterActiveDelete.activeProjectName !== "Delete Alpha" ||
      value.afterActiveDelete.activeTitle !== "" ||
      value.afterActiveDelete.overviewTitle !== "Delete Alpha") {
    failures.push("remaining project should become active and show overview");
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
      const input = document.querySelector('textarea[aria-label="메시지 입력"]');
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
    expression: `document.querySelector('textarea[aria-label="메시지 입력"]').value`,
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
      const input = document.querySelector('textarea[aria-label="메시지 입력"]');
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

  return { value, failures };
}

// 채팅 입력부의 Overview 버튼이 현재 프로젝트 개요로 돌아가는지 확인한다.
async function verifyPromptOverviewButton(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="프로젝트 개요"]')?.click()`,
  });
  await sleep(200);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      return {
        selectedSessionId: savedState.selectedSessionId ?? null,
        hasPrompt: Boolean(document.querySelector('.prompt')),
        hasOverview: Boolean(document.querySelector('.project-overview')),
        overviewTitle: document.querySelector('.project-overview h1')?.textContent.trim() || "",
        modelSelectorExists: Boolean(document.querySelector('.model-pill')),
      };
    })()`,
  });
  const value = result.result.value;
  const failures = [];

  if (value.selectedSessionId !== null || value.hasPrompt) {
    failures.push("overview button should leave the current chat session");
  }

  if (!value.hasOverview || value.overviewTitle !== "Smoke Project") {
    failures.push("overview button should show the current project overview");
  }

  if (value.modelSelectorExists) {
    failures.push("model selector should not render in the prompt");
  }

  return { value, failures };
}

// Overview 질문 입력이 새 채팅 세션과 데모 응답으로 이어지는지 확인한다.
async function verifyProjectOverviewQuestion(send) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openAppWithProject(send);

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="프로젝트 개요"]')?.click()`,
  });
  await sleep(200);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('input[aria-label="프로젝트 질문 입력"]');
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

      valueSetter?.call(input, '이번 주 액션 알려줘');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="프로젝트 질문 보내기"]')?.click()`,
  });
  await sleep(800);

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

  if (value.sessionCount !== 2 || value.activeTitle !== "이번 주 액션 알려줘") {
    failures.push("overview question should create a new chat session");
  }

  if (!value.hasPrompt || value.hasOverview) {
    failures.push("overview question should switch to the chat view");
  }

  if (!value.conversationText.includes("이번 주 액션 알려줘") ||
      !value.conversationText.includes("좋아요. 이 내용을 프로젝트 메모로 정리할 수 있습니다.")) {
    failures.push("overview question should submit through the demo chat flow");
  }

  return { value, failures };
}

// Overview 파일 목록은 프로젝트 소유 파일을 보여주고 삭제할 수 있어야 한다.
async function verifyProjectOverviewFiles(send) {
  const projectFiles = [
    { id: "file-audio", name: "회의.m4a", path: "/tmp/회의.m4a" },
    { id: "file-spec", name: "기획서.pdf", path: "/tmp/기획서.pdf" },
    ...Array.from({ length: 16 }, (_, index) => ({
      id: `file-extra-${index}`,
      name: `추가자료_${index + 1}.pdf`,
      path: `/tmp/추가자료_${index + 1}.pdf`,
    })),
  ];
  const seededProjectState = createProjectStorage(
    "project-files",
    "Files Project",
    [],
    null,
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
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(seededProjectState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const initialResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      fileNames: Array.from(document.querySelectorAll('.overview-file-row p')).map((item) => item.textContent.trim()),
      fileCountText: document.querySelector('.project-overview-meta')?.textContent.trim() || "",
      fileListScrollable: document.querySelector('.overview-file-list')?.scrollHeight > document.querySelector('.overview-file-list')?.clientHeight,
      fileListOverflow: getComputedStyle(document.querySelector('.overview-file-list')).overflowY,
      hasPrompt: Boolean(document.querySelector('.prompt')),
      hasOverview: Boolean(document.querySelector('.project-overview')),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="기획서.pdf 삭제"]')?.click()`,
  });
  await sleep(200);

  const afterDeleteResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const savedState = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_STORAGE_KEY)}) || '{}');
      const activeProject = savedState.projects?.find((project) => project.id === savedState.selectedProjectId);

      return {
        storedFileNames: activeProject?.files?.map((file) => file.name) ?? [],
        visibleFileNames: Array.from(document.querySelectorAll('.overview-file-row p')).map((item) => item.textContent.trim()),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-overview-file-action')?.click()`,
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
      };
    })()`,
  });

  const value = {
    initial: initialResult.result.value,
    afterDelete: afterDeleteResult.result.value,
    afterAddClick: afterAddClickResult.result.value,
  };
  const failures = [];

  if (!value.initial.fileNames.includes("회의.m4a") ||
      !value.initial.fileNames.includes("기획서.pdf") ||
      !value.initial.fileCountText.includes(`${projectFiles.length} FILES`)) {
    failures.push("overview should render project files");
  }

  if (!value.initial.fileListScrollable || value.initial.fileListOverflow === "visible") {
    failures.push("overview file list should scroll inside a bounded area");
  }

  if (value.initial.hasPrompt || !value.initial.hasOverview) {
    failures.push("project files should render on the overview without chat UI");
  }

  if (value.afterDelete.storedFileNames.includes("기획서.pdf") ||
      value.afterDelete.visibleFileNames.includes("기획서.pdf") ||
      value.afterDelete.storedFileNames.length !== projectFiles.length - 1) {
    failures.push("overview file delete should remove only the selected project file");
  }

  if (value.afterAddClick.sessionCount !== 0 ||
      value.afterAddClick.selectedSessionId !== null ||
      value.afterAddClick.hasChatPrompt ||
      !value.afterAddClick.hasOverview) {
    failures.push("overview file add should not create or enter a chat session");
  }

  return { value, failures };
}

// GitHub 연동 전에는 버튼을, 연동 데이터가 있으면 issue/PR/commit을 보여준다.
async function verifyGithubTimelineState(send) {
  const now = Date.now();
  const unlinkedState = createProjectStorage(
    "project-github-unlinked",
    "GitHub Unlinked",
    [],
    null,
  );
  const linkedState = createProjectStorage(
    "project-github-linked",
    "GitHub Linked",
    [],
    null,
    [],
    {
      githubConnected: true,
      githubRepository: {
        path: "/tmp/stampy",
        name: "stampy",
        branch: "main",
        isDirty: true,
        remoteRepo: "j3s30p/Stampy",
        issuePrStatus: "GitHub issue/PR 연동됨",
      },
      githubEvents: [
        {
          id: "github-pr",
          type: "pull_request",
          title: "PR #18 프로젝트 Overview 연결",
          status: "open",
          createdAt: now - 1000 * 60 * 30,
        },
        {
          id: "github-issue",
          type: "issue",
          title: "issue #21 파일 목록 스크롤",
          status: "open",
          createdAt: now - 1000 * 60 * 60 * 3,
        },
        {
          id: "github-commit",
          type: "commit",
          title: "feat: project file management",
          createdAt: now - 1000 * 60 * 60 * 8,
        },
      ],
    },
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
    expression: `localStorage.removeItem(${JSON.stringify(LEGACY_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}, 'false'); localStorage.setItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}, '272'); localStorage.removeItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}); localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(unlinkedState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const unlinkedResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      hasConnectButton: Boolean(Array.from(document.querySelectorAll('.overview-github-empty button')).find((button) => button.textContent.includes('GitHub 연동'))),
      hasTimelineRows: Boolean(document.querySelector('.overview-timeline-row')),
    }))()`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.overview-github-empty button')?.click()`,
  });
  await sleep(100);

  const connectClickResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const input = document.querySelector('.overview-github-connect-form input');
      return {
        hasUrlInput: Boolean(input),
        urlValue: input?.value ?? null,
        hasRuntimeStatus: Boolean(document.querySelector('.runtime-status')),
        sidebarHasRuntimeStatus: Boolean(document.querySelector('.sidebar .runtime-status')),
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.overview-github-connect-form input');
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'https://example.com/not-a-github-repo');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.overview-github-connect-form button')?.click();
    })()`,
  });
  await sleep(250);

  const invalidSubmitResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const githubPanel = document.querySelector('section[aria-label="GitHub 타임라인"]');
      const githubStatus = githubPanel?.querySelector('.runtime-status');
      const status = document.querySelector('.runtime-status');
      return {
        githubPanelHasStatus: Boolean(githubStatus),
        githubStatusText: githubStatus?.textContent.trim() ?? "",
        githubStatusOk: githubStatus?.getAttribute('data-ok') ?? "",
        sidebarHasRuntimeStatus: Boolean(document.querySelector('.sidebar .runtime-status')),
        runtimeStatusCount: document.querySelectorAll('.runtime-status').length,
        animationName: status ? getComputedStyle(status).animationName : "",
      };
    })()`,
  });

  await send("Runtime.evaluate", {
    expression: `localStorage.setItem(${JSON.stringify(PROJECT_STORAGE_KEY)}, ${JSON.stringify(linkedState)})`,
  });
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);

  const linkedResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      titles: Array.from(document.querySelectorAll('.overview-timeline-row p')).map((item) => item.textContent.trim()),
      meta: Array.from(document.querySelectorAll('.overview-timeline-row small')).map((item) => item.textContent.trim()),
      repoMeta: document.querySelector('.overview-github-meta')?.textContent.trim() || "",
      visibleIconCount: Array.from(document.querySelectorAll('.overview-timeline-icon .tabler-icon')).filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width >= 12 && rect.height >= 12;
      }).length,
      boxedIconCount: Array.from(document.querySelectorAll('.overview-timeline-icon .tabler-icon')).filter((item) => (
        getComputedStyle(item).backgroundColor !== 'rgba(0, 0, 0, 0)'
      )).length,
      hasConnectButton: Boolean(document.querySelector('.overview-github-empty button')),
    }))()`,
  });

  const value = {
    unlinked: unlinkedResult.result.value,
    connectForm: connectClickResult.result.value,
    invalidSubmit: invalidSubmitResult.result.value,
    linked: linkedResult.result.value,
  };
  const failures = [];

  if (!value.unlinked.hasConnectButton || value.unlinked.hasTimelineRows) {
    failures.push("unlinked GitHub timeline should show only a connect button");
  }

  if (!value.connectForm.hasUrlInput || value.connectForm.urlValue !== "" ||
      value.connectForm.hasRuntimeStatus || value.connectForm.sidebarHasRuntimeStatus) {
    failures.push("GitHub connect button should open an empty inline repository URL form");
  }

  if (!value.invalidSubmit.githubPanelHasStatus ||
      value.invalidSubmit.githubStatusOk !== "false" ||
      !value.invalidSubmit.githubStatusText.includes("GitHub repo를 연결할 수 없습니다") ||
      value.invalidSubmit.sidebarHasRuntimeStatus ||
      value.invalidSubmit.runtimeStatusCount !== 1) {
    failures.push("GitHub connection failure status should render inside the GitHub panel only");
  }

  if (!value.invalidSubmit.animationName.includes("status-shake")) {
    failures.push("GitHub connection failure status should keep the shake animation");
  }

  if (value.linked.hasConnectButton ||
      !value.linked.titles.includes("PR #18 프로젝트 Overview 연결") ||
      !value.linked.titles.includes("issue #21 파일 목록 스크롤") ||
      !value.linked.titles.includes("feat: project file management")) {
    failures.push("linked GitHub timeline should render issue, PR, and commit events");
  }

  if (!value.linked.meta.some((item) => item.includes("PR")) ||
      !value.linked.meta.some((item) => item.includes("ISSUE")) ||
      !value.linked.meta.some((item) => item.includes("COMMIT"))) {
    failures.push("linked GitHub timeline should label event types");
  }

  if (value.linked.visibleIconCount !== 3) {
    failures.push("linked GitHub timeline should render visible event icons");
  }

  if (value.linked.boxedIconCount !== 0) {
    failures.push("linked GitHub timeline icons should not render boxed backgrounds");
  }

  if (!value.linked.repoMeta.includes("stampy") ||
      !value.linked.repoMeta.includes("main") ||
      !value.linked.repoMeta.includes("j3s30p/Stampy") ||
      !value.linked.repoMeta.includes("GitHub issue/PR 연동됨")) {
    failures.push("linked GitHub timeline should show repository metadata");
  }

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
    expression: `document.querySelector('.sidebar-toggle')?.click()`,
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
    expression: `document.querySelector('.sidebar-toggle')?.click()`,
  });
  await sleep(200);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const projects = getComputedStyle(document.querySelector('.projects')).display;
      const resizeHandle = getComputedStyle(document.querySelector('.sidebar-resize-handle')).display;
      return {
        expanded: shell?.getAttribute('data-sidebar-collapsed') === 'false',
        sidebarWidth: sidebar.width,
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
    failures.push("narrow sidebar toggle should switch to expanded state");
  }

  if (!value.projectsVisible || value.sidebarWidth < 220) {
    failures.push("narrow sidebar toggle should reveal sidebar content");
  }

  if (!value.resizeHandleHidden) {
    failures.push("narrow sidebar should use toggle only, without resize handle");
  }

  if (value.scrollWidth > 520) {
    failures.push(`narrow sidebar overlay should not overflow horizontally: ${value.scrollWidth} > 520`);
  }

  return { value, failures };
}

// 사이드바 드래그 리사이즈와 프로젝트별 채팅 묶음 접기/펼치기를 확인한다.
async function verifySidebarResizeAndProjectCollapse(send) {
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

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-collapse-button')?.click()`,
  });
  await sleep(160);
  await send("Page.navigate", { url: APP_URL });
  await sleep(700);
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-collapse-button')?.click()`,
  });
  await sleep(160);

  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const storedCollapsedIds = JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_COLLAPSED_STORAGE_KEY)}) || '[]');
      return {
        resizedWidth: sidebar.width,
        storedWidth: Number(localStorage.getItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)}) || 0),
        sessionCountAfterExpand: document.querySelectorAll('.history-row').length,
        projectExpanded: document.querySelector('.project-collapse-button')?.getAttribute('aria-expanded') || "",
        storedCollapsedIds,
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

  if (value.sessionCountAfterExpand !== 1 || value.projectExpanded !== "true") {
    failures.push("project collapse button should hide and reopen its chat sessions");
  }

  if (value.storedCollapsedIds.includes("project-smoke")) {
    failures.push("expanded project should be removed from collapsed project storage");
  }

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
    expression: `document.activeElement === document.querySelector('textarea[aria-label="메시지 입력"]')`,
  });

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-group[data-active="true"] .project-chat-create-button')?.click()`,
  });
  await sleep(200);
  const newChatFocusResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.activeElement === document.querySelector('textarea[aria-label="메시지 입력"]')`,
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
    expression: `document.activeElement === document.querySelector('textarea[aria-label="메시지 입력"]')`,
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
          content: "안녕하세요! 😊",
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
          content: "안녕하세요! 😊",
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
    expression: `document.querySelector('textarea[aria-label="메시지 입력"]').value`,
  });

  await send("Input.insertText", { text: "새 채팅으로 새면 안 되는 초안" });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.project-group[data-active="true"] .project-chat-create-button')?.click()`,
  });
  await sleep(200);
  const afterNewChatResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.querySelector('textarea[aria-label="메시지 입력"]').value`,
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
          content: "안녕하세요! 😊",
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
          content: "안녕하세요! 😊",
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
        textAfterDelete: document.querySelector('textarea[aria-label="메시지 입력"]').value,
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
      return {
        titles: Array.from(document.querySelectorAll('.history-title')).map((item) => item.textContent.trim()),
        sessionCount: activeProject?.sessions.length ?? 0,
        selectedSessionId: savedState.selectedSessionId ?? null,
        hasPrompt: Boolean(document.querySelector('.prompt')),
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

  if (value.afterLastDelete.titles.length !== 0 ||
      value.afterLastDelete.sessionCount !== 0 ||
      value.afterLastDelete.selectedSessionId !== null) {
    failures.push("deleting the last session should leave the project without chats");
  }

  if (value.afterLastDelete.hasPrompt ||
      !value.afterLastDelete.hasProjectOverview ||
      !value.afterLastDelete.hasOverviewPrompt) {
    failures.push("project without chats should hide prompt and show project overview");
  }

  return { value, failures };
}

const browserPath = findBrowserPath();
rmSync(USER_DATA_DIR, { recursive: true, force: true });

const vite = spawn(process.execPath, [VITE_BIN, "--host", "127.0.0.1", "--port", "1420", "--strictPort"], {
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

  const promptOverviewResult = await verifyPromptOverviewButton(send);

  if (promptOverviewResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL prompt overview button");
    promptOverviewResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS prompt overview button opens project overview");
  }

  const overviewQuestionResult = await verifyProjectOverviewQuestion(send);

  if (overviewQuestionResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL project overview question");
    overviewQuestionResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS project overview question starts a chat");
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

  const sidebarResizeCollapseResult = await verifySidebarResizeAndProjectCollapse(send);

  if (sidebarResizeCollapseResult.failures.length > 0) {
    hasFailures = true;
    console.log("FAIL sidebar resize and project collapse");
    sidebarResizeCollapseResult.failures.forEach((failure) => console.log(`  - ${failure}`));
  } else {
    console.log("PASS sidebar resizes and project chat groups collapse");
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
