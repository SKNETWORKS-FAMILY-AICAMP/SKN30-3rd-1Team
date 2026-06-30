import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileUp,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LayoutDashboard,
  Ellipsis,
  Link2,
  Lightbulb,
  LogOut,
  MessageSquare,
  Minus,
  PanelLeft,
  Plus,
  RefreshCcw,
  Search,
  Square,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  type CSSProperties,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import githubMark from "../assets/github/github-mark.svg";
import paimWatermark from "./assets/paim-watermark.png";
import tablerAlertCircle from "./assets/tabler-icons/alert-circle.svg?raw";
import tablerAlertTriangle from "./assets/tabler-icons/alert-triangle.svg?raw";
import tablerArrowRight from "./assets/tabler-icons/arrow-right.svg?raw";
import tablerArrowUp from "./assets/tabler-icons/arrow-up.svg?raw";
import tablerCheck from "./assets/tabler-icons/check.svg?raw";
import tablerCode from "./assets/tabler-icons/code.svg?raw";
import tablerFilePlus from "./assets/tabler-icons/file-plus.svg?raw";
import tablerFileText from "./assets/tabler-icons/file-text.svg?raw";
import tablerFlame from "./assets/tabler-icons/flame.svg?raw";
import tablerGitCommit from "./assets/tabler-icons/git-commit.svg?raw";
import tablerGitPullRequest from "./assets/tabler-icons/git-pull-request.svg?raw";
import tablerMicrophone from "./assets/tabler-icons/microphone.svg?raw";
import tablerSparkles from "./assets/tabler-icons/sparkles.svg?raw";
import tablerTable from "./assets/tabler-icons/table.svg?raw";

type Attachment = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

type Message = {
  id: string;
  role: "assistant" | "user";
  content: string;
  attachments?: Attachment[];
};

type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
};

type GitHubEventType = "issue" | "pull_request" | "commit";

type GitHubTimelineEvent = {
  id: string;
  type: GitHubEventType;
  title: string;
  createdAt: number;
  status?: string;
  url?: string;
};

type GitRepositoryInfo = {
  path: string;
  name: string;
  branch: string;
  isDirty: boolean;
  remoteRepo?: string;
  issuePrStatus: string;
  visibility?: "public" | "private";
  authProvider?: "public" | "github_oauth";
};

type ProjectWorkspace = {
  id: string;
  name: string;
  files?: Attachment[];
  githubConnected?: boolean;
  githubRepository?: GitRepositoryInfo;
  githubEvents?: GitHubTimelineEvent[];
  sessions: ChatSession[];
  createdAt: number;
};

type ProjectState = {
  projects: ProjectWorkspace[];
  selectedProjectId: string | null;
  selectedSessionId: string | null;
};

type DemoStatus = {
  ok: boolean;
  message: string;
  scope?: "github" | "overview";
};

type GithubLoginSessionState = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  status: "pending" | "connected";
  accessToken?: string;
  scope?: string;
  tokenType?: string;
};

type GithubDeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
};

type GithubAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GithubAvailableRepository = {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
};

type GithubRepositoriesResponse = {
  repositories: GithubAvailableRepository[];
};

type GithubPanelState = "signedout" | "authing" | "repos" | "connected";

type ActionMenuState =
  | { type: "project"; projectId: string; top: number; left: number }
  | { type: "session"; projectId: string; sessionId: string; top: number; left: number };

type RenameDraft =
  | { type: "project"; projectId: string; value: string }
  | { type: "session"; projectId: string; sessionId: string; value: string };

type GitHubRepoApiResponse = {
  default_branch: string;
  full_name: string;
  html_url: string;
  name: string;
  private: boolean;
};

type GitHubUserRepoApiResponse = GitHubRepoApiResponse & {
  updated_at?: string;
};

type GitHubCommitApiResponse = {
  html_url: string;
  sha: string;
  commit: {
    author?: {
      date?: string;
    };
    message: string;
  };
};

type GitHubIssueApiResponse = {
  html_url: string;
  number: number;
  pull_request?: unknown;
  state: string;
  title: string;
  updated_at: string;
};

type GitHubPullApiResponse = {
  html_url: string;
  number: number;
  state: string;
  title: string;
  updated_at: string;
};

const DEMO_REPLY_DELAY_MS = 360;
const ACTION_MENU_WIDTH = 132;
const ACTION_MENU_HEIGHT = 76;
const ACTION_MENU_GAP = 6;
const PROJECT_STORAGE_KEY = "paim.projects.v1";
const SIDEBAR_STORAGE_KEY = "paim.sidebarCollapsed.v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "paim.sidebarWidth.v1";
const PROJECT_COLLAPSED_STORAGE_KEY = "paim.projectCollapsed.v1";
const ZOOM_STORAGE_KEY = "paim.zoomScale.v1";
const DEFAULT_SIDEBAR_WIDTH = 272;
const COLLAPSED_SIDEBAR_WIDTH = 44;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_ZOOM_SCALE = 1;
const MIN_ZOOM_SCALE = 0.8;
const MAX_ZOOM_SCALE = 1.6;
const ZOOM_STEP = 0.1;
const PAIM_API_BASE_URL = (
  (import.meta.env.VITE_PAIM_API_BASE_URL as string | undefined) || "http://127.0.0.1:8000"
).replace(/\/$/, "");
const GITHUB_CLIENT_ID = (
  (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ||
  (import.meta.env.VITE_GITHUB_APP_CLIENT_ID as string | undefined) ||
  ""
).trim();
const GITHUB_CLIENT_ID_STORAGE_KEY = "paim.githubClientId.v1";
const GITHUB_LOGIN_CONFIG_ERROR_MESSAGE =
  "이 앱 빌드에는 GitHub 로그인이 아직 설정되어 있지 않습니다. 개발팀에 문의해 주세요.";
const GITHUB_LOGIN_SCOPE = "repo read:user";
const OVERVIEW_SUGGESTIONS = [
  "이번 주 액션 알려줘",
  "프로젝트 리스크 정리해줘",
  "최근 채팅 결정사항 요약",
];

type TablerIconProps = {
  className?: string;
  label?: string;
  svg: string;
};

// 로컬로 번들된 Tabler SVG가 부모 색상을 그대로 받도록 인라인으로 렌더한다.
function TablerIcon({ className = "", label, svg }: TablerIconProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`tabler-icon ${className}`.trim()}
      role={label ? "img" : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function isWindowsHost() {
  return window.navigator.userAgent.includes("Windows");
}

function WindowsTitlebar() {
  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    void getCurrentWindow().startDragging();
  }

  function handleToggleMaximize(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    void getCurrentWindow().toggleMaximize();
  }

  return (
    <div
      className="windows-titlebar"
      onDoubleClick={handleToggleMaximize}
      onPointerDown={handleDragStart}
    >
      <div className="windows-titlebar-title">PaiM</div>
      <div className="windows-titlebar-controls">
        <button
          aria-label="최소화"
          onClick={() => void getCurrentWindow().minimize()}
          title="최소화"
          type="button"
        >
          <Minus size={14} />
        </button>
        <button
          aria-label="최대화"
          onClick={() => void getCurrentWindow().toggleMaximize()}
          title="최대화"
          type="button"
        >
          <Square size={12} />
        </button>
        <button
          aria-label="닫기"
          className="windows-close-button"
          onClick={() => void getCurrentWindow().close()}
          title="닫기"
          type="button"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createWelcomeMessage(): Message {
  return {
    id: createId("assistant"),
    role: "assistant",
    content: "안녕하세요! 😊",
  };
}

function createProject(name: string, sessions: ChatSession[], files: Attachment[] = []): ProjectWorkspace {
  return {
    id: createId("project"),
    name,
    files,
    createdAt: Date.now(),
    sessions,
  };
}

function createEmptySession(): ChatSession {
  return {
    id: createId("session"),
    title: "New Chat",
    createdAt: Date.now(),
    messages: [createWelcomeMessage()],
  };
}

function createUniqueProjectName(projects: ProjectWorkspace[], baseName: string) {
  const projectNames = new Set(projects.map((project) => project.name));
  const safeBaseName = baseName.trim() || "New Project";

  if (!projectNames.has(safeBaseName)) {
    return safeBaseName;
  }

  for (let index = 2; ; index += 1) {
    const candidateName = `${safeBaseName} ${index}`;

    if (!projectNames.has(candidateName)) {
      return candidateName;
    }
  }
}

function createNextProjectName(projects: ProjectWorkspace[]) {
  return createUniqueProjectName(projects, "New Project");
}

// 액션 메뉴를 화면 기준으로 배치해 사이드바 스크롤 영역에 잘리지 않게 한다.
function getActionMenuPosition(button: HTMLButtonElement) {
  const rect = button.getBoundingClientRect();

  return {
    top: Math.max(
      8,
      Math.min(rect.bottom + ACTION_MENU_GAP, window.innerHeight - ACTION_MENU_HEIGHT - 8),
    ),
    left: Math.max(8, rect.right - ACTION_MENU_WIDTH),
  };
}

function createProjectState(
  projects: ProjectWorkspace[],
  selectedProjectId?: string | null,
  selectedSessionId?: string | null,
): ProjectState {
  const validProjects = projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.messages.length > 0),
    }));

  if (validProjects.length === 0) {
    return {
      projects: [],
      selectedProjectId: null,
      selectedSessionId: null,
    };
  }

  const selectedProject =
    validProjects.find((project) => project.id === selectedProjectId) ?? validProjects[0];
  const selectedSession =
    selectedSessionId === null
      ? null
      : selectedProject.sessions.find((session) => session.id === selectedSessionId) ?? null;

  return {
    projects: validProjects,
    selectedProjectId: selectedProject.id,
    selectedSessionId: selectedSession?.id ?? null,
  };
}

function loadProjectState() {
  const savedValue = window.localStorage.getItem(PROJECT_STORAGE_KEY);

  if (!savedValue) {
    return createProjectState([]);
  }

  try {
    const savedState = JSON.parse(savedValue) as Partial<ProjectState>;
    const projects = savedState.projects ?? [];

    return createProjectState(projects, savedState.selectedProjectId, savedState.selectedSessionId);
  } catch {
    return createProjectState([]);
  }
}

// 데스크톱 앱을 다시 열 때 마지막 사이드바 접힘 상태를 복원한다.
function loadSidebarCollapsed() {
  return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function loadSidebarWidth() {
  const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));

  if (!Number.isFinite(savedWidth)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  return clampSidebarWidth(savedWidth);
}

function loadCollapsedProjectIds() {
  try {
    const savedProjectIds = JSON.parse(
      window.localStorage.getItem(PROJECT_COLLAPSED_STORAGE_KEY) || "[]",
    );

    return Array.isArray(savedProjectIds)
      ? savedProjectIds.filter((projectId): projectId is string => typeof projectId === "string")
      : [];
  } catch {
    return [];
  }
}

function clampZoomScale(scale: number) {
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale));
}

function loadZoomScale() {
  const savedScale = Number(window.localStorage.getItem(ZOOM_STORAGE_KEY));

  if (!Number.isFinite(savedScale)) {
    return DEFAULT_ZOOM_SCALE;
  }

  return clampZoomScale(savedScale);
}

function getZoomShortcutDirection(event: globalThis.KeyboardEvent, isWindows: boolean) {
  if (isWindows ? !event.ctrlKey : !event.metaKey) {
    return null;
  }

  if (event.altKey) {
    return null;
  }

  if (event.key === "+" || event.key === "=") {
    return "in";
  }

  if (event.key === "-") {
    return "out";
  }

  if (event.key === "0") {
    return "reset";
  }

  return null;
}

function getFileName(path: string) {
  const normalizedPath = path.replace(/[\\/]+$/, "");
  return normalizedPath.split(/[\\/]/).pop() || normalizedPath || path;
}

function normalizeDialogPaths(selectedPaths: string | string[] | null) {
  if (!selectedPaths) {
    return [];
  }

  return (Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths]).filter(Boolean);
}

function createProjectNameFromPaths(paths: string[]) {
  if (paths.length === 0) {
    return "New Project";
  }

  const firstName = getFileName(paths[0]);

  if (paths.length === 1) {
    return firstName;
  }

  return `${firstName} 외 ${paths.length - 1}개`;
}

function canUseTauriDialog() {
  return "__TAURI_INTERNALS__" in window;
}

function parseGithubRepositoryUrl(rawUrl: string) {
  const trimmedUrl = rawUrl.trim().replace(/\.git$/, "");
  const sshMatch = trimmedUrl.match(/^git@github\.com:([^/]+)\/([^/]+)$/);

  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  try {
    const url = new URL(trimmedUrl.startsWith("http") ? trimmedUrl : `https://${trimmedUrl}`);

    if (url.hostname !== "github.com") {
      return null;
    }

    const [owner, repo] = url.pathname.split("/").filter(Boolean);

    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

async function fetchPaimJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PAIM_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof payload?.detail === "string" ? payload.detail : "PaiM API 요청 실패";

    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error) {
    return error;
  }

  return error instanceof Error && error.message ? error.message : fallback;
}

function getGithubOAuthErrorMessage(
  error: string | undefined,
  description: string | undefined,
  fallback: string,
) {
  if (error === "device_flow_disabled") {
    return "GitHub App 설정에서 Device Flow를 켜야 로그인할 수 있습니다.";
  }

  if (error === "incorrect_client_credentials") {
    return "GitHub 로그인 설정이 올바르지 않습니다. 개발팀에 문의해 주세요.";
  }

  return description || fallback;
}

function githubTimestamp(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function createGithubEvents(
  commits: GitHubCommitApiResponse[],
  issues: GitHubIssueApiResponse[],
  pulls: GitHubPullApiResponse[],
) {
  const commitEvents = commits.map((commit) => ({
    id: `commit-${commit.sha}`,
    type: "commit" as const,
    title: commit.commit.message.split("\n")[0] || commit.sha.slice(0, 7),
    createdAt: githubTimestamp(commit.commit.author?.date),
    status: commit.sha.slice(0, 7),
    url: commit.html_url,
  }));
  const issueEvents = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      id: `issue-${issue.number}`,
      type: "issue" as const,
      title: `issue #${issue.number} ${issue.title}`,
      createdAt: githubTimestamp(issue.updated_at),
      status: issue.state,
      url: issue.html_url,
    }));
  const pullEvents = pulls.map((pull) => ({
    id: `pull_request-${pull.number}`,
    type: "pull_request" as const,
    title: `PR #${pull.number} ${pull.title}`,
    createdAt: githubTimestamp(pull.updated_at),
    status: pull.state,
    url: pull.html_url,
  }));

  return [...commitEvents, ...issueEvents, ...pullEvents]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 10);
}

async function createGithubDeviceCode() {
  const clientId = getGithubClientId();

  if (!clientId) {
    throw new Error(GITHUB_LOGIN_CONFIG_ERROR_MESSAGE);
  }

  if (!canUseTauriDialog()) {
    return postGithubOAuthForm<GithubDeviceCodeResponse>(
      "https://github.com/login/device/code",
      {
        client_id: clientId,
        scope: GITHUB_LOGIN_SCOPE,
      },
    );
  }

  return invoke<GithubDeviceCodeResponse>("github_oauth_device_code", {
    clientId,
    scope: GITHUB_LOGIN_SCOPE,
  });
}

async function fetchGithubAccessToken(deviceCode: string) {
  const clientId = getGithubClientId();

  if (!clientId) {
    throw new Error(GITHUB_LOGIN_CONFIG_ERROR_MESSAGE);
  }

  if (!canUseTauriDialog()) {
    return postGithubOAuthForm<GithubAccessTokenResponse>(
      "https://github.com/login/oauth/access_token",
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    );
  }

  return invoke<GithubAccessTokenResponse>("github_oauth_access_token", {
    clientId,
    deviceCode,
  });
}

function getGithubClientId() {
  return GITHUB_CLIENT_ID || localStorage.getItem(GITHUB_CLIENT_ID_STORAGE_KEY)?.trim() || "";
}

async function postGithubOAuthForm<T>(url: string, params: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    throw new Error(`GitHub OAuth ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function getGithubHeaders(accessToken?: string | null) {
  return {
    Accept: "application/vnd.github+json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function fetchGithubJson<T>(path: string, accessToken?: string | null): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: getGithubHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchGithubRepositories(accessToken: string) {
  const repositories = await fetchGithubJson<GitHubUserRepoApiResponse[]>(
    "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100",
    accessToken,
  );

  return {
    repositories: repositories.map((repository) => ({
      fullName: repository.full_name,
      name: repository.name,
      private: repository.private,
      defaultBranch: repository.default_branch,
      url: repository.html_url,
    })),
  };
}

async function fetchGithubRepository(rawUrl: string, accessToken?: string | null) {
  const parsedRepo = parseGithubRepositoryUrl(rawUrl);

  if (!parsedRepo) {
    throw new Error("GitHub repository URL을 확인할 수 없습니다");
  }

  const repoPath = `/repos/${parsedRepo.owner}/${parsedRepo.repo}`;
  const repo = await fetchGithubJson<GitHubRepoApiResponse>(repoPath, accessToken);
  const [commits, issues, pulls] = await Promise.all([
    fetchGithubJson<GitHubCommitApiResponse[]>(
      `${repoPath}/commits?sha=${encodeURIComponent(repo.default_branch)}&per_page=6`,
      accessToken,
    ),
    fetchGithubJson<GitHubIssueApiResponse[]>(
      `${repoPath}/issues?state=open&per_page=6`,
      accessToken,
    ),
    fetchGithubJson<GitHubPullApiResponse[]>(
      `${repoPath}/pulls?state=open&per_page=6`,
      accessToken,
    ),
  ]);
  const openIssues = issues.filter((issue) => !issue.pull_request);

  return {
    events: createGithubEvents(commits, issues, pulls),
    repository: {
      path: repo.html_url,
      name: repo.name,
      branch: repo.default_branch,
      isDirty: false,
      remoteRepo: repo.full_name,
      issuePrStatus: `${openIssues.length} open issues · ${pulls.length} open PRs`,
      visibility: repo.private ? "private" as const : "public" as const,
      authProvider: accessToken ? "github_oauth" as const : "public" as const,
    },
  };
}

function formatRelativeAge(createdAt: number) {
  const diffMs = Math.max(0, Date.now() - createdAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  if (diffMs < minuteMs) {
    return "방금";
  }

  if (diffMs < hourMs) {
    return `${Math.floor(diffMs / minuteMs)}분`;
  }

  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}시간`;
  }

  if (diffMs < weekMs) {
    return `${Math.floor(diffMs / dayMs)}일`;
  }

  return `${Math.floor(diffMs / weekMs)}주`;
}

function getProjectMessageCount(project: ProjectWorkspace) {
  return project.sessions.reduce((sum, session) => sum + session.messages.length, 0);
}

function getProjectLastActivity(project: ProjectWorkspace) {
  const latestSession = project.sessions.reduce<ChatSession | null>((latest, session) => {
    if (!latest || session.createdAt > latest.createdAt) {
      return session;
    }

    return latest;
  }, null);

  return latestSession ? formatRelativeAge(latestSession.createdAt) : "아직 없음";
}

// 프로젝트 생성 시각과 채팅 생성 시각 중 가장 최근 값을 Overview 날짜로 사용한다.
function getProjectLastUpdatedAt(project: ProjectWorkspace) {
  return project.sessions.reduce(
    (latest, session) => Math.max(latest, session.createdAt),
    project.createdAt,
  );
}

// mockup의 영문 날짜 표기를 유지한다.
function formatOverviewDate(timestamp: number) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" })
    .format(timestamp)
    .toUpperCase();
}

// Overview 파일 목록은 프로젝트에 직접 등록된 파일만 보여준다.
function getProjectAttachments(project: ProjectWorkspace) {
  return project.files ?? [];
}

// GitHub 이벤트는 최신순으로만 정렬해서 Overview에 보여준다.
function getProjectGithubEvents(project: ProjectWorkspace) {
  return [...(project.githubEvents ?? [])].sort((left, right) => right.createdAt - left.createdAt);
}

function getGithubEventIconSvg(eventType: GitHubEventType) {
  if (eventType === "pull_request") {
    return tablerGitPullRequest;
  }

  if (eventType === "commit") {
    return tablerGitCommit;
  }

  return tablerAlertCircle;
}

function getGithubEventMeta(event: GitHubTimelineEvent) {
  const eventLabel =
    event.type === "pull_request" ? "PR" : event.type === "issue" ? "ISSUE" : "COMMIT";
  const status = event.status ? `${event.status} · ` : "";

  return `${eventLabel} · ${status}${formatRelativeAge(event.createdAt)}`;
}

// GitHub 패널은 참조 HTML의 4단계 흐름을 실제 세션 상태에 맞춰 표시한다.
function getGithubPanelStateLabel(panelState: GithubPanelState) {
  const labels: Record<GithubPanelState, string> = {
    signedout: "미연결",
    authing: "로그인 중",
    repos: "로그인됨",
    connected: "연결됨",
  };

  return labels[panelState];
}

// Repo 선택 목록의 공개 범위 badge는 GitHub API 값을 그대로 짧게 보여준다.
function getGithubAvailableRepositoryVisibility(repository: GithubAvailableRepository) {
  return repository.private ? "PRIVATE" : "PUBLIC";
}

function getGithubLoginErrorMessage(error: unknown) {
  const message = getErrorMessage(error, "GitHub 로그인을 시작할 수 없습니다");

  return /failed to fetch|load failed/i.test(message)
    ? "GitHub 로그인 서버에 연결할 수 없습니다. 네트워크를 확인해 주세요."
    : message;
}

function getGithubRepoLabel(repository: GitRepositoryInfo) {
  const visibility = repository.visibility === "private" ? "Private" : "Public";
  const provider = repository.authProvider === "github_oauth" ? "GitHub Login" : "Public API";

  return `${visibility} · ${provider}`;
}

// 프로젝트 Overview의 PM 카드에는 아직 연결된 분석 결과 대신 현재 앱 상태를 담는다.
function createOverviewMemoryCards(project: ProjectWorkspace, attachmentCount: number) {
  return [
    {
      icon: tablerCheck,
      label: "Decision",
      tone: "decision",
      items: [
        project.sessions.length > 0
          ? `${project.sessions.length}개 채팅에서 결정사항 추출 대기`
          : "아직 기록된 결정사항이 없습니다",
        "DB/LLM 연결 후 프로젝트 메모로 확정",
      ],
    },
    {
      icon: tablerArrowRight,
      label: "Action",
      tone: "action",
      items: [
        attachmentCount > 0
          ? `${attachmentCount}개 첨부 자료 확인 가능`
          : "프로젝트 자료 추가 대기",
        "새 채팅에서 다음 액션 정리",
      ],
    },
    {
      icon: tablerAlertTriangle,
      label: "Issue",
      tone: "issue",
      items: [
        project.sessions.length > 0 ? "채팅 기반 이슈 정리 대기" : "아직 등록된 이슈가 없습니다",
        "충돌 자료 판별은 백엔드 연결 후 처리",
      ],
    },
    {
      icon: tablerFlame,
      label: "Risk",
      tone: "risk",
      items: [
        "프로젝트 상태 판단은 현재 프론트 데모 범위",
        "연결 전까지 채팅/첨부 이력만 보존",
      ],
    },
  ];
}

// 파일 확장자만 보고 Overview 파일 목록에 맞는 Tabler 아이콘을 고른다.
function getAttachmentIconSvg(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (["m4a", "mp3", "wav"].includes(extension)) {
    return tablerMicrophone;
  }

  if (["csv", "xls", "xlsx"].includes(extension)) {
    return tablerTable;
  }

  if (["js", "json", "md", "py", "ts", "tsx"].includes(extension)) {
    return tablerCode;
  }

  return tablerFileText;
}

// 파일 크기는 아직 저장하지 않으므로 확장자 기반 메타만 표시한다.
function getAttachmentMeta(fileName: string) {
  const extension = fileName.split(".").pop()?.toUpperCase();

  return extension ? `${extension} · 첨부 파일` : "첨부 파일";
}

// localStorage에는 큰 data URL을 저장하지 않도록 첨부 미리보기를 제외한다.
function createStoredAttachments(attachments: Attachment[] = []) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
  }));
}

function createStoredSessions(sessions: ChatSession[]) {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      attachments: message.attachments ? createStoredAttachments(message.attachments) : undefined,
    })),
  }));
}

// 프로젝트 저장 시에도 큰 data URL 미리보기는 제외하고 파일 경로만 남긴다.
function createStoredProjectState(
  projects: ProjectWorkspace[],
  selectedProjectId: string | null,
  selectedSessionId: string | null,
): ProjectState {
  return {
    projects: projects.map((project) => ({
      ...project,
      files: createStoredAttachments(project.files),
      sessions: createStoredSessions(project.sessions),
    })),
    selectedProjectId,
    selectedSessionId,
  };
}

type AttachmentListProps = {
  attachments: Attachment[];
  label: string;
  onRemove?: (attachmentId: string) => void;
};

// 이미지 파일은 썸네일로, 나머지 파일은 파일칩으로 표시한다.
function AttachmentList({ attachments, label, onRemove }: AttachmentListProps) {
  return (
    <div className="attachment-list" aria-label={label}>
      {attachments.map((attachment) => {
        const isImage = Boolean(attachment.previewUrl);

        if (isImage) {
          return (
            <div className="attachment-preview" key={attachment.id}>
              <img src={attachment.previewUrl} alt={`${attachment.name} 미리보기`} />
              <span>{attachment.name}</span>
              {onRemove ? (
                <button
                  aria-label={`${attachment.name} 제거`}
                  className="remove-attachment-button"
                  onClick={() => onRemove(attachment.id)}
                  title={`${attachment.name} 제거`}
                  type="button"
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          );
        }

        if (onRemove) {
          return (
            <span className="attachment-chip removable" key={attachment.id}>
              <span className="attachment-name">{attachment.name}</span>
              <button
                aria-label={`${attachment.name} 제거`}
                className="remove-attachment-button"
                onClick={() => onRemove(attachment.id)}
                title={`${attachment.name} 제거`}
                type="button"
              >
                <X size={13} />
              </button>
            </span>
          );
        }

        return (
          <span className="attachment-chip" key={attachment.id}>
            <span className="attachment-name">{attachment.name}</span>
          </span>
        );
      })}
    </div>
  );
}

// 프론트 데모에서 런타임 없이도 자연스러운 응답 흐름을 만든다.
function createDemoAssistantReply(message: Message) {
  const fileNames = message.attachments?.map((attachment) => attachment.name) ?? [];
  const fileSummary =
    fileNames.length > 0 ? `\n\n첨부된 파일: ${fileNames.join(", ")}` : "";

  return [
    "좋아요. 이 내용을 프로젝트 메모로 정리할 수 있습니다.",
    "",
    `요청: ${message.content}`,
    "",
    "다음 단계는 핵심 요청, 담당자, 마감일, 리스크를 분리해서 확인하는 것입니다.",
  ].join("\n") + fileSummary;
}

// 데모 응답이 바로 튀어나오지 않도록 짧은 생각 시간을 둔다.
function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// 레퍼런스 앱의 단순한 채팅 경험을 유지하면서 세션 상태를 관리한다.
export function App() {
  const isWindows = useMemo(isWindowsHost, []);
  const [initialProjectState] = useState(loadProjectState);
  const [projects, setProjects] = useState<ProjectWorkspace[]>(initialProjectState.projects);
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialProjectState.selectedProjectId,
  );
  const [selectedSessionId, setSelectedSessionId] = useState(
    initialProjectState.selectedSessionId,
  );
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [demoStatus, setDemoStatus] = useState<DemoStatus | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  const [isProjectCreateMenuOpen, setIsProjectCreateMenuOpen] = useState(false);
  const [openActionMenu, setOpenActionMenu] = useState<ActionMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState(loadCollapsedProjectIds);
  const [githubLoginSessions, setGithubLoginSessions] = useState<Record<string, GithubLoginSessionState>>({});
  const [githubRepositories, setGithubRepositories] = useState<Record<string, GithubAvailableRepository[]>>({});
  const [githubRepositoryQuery, setGithubRepositoryQuery] = useState("");
  const [isGithubAuthStarting, setIsGithubAuthStarting] = useState(false);
  const [isGithubAuthChecking, setIsGithubAuthChecking] = useState(false);
  const [isGithubRepoLoading, setIsGithubRepoLoading] = useState(false);
  const [isGithubConnecting, setIsGithubConnecting] = useState(false);
  const [isGithubSyncing, setIsGithubSyncing] = useState(false);
  const sidebarResizeRef = useRef({ startX: 0, startWidth: DEFAULT_SIDEBAR_WIDTH });
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const projectCreateRef = useRef<HTMLDivElement | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const didHydrateAttachmentPreviewsRef = useRef(false);
  const zoomScaleRef = useRef(loadZoomScale());

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const sessions = selectedProject?.sessions ?? [];
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const selectedProjectAttachments = useMemo(
    () => (selectedProject ? getProjectAttachments(selectedProject) : []),
    [selectedProject],
  );
  const selectedProjectGithubEvents = useMemo(
    () => (selectedProject ? getProjectGithubEvents(selectedProject) : []),
    [selectedProject],
  );
  const selectedProjectGithubSession = selectedProject
    ? githubLoginSessions[selectedProject.id] ?? null
    : null;
  const selectedProjectGithubRepositories = selectedProject
    ? githubRepositories[selectedProject.id] ?? []
    : [];
  const selectedProjectGithubPanelState: GithubPanelState = selectedProject?.githubRepository
    ? "connected"
    : selectedProjectGithubSession?.status === "connected"
      ? "repos"
      : selectedProjectGithubSession?.status === "pending"
        ? "authing"
        : "signedout";
  const filteredSelectedProjectGithubRepositories = useMemo(() => {
    const query = githubRepositoryQuery.trim().toLowerCase();

    if (!query) {
      return selectedProjectGithubRepositories;
    }

    return selectedProjectGithubRepositories.filter((repository) =>
      `${repository.fullName} ${repository.name}`.toLowerCase().includes(query),
    );
  }, [githubRepositoryQuery, selectedProjectGithubRepositories]);
  const overviewMemoryCards = useMemo(
    () =>
      selectedProject
        ? createOverviewMemoryCards(selectedProject, selectedProjectAttachments.length)
        : [],
    [selectedProject, selectedProjectAttachments.length],
  );
  const actionMenuProject = openActionMenu
    ? projects.find((project) => project.id === openActionMenu.projectId) ?? null
    : null;
  const actionMenuSession =
    openActionMenu?.type === "session"
      ? actionMenuProject?.sessions.find((session) => session.id === openActionMenu.sessionId) ??
        null
      : null;
  const collapsedProjectIdSet = useMemo(
    () => new Set(collapsedProjectIds),
    [collapsedProjectIds],
  );
  const appShellStyle = {
    "--sidebar-width": `${
      isSidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth
    }px`,
  } as CSSProperties;

  useEffect(() => {
    window.localStorage.setItem(
      PROJECT_STORAGE_KEY,
      JSON.stringify(createStoredProjectState(projects, selectedProjectId, selectedSessionId)),
    );
  }, [projects, selectedProjectId, selectedSessionId]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(
      PROJECT_COLLAPSED_STORAGE_KEY,
      JSON.stringify(collapsedProjectIds),
    );
  }, [collapsedProjectIds]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    const webview = getCurrentWebview();

    function setZoomScale(scale: number) {
      const nextScale = Math.round(clampZoomScale(scale) * 100) / 100;
      zoomScaleRef.current = nextScale;
      window.localStorage.setItem(ZOOM_STORAGE_KEY, String(nextScale));
      void webview.setZoom(nextScale).catch(() => undefined);
    }

    setZoomScale(zoomScaleRef.current);

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      const direction = getZoomShortcutDirection(event, isWindows);

      if (!direction) {
        return;
      }

      event.preventDefault();

      if (direction === "reset") {
        setZoomScale(DEFAULT_ZOOM_SCALE);
        return;
      }

      setZoomScale(
        zoomScaleRef.current + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP),
      );
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isWindows]);

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    function handleMouseMove(event: globalThis.MouseEvent) {
      const deltaX = event.clientX - sidebarResizeRef.current.startX;
      setSidebarWidth(clampSidebarWidth(sidebarResizeRef.current.startWidth + deltaX));
    }

    function handleMouseUp() {
      setIsSidebarResizing(false);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    if (demoStatus) {
      setStatusRevision((currentRevision) => currentRevision + 1);
    }
  }, [demoStatus]);

  useEffect(() => {
    if (didHydrateAttachmentPreviewsRef.current) {
      return;
    }

    didHydrateAttachmentPreviewsRef.current = true;
    void hydrateStoredAttachmentPreviews();
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let isDisposed = false;
    let unlistenDragDrop: (() => void) | undefined;

    // 네이티브 파일 드롭 이벤트를 기존 첨부 생성 흐름으로 연결한다.
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragActive(true);
          return;
        }

        if (event.payload.type === "leave") {
          setIsDragActive(false);
          return;
        }

        setIsDragActive(false);
        void appendAttachmentPaths(event.payload.paths);
      })
      .then((unlisten) => {
        if (isDisposed) {
          unlisten();
          return;
        }

        unlistenDragDrop = unlisten;
      })
      .catch(() => undefined);

    return () => {
      isDisposed = true;
      unlistenDragDrop?.();
    };
  }, []);

  useEffect(() => {
    const scrollContainer = chatScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [isSending, selectedSession?.messages.length, selectedSessionId]);

  useEffect(() => {
    focusPrompt();
  }, [selectedSessionId]);

  useEffect(() => {
    if (!isProjectCreateMenuOpen) {
      return;
    }

    // 프로젝트 생성 메뉴도 바깥 클릭과 Escape 키로 닫는다.
    function handlePointerDown(event: PointerEvent) {
      const projectCreate = projectCreateRef.current;

      if (!projectCreate || projectCreate.contains(event.target as Node)) {
        return;
      }

      setIsProjectCreateMenuOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setIsProjectCreateMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProjectCreateMenuOpen]);

  function updateProject(projectId: string, updater: (project: ProjectWorkspace) => ProjectWorkspace) {
    setProjects((currentProjects) =>
      currentProjects.map((project) => (project.id === projectId ? updater(project) : project)),
    );
  }

  function updateSessionInProject(
    projectId: string,
    sessionId: string,
    updater: (session: ChatSession) => ChatSession,
  ) {
    updateProject(projectId, (project) => ({
      ...project,
      sessions: project.sessions.map((session) =>
        session.id === sessionId ? updater(session) : session,
      ),
    }));
  }

  function handleSelectProject(projectId: string) {
    const nextProject = projects.find((project) => project.id === projectId);

    if (!nextProject) {
      return;
    }

    setSelectedProjectId(nextProject.id);
    setSelectedSessionId(null);
    clearDraft();
  }

  // 선택된 폴더나 파일 이름으로 프로젝트를 만들고, 선택 파일은 Overview 파일에 저장한다.
  function createProjectFromName(baseName: string, files: Attachment[] = []) {
    const nextProject = createProject(createUniqueProjectName(projects, baseName), [], files);

    setProjects((currentProjects) => [nextProject, ...currentProjects]);
    setSelectedProjectId(nextProject.id);
    setSelectedSessionId(null);
    setIsProjectCreateMenuOpen(false);
    clearDraft();
  }

  // New Project 버튼은 폴더/파일 선택 메뉴를 여닫는다.
  function handleToggleProjectCreateMenu() {
    setIsProjectCreateMenuOpen((current) => !current);
  }

  function handleToggleSidebar() {
    setIsSidebarCollapsed((current) => !current);
    setIsSidebarResizing(false);
  }

  function handleSidebarResizeStart(event: MouseEvent<HTMLDivElement>) {
    if (isSidebarCollapsed) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    setIsSidebarResizing(true);
  }

  function toggleProjectSessions(projectId: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setCollapsedProjectIds((currentProjectIds) =>
      currentProjectIds.includes(projectId)
        ? currentProjectIds.filter((currentProjectId) => currentProjectId !== projectId)
        : [...currentProjectIds, projectId],
    );
  }

  // 데스크톱에서는 폴더명을 쓰고, 브라우저 smoke test에서는 fallback 이름으로 검증한다.
  async function handleCreateProjectFromFolder() {
    if (!canUseTauriDialog()) {
      createProjectFromName(createNextProjectName(projects));
      return;
    }

    try {
      const selectedPaths = await open({
        directory: true,
        multiple: false,
        title: "프로젝트 폴더 선택",
      });
      const paths = normalizeDialogPaths(selectedPaths);

      if (paths.length === 0) {
        return;
      }

      const projectFiles = await Promise.all(paths.map(createAttachment));

      createProjectFromName(createProjectNameFromPaths(paths), projectFiles);
    } catch {
      setDemoStatus({
        ok: false,
        message: "프로젝트 폴더를 열 수 없습니다",
        scope: "overview",
      });
    }
  }

  // 데스크톱에서는 선택한 파일 묶음 이름으로 새 프로젝트 카테고리를 만든다.
  async function handleCreateProjectFromFiles() {
    if (!canUseTauriDialog()) {
      createProjectFromName(createNextProjectName(projects));
      return;
    }

    try {
      const selectedPaths = await open({
        directory: false,
        multiple: true,
        title: "프로젝트 파일 선택",
      });
      const paths = normalizeDialogPaths(selectedPaths);

      if (paths.length === 0) {
        return;
      }

      createProjectFromName(createProjectNameFromPaths(paths));
    } catch {
      setDemoStatus({
        ok: false,
        message: "프로젝트 파일을 열 수 없습니다",
        scope: "overview",
      });
    }
  }

  // 지정한 프로젝트 안에 새 채팅을 항상 추가하고 그 채팅을 선택한다.
  function handleCreateChatInProject(projectId: string) {
    const targetProject = projects.find((project) => project.id === projectId);

    if (!targetProject) {
      return;
    }

    const nextSession = createEmptySession();

    updateProject(projectId, (project) => ({
      ...project,
      sessions: [nextSession, ...project.sessions],
    }));
    setSelectedProjectId(projectId);
    setSelectedSessionId(nextSession.id);
    setCollapsedProjectIds((currentProjectIds) =>
      currentProjectIds.filter((currentProjectId) => currentProjectId !== projectId),
    );
    clearDraft();
    focusPrompt();
  }

  // Overview에서 질문을 보내면 새 채팅을 만들고 같은 데모 응답 흐름을 사용한다.
  async function handleStartOverviewChat(projectId: string, rawPrompt: string) {
    const trimmedPrompt = rawPrompt.trim();
    const targetProject = projects.find((project) => project.id === projectId);

    if (!targetProject || !trimmedPrompt || isSending) {
      return;
    }

    const nextSession = createEmptySession();
    const userMessage: Message = {
      id: createId("user"),
      role: "user",
      content: trimmedPrompt,
    };

    updateProject(projectId, (project) => ({
      ...project,
      sessions: [
        {
          ...nextSession,
          title: trimmedPrompt.slice(0, 32),
          messages: [...nextSession.messages, userMessage],
        },
        ...project.sessions,
      ],
    }));
    setSelectedProjectId(projectId);
    setSelectedSessionId(nextSession.id);
    setCollapsedProjectIds((currentProjectIds) =>
      currentProjectIds.filter((currentProjectId) => currentProjectId !== projectId),
    );
    clearDraft();
    setIsSending(true);

    await wait(DEMO_REPLY_DELAY_MS);

    updateSessionInProject(projectId, nextSession.id, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id: createId("assistant"),
          role: "assistant",
          content: createDemoAssistantReply(userMessage),
        },
      ],
    }));
    setIsSending(false);
    focusPrompt();
  }

  // Overview의 파일 추가는 채팅을 만들지 않고 프로젝트 파일 목록만 갱신한다.
  async function handleAddFilesToProject(projectId: string) {
    const targetProject = projects.find((project) => project.id === projectId);

    if (!targetProject) {
      return;
    }

    if (!canUseTauriDialog()) {
      setDemoStatus({
        ok: false,
        message: "데스크톱 앱에서 파일을 추가할 수 있습니다",
        scope: "overview",
      });
      return;
    }

    try {
      const selectedPaths = await open({
        directory: false,
        multiple: true,
        title: "프로젝트 파일 추가",
      });
      const paths = normalizeDialogPaths(selectedPaths);

      if (paths.length === 0) {
        return;
      }

      const nextAttachments = await Promise.all(paths.map(createAttachment));

      updateProject(projectId, (project) => ({
        ...project,
        files: [...(project.files ?? []), ...nextAttachments],
      }));
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
    } catch {
      setDemoStatus({
        ok: false,
        message: "프로젝트 파일을 추가할 수 없습니다",
        scope: "overview",
      });
    }
  }

  // Overview 파일 행에서 선택한 파일만 프로젝트 파일 목록에서 제거한다.
  function handleDeleteProjectFile(projectId: string, attachmentId: string) {
    updateProject(projectId, (project) => ({
      ...project,
      files: (project.files ?? []).filter((file) => file.id !== attachmentId),
    }));
  }

  async function handleStartGithubLogin(projectId: string) {
    if (isGithubAuthStarting) {
      return;
    }

    setSelectedProjectId(projectId);
    setSelectedSessionId(null);
    setGithubRepositoryQuery("");
    setIsGithubAuthStarting(true);
    setDemoStatus({
      ok: true,
      message: "GitHub 로그인 준비 중...",
      scope: "github",
    });

    try {
      const deviceCode = await createGithubDeviceCode();

      if (
        deviceCode.error ||
        !deviceCode.device_code ||
        !deviceCode.user_code ||
        !deviceCode.verification_uri
      ) {
        throw new Error(
          getGithubOAuthErrorMessage(
            deviceCode.error,
            deviceCode.error_description,
            "GitHub 로그인을 시작할 수 없습니다",
          ),
        );
      }

      const session: GithubLoginSessionState = {
        deviceCode: deviceCode.device_code,
        userCode: deviceCode.user_code,
        verificationUri: deviceCode.verification_uri,
        interval: deviceCode.interval ?? 5,
        status: "pending",
      };

      setGithubLoginSessions((currentSessions) => ({
        ...currentSessions,
        [projectId]: session,
      }));
      window.open(session.verificationUri, "_blank", "noopener,noreferrer");
      setDemoStatus({
        ok: true,
        message: `GitHub 인증 화면을 열었습니다. 코드: ${session.userCode}`,
        scope: "github",
      });
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getGithubLoginErrorMessage(error),
        scope: "github",
      });
    } finally {
      setIsGithubAuthStarting(false);
    }
  }

  async function handleCheckGithubLogin(projectId: string) {
    const session = githubLoginSessions[projectId];

    if (!session || isGithubAuthChecking) {
      return;
    }

    setIsGithubAuthChecking(true);

    try {
      const tokenResponse = await fetchGithubAccessToken(session.deviceCode);

      if (!tokenResponse.access_token) {
        const isPending = tokenResponse.error === "authorization_pending";

        setDemoStatus({
          ok: false,
          message: isPending
            ? "아직 GitHub 인증이 완료되지 않았습니다"
            : getGithubOAuthErrorMessage(
                tokenResponse.error,
                tokenResponse.error_description,
                "GitHub 인증을 완료할 수 없습니다",
              ),
          scope: "github",
        });
        return;
      }

      const nextSession: GithubLoginSessionState = {
        ...session,
        accessToken: tokenResponse.access_token,
        scope: tokenResponse.scope,
        tokenType: tokenResponse.token_type,
        status: "connected",
      };
      const repositories = await fetchGithubRepositories(tokenResponse.access_token);

      setGithubLoginSessions((currentSessions) => ({
        ...currentSessions,
        [projectId]: nextSession,
      }));
      setGithubRepositories((currentRepositories) => ({
        ...currentRepositories,
        [projectId]: repositories.repositories,
      }));
      setDemoStatus({
        ok: true,
        message: `${repositories.repositories.length}개 repo를 불러왔습니다`,
        scope: "github",
      });
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "GitHub 로그인 상태를 확인할 수 없습니다"),
        scope: "github",
      });
    } finally {
      setIsGithubAuthChecking(false);
    }
  }

  function handleResetGithubLogin(projectId: string) {
    setGithubLoginSessions((currentSessions) => {
      const nextSessions = { ...currentSessions };
      delete nextSessions[projectId];
      return nextSessions;
    });
    setGithubRepositories((currentRepositories) => {
      const nextRepositories = { ...currentRepositories };
      delete nextRepositories[projectId];
      return nextRepositories;
    });
    setGithubRepositoryQuery("");
    setDemoStatus({
      ok: true,
      message: "GitHub 로그인을 해제했습니다",
      scope: "github",
    });
  }

  async function handleLoadGithubRepositories(projectId: string) {
    const session = githubLoginSessions[projectId];

    if (!session?.accessToken || isGithubRepoLoading) {
      return;
    }

    setIsGithubRepoLoading(true);

    try {
      const response = await fetchGithubRepositories(session.accessToken);

      setGithubRepositories((currentRepositories) => ({
        ...currentRepositories,
        [projectId]: response.repositories,
      }));
      setDemoStatus({
        ok: true,
        message: `${response.repositories.length}개 repo를 불러왔습니다`,
        scope: "github",
      });
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "GitHub repo 목록을 불러올 수 없습니다"),
        scope: "github",
      });
    } finally {
      setIsGithubRepoLoading(false);
    }
  }

  async function connectGithubRepository(projectId: string, repositoryUrl: string) {
    const trimmedRepositoryUrl = repositoryUrl.trim();
    const accessToken = githubLoginSessions[projectId]?.accessToken ?? null;

    if (!trimmedRepositoryUrl || isGithubConnecting) {
      return;
    }

    setSelectedProjectId(projectId);
    setSelectedSessionId(null);
    setIsGithubConnecting(true);
    setDemoStatus({
      ok: true,
      message: "GitHub repo 연결 중...",
      scope: "github",
    });

    try {
      const { events, repository } = await fetchGithubRepository(
        trimmedRepositoryUrl,
        accessToken,
      );

      updateProject(projectId, (project) => ({
        ...project,
        githubConnected: true,
        githubEvents: events,
        githubRepository: repository,
      }));
      setDemoStatus({
        ok: true,
        message: `${repository.remoteRepo ?? repository.name} repo 연결됨`,
        scope: "github",
      });
      setGithubRepositoryQuery("");
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "GitHub repo를 연결할 수 없습니다"),
        scope: "github",
      });
    } finally {
      setIsGithubConnecting(false);
    }
  }

  async function handleSyncGithubRepository(projectId: string) {
    const project = projects.find((currentProject) => currentProject.id === projectId);

    if (!project?.githubRepository || isGithubSyncing) {
      return;
    }

    setIsGithubSyncing(true);
    setDemoStatus({
      ok: true,
      message: "GitHub repo 서버 동기화 중...",
      scope: "github",
    });

    try {
      await fetchPaimJson("/github/sync", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          projectName: project.name,
          repository: project.githubRepository,
          events: project.githubEvents ?? [],
        }),
      });
      setDemoStatus({
        ok: true,
        message: "GitHub repo 서버 동기화 완료",
        scope: "github",
      });
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "GitHub sync API에 연결할 수 없습니다"),
        scope: "github",
      });
    } finally {
      setIsGithubSyncing(false);
    }
  }

  function handleDisconnectGithub(projectId: string, message = "GitHub 연동이 취소되었습니다") {
    updateProject(projectId, (project) => ({
      ...project,
      githubConnected: false,
      githubEvents: undefined,
      githubRepository: undefined,
    }));
    setDemoStatus({
      ok: true,
      message,
      scope: "github",
    });
  }

  function handleOverviewPromptSubmit(event: FormEvent<HTMLFormElement>, projectId: string) {
    event.preventDefault();
    void handleStartOverviewChat(projectId, prompt);
  }

  function toggleProjectActionMenu(projectId: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const position = getActionMenuPosition(event.currentTarget);

    setOpenActionMenu((current) =>
      current?.type === "project" && current.projectId === projectId
        ? null
        : { type: "project", projectId, ...position },
    );
  }

  function toggleSessionActionMenu(
    projectId: string,
    sessionId: string,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    event.stopPropagation();
    const position = getActionMenuPosition(event.currentTarget);

    setOpenActionMenu((current) =>
      current?.type === "session" &&
      current.projectId === projectId &&
      current.sessionId === sessionId
        ? null
        : { type: "session", projectId, sessionId, ...position },
    );
  }

  // 행 안에서 바로 수정하도록 프로젝트명 입력을 연다.
  function beginRenameProject(projectId: string) {
    const targetProject = projects.find((project) => project.id === projectId);

    if (!targetProject) {
      return;
    }

    setRenameDraft({ type: "project", projectId, value: targetProject.name });
    setOpenActionMenu(null);
  }

  // 행 안에서 바로 수정하도록 채팅명 입력을 연다.
  function beginRenameSession(projectId: string, sessionId: string) {
    const targetSession = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((session) => session.id === sessionId);

    if (!targetSession) {
      return;
    }

    setRenameDraft({ type: "session", projectId, sessionId, value: targetSession.title });
    setOpenActionMenu(null);
  }

  // 빈 값은 저장하지 않고 편집만 닫는다.
  function commitRenameDraft(rawValue: string) {
    if (!renameDraft) {
      return;
    }

    const nextValue = rawValue.trim();

    if (!nextValue) {
      setRenameDraft(null);
      return;
    }

    if (renameDraft.type === "project") {
      updateProject(renameDraft.projectId, (project) => ({
        ...project,
        name: nextValue,
      }));
    } else {
      updateSessionInProject(renameDraft.projectId, renameDraft.sessionId, (session) => ({
        ...session,
        title: nextValue,
      }));
    }

    setRenameDraft(null);
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRenameDraft(event.currentTarget.value);
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setRenameDraft(null);
    }
  }

  // 히스토리에서 채팅 세션을 제거하고 마지막 세션이면 chat 없는 프로젝트로 둔다.
  function handleDeleteSession(
    projectId: string,
    sessionId: string,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    const targetProject = projects.find((project) => project.id === projectId);

    event.stopPropagation();

    if (!targetProject) {
      return;
    }

    const remainingSessions = targetProject.sessions.filter((session) => session.id !== sessionId);
    const shouldMoveSelection =
      selectedProjectId === projectId &&
      (sessionId === selectedSessionId ||
        !remainingSessions.some((session) => session.id === selectedSessionId));

    updateProject(projectId, (project) => ({
      ...project,
      sessions: remainingSessions,
    }));

    if (shouldMoveSelection) {
      setSelectedSessionId(remainingSessions[0]?.id ?? null);
      setIsSending(false);
      clearDraft();
    }

    setOpenActionMenu(null);

    if (remainingSessions.length > 0) {
      focusPrompt();
    }
  }

  // 프로젝트 삭제 후에는 남은 프로젝트로 선택을 옮기고, 마지막이면 빈 상태로 둔다.
  function handleDeleteProject(projectId: string, event: MouseEvent<HTMLButtonElement>) {
    const remainingProjects = projects.filter((project) => project.id !== projectId);

    event.stopPropagation();

    if (remainingProjects.length === projects.length) {
      return;
    }

    if (remainingProjects.length === 0) {
      setProjects([]);
      setSelectedProjectId(null);
      setSelectedSessionId(null);
      setIsSending(false);
      setOpenActionMenu(null);
      clearDraft();
      return;
    }

    setProjects(remainingProjects);

    if (projectId === selectedProjectId) {
      setSelectedProjectId(remainingProjects[0].id);
      setSelectedSessionId(null);
      clearDraft();
    }

    setOpenActionMenu(null);
  }

  // 렌더링이 끝난 뒤 채팅 입력창으로 포커스를 복원한다.
  function focusPrompt() {
    window.requestAnimationFrame(() => {
      promptTextareaRef.current?.focus();
    });
  }

  // 세션 이동 시 이전 채팅의 초안 텍스트와 첨부가 새 채팅으로 넘어가지 않게 비운다.
  function clearDraft() {
    setPrompt("");
    setAttachments([]);
  }

  function handleSelectSession(projectId: string, sessionId: string) {
    setSelectedProjectId(projectId);
    setSelectedSessionId(sessionId);
    setCollapsedProjectIds((currentProjectIds) =>
      currentProjectIds.filter((currentProjectId) => currentProjectId !== projectId),
    );
    clearDraft();
    focusPrompt();
  }

  async function handleCopy(message: Message) {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 900);
  }

  async function handlePickFiles() {
    if (!selectedProject || !selectedSession) {
      return;
    }

    const selectedPaths = await open({
      multiple: true,
      directory: false,
      title: "PaiM에 첨부할 파일 선택",
    });

    if (!selectedPaths) {
      return;
    }

    const paths = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
    await appendAttachmentPaths(paths);
  }

  // 여러 파일 경로를 현재 초안 첨부 목록에 추가한다.
  async function appendAttachmentPaths(paths: string[]) {
    if (!selectedProject || !selectedSession || paths.length === 0) {
      return;
    }

    const nextAttachments = await Promise.all(paths.map(createAttachment));

    setAttachments((currentAttachments) => [...currentAttachments, ...nextAttachments]);
  }

  // 로컬 이미지 파일이면 프론트 표시용 미리보기 URL을 만든다.
  async function createAttachmentPreviewUrl(path: string) {
    try {
      const previewUrl = await invoke<string | null>("create_attachment_preview", { path });
      return previewUrl;
    } catch {
      return null;
    }
  }

  // 선택한 파일의 기본 정보와 이미지 미리보기 URL을 만든다.
  async function createAttachment(path: string): Promise<Attachment> {
    const attachment: Attachment = {
      id: createId("attachment"),
      name: getFileName(path),
      path,
    };
    const previewUrl = await createAttachmentPreviewUrl(path);

    if (previewUrl) {
      attachment.previewUrl = previewUrl;
    }

    return attachment;
  }

  // 저장된 세션을 다시 열 때 파일 경로로 이미지 미리보기를 복원한다.
  async function hydrateStoredAttachmentPreviews() {
    let didChange = false;
    const hydratedProjects = await Promise.all(
      projects.map(async (project) => ({
        ...project,
        sessions: await Promise.all(
          project.sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
              session.messages.map(async (message) => {
                if (!message.attachments || message.attachments.length === 0) {
                  return message;
                }

                const attachments = await Promise.all(
                  message.attachments.map(async (attachment) => {
                    if (attachment.previewUrl) {
                      return attachment;
                    }

                    const previewUrl = await createAttachmentPreviewUrl(attachment.path);

                    if (!previewUrl) {
                      return attachment;
                    }

                    didChange = true;
                    return { ...attachment, previewUrl };
                  }),
                );

                return { ...message, attachments };
              }),
            ),
          })),
        ),
      })),
    );

    if (!didChange) {
      return;
    }

    setProjects((currentProjects) =>
      currentProjects.map(
        (currentProject) =>
          hydratedProjects.find((project) => project.id === currentProject.id) ?? currentProject,
      ),
    );
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => attachment.id !== attachmentId),
    );
  }

  function handleOpenProjectOverview() {
    setSelectedSessionId(null);
    setPrompt("");
    setAttachments([]);
    setIsSending(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();

    if (!selectedProject || !selectedSession || (!trimmedPrompt && attachments.length === 0) || isSending) {
      return;
    }

    const targetProjectId = selectedProject.id;
    const targetSessionId = selectedSession.id;
    const messageAttachments = attachments;
    const userMessage: Message = {
      id: createId("user"),
      role: "user",
      content: trimmedPrompt || "첨부 파일을 확인해줘",
      attachments: messageAttachments,
    };

    updateSessionInProject(targetProjectId, targetSessionId, (session) => ({
      ...session,
      title:
        session.title === "New Chat"
          ? (trimmedPrompt || messageAttachments[0]?.name || "File attachment").slice(0, 32)
          : session.title,
      messages: [...session.messages, userMessage],
    }));
    setPrompt("");
    setAttachments([]);
    setIsSending(true);

    await wait(DEMO_REPLY_DELAY_MS);

    updateSessionInProject(targetProjectId, targetSessionId, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id: createId("assistant"),
          role: "assistant",
          content: createDemoAssistantReply(userMessage),
        },
      ],
    }));
    setIsSending(false);
    focusPrompt();
  }

  // 채팅 앱의 기본 키보드 동작으로 Enter 전송, Shift+Enter 줄바꿈을 처리한다.
  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div
      className="app-shell"
      data-drag-active={isDragActive}
      data-platform={isWindows ? "windows" : "native"}
      data-sidebar-collapsed={isSidebarCollapsed}
      data-sidebar-resizing={isSidebarResizing}
      onClick={() => setOpenActionMenu(null)}
      style={appShellStyle}
    >
      {isWindows ? <WindowsTitlebar /> : null}
      <aside className="sidebar">
        <div className="sidebar-header">
          <button
            className="sidebar-toggle"
            aria-label={isSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
            onClick={handleToggleSidebar}
            title={isSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
            type="button"
          >
            <PanelLeft size={17} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="주요 메뉴">
          <div className="project-create" ref={projectCreateRef}>
            <button
              aria-expanded={isProjectCreateMenuOpen}
              aria-haspopup="menu"
              className="project-create-trigger"
              onClick={handleToggleProjectCreateMenu}
              title="새 프로젝트"
              type="button"
            >
              <FolderPlus size={18} />
              <span>New Project</span>
            </button>
            {isProjectCreateMenuOpen ? (
              <div className="project-create-menu" role="menu" aria-label="프로젝트 생성">
                <button
                  className="project-create-option"
                  data-source="folder"
                  onClick={() => void handleCreateProjectFromFolder()}
                  role="menuitem"
                  type="button"
                >
                  <FolderOpen size={16} />
                  <span>Open folder</span>
                </button>
                <button
                  className="project-create-option"
                  data-source="files"
                  onClick={() => void handleCreateProjectFromFiles()}
                  role="menuitem"
                  type="button"
                >
                  <FileUp size={16} />
                  <span>Upload files</span>
                </button>
              </div>
            ) : null}
          </div>
        </nav>

        <section className="projects project-tree" aria-label="프로젝트">
          <h2>Projects</h2>
          <div className="project-tree-list">
            {projects.map((project) => (
              <div
                className="project-group"
                data-active={project.id === selectedProjectId}
                data-collapsed={collapsedProjectIdSet.has(project.id)}
                data-project-id={project.id}
                key={project.id}
              >
                <div className="project-row">
                  <div className="project-title">
                    {renameDraft?.type === "project" && renameDraft.projectId === project.id ? (
                      <div className="project-item project-rename-editor">
                        <FolderOpen size={15} />
                        <input
                          aria-label="프로젝트 이름 변경"
                          autoFocus
                          className="rename-input"
                          defaultValue={renameDraft.value}
                          onBlur={(event) => commitRenameDraft(event.currentTarget.value)}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={handleRenameKeyDown}
                        />
                      </div>
                    ) : (
                      <>
                        <button
                          className="project-item"
                          data-active={project.id === selectedProjectId}
                          data-project-id={project.id}
                          onClick={() => handleSelectProject(project.id)}
                          title={project.name}
                          type="button"
                        >
                          <FolderOpen size={15} />
                          <span className="project-name">{project.name}</span>
                        </button>
                        {project.sessions.length > 0 ? (
                          <button
                            aria-expanded={!collapsedProjectIdSet.has(project.id)}
                            aria-label={`${project.name} 채팅 목록 ${
                              collapsedProjectIdSet.has(project.id) ? "펼치기" : "접기"
                            }`}
                            className="project-collapse-button"
                            data-collapsed={collapsedProjectIdSet.has(project.id)}
                            onClick={(event) => toggleProjectSessions(project.id, event)}
                            title={
                              collapsedProjectIdSet.has(project.id)
                                ? `${project.name} 채팅 목록 펼치기`
                                : `${project.name} 채팅 목록 접기`
                            }
                            type="button"
                          >
                            <ChevronDown size={14} />
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div className="project-actions">
                    <button
                      aria-label={`${project.name}에 새 채팅 만들기`}
                      className="project-chat-create-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCreateChatInProject(project.id);
                      }}
                      title={`${project.name}에 새 채팅 만들기`}
                      type="button"
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      aria-expanded={
                        openActionMenu?.type === "project" &&
                        openActionMenu.projectId === project.id
                      }
                      aria-haspopup="menu"
                      aria-label={`${project.name} 메뉴`}
                      className="project-action-menu-button"
                      onClick={(event) => toggleProjectActionMenu(project.id, event)}
                      title={`${project.name} 메뉴`}
                      type="button"
                    >
                      <Ellipsis size={15} />
                    </button>
                  </div>
                </div>

                {collapsedProjectIdSet.has(project.id) ? null : (
                  <div className="project-sessions">
                    {project.sessions.map((session) => (
                      <div
                        className="history-row"
                        data-active={
                          project.id === selectedProjectId && session.id === selectedSessionId
                        }
                        key={session.id}
                      >
                        {renameDraft?.type === "session" &&
                        renameDraft.projectId === project.id &&
                        renameDraft.sessionId === session.id ? (
                          <div className="history-item history-rename-editor">
                            <MessageSquare size={13} />
                            <input
                              aria-label="채팅 이름 변경"
                              autoFocus
                              className="rename-input"
                              defaultValue={renameDraft.value}
                              onBlur={(event) => commitRenameDraft(event.currentTarget.value)}
                              onClick={(event) => event.stopPropagation()}
                              onFocus={(event) => event.currentTarget.select()}
                              onKeyDown={handleRenameKeyDown}
                            />
                          </div>
                        ) : (
                          <button
                            className="history-item"
                            data-active={
                              project.id === selectedProjectId && session.id === selectedSessionId
                            }
                            onClick={() => handleSelectSession(project.id, session.id)}
                            type="button"
                          >
                            <MessageSquare size={13} />
                            <span className="history-title">{session.title}</span>
                            <small className="history-age">
                              {formatRelativeAge(session.createdAt)}
                            </small>
                          </button>
                        )}
                        <button
                          aria-expanded={
                            openActionMenu?.type === "session" &&
                            openActionMenu.projectId === project.id &&
                            openActionMenu.sessionId === session.id
                          }
                          aria-haspopup="menu"
                          aria-label={`${session.title} 메뉴`}
                          className="history-action-menu-button"
                          onClick={(event) =>
                            toggleSessionActionMenu(project.id, session.id, event)
                          }
                          title={`${session.title} 메뉴`}
                          type="button"
                        >
                          <Ellipsis size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <div
          aria-label="사이드바 크기 조절"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="sidebar-resize-handle"
          onMouseDown={handleSidebarResizeStart}
          role="separator"
        />

        {openActionMenu && actionMenuProject ? (
          <div
            className="item-action-menu"
            onClick={(event) => event.stopPropagation()}
            role="menu"
            style={{ top: openActionMenu.top, left: openActionMenu.left }}
          >
            {openActionMenu.type === "project" ? (
              <>
                <button
                  data-action="rename-project"
                  onClick={() => beginRenameProject(actionMenuProject.id)}
                  role="menuitem"
                  type="button"
                >
                  Name change
                </button>
                <button
                  className="danger"
                  data-action="delete-project"
                  onClick={(event) => handleDeleteProject(actionMenuProject.id, event)}
                  role="menuitem"
                  type="button"
                >
                  Delete
                </button>
              </>
            ) : actionMenuSession ? (
              <>
                <button
                  data-action="rename-session"
                  onClick={() => beginRenameSession(actionMenuProject.id, actionMenuSession.id)}
                  role="menuitem"
                  type="button"
                >
                  Name change
                </button>
                <button
                  className="danger"
                  data-action="delete-session"
                  onClick={(event) =>
                    handleDeleteSession(actionMenuProject.id, actionMenuSession.id, event)
                  }
                  role="menuitem"
                  type="button"
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </aside>

      <main className="chat">
        {selectedSession ? (
          <>
            <div className="chat-scroll" ref={chatScrollRef}>
              <div className="conversation">
                {selectedSession.messages.map((message, index) => (
                <article className="message" data-role={message.role} key={message.id}>
                  {message.role === "assistant" && index > 1 ? (
                    <div className="thinking">
                      <Lightbulb size={16} />
                      <span>Thought for a moment</span>
                    </div>
                  ) : null}
                  <div className="message-content">
                    {message.content.split("\n").map((line, lineIndex) => (
                      <p key={`${message.id}-${lineIndex}`}>{line}</p>
                    ))}
                    {message.attachments && message.attachments.length > 0 ? (
                      <AttachmentList attachments={message.attachments} label="첨부 파일" />
                    ) : null}
                  </div>
                  {message.role === "assistant" ? (
                    <button
                      className="copy-button"
                      data-copied={copiedMessageId === message.id}
                      onClick={() => void handleCopy(message)}
                      aria-label={copiedMessageId === message.id ? "복사됨" : "응답 복사"}
                      title={copiedMessageId === message.id ? "복사됨" : "응답 복사"}
                      type="button"
                    >
                      <Copy size={16} />
                    </button>
                  ) : null}
                </article>
                ))}

                {isSending ? (
                  <article className="message" data-role="assistant">
                    <div className="thinking">
                      <Lightbulb size={16} />
                      <span>Thought for a moment</span>
                    </div>
                  </article>
                ) : null}
              </div>
            </div>

            <form className="prompt" onSubmit={handleSubmit}>
              <textarea
                aria-label="메시지 입력"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Send a message"
                ref={promptTextareaRef}
                rows={1}
                value={prompt}
              />
              {attachments.length > 0 ? (
                <div className="draft-attachments">
                  <AttachmentList
                    attachments={attachments}
                    label="전송할 첨부 파일"
                    onRemove={removeAttachment}
                  />
                </div>
              ) : null}
              <div className="prompt-actions">
                <button
                  aria-label="파일 추가"
                  onClick={() => void handlePickFiles()}
                  title="파일 추가"
                  type="button"
                >
                  <Plus size={17} />
                </button>
                <button
                  aria-label="프로젝트 개요"
                  className="overview-button"
                  onClick={handleOpenProjectOverview}
                  title="프로젝트 개요"
                  type="button"
                >
                  <LayoutDashboard size={17} />
                </button>
                <button
                  aria-label="메시지 보내기"
                  className="send-button"
                  disabled={(!prompt.trim() && attachments.length === 0) || isSending}
                  title="메시지 보내기"
                  type="submit"
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </form>
          </>
        ) : selectedProject ? (
          <div className="project-overview" aria-label="프로젝트 개요">
            <div className="project-overview-scroll">
              <div className="project-overview-header">
                <div>
                  <p className="project-overview-kicker">PROJECT OVERVIEW</p>
                  <h1>{selectedProject.name}</h1>
                  <p className="project-overview-meta">
                    {selectedProjectAttachments.length} FILES ·{" "}
                    {getProjectMessageCount(selectedProject)} MESSAGES · LAST UPDATE{" "}
                    {formatOverviewDate(getProjectLastUpdatedAt(selectedProject))}
                  </p>
                </div>
                <div className="project-overview-actions">
                  <button
                    className="project-overview-file-action"
                    onClick={() => void handleAddFilesToProject(selectedProject.id)}
                    title="프로젝트 파일 추가"
                    type="button"
                  >
                    <TablerIcon svg={tablerFilePlus} />
                    <span>파일 추가</span>
                  </button>
                </div>
              </div>

              {demoStatus && demoStatus.scope !== "github" ? (
                <p
                  className="runtime-status project-overview-status"
                  data-ok={demoStatus.ok}
                  key={statusRevision}
                  role="status"
                >
                  {demoStatus.message}
                </p>
              ) : null}

              <section className="overview-memory" aria-label="프로젝트 메모">
                <h2>PROJECT MEMORY</h2>
                <div className="overview-memory-grid">
                  {overviewMemoryCards.map((card) => (
                    <article className="overview-memory-card" data-tone={card.tone} key={card.label}>
                      <div className="overview-memory-label">
                        <TablerIcon svg={card.icon} />
                        <span>{card.label}</span>
                      </div>
                      {card.items.map((item) => (
                        <p key={item}>
                          <span>·</span>
                          {item}
                        </p>
                      ))}
                    </article>
                  ))}
                </div>
              </section>

              <div className="overview-columns">
                <section className="overview-panel" aria-label="프로젝트 파일">
                  <h2>FILES</h2>
                  {selectedProjectAttachments.length > 0 ? (
                    <div className="overview-file-list">
                      {selectedProjectAttachments.map((attachment) => (
                        <div className="overview-file-row" key={attachment.id}>
                          <TablerIcon svg={getAttachmentIconSvg(attachment.name)} />
                          <div>
                            <p>{attachment.name}</p>
                            <small>{getAttachmentMeta(attachment.name)}</small>
                          </div>
                          <button
                            aria-label={`${attachment.name} 삭제`}
                            onClick={() => handleDeleteProjectFile(selectedProject.id, attachment.id)}
                            title={`${attachment.name} 삭제`}
                            type="button"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="overview-empty-text">
                      <TablerIcon svg={tablerAlertCircle} />
                      아직 프로젝트에 연결된 첨부 파일이 없습니다.
                    </p>
                  )}
                </section>

                <section className="overview-panel" aria-label="GitHub 타임라인">
                  <div className="overview-github-header">
                    <h2>GITHUB</h2>
                    <span
                      className="overview-github-state"
                      data-state={selectedProjectGithubPanelState}
                    >
                      {getGithubPanelStateLabel(selectedProjectGithubPanelState)}
                    </span>
                  </div>
                  {demoStatus?.scope === "github" ? (
                    <p
                      className="runtime-status overview-github-status"
                      data-ok={demoStatus.ok}
                      key={statusRevision}
                      role="status"
                    >
                      {demoStatus.message}
                    </p>
                  ) : null}

                  {selectedProjectGithubPanelState === "signedout" ? (
                    <div className="overview-github-card overview-github-login-card">
                      <div className="overview-github-brand">
                        <span className="overview-github-logo-box" aria-hidden="true">
                          <img className="overview-github-logo" src={githubMark} alt="" />
                        </span>
                        <div className="overview-github-copy">
                          <p>GitHub 연결</p>
                          <small>
                            GitHub으로 로그인하면 repo의 커밋·PR·이슈를 타임라인으로
                            가져옵니다. private repo도 지원됩니다.
                          </small>
                        </div>
                      </div>
                      <button
                        className="overview-github-primary-button"
                        disabled={isGithubAuthStarting}
                        onClick={() => void handleStartGithubLogin(selectedProject.id)}
                        type="button"
                      >
                        <img className="overview-github-button-logo" src={githubMark} alt="" />
                        <span>{isGithubAuthStarting ? "여는 중..." : "GitHub 로그인"}</span>
                      </button>
                    </div>
                  ) : null}

                  {selectedProjectGithubPanelState === "authing" ? (
                    <div className="overview-github-card overview-github-auth-card">
                      <span className="overview-github-logo-box" aria-hidden="true">
                        <img className="overview-github-logo" src={githubMark} alt="" />
                      </span>
                      <p>브라우저에서 로그인을 완료해 주세요</p>
                      <small>
                        GitHub 인증 페이지를 새 창에서 열었습니다.
                        <br />
                        코드 {selectedProjectGithubSession?.userCode ?? ""} 입력 후 완료 버튼을 눌러 주세요.
                      </small>
                      <span className="overview-github-loader">
                        <RefreshCcw size={16} />
                        로그인 대기 중...
                      </span>
                      <div className="overview-github-action-buttons">
                        <button
                          className="overview-github-secondary-button"
                          disabled={isGithubAuthChecking}
                          onClick={() => void handleCheckGithubLogin(selectedProject.id)}
                          type="button"
                        >
                          <Check size={14} />
                          <span>{isGithubAuthChecking ? "확인 중..." : "로그인 완료했어요"}</span>
                        </button>
                        <button
                          className="overview-github-ghost-button"
                          onClick={() => handleResetGithubLogin(selectedProject.id)}
                          type="button"
                        >
                          <X size={14} />
                          <span>취소</span>
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {selectedProjectGithubPanelState === "repos" ? (
                    <div className="overview-github-card overview-github-repos-card">
                      <div className="overview-github-toolbar">
                        <div className="overview-github-account">
                          <img className="overview-github-toolbar-logo" src={githubMark} alt="" />
                          <span>GitHub</span>
                          <span className="overview-github-login-badge">
                            <Check size={12} />
                            로그인됨
                          </span>
                        </div>
                        <button
                          className="overview-github-ghost-button"
                          onClick={() => handleResetGithubLogin(selectedProject.id)}
                          type="button"
                        >
                          <LogOut size={13} />
                          <span>로그아웃</span>
                        </button>
                      </div>
                      <label className="overview-github-search">
                        <Search size={15} />
                        <input
                          aria-label="GitHub repo 검색"
                          onChange={(event) => setGithubRepositoryQuery(event.target.value)}
                          placeholder="repo 검색..."
                          type="text"
                          value={githubRepositoryQuery}
                        />
                        {githubRepositoryQuery ? (
                          <button
                            aria-label="repo 검색어 지우기"
                            onClick={() => setGithubRepositoryQuery("")}
                            title="repo 검색어 지우기"
                            type="button"
                          >
                            <X size={15} />
                          </button>
                        ) : null}
                      </label>
                      <p className="overview-github-list-label">
                        YOUR REPOS · {filteredSelectedProjectGithubRepositories.length}
                      </p>
                      {selectedProjectGithubRepositories.length > 0 ? (
                        <div className="overview-github-repo-list" aria-label="접근 가능한 GitHub repo">
                          {filteredSelectedProjectGithubRepositories.length > 0 ? (
                            filteredSelectedProjectGithubRepositories.map((repository, index) => (
                              <div
                                className="overview-github-repo-row"
                                data-last={index === filteredSelectedProjectGithubRepositories.length - 1}
                                key={repository.fullName}
                              >
                                <GitBranch size={16} />
                                <div className="overview-github-repo-copy">
                                  <div>
                                    <p>{repository.fullName}</p>
                                    <span className="overview-github-repo-visibility">
                                      {getGithubAvailableRepositoryVisibility(repository)}
                                    </span>
                                  </div>
                                  <small>기본 브랜치 {repository.defaultBranch}</small>
                                </div>
                                <button
                                  className="overview-github-secondary-button"
                                  disabled={isGithubConnecting}
                                  onClick={() =>
                                    void connectGithubRepository(selectedProject.id, repository.url)
                                  }
                                  type="button"
                                >
                                  <Link2 size={14} />
                                  <span>{isGithubConnecting ? "연결 중..." : "연결"}</span>
                                </button>
                              </div>
                            ))
                          ) : (
                            <p className="overview-github-empty">
                              "{githubRepositoryQuery}" 검색 결과가 없습니다
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="overview-github-empty">
                          <p>아직 불러온 repo가 없습니다.</p>
                          <button
                            className="overview-github-secondary-button"
                            disabled={isGithubRepoLoading}
                            onClick={() => void handleLoadGithubRepositories(selectedProject.id)}
                            type="button"
                          >
                            <RefreshCcw size={14} />
                            <span>{isGithubRepoLoading ? "불러오는 중..." : "Repo 목록 불러오기"}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}

                  {selectedProject.githubRepository ? (
                    <div className="overview-github-card overview-github-connected-card">
                      <div className="overview-github-brand">
                        <span className="overview-github-logo-box" data-tone="connected" aria-hidden="true">
                          <img className="overview-github-logo" src={githubMark} alt="" />
                        </span>
                        <div className="overview-github-copy">
                          <div className="overview-github-repo-title">
                            <p className="overview-github-repo-name">
                              {selectedProject.githubRepository.remoteRepo ??
                                selectedProject.githubRepository.name}
                            </p>
                            <span className="overview-github-repo-visibility">
                              {selectedProject.githubRepository.visibility === "private"
                                ? "PRIVATE"
                                : "PUBLIC"}
                            </span>
                          </div>
                          <p className="overview-github-meta">
                            LOCAL · {selectedProject.githubRepository.branch} ·{" "}
                            {getGithubRepoLabel(selectedProject.githubRepository)} ·{" "}
                            {selectedProject.githubRepository.issuePrStatus}
                          </p>
                        </div>
                      </div>
                      <div className="overview-github-action-buttons">
                        <button
                          className="overview-github-secondary-button"
                          disabled={isGithubSyncing}
                          onClick={() => void handleSyncGithubRepository(selectedProject.id)}
                          type="button"
                        >
                          <RefreshCcw size={15} />
                          <span>{isGithubSyncing ? "Sync 중..." : "Sync"}</span>
                        </button>
                        <button
                          className="overview-github-secondary-button"
                          onClick={() =>
                            handleDisconnectGithub(
                              selectedProject.id,
                              "repo 연결을 해제했습니다. 새 repo를 선택하세요",
                            )
                          }
                          type="button"
                        >
                          <GitBranch size={15} />
                          <span>repo 변경</span>
                        </button>
                        <button
                          className="overview-github-danger-button"
                          onClick={() => handleDisconnectGithub(selectedProject.id)}
                          type="button"
                        >
                          <X size={15} />
                          <span>연결 해제</span>
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {selectedProjectGithubEvents.length > 0 ? (
                    <div className="overview-timeline-list">
                      {selectedProjectGithubEvents.map((event, index) => (
                        <div className="overview-timeline-row" key={event.id}>
                          <div className="overview-timeline-icon" data-event-type={event.type}>
                            <TablerIcon svg={getGithubEventIconSvg(event.type)} />
                            {index < selectedProjectGithubEvents.length - 1 ? <span /> : null}
                          </div>
                          <div>
                            <p>{event.title}</p>
                            <small>{getGithubEventMeta(event)}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : selectedProject.githubConnected ? (
                    <p className="overview-empty-text">
                      <TablerIcon svg={tablerAlertCircle} />
                      아직 GitHub 이벤트가 없습니다.
                    </p>
                  ) : null}
                </section>
              </div>
            </div>

            <form
              className="overview-chatbox"
              onSubmit={(event) => handleOverviewPromptSubmit(event, selectedProject.id)}
            >
              <div className="overview-chatline">
                <TablerIcon className="overview-chat-spark" svg={tablerSparkles} />
                <input
                  aria-label="프로젝트 질문 입력"
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Chat about this project — ask anything from the meetings"
                  value={prompt}
                />
                <button
                  aria-label="프로젝트 질문 보내기"
                  disabled={!prompt.trim() || isSending}
                  title="프로젝트 질문 보내기"
                  type="submit"
                >
                  <TablerIcon svg={tablerArrowUp} />
                </button>
              </div>
              <div className="overview-suggestions" aria-label="추천 질문">
                {OVERVIEW_SUGGESTIONS.map((suggestion) => (
                  <button
                    disabled={isSending}
                    key={suggestion}
                    onClick={() => void handleStartOverviewChat(selectedProject.id, suggestion)}
                    type="button"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </form>
          </div>
        ) : (
          <div className="project-start" role="status">
            <div className="project-start-content">
              <img
                className="project-start-watermark"
                src={paimWatermark}
                alt="PaiM AI Project Manager"
              />
              {demoStatus && demoStatus.scope !== "github" ? (
                <p
                  className="runtime-status project-start-status"
                  data-ok={demoStatus.ok}
                  key={statusRevision}
                  role="status"
                >
                  {demoStatus.message}
                </p>
              ) : null}
              <button
                className="project-start-button"
                onClick={() => void handleCreateProjectFromFolder()}
                title="새 프로젝트 시작하기"
                type="button"
              >
                <FolderPlus size={16} />
                <span>새 프로젝트 시작하기</span>
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
