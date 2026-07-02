import {
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  Copy,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Ellipsis,
  Lightbulb,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Square,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type CSSProperties,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import paimWatermark from "./assets/paim-watermark.png";
import { GithubPanel } from "./GithubPanel";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { formatRelativeAge } from "./format";
import {
  createGithubDeviceCode,
  createGithubAppSession,
  fetchGithubAccessToken,
  fetchGithubAppRepositories,
  fetchGithubAppRepositoryPreview,
  fetchGithubAppSession,
  fetchGithubRepositories,
  fetchGithubRepository,
  fetchGithubUserProfile,
  fetchPaimFormData,
  fetchPaimJson,
  fetchPaimRootJson,
  getErrorMessage,
  getGithubOAuthErrorMessage,
  getGithubPanelStateLabel,
} from "./github";
import {
  clampProjectFileTreeWidth,
  countProjectFileEntries,
  createProjectFileEntry,
  DEFAULT_PROJECT_FILE_TREE_WIDTH,
  deleteProjectFileEntry,
  filterProjectFileEntries,
  getProjectFileVisualMeta,
  groupProjectSourcesByUploadedDate,
  MIN_PROJECT_FILE_TREE_WIDTH,
  ProjectFilesPanel,
  sortProjectSourcesByUploadedAt,
  updateProjectFileEntry,
  type ProjectFileVisualMeta,
} from "./projectFiles";
import type {
  Attachment,
  ChatSession,
  DemoStatus,
  DirectoryChildEntry,
  GithubAvailableRepository,
  GithubLoginSessionState,
  GithubPanelState,
  Message,
  ProjectDocumentStatus,
  ProjectFilePreview,
  ProjectSourcesMode,
  ProjectState,
  ProjectWorkspace,
} from "./types";

const PROJECT_PANEL_TOOL_VIEWS = ["memory", "files", "github"] as const;
type ProjectPanelToolView = (typeof PROJECT_PANEL_TOOL_VIEWS)[number];
type ProjectPanelView = "menu" | ProjectPanelToolView;

type ProjectPanelTab = {
  id: string;
  view: ProjectPanelToolView;
  fileQuery: string;
  filePreview: ProjectFilePreview | null;
  projectSourcesMode: ProjectSourcesMode;
  selectedProjectSourceId: string | null;
  pendingDeleteProjectFileId: string | null;
};

type ApiProjectCreateResponse = {
  id: number;
  name: string;
};

type ApiProjectResponse = ApiProjectCreateResponse & {
  created_at?: string;
};

type ApiHealthResponse = {
  status?: string;
};

type ApiDocumentStatus = "uploaded" | "processing" | "indexed" | "failed";

type ApiDocumentUploadResponse = {
  doc_id: number;
  status: ApiDocumentStatus;
};

type ApiDocumentListItem = {
  id: number;
  filename: string;
  doc_type?: string | null;
  status: ApiDocumentStatus;
  uploaded_at?: string | null;
};

type ApiDocumentStatusResponse = {
  doc_id: number;
  status: ApiDocumentStatus;
  last_error?: string | null;
  extracted?: Record<string, number>;
};

type ServerStatus = "online" | "offline";

type ActionMenuState =
  | { type: "project"; projectId: string; top: number; left: number }
  | { type: "session"; projectId: string; sessionId: string; top: number; left: number };

type RenameDraft =
  | { type: "project"; projectId: string; value: string }
  | { type: "session"; projectId: string; sessionId: string; value: string };

const DEMO_REPLY_DELAY_MS = 360;
const SERVER_SYNC_TIMEOUT_MS = 3000;
const DOCUMENT_STATUS_POLL_INTERVAL_MS = 3000;
const DOCUMENT_STATUS_POLL_TIMEOUT_MS = 180000;
const ACTION_MENU_WIDTH = 132;
const ACTION_MENU_HEIGHT = 76;
const ACTION_MENU_GAP = 6;
const PROJECT_STORAGE_KEY = "paim.projects.v3";
const LEGACY_PROJECT_STORAGE_KEYS = ["paim.projects.v2", "paim.projects.v1"];
const SIDEBAR_STORAGE_KEY = "paim.sidebarCollapsed.v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "paim.sidebarWidth.v1";
const PROJECT_PANEL_COLLAPSED_STORAGE_KEY = "paim.projectPanelCollapsed.v1";
const PROJECT_PANEL_WIDTH_STORAGE_KEY = "paim.projectPanelWidth.v1";
const PROJECT_COLLAPSED_STORAGE_KEY = "paim.projectCollapsed.v1";
const ZOOM_STORAGE_KEY = "paim.zoomScale.v1";
const DEFAULT_SIDEBAR_WIDTH = 272;
const COLLAPSED_SIDEBAR_WIDTH = 44;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_PROJECT_PANEL_WIDTH = 360;
const MIN_PROJECT_PANEL_WIDTH = 300;
const MAX_PROJECT_PANEL_WIDTH = 520;
const COLLAPSED_PROJECT_PANEL_WIDTH = 44;
const DEFAULT_ZOOM_SCALE = 1;
const MIN_ZOOM_SCALE = 0.8;
const MAX_ZOOM_SCALE = 1.6;
const ZOOM_STEP = 0.1;
const LEGACY_WELCOME_CONTENT = "안녕하세요! 😊";

function isWindowsHost() {
  return window.navigator.userAgent.includes("Windows");
}

function isMacHost() {
  return window.navigator.userAgent.includes("Mac");
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

function createProject(name: string, sessions: ChatSession[], files: Attachment[] = []): ProjectWorkspace {
  return {
    id: createId("project"),
    name,
    files,
    createdAt: Date.now(),
    sessions,
  };
}

function createProjectFromApi(serverProject: ApiProjectResponse): ProjectWorkspace {
  const createdAt = Date.parse(serverProject.created_at ?? "");

  return {
    id: createId("project"),
    apiProjectId: serverProject.id,
    name: serverProject.name,
    files: [],
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    sessions: [],
  };
}

function createEmptySession(): ChatSession {
  return {
    id: createId("session"),
    title: "New Chat",
    createdAt: Date.now(),
    messages: [],
  };
}

// 이전 버전이 자동으로 넣던 첫 assistant 인사는 새 empty state와 중복되므로 로딩 때만 걷어낸다.
function removeLegacyWelcomeMessages(messages: Message[]) {
  if (
    messages.length === 1 &&
    messages[0].role === "assistant" &&
    messages[0].content === LEGACY_WELCOME_CONTENT
  ) {
    return [];
  }

  return messages;
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
  const projectNames = new Set(projects.map((project) => project.name.trim()));

  for (let index = 1; ; index += 1) {
    const candidateName = `New Project ${index}`;

    if (!projectNames.has(candidateName)) {
      return candidateName;
    }
  }
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
    .map((project) => {
      const sessions = (project.sessions ?? []).map((session) => ({
        ...session,
        messages: removeLegacyWelcomeMessages(session.messages),
      }));

      return {
        ...project,
        sessions,
      };
    });

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
      : selectedProject.sessions.find((session) => session.id === selectedSessionId) ??
        selectedProject.sessions[0] ??
        null;

  return {
    projects: validProjects,
    selectedProjectId: selectedProject.id,
    selectedSessionId: selectedSession?.id ?? null,
  };
}

// 서버 목록을 정본으로 삼되, 로컬 전용 작업 상태는 보존한다.
function mergeServerProjects(
  localProjects: ProjectWorkspace[],
  serverProjects: ApiProjectResponse[],
) {
  const serverProjectIds = new Set(serverProjects.map((project) => project.id));
  const usedLocalProjectIds = new Set<string>();
  const localProjectsByApiId = new Map<number, ProjectWorkspace>();

  for (const project of localProjects) {
    if (typeof project.apiProjectId === "number" && !localProjectsByApiId.has(project.apiProjectId)) {
      localProjectsByApiId.set(project.apiProjectId, project);
    }
  }

  const syncedProjects = serverProjects.map((serverProject) => {
    const localProject = localProjectsByApiId.get(serverProject.id);

    if (!localProject) {
      return createProjectFromApi(serverProject);
    }

    usedLocalProjectIds.add(localProject.id);

    return {
      ...localProject,
      apiProjectId: serverProject.id,
      name: serverProject.name,
      serverMissing: undefined,
    };
  });

  const cachedOnlyProjects = localProjects
    .filter((project) => !usedLocalProjectIds.has(project.id))
    .map((project) =>
      typeof project.apiProjectId === "number" && !serverProjectIds.has(project.apiProjectId)
        ? { ...project, serverMissing: true }
        : { ...project, serverMissing: undefined },
    );

  return [...syncedProjects, ...cachedOnlyProjects];
}

function loadProjectState() {
  const savedValue =
    window.localStorage.getItem(PROJECT_STORAGE_KEY) ??
    LEGACY_PROJECT_STORAGE_KEYS
      .map((storageKey) => window.localStorage.getItem(storageKey))
      .find((value): value is string => Boolean(value));

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

// 우측 프로젝트 패널 접힘 상태를 앱 재실행 후에도 유지한다.
function loadProjectPanelCollapsed() {
  return window.localStorage.getItem(PROJECT_PANEL_COLLAPSED_STORAGE_KEY) === "true";
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function clampProjectPanelWidth(width: number) {
  return Math.min(MAX_PROJECT_PANEL_WIDTH, Math.max(MIN_PROJECT_PANEL_WIDTH, width));
}

function loadSidebarWidth() {
  const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));

  if (!Number.isFinite(savedWidth)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  return clampSidebarWidth(savedWidth);
}

function loadProjectPanelWidth() {
  const savedWidth = Number(window.localStorage.getItem(PROJECT_PANEL_WIDTH_STORAGE_KEY));

  if (!Number.isFinite(savedWidth)) {
    return DEFAULT_PROJECT_PANEL_WIDTH;
  }

  return clampProjectPanelWidth(savedWidth);
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

function getFileExtension(name: string) {
  return name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
}

function isSupportedProjectDocument(name: string) {
  return ["md", "txt", "pdf"].includes(getFileExtension(name));
}

function getUploadMimeType(name: string) {
  const extension = getFileExtension(name);

  if (extension === "pdf") {
    return "application/pdf";
  }

  return "text/plain";
}

function base64ToBytes(encoded: string) {
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toProjectDocumentStatus(status: ApiDocumentStatus): ProjectDocumentStatus {
  return status;
}

function isProjectDocumentTerminal(status?: ProjectDocumentStatus) {
  return status === "indexed" || status === "failed" || status === "delayed";
}

function createServerDocumentAttachment(document: ApiDocumentListItem): Attachment {
  const uploadedAt = Date.parse(document.uploaded_at ?? "");

  return {
    id: `project-document-${document.id}`,
    name: document.filename,
    path: `server-document://${document.id}/${document.filename}`,
    kind: "file",
    docId: document.id,
    documentStatus: toProjectDocumentStatus(document.status),
    serverOnly: true,
    uploadedAt: Number.isFinite(uploadedAt) ? uploadedAt : Date.now(),
  };
}

function mapAttachments(
  attachments: Attachment[],
  updater: (attachment: Attachment) => Attachment,
): Attachment[] {
  return attachments.map((attachment) => ({
    ...updater(attachment),
    children: attachment.children ? mapAttachments(attachment.children, updater) : undefined,
  }));
}

function collectFileAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.flatMap((attachment) =>
    attachment.kind === "directory"
      ? collectFileAttachments(attachment.children ?? [])
      : [attachment],
  );
}

function getAttachmentDocIds(attachments: Attachment[]) {
  return new Set(
    collectFileAttachments(attachments)
      .map((attachment) => attachment.docId)
      .filter((docId): docId is number => typeof docId === "number"),
  );
}

function mergeServerDocumentsIntoAttachments(
  attachments: Attachment[],
  documents: ApiDocumentListItem[],
) {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const updatedAttachments = mapAttachments(attachments, (attachment) => {
    if (typeof attachment.docId !== "number") {
      return attachment;
    }

    const document = documentsById.get(attachment.docId);

    if (!document) {
      return attachment;
    }

    return {
      ...attachment,
      name: document.filename,
      documentStatus: toProjectDocumentStatus(document.status),
    };
  });
  const existingDocIds = getAttachmentDocIds(updatedAttachments);
  const serverOnlyAttachments = documents
    .filter((document) => !existingDocIds.has(document.id))
    .map(createServerDocumentAttachment);

  return [...serverOnlyAttachments, ...updatedAttachments];
}

function canUseTauriDialog() {
  return "__TAURI_INTERNALS__" in window;
}

async function openExternalUrl(url: string) {
  if (canUseTauriDialog()) {
    await openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

// Overview 파일 목록은 프로젝트에 직접 등록된 파일만 보여준다.
function getProjectAttachments(project: ProjectWorkspace) {
  return project.files ?? [];
}

// GitHub 이벤트는 최신순으로만 정렬해서 Overview에 보여준다.
function getProjectGithubEvents(project: ProjectWorkspace) {
  return [...(project.githubEvents ?? [])].sort((left, right) => right.createdAt - left.createdAt);
}

// 우측 패널은 Codex류 보조 패널처럼 메뉴와 상세 화면을 오간다.
function getProjectPanelTitle(view: ProjectPanelView) {
  const titles: Record<ProjectPanelView, string> = {
    menu: "도구 선택",
    memory: "프로젝트 메모리",
    files: "자료",
    github: "GitHub",
  };

  return titles[view];
}

// 새 탭은 자료 탭일 때만 독립 상태를 사용한다. 다른 탭은 같은 화면을 여러 개 열 수만 있으면 충분하다.
function createProjectPanelTab(view: ProjectPanelToolView): ProjectPanelTab {
  return {
    id: createId("project-panel-tab"),
    view,
    fileQuery: "",
    filePreview: null,
    projectSourcesMode: "library",
    selectedProjectSourceId: null,
    pendingDeleteProjectFileId: null,
  };
}

function resolveStateAction<T>(action: SetStateAction<T>, currentValue: T) {
  return typeof action === "function"
    ? (action as (value: T) => T)(currentValue)
    : action;
}

// 패널 탭은 열린 파일이 있으면 자료 탭 대신 파일명과 파일 아이콘을 보여준다.
function getProjectPanelTabVisualMeta(
  view: ProjectPanelToolView,
  preview: ProjectFilePreview | null,
) {
  if (view === "files" && preview) {
    return getProjectFileVisualMeta(preview.name);
  }

  const icons: Record<ProjectPanelToolView, ProjectFileVisualMeta> = {
    memory: { Icon: Brain, color: "var(--muted)" },
    files: { Icon: Files, color: "var(--muted)" },
    github: { Icon: GitBranch, color: "var(--muted)" },
  };

  return icons[view];
}

function getGithubLoginErrorMessage(error: unknown) {
  const message = getErrorMessage(error, "GitHub 로그인을 시작할 수 없습니다");

  return /failed to fetch|load failed/i.test(message)
    ? "GitHub 로그인 서버에 연결할 수 없습니다. 네트워크를 확인해 주세요."
    : message;
}

// private repo가 실제로 포함됐는지 로그인/새로고침 결과에서 바로 보이게 한다.
function getGithubRepositoryLoadMessage(repositories: GithubAvailableRepository[]) {
  const privateCount = repositories.filter((repository) => repository.private).length;

  return `${repositories.length}개 repo를 불러왔습니다 · private ${privateCount}개`;
}

// GitHub App 설치는 user API가 없어서 repo owner를 계정 표시 fallback으로 쓴다.
function getGithubRepositoryOwner(repositories: GithubAvailableRepository[]) {
  return repositories.find((repository) => repository.owner)?.owner;
}

// localStorage에는 큰 data URL을 저장하지 않도록 첨부 미리보기를 제외한다.
function createStoredAttachments(attachments: Attachment[] = []): Attachment[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
	    name: attachment.name,
	    path: attachment.path,
	    kind: attachment.kind,
	    children: attachment.children ? createStoredAttachments(attachment.children) : undefined,
	    childrenLoaded: attachment.childrenLoaded,
	    docId: attachment.docId,
	    documentStatus: attachment.documentStatus,
	    isExpanded: attachment.isExpanded,
	    lastError: attachment.lastError,
	    serverOnly: attachment.serverOnly,
	    uploadedAt: attachment.uploadedAt,
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

// 업로드된 프로젝트 자료를 읽은 뒤 처음 보여줄 짧은 브리핑 응답을 만든다.
function createProjectBriefingReply(project: ProjectWorkspace, projectFiles: Attachment[]) {
  const description = project.description?.trim();
  const fileNames = projectFiles.map((file) => file.name).join(", ");
  const githubName = project.githubRepository?.remoteRepo ?? project.githubRepository?.name;

  return [
    `${project.name || "New Project"} 프로젝트 맥락을 받았습니다.`,
    "",
    description ? `프로젝트 설명: ${description}` : null,
    projectFiles.length > 0 ? `확인한 자료: ${fileNames}` : null,
    githubName ? `GitHub 저장소: ${githubName}` : null,
    "",
    "지금부터 이 정보를 기준으로 프로젝트 목적, 현재 상태, 다음 액션을 함께 정리할 수 있습니다.",
  ]
    .filter((line) => line !== null)
    .join("\n");
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
  const isMac = useMemo(isMacHost, []);
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
  const [isProjectPanelCollapsed, setIsProjectPanelCollapsed] = useState(
    loadProjectPanelCollapsed,
  );
  const [projectPanelWidth, setProjectPanelWidth] = useState(loadProjectPanelWidth);
  const [isProjectPanelResizing, setIsProjectPanelResizing] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [demoStatus, setDemoStatusState] = useState<DemoStatus | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  const [projectPanelTabs, setProjectPanelTabs] = useState<ProjectPanelTab[]>([]);
  const [activeProjectPanelTabId, setActiveProjectPanelTabId] = useState<string | null>(null);
  const [isProjectPanelMaximized, setIsProjectPanelMaximized] = useState(false);
  const [projectFileTreeWidth, setProjectFileTreeWidth] = useState(
    DEFAULT_PROJECT_FILE_TREE_WIDTH,
  );
  const [isProjectFileTreeCollapsed, setIsProjectFileTreeCollapsed] = useState(false);
  const [isProjectFileTreeResizing, setIsProjectFileTreeResizing] = useState(false);
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
  const [serverStatus, setServerStatus] = useState<ServerStatus>("online");
  const sidebarResizeRef = useRef({ startX: 0, startWidth: DEFAULT_SIDEBAR_WIDTH });
  const projectPanelResizeRef = useRef({
    startX: 0,
    startWidth: DEFAULT_PROJECT_PANEL_WIDTH,
  });
  const projectFileTreeResizeRef = useRef({
    startX: 0,
    startWidth: DEFAULT_PROJECT_FILE_TREE_WIDTH,
  });
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const didHydrateAttachmentPreviewsRef = useRef(false);
  const didSyncProjectsRef = useRef(false);
  const documentPollTimeoutsRef = useRef(new Map<string, number>());
  const demoStatusTimeoutRef = useRef<number | null>(null);
  const projectsRef = useRef(initialProjectState.projects);
  const selectedProjectIdRef = useRef(initialProjectState.selectedProjectId);
  const selectedSessionIdRef = useRef(initialProjectState.selectedSessionId);
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
  const activeProjectPanelTab = useMemo(
    () => projectPanelTabs.find((tab) => tab.id === activeProjectPanelTabId) ?? null,
    [activeProjectPanelTabId, projectPanelTabs],
  );
  const projectPanelView: ProjectPanelView = activeProjectPanelTab?.view ?? "menu";
  const activeProjectFileTab =
    activeProjectPanelTab?.view === "files" ? activeProjectPanelTab : null;
  const projectFileQuery = activeProjectFileTab?.fileQuery ?? "";
  const projectFilePreview = activeProjectFileTab?.filePreview ?? null;
  const projectSourcesMode = activeProjectFileTab?.projectSourcesMode ?? "library";
  const selectedProjectSourceId = activeProjectFileTab?.selectedProjectSourceId ?? null;
  const pendingDeleteProjectFileId = activeProjectFileTab?.pendingDeleteProjectFileId ?? null;
	  const selectedProjectAttachments = useMemo(
	    () => (selectedProject ? getProjectAttachments(selectedProject) : []),
	    [selectedProject],
	  );
	  const sortedSelectedProjectAttachments = useMemo(
	    () => sortProjectSourcesByUploadedAt(selectedProjectAttachments),
	    [selectedProjectAttachments],
	  );
  const selectedProjectFileCount = useMemo(
    () => countProjectFileEntries(selectedProjectAttachments),
    [selectedProjectAttachments],
  );
  const selectedProjectRootFileCount = useMemo(
    () => selectedProjectAttachments.filter((attachment) => attachment.kind !== "directory").length,
    [selectedProjectAttachments],
  );
  const selectedProjectFolderCount = useMemo(
    () => selectedProjectAttachments.filter((attachment) => attachment.kind === "directory").length,
    [selectedProjectAttachments],
  );
	  const filteredSelectedProjectFiles = useMemo(
	    () => filterProjectFileEntries(sortedSelectedProjectAttachments, projectFileQuery),
	    [projectFileQuery, sortedSelectedProjectAttachments],
	  );
	  const groupedSelectedProjectFiles = useMemo(
	    () => groupProjectSourcesByUploadedDate(filteredSelectedProjectFiles),
	    [filteredSelectedProjectFiles],
	  );
	  const selectedProjectSource = useMemo(
	    () => selectedProjectAttachments.find((source) => source.id === selectedProjectSourceId) ?? null,
	    [selectedProjectAttachments, selectedProjectSourceId],
	  );
	  const isSelectedProjectSourceFile = selectedProjectSource?.kind === "file";
	  const selectedProjectTreeAttachments = useMemo(
	    () => (selectedProjectSource ? [selectedProjectSource] : selectedProjectAttachments),
	    [selectedProjectAttachments, selectedProjectSource],
	  );
	  const selectedProjectTreeFileCount = useMemo(
	    () => countProjectFileEntries(selectedProjectTreeAttachments),
	    [selectedProjectTreeAttachments],
	  );
	  const filteredSelectedProjectTreeFiles = useMemo(
	    () => filterProjectFileEntries(selectedProjectTreeAttachments, projectFileQuery),
	    [projectFileQuery, selectedProjectTreeAttachments],
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
  const selectedProjectDescription = selectedProject?.description?.trim() ?? "";
  const isSelectedProjectDefaultName = /^New Project(?: \d+)?$/.test(selectedProject?.name ?? "");
  const canOpenProjectMemory =
    serverStatus === "online" &&
    typeof selectedProject?.apiProjectId === "number" &&
    !selectedProject.serverMissing;
  const hasProjectHomeContext =
    selectedProjectFileCount > 0 ||
    selectedProjectGithubPanelState === "connected" ||
    selectedProjectDescription.length > 0;
  function clearDemoStatusTimeout() {
    if (demoStatusTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(demoStatusTimeoutRef.current);
    demoStatusTimeoutRef.current = null;
  }

  function queueDemoStatusClear() {
    demoStatusTimeoutRef.current = window.setTimeout(() => {
      setDemoStatusState(null);
      demoStatusTimeoutRef.current = null;
    }, 3200);
  }

  function setDemoStatus(nextStatus: DemoStatus | null) {
    clearDemoStatusTimeout();
    setDemoStatusState(nextStatus);

    if (nextStatus) {
      queueDemoStatusClear();
    }
  }

  function applyProjectState(nextState: ProjectState) {
    projectsRef.current = nextState.projects;
    selectedProjectIdRef.current = nextState.selectedProjectId;
    selectedSessionIdRef.current = nextState.selectedSessionId;
    setProjects(nextState.projects);
    setSelectedProjectId(nextState.selectedProjectId);
    setSelectedSessionId(nextState.selectedSessionId);
  }

  async function fetchServerProjects() {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SERVER_SYNC_TIMEOUT_MS);

    try {
      const health = await fetchPaimRootJson<ApiHealthResponse>("/health", {
        signal: controller.signal,
      });

      if (health.status !== "ok") {
        throw new Error("PaiM 서버 상태를 확인할 수 없습니다");
      }

      return fetchPaimJson<ApiProjectResponse[]>("/projects", {
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function syncProjectsWithServer(showResult = false) {
    try {
      const serverProjects = await fetchServerProjects();
      const nextState = createProjectState(
        mergeServerProjects(projectsRef.current, serverProjects),
        selectedProjectIdRef.current,
        selectedSessionIdRef.current,
      );

      applyProjectState(nextState);
      setServerStatus("online");

      if (showResult) {
        setDemoStatus({
          ok: true,
          message: "PaiM 서버와 다시 연결했습니다",
          scope: "overview",
        });
      }
    } catch {
      setServerStatus("offline");

      if (showResult) {
        setDemoStatus({
          ok: false,
          message: "PaiM 서버에 연결할 수 없습니다",
          scope: "overview",
        });
      }
    }
  }

  function showServerOfflineMessage(scope: DemoStatus["scope"] = "overview") {
    setDemoStatus({
      ok: false,
      message: "PaiM 서버에 연결할 수 없습니다 — 마지막 저장 상태를 표시 중",
      scope,
    });
  }

  function shouldSkipServerAction(scope: DemoStatus["scope"] = "overview") {
    if (serverStatus === "online") {
      return false;
    }

    showServerOfflineMessage(scope);
    return true;
  }

  const filteredSelectedProjectGithubRepositories = useMemo(() => {
    const query = githubRepositoryQuery.trim().toLowerCase();

    if (!query) {
      return selectedProjectGithubRepositories;
    }

    return selectedProjectGithubRepositories.filter((repository) =>
      `${repository.fullName} ${repository.name}`.toLowerCase().includes(query),
    );
  }, [githubRepositoryQuery, selectedProjectGithubRepositories]);
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
    "--project-panel-width": `${
      isProjectPanelCollapsed ? COLLAPSED_PROJECT_PANEL_WIDTH : projectPanelWidth
    }px`,
    "--project-file-tree-width": `${
      isProjectFileTreeCollapsed ? COLLAPSED_PROJECT_PANEL_WIDTH : projectFileTreeWidth
    }px`,
  } as CSSProperties;

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (didSyncProjectsRef.current) {
      return;
    }

    didSyncProjectsRef.current = true;
    void syncProjectsWithServer();
  }, []);

  useEffect(() => {
    if (
      serverStatus !== "online" ||
      !selectedProject ||
      selectedProject.serverMissing ||
      typeof selectedProject.apiProjectId !== "number"
    ) {
      return;
    }

    void syncProjectDocuments(selectedProject.id, selectedProject.apiProjectId);
  }, [
    selectedProject?.apiProjectId,
    selectedProject?.id,
    selectedProject?.serverMissing,
    serverStatus,
  ]);

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
      PROJECT_PANEL_COLLAPSED_STORAGE_KEY,
      String(isProjectPanelCollapsed),
    );
  }, [isProjectPanelCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_PANEL_WIDTH_STORAGE_KEY, String(projectPanelWidth));
  }, [projectPanelWidth]);

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
    if (!isProjectPanelResizing) {
      return;
    }

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    function handleMouseMove(event: globalThis.MouseEvent) {
      const deltaX = projectPanelResizeRef.current.startX - event.clientX;
      setProjectPanelWidth(
        clampProjectPanelWidth(projectPanelResizeRef.current.startWidth + deltaX),
      );
    }

    function handleMouseUp() {
      setIsProjectPanelResizing(false);
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
  }, [isProjectPanelResizing]);

  useEffect(() => {
    if (!isProjectFileTreeResizing) {
      return;
    }

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    function handleMouseMove(event: globalThis.MouseEvent) {
      const deltaX = projectFileTreeResizeRef.current.startX - event.clientX;
      setProjectFileTreeWidth(
        clampProjectFileTreeWidth(projectFileTreeResizeRef.current.startWidth + deltaX),
      );
    }

    function handleMouseUp() {
      setIsProjectFileTreeResizing(false);
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
  }, [isProjectFileTreeResizing]);


  useEffect(() => {
    if (!demoStatus) {
      return;
    }

    setStatusRevision((currentRevision) => currentRevision + 1);

    if (demoStatusTimeoutRef.current === null) {
      queueDemoStatusClear();
    }
  }, [demoStatus]);

  useEffect(() => () => clearDemoStatusTimeout(), []);

  useEffect(
    () => () => {
      for (const timeoutId of documentPollTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      documentPollTimeoutsRef.current.clear();
    },
    [],
  );

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
	    setProjectPanelTabs([]);
	    setActiveProjectPanelTabId(null);
	  }, [selectedProjectId]);

  useEffect(() => {
    setPendingDeleteProjectFileId(null);
  }, [projectSourcesMode]);

  useEffect(() => {
    if (canOpenProjectMemory) {
      return;
    }

    setProjectPanelTabs((currentTabs) => {
      if (!currentTabs.some((tab) => tab.view === "memory")) {
        return currentTabs;
      }

      setActiveProjectPanelTabId((currentTabId) => {
        const currentTab = currentTabs.find((tab) => tab.id === currentTabId);

        return currentTab?.view === "memory" ? null : currentTabId;
      });

      return currentTabs.filter((tab) => tab.view !== "memory");
    });
  }, [canOpenProjectMemory]);

  function updateProjectPanelTab(
    tabId: string,
    updater: (tab: ProjectPanelTab) => ProjectPanelTab,
  ) {
    setProjectPanelTabs((currentTabs) =>
      currentTabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    );
  }

  function updateActiveProjectFileTab(updater: (tab: ProjectPanelTab) => ProjectPanelTab) {
    if (!activeProjectFileTab) {
      return;
    }

    updateProjectPanelTab(activeProjectFileTab.id, updater);
  }

  function setProjectFileQuery(action: SetStateAction<string>) {
    updateActiveProjectFileTab((tab) => ({
      ...tab,
      fileQuery: resolveStateAction(action, tab.fileQuery),
    }));
  }

  function setProjectFilePreviewForTab(
    tabId: string,
    action: SetStateAction<ProjectFilePreview | null>,
  ) {
    updateProjectPanelTab(tabId, (tab) => ({
      ...tab,
      filePreview: resolveStateAction(action, tab.filePreview),
    }));
  }

  function setProjectFilePreview(action: SetStateAction<ProjectFilePreview | null>) {
    updateActiveProjectFileTab((tab) => ({
      ...tab,
      filePreview: resolveStateAction(action, tab.filePreview),
    }));
  }

  function setProjectSourcesMode(action: SetStateAction<ProjectSourcesMode>) {
    updateActiveProjectFileTab((tab) => ({
      ...tab,
      projectSourcesMode: resolveStateAction(action, tab.projectSourcesMode),
    }));
  }

  function setSelectedProjectSourceId(action: SetStateAction<string | null>) {
    updateActiveProjectFileTab((tab) => ({
      ...tab,
      selectedProjectSourceId: resolveStateAction(action, tab.selectedProjectSourceId),
    }));
  }

  function setPendingDeleteProjectFileId(action: SetStateAction<string | null>) {
    updateActiveProjectFileTab((tab) => ({
      ...tab,
      pendingDeleteProjectFileId: resolveStateAction(action, tab.pendingDeleteProjectFileId),
    }));
  }

  function updateProject(projectId: string, updater: (project: ProjectWorkspace) => ProjectWorkspace) {
    setProjects((currentProjects) =>
      currentProjects.map((project) => (project.id === projectId ? updater(project) : project)),
    );
  }

  function updateProjectAttachment(
    projectId: string,
    attachmentId: string,
    updater: (attachment: Attachment) => Attachment,
  ) {
    updateProject(projectId, (project) => ({
      ...project,
      files: updateProjectFileEntry(project.files ?? [], attachmentId, updater),
    }));
  }

  function clearDocumentPoll(projectId: string, docId: number) {
    const pollKey = `${projectId}:${docId}`;
    const timeoutId = documentPollTimeoutsRef.current.get(pollKey);

    if (typeof timeoutId === "number") {
      window.clearTimeout(timeoutId);
    }

    documentPollTimeoutsRef.current.delete(pollKey);
  }

  function scheduleDocumentStatusPoll(
    projectId: string,
    apiProjectId: number,
    attachmentId: string,
    docId: number,
    startedAt = Date.now(),
  ) {
    clearDocumentPoll(projectId, docId);

    const pollKey = `${projectId}:${docId}`;
    const timeoutId = window.setTimeout(async () => {
      try {
        const status = await fetchPaimJson<ApiDocumentStatusResponse>(
          `/projects/${apiProjectId}/documents/${docId}/status`,
        );
        const documentStatus = toProjectDocumentStatus(status.status);

        updateProjectAttachment(projectId, attachmentId, (attachment) => ({
          ...attachment,
          docId: status.doc_id,
          documentStatus,
          lastError: status.last_error ?? null,
        }));

        if (isProjectDocumentTerminal(documentStatus)) {
          documentPollTimeoutsRef.current.delete(pollKey);
          return;
        }

        if (Date.now() - startedAt >= DOCUMENT_STATUS_POLL_TIMEOUT_MS) {
          updateProjectAttachment(projectId, attachmentId, (attachment) => ({
            ...attachment,
            documentStatus: "delayed",
            lastError: "처리 지연 — 나중에 다시 확인",
          }));
          documentPollTimeoutsRef.current.delete(pollKey);
          return;
        }

        scheduleDocumentStatusPoll(projectId, apiProjectId, attachmentId, docId, startedAt);
      } catch (error) {
        updateProjectAttachment(projectId, attachmentId, (attachment) => ({
          ...attachment,
          documentStatus: "failed",
          lastError: getErrorMessage(error, "문서 처리 상태를 확인할 수 없습니다"),
        }));
        documentPollTimeoutsRef.current.delete(pollKey);
      }
    }, DOCUMENT_STATUS_POLL_INTERVAL_MS);

    documentPollTimeoutsRef.current.set(pollKey, timeoutId);
  }

  async function syncProjectDocuments(projectId: string, apiProjectId: number) {
    if (serverStatus === "offline") {
      return;
    }

    try {
      const documents = await fetchPaimJson<ApiDocumentListItem[]>(
        `/projects/${apiProjectId}/documents`,
      );

      updateProject(projectId, (project) => ({
        ...project,
        files: mergeServerDocumentsIntoAttachments(project.files ?? [], documents),
      }));
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "서버 문서 목록을 불러올 수 없습니다"),
        scope: "overview",
      });
    }
  }

  // 서버 업로드는 로컬 파일을 base64로 읽어 브라우저 FormData 파일로 감싼다.
  async function readUploadFile(entry: Attachment) {
    const encoded = await invoke<string>("read_file_base64", { path: entry.path });
    const bytes = base64ToBytes(encoded);

    return new File([bytes], entry.name, { type: getUploadMimeType(entry.name) });
  }

  async function uploadProjectDocument(
    projectId: string,
    apiProjectId: number,
    entry: Attachment,
  ) {
    updateProjectAttachment(projectId, entry.id, (attachment) => ({
      ...attachment,
      documentStatus: "uploading",
      lastError: null,
    }));

    try {
      const file = await readUploadFile(entry);
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetchPaimFormData<ApiDocumentUploadResponse>(
        `/projects/${apiProjectId}/documents`,
        formData,
      );
      const documentStatus = toProjectDocumentStatus(response.status);

      updateProjectAttachment(projectId, entry.id, (attachment) => ({
        ...attachment,
        docId: response.doc_id,
        documentStatus,
        lastError: null,
      }));

      if (!isProjectDocumentTerminal(documentStatus)) {
        scheduleDocumentStatusPoll(projectId, apiProjectId, entry.id, response.doc_id);
      }
    } catch (error) {
      updateProjectAttachment(projectId, entry.id, (attachment) => ({
        ...attachment,
        documentStatus: "failed",
        lastError: getErrorMessage(error, "문서를 업로드할 수 없습니다"),
      }));
    }
  }

  // 지원 문서만 서버로 보내고, 그 외 파일은 기존처럼 로컬 참조로 남긴다.
  async function uploadProjectDocuments(
    projectId: string,
    project: ProjectWorkspace,
    entries: Attachment[],
  ) {
    const supportedFiles = collectFileAttachments(entries).filter(
      (entry) =>
        !entry.serverOnly &&
        typeof entry.docId !== "number" &&
        isSupportedProjectDocument(entry.name),
    );

    if (supportedFiles.length === 0) {
      return;
    }

    if (project.serverMissing) {
      setDemoStatus({
        ok: false,
        message: "서버에서 찾을 수 없는 프로젝트에는 문서를 업로드할 수 없습니다",
        scope: "overview",
      });
      return;
    }

    if (shouldSkipServerAction("overview")) {
      return;
    }

    try {
      const apiProject = await ensureApiProject(project);

      if (typeof apiProject.apiProjectId !== "number") {
        throw new Error("서버 프로젝트를 준비할 수 없습니다");
      }

      setDemoStatus({
        ok: true,
        message: `지원 문서 ${supportedFiles.length}개 서버 업로드 중...`,
        scope: "overview",
      });

      for (const entry of supportedFiles) {
        await uploadProjectDocument(projectId, apiProject.apiProjectId, entry);
      }

      setDemoStatus({
        ok: true,
        message: `지원 문서 ${supportedFiles.length}개 서버 업로드 요청 완료`,
        scope: "overview",
      });
      void syncProjectDocuments(projectId, apiProject.apiProjectId);
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "문서를 서버로 업로드할 수 없습니다"),
        scope: "overview",
      });
    }
  }

  // FastAPI의 정수 project_id가 있어야 서버 메모리 API를 조회할 수 있다.
  async function ensureApiProject(project: ProjectWorkspace) {
    if (typeof project.apiProjectId === "number") {
      return project;
    }

    if (serverStatus === "offline") {
      throw new Error("PaiM 서버에 연결할 수 없습니다 — 마지막 저장 상태를 표시 중");
    }

    const createdProject = await fetchPaimJson<ApiProjectCreateResponse>("/projects", {
      method: "POST",
      body: JSON.stringify({ name: project.name || "New Project" }),
    });

    const nextProject = {
      ...project,
      apiProjectId: createdProject.id,
    };

    updateProject(project.id, (currentProject) => ({
      ...currentProject,
      apiProjectId: createdProject.id,
    }));

    return nextProject;
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
    setSelectedSessionId(nextProject.sessions[0]?.id ?? null);
    clearDraft();
  }

  // 새 프로젝트는 먼저 홈에서 자료를 받기 위해 채팅 세션 없이 만든다.
  function createProjectFromName(baseName: string, files: Attachment[] = []) {
    const nextProject = createProject(createUniqueProjectName(projects, baseName), [], files);

    setProjects((currentProjects) => [nextProject, ...currentProjects]);
    setSelectedProjectId(nextProject.id);
    setSelectedSessionId(null);
    setProjectPanelTabs([]);
    setActiveProjectPanelTabId(null);
    clearDraft();
  }

  function handleToggleSidebar() {
    setIsSidebarCollapsed((current) => !current);
    setIsSidebarResizing(false);
  }

  function handleToggleProjectPanel() {
    setIsProjectPanelCollapsed((current) => !current);
    setIsProjectPanelResizing(false);
    setIsProjectFileTreeResizing(false);
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

  function handleProjectPanelResizeStart(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    projectPanelResizeRef.current = {
      startX: event.clientX,
      startWidth: projectPanelWidth,
    };
    setIsProjectPanelResizing(true);
  }

  function handleProjectFileTreeResizeStart(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    projectFileTreeResizeRef.current = {
      startX: event.clientX,
      startWidth: isProjectFileTreeCollapsed
        ? MIN_PROJECT_FILE_TREE_WIDTH
        : projectFileTreeWidth,
    };
    setIsProjectFileTreeCollapsed(false);
    setIsProjectFileTreeResizing(true);
  }

  function toggleProjectSessions(projectId: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setCollapsedProjectIds((currentProjectIds) =>
      currentProjectIds.includes(projectId)
        ? currentProjectIds.filter((currentProjectId) => currentProjectId !== projectId)
        : [...currentProjectIds, projectId],
    );
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

	  // 같은 도구도 새 탭으로 추가한다. 자료 탭은 탭별로 검색/선택/프리뷰 상태를 따로 가진다.
	  function openProjectPanelTool(view: ProjectPanelToolView) {
	    if (view === "memory" && shouldSkipServerAction("overview")) {
	      return;
	    }

	    if (view === "memory" && !canOpenProjectMemory) {
	      return;
	    }

	    const nextTab = createProjectPanelTab(view);

	    setProjectPanelTabs((currentTabs) => [...currentTabs, nextTab]);
	    setActiveProjectPanelTabId(nextTab.id);
	  }

	  // 탭을 닫으면 바로 왼쪽 탭을 우선 활성화하고, 남은 탭이 없으면 메뉴로 돌아간다.
	  function handleCloseProjectPanelTab(tabId: string) {
	    setProjectPanelTabs((currentTabs) => {
	      const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId);
	      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);

	      if (activeProjectPanelTabId === tabId) {
	        const nextActiveTab = nextTabs[Math.max(0, closingIndex - 1)] ?? nextTabs[0] ?? null;
	        setActiveProjectPanelTabId(nextActiveTab?.id ?? null);
	      }

	      return nextTabs;
	    });
	  }

	  // 열린 파일이 있으면 자료 탭 라벨을 파일명으로 압축해서 보여준다.
	  function getProjectPanelTabLabel(tab: ProjectPanelTab) {
	    return tab.view === "files" && tab.filePreview
	      ? tab.filePreview.name
	      : getProjectPanelTitle(tab.view);
	  }

  async function readDirectoryChildren(path: string) {
    const children = await invoke<DirectoryChildEntry[]>("read_directory_children", { path });

    return children.map(createProjectFileEntry);
  }

  async function createProjectDirectoryEntry(path: string, uploadedAt: number): Promise<Attachment> {
    const children = await invoke<DirectoryChildEntry[]>("read_directory_children", { path });
    const nextChildren = await Promise.all(
      children.map((entry) =>
        entry.kind === "directory"
          ? createProjectDirectoryEntry(entry.path, uploadedAt)
          : { ...createProjectFileEntry(entry), uploadedAt },
      ),
    );

    return {
      id: createId("project-file"),
      name: getFileName(path),
      path,
      kind: "directory",
      children: nextChildren,
      childrenLoaded: true,
      isExpanded: true,
      uploadedAt,
    };
  }

  // 프로젝트 자료함에 단일 파일을 트리의 루트 항목으로 추가한다.
  function createProjectFileRootEntry(path: string, uploadedAt: number): Attachment {
    return {
      id: createId("project-file"),
      name: getFileName(path),
      path,
      kind: "file",
      uploadedAt,
    };
  }

  // 프로젝트 자료함에 개별 파일을 루트 자료로 추가한다.
  async function handleOpenProjectFiles(projectId: string) {
    const targetProject = projects.find((project) => project.id === projectId);

    if (!targetProject) {
      return;
    }

    if (!canUseTauriDialog()) {
      setDemoStatus({
        ok: false,
        message: "데스크톱 앱에서 파일을 업로드할 수 있습니다",
        scope: "overview",
      });
      return;
    }

    try {
      const selectedPaths = await open({
        directory: false,
        multiple: true,
        title: "프로젝트 파일 업로드",
      });
      const paths = normalizeDialogPaths(selectedPaths);

      if (paths.length === 0) {
        return;
      }

      const uploadedAt = Date.now();
      const nextEntries = paths.map((path) => createProjectFileRootEntry(path, uploadedAt));

      updateProject(projectId, (project) => ({
        ...project,
        files: [...nextEntries, ...(project.files ?? [])],
      }));
      setSelectedProjectId(projectId);
      setProjectSourcesMode("library");
      void uploadProjectDocuments(projectId, targetProject, nextEntries);
    } catch {
      setDemoStatus({
        ok: false,
        message: "프로젝트 파일을 업로드할 수 없습니다",
        scope: "overview",
      });
    }
  }

  // 프로젝트 자료함은 폴더를 루트로 받아 트리로 보여준다.
  async function handleOpenProjectDirectory(projectId: string) {
    const targetProject = projects.find((project) => project.id === projectId);

    if (!targetProject) {
      return;
    }

    if (!canUseTauriDialog()) {
      setDemoStatus({
        ok: false,
        message: "데스크톱 앱에서 폴더를 업로드할 수 있습니다",
        scope: "overview",
      });
      return;
    }

    try {
      const selectedPaths = await open({
        directory: true,
        multiple: true,
        title: "프로젝트 폴더 업로드",
      });
      const paths = normalizeDialogPaths(selectedPaths);

      if (paths.length === 0) {
        return;
      }

      const uploadedAt = Date.now();
      const nextEntries = await Promise.all(
        paths.map((path) => createProjectDirectoryEntry(path, uploadedAt)),
      );

      updateProject(projectId, (project) => ({
        ...project,
        files: [...nextEntries, ...(project.files ?? [])],
      }));
      setSelectedProjectId(projectId);
      setProjectSourcesMode("library");
      void uploadProjectDocuments(projectId, targetProject, nextEntries);
    } catch {
      setDemoStatus({
        ok: false,
        message: "프로젝트 폴더를 업로드할 수 없습니다",
        scope: "overview",
      });
    }
  }

  async function handleToggleProjectFileEntry(projectId: string, entry: Attachment) {
    if (entry.kind !== "directory") {
      return;
    }

    if (entry.childrenLoaded) {
      updateProject(projectId, (project) => ({
        ...project,
        files: updateProjectFileEntry(project.files ?? [], entry.id, (currentEntry) => ({
          ...currentEntry,
          isExpanded: !currentEntry.isExpanded,
        })),
      }));
      return;
    }

    try {
      const children = await readDirectoryChildren(entry.path);

      updateProject(projectId, (project) => ({
        ...project,
        files: updateProjectFileEntry(project.files ?? [], entry.id, (currentEntry) => ({
          ...currentEntry,
          children,
          childrenLoaded: true,
          isExpanded: true,
        })),
      }));
    } catch {
      setDemoStatus({
        ok: false,
        message: "하위 폴더를 읽을 수 없습니다",
        scope: "overview",
      });
    }
  }

  // 파일 트리에서 선택한 텍스트 파일을 왼쪽 프리뷰 영역에 읽기 전용으로 표시한다.
  async function handleSelectProjectFile(entry: Attachment) {
    if (entry.kind === "directory") {
      return;
    }
    const targetTabId = activeProjectFileTab?.id;

    if (!targetTabId) {
      return;
    }

    const nextPreview = {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      content: "",
      isLoading: true,
    };

    setProjectFilePreviewForTab(targetTabId, nextPreview);

    if (entry.serverOnly) {
      setProjectFilePreviewForTab(targetTabId, {
        ...nextPreview,
        isLoading: false,
        error: "서버 문서는 로컬 경로가 없어 미리볼 수 없습니다",
      });
      return;
    }

    try {
      const content = await invoke<string>("read_text_file", { path: entry.path });

      setProjectFilePreviewForTab(targetTabId, (currentPreview) =>
        currentPreview?.id === entry.id
          ? { ...nextPreview, content, isLoading: false }
          : currentPreview,
      );
    } catch (error) {
      setProjectFilePreviewForTab(targetTabId, (currentPreview) =>
        currentPreview?.id === entry.id
          ? {
              ...nextPreview,
              isLoading: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : currentPreview,
      );
    }
  }

  // 파일 패널에서 선택한 항목을 트리에서 제거한다.
  async function handleDeleteProjectFile(projectId: string, attachment: Attachment) {
    const targetProject = projects.find((project) => project.id === projectId);
    const linkedDocIds = Array.from(getAttachmentDocIds([attachment]));

    if (!targetProject) {
      return;
    }

    if (linkedDocIds.length > 0) {
      if (shouldSkipServerAction("overview")) {
        return;
      }

      if (targetProject.serverMissing || typeof targetProject.apiProjectId !== "number") {
        setDemoStatus({
          ok: false,
          message: "서버 문서 삭제에 필요한 프로젝트 정보를 찾을 수 없습니다",
          scope: "overview",
        });
        return;
      }

      for (const docId of linkedDocIds) {
        try {
          await fetchPaimJson<void>(
            `/projects/${targetProject.apiProjectId}/documents/${docId}`,
            { method: "DELETE" },
          );
        } catch (error) {
          const message = getErrorMessage(error, "서버 문서를 삭제할 수 없습니다");

          if (!/document not found/i.test(message)) {
            setDemoStatus({
              ok: false,
              message,
              scope: "overview",
            });
            return;
          }
        }

        clearDocumentPoll(projectId, docId);
      }
    }

    setProjectPanelTabs((currentTabs) =>
      currentTabs.map((tab) => {
        if (tab.view !== "files") {
          return tab;
        }

        const isSelectedSource = tab.selectedProjectSourceId === attachment.id;

        return {
          ...tab,
          filePreview: tab.filePreview?.id === attachment.id ? null : tab.filePreview,
          pendingDeleteProjectFileId: null,
          projectSourcesMode: isSelectedSource ? "library" : tab.projectSourcesMode,
          selectedProjectSourceId: isSelectedSource ? null : tab.selectedProjectSourceId,
        };
      }),
    );

    updateProject(projectId, (project) => ({
      ...project,
      files: deleteProjectFileEntry(project.files ?? [], attachment.id),
    }));
  }

  // 실수 클릭을 막기 위해 파일 삭제는 같은 항목을 두 번 눌러야 실행한다.
  function handleRequestDeleteProjectFile(projectId: string, attachment: Attachment) {
    if (pendingDeleteProjectFileId !== attachment.id) {
      setPendingDeleteProjectFileId(attachment.id);
      return;
    }

    void handleDeleteProjectFile(projectId, attachment);
  }

	  // 자료 카드 선택은 해당 자료 하나만 트리 루트로 보여주고, 파일이면 바로 미리보기를 연다.
	  function handleOpenProjectSource(source: Attachment) {
	    setProjectFileQuery("");
	    setSelectedProjectSourceId(source.id);
	    setPendingDeleteProjectFileId(null);
	    setProjectSourcesMode("tree");

	    if (source.kind === "file") {
	      void handleSelectProjectFile(source);
	      return;
	    }

	    setProjectFilePreview(null);
	  }

  async function handleStartGithubLogin(projectId: string) {
    if (isGithubAuthStarting) {
      return;
    }

    setSelectedProjectId(projectId);
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
      await openExternalUrl(session.verificationUri);
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

  async function handleStartGithubPrivateLogin(projectId: string) {
    if (isGithubAuthStarting) {
      return;
    }

    if (shouldSkipServerAction("github")) {
      return;
    }

    setSelectedProjectId(projectId);
    setGithubRepositoryQuery("");
    setIsGithubAuthStarting(true);
    setDemoStatus({
      ok: true,
      message: "Private repo 연결 준비 중...",
      scope: "github",
    });

    try {
      const appSession = await createGithubAppSession();

      if (!appSession.state || !appSession.installUrl) {
        throw new Error("GitHub App 설치를 시작할 수 없습니다");
      }

      const session: GithubLoginSessionState = {
        state: appSession.state,
        verificationUri: appSession.installUrl,
        interval: 5,
        status: "pending",
      };

      setGithubLoginSessions((currentSessions) => ({
        ...currentSessions,
        [projectId]: session,
      }));
      await openExternalUrl(session.verificationUri);
      setDemoStatus({
        ok: true,
        message: "GitHub App 설치 화면을 열었습니다",
        scope: "github",
      });
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "Private repo 연결은 PaiM backend가 켜져 있어야 합니다"),
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

    if (session.state && shouldSkipServerAction("github")) {
      return;
    }

    setIsGithubAuthChecking(true);

    try {
      if (session.state) {
        const appSession = await fetchGithubAppSession(session.state);

        if (appSession.status !== "connected") {
          setDemoStatus({
            ok: false,
            message: "아직 GitHub App 설치가 완료되지 않았습니다",
            scope: "github",
          });
          return;
        }

        const response = await fetchGithubAppRepositories(session.state);
        const nextSession: GithubLoginSessionState = {
          ...session,
          status: "connected",
          user: response.user ?? getGithubRepositoryOwner(response.repositories) ?? session.user,
        };

        setGithubLoginSessions((currentSessions) => ({
          ...currentSessions,
          [projectId]: nextSession,
        }));
        setGithubRepositories((currentRepositories) => ({
          ...currentRepositories,
          [projectId]: response.repositories,
        }));
        setDemoStatus({
          ok: true,
          message: getGithubRepositoryLoadMessage(response.repositories),
          scope: "github",
        });
        return;
      }

      if (!session.deviceCode) {
        throw new Error("GitHub 인증 세션을 찾을 수 없습니다");
      }

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

      const [repositories, user] = await Promise.all([
        fetchGithubRepositories(tokenResponse.access_token),
        fetchGithubUserProfile(tokenResponse.access_token),
      ]);
      const nextSession: GithubLoginSessionState = {
        ...session,
        accessToken: tokenResponse.access_token,
        scope: tokenResponse.scope,
        tokenType: tokenResponse.token_type,
        status: "connected",
        user,
      };

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
        message: getGithubRepositoryLoadMessage(repositories.repositories),
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

  async function handleOpenGithubVerification(projectId: string) {
    const session = githubLoginSessions[projectId];

    if (!session) {
      return;
    }

    try {
      await openExternalUrl(session.verificationUri);
    } catch {
      setDemoStatus({
        ok: false,
        message: "GitHub 인증 페이지를 열 수 없습니다",
        scope: "github",
      });
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

    if ((!session?.accessToken && !session?.state) || isGithubRepoLoading) {
      return;
    }

    if (session.state && shouldSkipServerAction("github")) {
      return;
    }

    setIsGithubRepoLoading(true);

    try {
      if (session.state) {
        const response = await fetchGithubAppRepositories(session.state);
        const appUser = response.user ?? getGithubRepositoryOwner(response.repositories);

        setGithubRepositories((currentRepositories) => ({
          ...currentRepositories,
          [projectId]: response.repositories,
        }));
        if (appUser && !session.user) {
          setGithubLoginSessions((currentSessions) => ({
            ...currentSessions,
            [projectId]: {
              ...session,
              user: appUser,
            },
          }));
        }
        setDemoStatus({
          ok: true,
          message: getGithubRepositoryLoadMessage(response.repositories),
          scope: "github",
        });
        return;
      }

      if (!session.accessToken) {
        throw new Error("GitHub 인증 세션을 찾을 수 없습니다");
      }

      const response = await fetchGithubRepositories(session.accessToken);

      setGithubRepositories((currentRepositories) => ({
        ...currentRepositories,
        [projectId]: response.repositories,
      }));
      setDemoStatus({
        ok: true,
        message: getGithubRepositoryLoadMessage(response.repositories),
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
    const session = githubLoginSessions[projectId] ?? null;

    if (!trimmedRepositoryUrl || isGithubConnecting) {
      return;
    }

    if (session?.state && shouldSkipServerAction("github")) {
      return;
    }

    setSelectedProjectId(projectId);
    setIsGithubConnecting(true);
    setDemoStatus({
      ok: true,
      message: "GitHub repo 연결 중...",
      scope: "github",
    });

    try {
      const { events, repository } = session?.state
        ? await fetchGithubAppRepositoryPreview(trimmedRepositoryUrl, session.state)
        : await fetchGithubRepository(trimmedRepositoryUrl, session?.accessToken ?? null);

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

    if (shouldSkipServerAction("github")) {
      return;
    }

    setIsGithubSyncing(true);
    setDemoStatus({
      ok: true,
      message: "GitHub repo 서버 동기화 중...",
      scope: "github",
    });

    try {
      // TODO: POST /api/v1/projects/{id}/repositories 흐름으로 재작성 예정 (API 협의 쟁점 4)
      await fetchPaimRootJson("/github/sync", {
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

	  // 히스토리에서 채팅 세션을 제거하고 마지막 세션이면 빈 채팅으로 남긴다.
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
	    const nextSessions = remainingSessions.length > 0 ? remainingSessions : [createEmptySession()];
    const shouldMoveSelection =
      selectedProjectId === projectId &&
      (sessionId === selectedSessionId ||
        !nextSessions.some((session) => session.id === selectedSessionId));

    updateProject(projectId, (project) => ({
      ...project,
      sessions: nextSessions,
    }));

    if (shouldMoveSelection) {
      setSelectedSessionId(nextSessions[0]?.id ?? null);
      setIsSending(false);
      clearDraft();
    }

    setOpenActionMenu(null);

    focusPrompt();
  }

  async function handleStartProjectBriefing(project: ProjectWorkspace, projectFiles: Attachment[]) {
    const description = project.description?.trim();
    const githubName = project.githubRepository?.remoteRepo ?? project.githubRepository?.name;
    let briefingProject = project;

    if (projectFiles.length === 0 && !description && !githubName) {
      setDemoStatus({
        ok: false,
        message: "프로젝트 설명, 파일, 폴더, GitHub 중 하나를 먼저 추가해 주세요",
        scope: "overview",
      });
      return;
    }

    try {
      briefingProject = await ensureApiProject(project);
    } catch (error) {
      setDemoStatus({
        ok: false,
        message: getErrorMessage(error, "FastAPI 프로젝트를 만들 수 없어 서버 메모리는 비활성화됩니다"),
        scope: "overview",
      });
    }

    const nextSession: ChatSession = {
      ...createEmptySession(),
      title: "Project Briefing",
      messages: [],
    };

    updateProject(project.id, (currentProject) => ({
      ...currentProject,
      sessions: [nextSession, ...currentProject.sessions],
    }));
    setSelectedProjectId(project.id);
    setSelectedSessionId(nextSession.id);
    setIsSending(true);
    clearDraft();

    await wait(DEMO_REPLY_DELAY_MS * 2);

    updateSessionInProject(project.id, nextSession.id, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id: createId("assistant"),
          role: "assistant",
          content: createProjectBriefingReply(briefingProject, projectFiles),
        },
      ],
    }));
    setIsSending(false);
    focusPrompt();
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
      setSelectedSessionId(remainingProjects[0].sessions[0]?.id ?? null);
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
      data-platform={isWindows ? "windows" : isMac ? "macos" : "native"}
      data-project-panel={selectedProject ? "true" : "false"}
      data-project-panel-collapsed={isProjectPanelCollapsed}
      data-project-panel-maximized={isProjectPanelMaximized}
      data-project-panel-resizing={isProjectPanelResizing}
      data-project-file-tree-resizing={isProjectFileTreeResizing}
      data-sidebar-collapsed={isSidebarCollapsed}
      data-sidebar-resizing={isSidebarResizing}
      onClick={() => setOpenActionMenu(null)}
      style={appShellStyle}
    >
      {isWindows ? <WindowsTitlebar /> : null}
      {serverStatus === "offline" ? (
        <div className="server-offline-banner" role="status">
          <span>PaiM 서버에 연결할 수 없습니다 — 마지막 저장 상태를 표시 중</span>
          <button onClick={() => void syncProjectsWithServer(true)} type="button">
            다시 연결
          </button>
        </div>
      ) : null}
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
          <button
            className="project-create-trigger"
            onClick={() => createProjectFromName(createNextProjectName(projects))}
            title="새 프로젝트"
            type="button"
          >
            <FolderPlus size={18} />
            <span>New Project</span>
          </button>
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

      <main
        className="chat"
        data-empty-chat={selectedSession?.messages.length === 0 ? "true" : undefined}
      >
        {selectedSession ? (
          <>
            {selectedSession.messages.length === 0 ? (
              <div className="chat-empty">
                <h1>
                  <span className="chat-empty-project-name">{selectedProject?.name ?? "PaiM"}</span>
                  에서 무엇을 도와드릴까요?
                </h1>
              </div>
            ) : (
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
            )}

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
          <section className="project-home" aria-label="프로젝트 시작 화면">
            <div className="project-home-content">
              <div className="project-home-name-row">
                <input
                  aria-label="프로젝트 이름"
                  className="project-home-name"
                  onBlur={(event) => {
                    const nextName =
                      event.currentTarget.value.trim() ||
                      createNextProjectName(
                        projects.filter((project) => project.id !== selectedProject.id),
                      );

                    if (nextName !== selectedProject.name) {
                      updateProject(selectedProject.id, (project) => ({
                        ...project,
                        name: nextName,
                      }));
                    }
                  }}
	                  onChange={(event) => {
	                    const nextName = event.currentTarget.value;

	                    updateProject(selectedProject.id, (project) => ({
	                      ...project,
	                      name: nextName,
	                    }));
	                  }}
	                  data-default-name={isSelectedProjectDefaultName ? "true" : undefined}
	                  placeholder="New Project 1"
	                  value={selectedProject.name}
	                />
	                <Pencil aria-hidden="true" className="project-home-name-edit" size={16} />
	              </div>
              <textarea
                aria-label="프로젝트 설명"
                className="project-home-description"
                onChange={(event) => {
                  const nextDescription = event.currentTarget.value;

                  updateProject(selectedProject.id, (project) => ({
                    ...project,
                    description: nextDescription,
                  }));
                }}
                placeholder="프로젝트 설명을 적어두면 PaiM이 맥락을 잡는 데 도움이 됩니다."
                rows={2}
                value={selectedProject.description ?? ""}
              />
              {selectedProject.serverMissing ? (
                <p className="runtime-status project-home-status" data-ok="false" role="status">
                  서버에서 찾을 수 없어 로컬 캐시를 표시 중
                </p>
              ) : null}
	              <div className="project-home-divider" />

              <div className="project-home-section-title">시작하기</div>
              <div className="project-home-upload-list">
                <div className="project-home-upload-card" data-ready={selectedProjectRootFileCount > 0}>
                  <span className="project-home-upload-state">
                    {selectedProjectRootFileCount > 0 ? "완료" : "파일"}
                  </span>
                  <Files size={18} />
                  <span className="project-home-upload-copy">
                    <strong>프로젝트 관련 파일 업로드</strong>
                    <small>PDF, PPT, README, 회의록 같은 자료를 한 번에 추가하세요</small>
                  </span>
                  <span className="project-home-upload-actions">
                    <button onClick={() => void handleOpenProjectFiles(selectedProject.id)} type="button">
                      {selectedProjectRootFileCount > 0 ? "추가" : "파일 선택"}
                    </button>
                    {selectedProjectFileCount > 0 ? (
                      <button
                        onClick={() => {
                          setIsProjectPanelCollapsed(false);
                          openProjectPanelTool("files");
                        }}
                        type="button"
                      >
                        자료 수정
                      </button>
                    ) : null}
                  </span>
                </div>
                <div className="project-home-upload-card" data-ready={selectedProjectFolderCount > 0}>
                  <span className="project-home-upload-state">
                    {selectedProjectFolderCount > 0 ? "완료" : "폴더"}
                  </span>
                  <FolderOpen size={18} />
                  <span className="project-home-upload-copy">
                    <strong>프로젝트 폴더 업로드</strong>
                    <small>소스 폴더나 문서 폴더를 통째로 추가하세요</small>
                  </span>
                  <span className="project-home-upload-actions">
                    <button
                      onClick={() => void handleOpenProjectDirectory(selectedProject.id)}
                      type="button"
                    >
                      {selectedProjectFolderCount > 0 ? "추가" : "폴더 선택"}
                    </button>
                    {selectedProjectFileCount > 0 ? (
                      <button
                        onClick={() => {
                          setIsProjectPanelCollapsed(false);
                          openProjectPanelTool("files");
                        }}
                        type="button"
                      >
                        자료 수정
                      </button>
                    ) : null}
                  </span>
                </div>
                <div
                  className="project-home-upload-card"
                  data-ready={selectedProjectGithubPanelState === "connected"}
                >
                  <span className="project-home-upload-state">
                    {selectedProjectGithubPanelState === "connected" ? "완료" : "GitHub"}
                  </span>
                  <GitBranch size={18} />
                  <span className="project-home-upload-copy">
                    <strong>GitHub 저장소 연결</strong>
                    <small>지금 연결하거나 나중에 프로젝트 패널에서 연결할 수 있습니다</small>
                  </span>
                  <span className="project-home-upload-actions">
                    <button
                      onClick={() => {
                        setIsProjectPanelCollapsed(false);
                        openProjectPanelTool("github");
                      }}
                      type="button"
                    >
                      {getGithubPanelStateLabel(selectedProjectGithubPanelState)}
                    </button>
                  </span>
                </div>
              </div>

              <div className="project-home-spacer" />

              {demoStatus && demoStatus.scope !== "github" ? (
                <p
                  className="runtime-status project-home-status"
                  data-ok={demoStatus.ok}
                  key={statusRevision}
                  role="status"
                >
                  {demoStatus.message}
                </p>
              ) : null}

              <p className="project-home-note">
                분석을 시작하면 PaiM이 입력한 설명과 연결된 자료를 읽고 브리핑을 만든 뒤 채팅으로 이어집니다.
              </p>
              <div className="project-home-actions">
                <button
                  className="project-home-primary"
                  disabled={!hasProjectHomeContext || isSending}
                  onClick={() =>
                    void handleStartProjectBriefing(selectedProject, selectedProjectAttachments)
                  }
                  type="button"
                >
                  <Brain size={16} />
                  <span>{isSending ? "분석 중" : "분석 시작"}</span>
                </button>
                <button
                  className="project-home-secondary"
                  onClick={() => handleCreateChatInProject(selectedProject.id)}
                  type="button"
                >
                  <MessageSquare size={16} />
                  <span>분석 없이 채팅 시작하기</span>
                </button>
              </div>
            </div>
          </section>
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
                onClick={() => createProjectFromName(createNextProjectName(projects))}
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

      {selectedProject ? (
        <aside
          className="project-panel"
          data-collapsed={isProjectPanelCollapsed}
          data-view={projectPanelView}
          aria-label="프로젝트 보조 패널"
        >
          {isProjectPanelCollapsed ? (
            <button
              aria-label="프로젝트 패널 펼치기"
              className="project-panel-rail-toggle"
              onClick={handleToggleProjectPanel}
              title="프로젝트 패널 펼치기"
              type="button"
            >
              <PanelRight size={17} />
            </button>
          ) : (
            <>
          <div
            aria-label="프로젝트 패널 크기 조절"
            aria-orientation="vertical"
            aria-valuemax={MAX_PROJECT_PANEL_WIDTH}
            aria-valuemin={MIN_PROJECT_PANEL_WIDTH}
            aria-valuenow={projectPanelWidth}
            className="project-panel-resize-handle"
            onMouseDown={handleProjectPanelResizeStart}
            role="separator"
          />
	          <div className="project-panel-topbar">
	            {projectPanelView === "menu" ? (
	              <span className="project-panel-kicker">도구 선택</span>
	            ) : (
	              <div className="project-panel-tabs">
	                {projectPanelTabs.map((tab) => {
	                  const tabLabel = getProjectPanelTabLabel(tab);
	                  const { Icon, color } = getProjectPanelTabVisualMeta(
	                    tab.view,
	                    tab.view === "files" ? tab.filePreview : null,
	                  );

	                  return (
	                    <div
	                      aria-label={`${tabLabel} 탭`}
	                      className="project-panel-tab"
	                      data-active={activeProjectPanelTabId === tab.id ? "true" : undefined}
	                      key={tab.id}
	                      onClick={() => setActiveProjectPanelTabId(tab.id)}
	                      onKeyDown={(event) => {
	                        if (event.key === "Enter" || event.key === " ") {
	                          event.preventDefault();
	                          setActiveProjectPanelTabId(tab.id);
	                        }
	                      }}
	                      role="tab"
	                      tabIndex={0}
	                      title={tabLabel}
	                    >
	                      <Icon size={16} style={{ color }} />
	                      <span>{tabLabel}</span>
	                      <button
	                        aria-label={`${tabLabel} 탭 닫기`}
	                        className="project-panel-tab-close"
	                        onClick={(event) => {
	                          event.stopPropagation();
	                          handleCloseProjectPanelTab(tab.id);
	                        }}
	                        title={`${tabLabel} 탭 닫기`}
	                        type="button"
	                      >
	                        <X size={13} />
	                      </button>
	                    </div>
	                  );
	                })}
	                <details className="project-panel-tab-add">
	                  <summary aria-label="패널 탭 추가" title="패널 탭 추가">
	                    <Plus size={18} />
	                  </summary>
	                  <div className="project-panel-tab-menu">
		                    {PROJECT_PANEL_TOOL_VIEWS
		                      .filter((view) => view !== "memory" || canOpenProjectMemory)
		                      .map((view) => (
		                        <button
		                          key={view}
		                          onClick={(event) => {
		                            event.currentTarget.closest("details")?.removeAttribute("open");
		                            openProjectPanelTool(view);
		                          }}
		                          type="button"
		                        >
		                          {getProjectPanelTitle(view)}
		                        </button>
		                      ))}
	                  </div>
	                </details>
	              </div>
	            )}
            <div className="project-panel-topbar-actions">
              {projectPanelView !== "menu" ? (
                <button
                  aria-label={`${getProjectPanelTitle(projectPanelView)} 패널 ${
                    isProjectPanelMaximized ? "축소" : "최대화"
                  }`}
                  className="project-panel-toggle"
                  onClick={() => setIsProjectPanelMaximized((current) => !current)}
                  title={`${getProjectPanelTitle(projectPanelView)} 패널 ${
                    isProjectPanelMaximized ? "축소" : "최대화"
                  }`}
                  type="button"
                >
                  {isProjectPanelMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
              ) : null}
              <button
                aria-label="프로젝트 패널 접기"
                className="project-panel-toggle"
                onClick={handleToggleProjectPanel}
                title="프로젝트 패널 접기"
                type="button"
              >
                <PanelRight size={16} />
              </button>
            </div>
          </div>

          {projectPanelView === "menu" ? (
	            <div className="project-panel-menu" role="list">
	              {canOpenProjectMemory ? (
	                <button onClick={() => openProjectPanelTool("memory")} role="listitem" type="button">
	                  <span>
	                    <Brain size={18} />
	                    <span>
	                      <strong>메모리</strong>
	                      <small>결정·액션·이슈·리스크</small>
	                    </span>
	                  </span>
	                  <ChevronRight size={16} />
	                </button>
	              ) : null}
		              <button
		                onClick={() => openProjectPanelTool("files")}
                role="listitem"
                type="button"
              >
                <span>
                  <Files size={18} />
                  <span>
                    <strong>자료</strong>
                    <small>{selectedProjectAttachments.length}개 소스</small>
                  </span>
                </span>
                <ChevronRight size={16} />
              </button>
	              <button onClick={() => openProjectPanelTool("github")} role="listitem" type="button">
                <span>
                  <GitBranch size={18} />
                  <span>
                    <strong>GitHub</strong>
                    <small>{getGithubPanelStateLabel(selectedProjectGithubPanelState)}</small>
                  </span>
                </span>
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}

          {projectPanelView === "memory" ? (
            <ProjectMemoryPanel
              isMaximized={isProjectPanelMaximized}
              project={selectedProject}
            />
          ) : null}

          {projectPanelView === "files" ? (
            <ProjectFilesPanel
              attachments={selectedProjectAttachments}
              demoStatus={demoStatus}
              filteredTreeFiles={filteredSelectedProjectTreeFiles}
              groupedFiles={groupedSelectedProjectFiles}
              isSelectedSourceFile={isSelectedProjectSourceFile}
              isTreeCollapsed={isProjectFileTreeCollapsed}
              mode={projectSourcesMode}
              onBackToLibrary={() => {
                setProjectFilePreview(null);
                setSelectedProjectSourceId(null);
                setProjectSourcesMode("library");
              }}
              onOpenDirectory={() => void handleOpenProjectDirectory(selectedProject.id)}
              onOpenFiles={() => void handleOpenProjectFiles(selectedProject.id)}
              onOpenSource={handleOpenProjectSource}
              onQueryChange={setProjectFileQuery}
              onRequestDelete={(entry) => handleRequestDeleteProjectFile(selectedProject.id, entry)}
              onSelectFile={(entry) => void handleSelectProjectFile(entry)}
              onToggleFile={(entry) => void handleToggleProjectFileEntry(selectedProject.id, entry)}
              onToggleTreeCollapsed={() => setIsProjectFileTreeCollapsed((current) => !current)}
              onTreeResizeStart={handleProjectFileTreeResizeStart}
              pendingDeleteEntryId={pendingDeleteProjectFileId}
              preview={projectFilePreview}
              query={projectFileQuery}
              statusRevision={statusRevision}
              treeAttachments={selectedProjectTreeAttachments}
              treeFileCount={selectedProjectTreeFileCount}
              treeWidth={projectFileTreeWidth}
            />
          ) : null}

          {projectPanelView === "github" ? (
            <GithubPanel
              demoStatus={demoStatus}
              events={selectedProjectGithubEvents}
              filteredRepositories={filteredSelectedProjectGithubRepositories}
              githubConnected={selectedProject.githubConnected}
              isAuthChecking={isGithubAuthChecking}
              isAuthStarting={isGithubAuthStarting}
              isConnecting={isGithubConnecting}
              isRepoLoading={isGithubRepoLoading}
              isSyncing={isGithubSyncing}
              onCheckLogin={() => void handleCheckGithubLogin(selectedProject.id)}
              onConnectRepository={(repositoryUrl) =>
                void connectGithubRepository(selectedProject.id, repositoryUrl)
              }
              onDisconnect={(message) => handleDisconnectGithub(selectedProject.id, message)}
              onLoadRepositories={() => void handleLoadGithubRepositories(selectedProject.id)}
              onOpenVerification={() => void handleOpenGithubVerification(selectedProject.id)}
              onQueryChange={setGithubRepositoryQuery}
              onResetLogin={() => handleResetGithubLogin(selectedProject.id)}
              onStartLogin={() => void handleStartGithubLogin(selectedProject.id)}
              onStartPrivateLogin={() => void handleStartGithubPrivateLogin(selectedProject.id)}
              onSyncRepository={() => void handleSyncGithubRepository(selectedProject.id)}
              panelState={selectedProjectGithubPanelState}
              repositories={selectedProjectGithubRepositories}
              repository={selectedProject.githubRepository}
              repositoryQuery={githubRepositoryQuery}
              session={selectedProjectGithubSession}
              statusRevision={statusRevision}
            />
          ) : null}
            </>
          )}
        </aside>
      ) : null}
    </div>
  );
}
