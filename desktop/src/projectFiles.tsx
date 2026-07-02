import {
  Braces,
  Check,
  ChevronRight,
  CodeXml,
  Database,
  Ellipsis,
  FileCode2,
  FileIcon,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Image,
  Lock,
  Music,
  NotebookTabs,
  Search,
  Settings,
  Sparkles,
  Table,
  Terminal,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";

import type {
  Attachment,
  DemoStatus,
  DirectoryChildEntry,
  ProjectFilePreview,
  ProjectSourcesMode,
} from "./types";

export const DEFAULT_PROJECT_FILE_TREE_WIDTH = 300;
export const MIN_PROJECT_FILE_TREE_WIDTH = 220;
export const MAX_PROJECT_FILE_TREE_WIDTH = 520;

export type ProjectFileVisualMeta = {
  Icon: LucideIcon;
  color: string;
  muted?: boolean;
};

type ProjectFileTreeProps = {
  entries: Attachment[];
  level?: number;
  onDelete: (entry: Attachment) => void;
  onSelect: (entry: Attachment) => void;
  onToggle: (entry: Attachment) => void;
  pendingDeleteEntryId?: string | null;
  selectedEntryId?: string;
};

type ProjectFileGroup = {
  label: string;
  sources: Attachment[];
};

type ProjectFilesPanelProps = {
  attachments: Attachment[];
  demoStatus: DemoStatus | null;
  filteredTreeFiles: Attachment[];
  groupedFiles: ProjectFileGroup[];
  isSelectedSourceFile: boolean;
  isTreeCollapsed: boolean;
  mode: ProjectSourcesMode;
  onBackToLibrary: () => void;
  onOpenDirectory: () => void;
  onOpenFiles: () => void;
  onOpenSource: (source: Attachment) => void;
  onQueryChange: (query: string) => void;
  onRequestDelete: (source: Attachment) => void;
  onSelectFile: (entry: Attachment) => void;
  onToggleFile: (entry: Attachment) => void;
  onToggleTreeCollapsed: () => void;
  onTreeResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  pendingDeleteEntryId: string | null;
  preview: ProjectFilePreview | null;
  query: string;
  statusRevision: number;
  treeAttachments: Attachment[];
  treeFileCount: number;
  treeWidth: number;
};

export function clampProjectFileTreeWidth(width: number) {
  return Math.min(
    MAX_PROJECT_FILE_TREE_WIDTH,
    Math.max(MIN_PROJECT_FILE_TREE_WIDTH, width),
  );
}

export function countProjectFileEntries(entries: Attachment[]): number {
  return entries.reduce(
    (count, entry) => count + 1 + countProjectFileEntries(entry.children ?? []),
    0,
  );
}

function getProjectFileRootLabel(entries: Attachment[]) {
  if (entries.length === 0) {
    return "/";
  }

  return entries.length === 1 ? entries[0].name : `${entries.length} roots`;
}

function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}

function getProjectSourceTimeLabel(source: Attachment) {
  if (!source.uploadedAt) {
    return "이전";
  }

  const date = new Date(source.uploadedAt);
  return `${date.getFullYear()}.${padTimePart(date.getMonth() + 1)}.${padTimePart(date.getDate())}`;
}

export function sortProjectSourcesByUploadedAt(sources: Attachment[]) {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((left, right) => (right.source.uploadedAt ?? 0) - (left.source.uploadedAt ?? 0) || left.index - right.index)
    .map(({ source }) => source);
}

export function groupProjectSourcesByUploadedDate(sources: Attachment[]) {
  return sources.reduce<ProjectFileGroup[]>((groups, source) => {
    const label = getProjectSourceTimeLabel(source);
    const currentGroup = groups[groups.length - 1];

    if (currentGroup?.label === label) {
      currentGroup.sources.push(source);
    } else {
      groups.push({ label, sources: [source] });
    }

    return groups;
  }, []);
}

export function createProjectFileEntry(entry: DirectoryChildEntry): Attachment {
  return {
    id: `project-file-${crypto.randomUUID()}`,
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    children: entry.kind === "directory" ? [] : undefined,
    childrenLoaded: false,
    isExpanded: false,
  };
}

export function updateProjectFileEntry(
  entries: Attachment[],
  entryId: string,
  updater: (entry: Attachment) => Attachment,
): Attachment[] {
  return entries.map((entry) => {
    if (entry.id === entryId) {
      return updater(entry);
    }

    if (!entry.children) {
      return entry;
    }

    return {
      ...entry,
      children: updateProjectFileEntry(entry.children, entryId, updater),
    };
  });
}

export function deleteProjectFileEntry(entries: Attachment[], entryId: string): Attachment[] {
  return entries
    .filter((entry) => entry.id !== entryId)
    .map((entry) => ({
      ...entry,
      children: entry.children ? deleteProjectFileEntry(entry.children, entryId) : undefined,
    }));
}

export function filterProjectFileEntries(entries: Attachment[], query: string): Attachment[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return entries;
  }

  return entries.flatMap((entry) => {
    const filteredChildren = filterProjectFileEntries(entry.children ?? [], normalizedQuery);
    const matches =
      entry.name.toLowerCase().includes(normalizedQuery) ||
      entry.path.toLowerCase().includes(normalizedQuery);

    return matches || filteredChildren.length > 0
      ? [{ ...entry, children: filteredChildren, isExpanded: true }]
      : [];
  });
}

// 파일명과 확장자로 파일 트리 아이콘 톤을 정한다.
export function getProjectFileVisualMeta(name: string): ProjectFileVisualMeta {
  const lowerName = name.toLowerCase();

  if (lowerName === ".gitignore" || lowerName === ".gitattributes") {
    return { Icon: GitBranch, color: "#f05033" };
  }

  if (lowerName === ".ds_store") {
    return { Icon: FileIcon, color: "var(--faint)", muted: true };
  }

  if (lowerName === ".env" || lowerName.startsWith(".env")) {
    return { Icon: Settings, color: "var(--issue-fg)" };
  }

  if (lowerName.endsWith(".python-version")) {
    return { Icon: FileCode2, color: "#4b8bbe" };
  }

  const extension = lowerName.includes(".") ? lowerName.split(".").pop() : "";
  const extensionMeta: Record<string, ProjectFileVisualMeta> = {
    py: { Icon: FileCode2, color: "#4b8bbe" },
    md: { Icon: FileText, color: "var(--decision-fg)" },
    txt: { Icon: FileText, color: "#9aa0b5" },
    json: { Icon: FileJson, color: "var(--issue-fg)" },
    toml: { Icon: Settings, color: "var(--accent-purple)" },
    yaml: { Icon: Settings, color: "var(--accent-purple)" },
    yml: { Icon: Settings, color: "var(--accent-purple)" },
    lock: { Icon: Lock, color: "var(--muted)" },
    skill: { Icon: Sparkles, color: "var(--accent-purple)" },
    png: { Icon: Image, color: "var(--action-fg)" },
    jpg: { Icon: Image, color: "var(--action-fg)" },
    jpeg: { Icon: Image, color: "var(--action-fg)" },
    gif: { Icon: Image, color: "var(--action-fg)" },
    svg: { Icon: Image, color: "var(--issue-fg)" },
    csv: { Icon: Table, color: "var(--decision-fg)" },
    xlsx: { Icon: Table, color: "var(--decision-fg)" },
    pdf: { Icon: FileText, color: "#e24b4a" },
    m4a: { Icon: Music, color: "#d4537e" },
    mp3: { Icon: Music, color: "#d4537e" },
    wav: { Icon: Music, color: "#d4537e" },
    js: { Icon: Braces, color: "#efd81d" },
    ts: { Icon: Braces, color: "#378add" },
    jsx: { Icon: CodeXml, color: "#61dafb" },
    tsx: { Icon: CodeXml, color: "#61dafb" },
    html: { Icon: CodeXml, color: "#d85a30" },
    css: { Icon: CodeXml, color: "#378add" },
    sh: { Icon: Terminal, color: "#97c459" },
    ipynb: { Icon: NotebookTabs, color: "var(--issue-fg)" },
    sql: { Icon: Database, color: "var(--action-fg)" },
  };

  return extensionMeta[extension ?? ""] ?? { Icon: FileIcon, color: "var(--muted)" };
}

function getProjectFilePathSegments(path: string) {
  return path.split(/[\\/]+/).filter(Boolean).slice(-4);
}

function getProjectFilePreviewLines(content: string) {
  const lines = content.split(/\r?\n/);

  return lines.length === 0 ? [""] : lines;
}

// Codex 파일 패널처럼 폴더를 접고 펼칠 수 있는 프로젝트 파일 트리를 렌더링한다.
function ProjectFileTree({
  entries,
  level = 0,
  onDelete,
  onSelect,
  onToggle,
  pendingDeleteEntryId,
  selectedEntryId,
}: ProjectFileTreeProps) {
  return (
    <div className="project-file-tree" role={level === 0 ? "tree" : "group"}>
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = Boolean(entry.isExpanded);
        const fileVisualMeta: ProjectFileVisualMeta = isDirectory
          ? { Icon: isExpanded ? FolderOpen : Folder, color: "var(--muted)" }
          : getProjectFileVisualMeta(entry.name);
        const ProjectFileIcon = fileVisualMeta.Icon;

        return (
          <div className="project-file-node" key={entry.id}>
            <div
              aria-expanded={isDirectory ? isExpanded : undefined}
              className="project-file-row"
              data-kind={isDirectory ? "directory" : "file"}
              data-selected={entry.id === selectedEntryId ? "true" : undefined}
              onClick={() => {
                if (!isDirectory) {
                  onSelect(entry);
                }
              }}
              role="treeitem"
              style={{ "--file-depth": level } as CSSProperties}
            >
              {isDirectory ? (
                <button
                  aria-label={`${entry.name} ${isExpanded ? "접기" : "펼치기"}`}
                  className="project-file-disclosure"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(entry);
                  }}
                  title={`${entry.name} ${isExpanded ? "접기" : "펼치기"}`}
                  type="button"
                >
                  <ChevronRight size={16} />
                </button>
              ) : (
                <span className="project-file-disclosure" />
              )}
              <ProjectFileIcon
                aria-hidden="true"
                className="project-file-icon"
                size={isDirectory ? 16 : 15}
                style={{ color: fileVisualMeta.color }}
              />
              <span
                className="project-file-name"
                data-muted={fileVisualMeta.muted ? "true" : undefined}
                title={entry.path}
              >
                {entry.name}
              </span>
              <button
                aria-label={`${entry.name} ${pendingDeleteEntryId === entry.id ? "제거 확인" : "제거"}`}
                className="project-file-remove"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(entry);
                }}
                title={`${entry.name} ${pendingDeleteEntryId === entry.id ? "제거 확인" : "제거"}`}
                type="button"
              >
                {pendingDeleteEntryId === entry.id ? <Check size={13} /> : <X size={13} />}
              </button>
            </div>
            {isDirectory && isExpanded && entry.children ? (
              <ProjectFileTree
                entries={entry.children}
                level={level + 1}
                onDelete={onDelete}
                onSelect={onSelect}
                onToggle={onToggle}
                pendingDeleteEntryId={pendingDeleteEntryId}
                selectedEntryId={selectedEntryId}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// 우측 프로젝트 패널의 자료함과 파일 트리 화면을 렌더링한다.
export function ProjectFilesPanel({
  attachments,
  demoStatus,
  filteredTreeFiles,
  groupedFiles,
  isSelectedSourceFile,
  isTreeCollapsed,
  mode,
  onBackToLibrary,
  onOpenDirectory,
  onOpenFiles,
  onOpenSource,
  onQueryChange,
  onRequestDelete,
  onSelectFile,
  onToggleFile,
  onToggleTreeCollapsed,
  onTreeResizeStart,
  pendingDeleteEntryId,
  preview,
  query,
  statusRevision,
  treeAttachments,
  treeFileCount,
  treeWidth,
}: ProjectFilesPanelProps) {
  if (mode === "library") {
    return (
      <div className="project-panel-content project-sources-panel">
        <div className="project-sources-header">
          <div className="project-sources-actions">
            <details className="project-upload-menu">
              <summary className="project-files-open-button" title="프로젝트 자료 업로드">
                <Upload size={15} />
                <span>업로드</span>
              </summary>
              <div className="project-upload-menu-popover">
                <button
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    onOpenFiles();
                  }}
                  type="button"
                >
                  파일
                </button>
                <button
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    onOpenDirectory();
                  }}
                  type="button"
                >
                  폴더
                </button>
              </div>
            </details>
          </div>
          {attachments.length > 0 ? (
            <label className="project-files-search project-sources-search">
              <Search size={15} />
              <input
                aria-label="프로젝트 자료 검색"
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="자료 검색..."
                type="text"
                value={query}
              />
              {query ? (
                <button
                  aria-label="프로젝트 자료 검색 지우기"
                  onClick={() => onQueryChange("")}
                  title="프로젝트 자료 검색 지우기"
                  type="button"
                >
                  <X size={14} />
                </button>
              ) : null}
            </label>
          ) : null}
        </div>

        <section className="project-sources-section" aria-label="프로젝트 자료">
          <div className="project-sources-section-title">
            <h2>업로드한 자료</h2>
            <span>{attachments.length}개</span>
          </div>
          {attachments.length > 0 ? (
            groupedFiles.length > 0 ? (
              <div className="project-source-timeline">
                {groupedFiles.map((group) => (
                  <div className="project-source-time-group" key={group.label}>
                    <span className="project-source-time-label">{group.label}</span>
                    <div className="project-source-list">
                      {group.sources.map((source) => {
                        const sourceCount = countProjectFileEntries([source]);
                        const sourceMeta =
                          source.kind === "directory"
                            ? { Icon: FolderOpen, color: "var(--muted)" }
                            : getProjectFileVisualMeta(source.name);
                        const SourceIcon = sourceMeta.Icon;

                        return (
                          <article
                            className="project-source-card"
                            key={source.id}
                            onClick={() => onOpenSource(source)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onOpenSource(source);
                              }
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="project-source-icon">
                              <SourceIcon size={18} style={{ color: sourceMeta.color }} />
                            </div>
                            <div className="project-source-body">
                              <strong title={source.path}>{source.name}</strong>
                              <span>
                                {source.kind === "directory" ? `폴더 · ${sourceCount}개 항목` : "파일"}
                              </span>
                            </div>
                            <div className="project-source-actions">
                              <details className="project-source-menu" onClick={(event) => event.stopPropagation()}>
                                <summary aria-label={`${source.name} 관리`} title={`${source.name} 관리`}>
                                  <Ellipsis size={15} />
                                </summary>
                                <div className="project-source-menu-popover">
                                  <button
                                    data-confirming={pendingDeleteEntryId === source.id ? "true" : undefined}
                                    onClick={() => onRequestDelete(source)}
                                    type="button"
                                  >
                                    {pendingDeleteEntryId === source.id ? "삭제 확인" : "삭제"}
                                  </button>
                                </div>
                              </details>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="overview-empty-text">
                <Search size={17} />
                검색 결과가 없습니다.
              </p>
            )
          ) : (
            <div className="project-sources-empty">
              <FolderOpen size={32} />
              <strong>등록된 자료가 없습니다</strong>
              <span>PaiM에게 제공할 파일이나 폴더를 업로드하세요.</span>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div
      className="project-panel-content project-files-panel"
      data-single-file={isSelectedSourceFile ? "true" : undefined}
      data-tree-collapsed={isTreeCollapsed}
    >
      <div className="project-files-header">
        <div className="project-files-toolbar">
          <button className="project-sources-secondary" onClick={onBackToLibrary} type="button">
            자료함
          </button>
          <span className="project-files-count">{treeFileCount}</span>
        </div>
        <div className="project-files-pathbar">
          <p className="project-files-root">{getProjectFileRootLabel(treeAttachments)}</p>
          {!isSelectedSourceFile ? (
            <button
              aria-label={isTreeCollapsed ? "파일 트리 펼치기" : "파일 트리 접기"}
              className="project-files-tree-toggle"
              onClick={onToggleTreeCollapsed}
              title={isTreeCollapsed ? "파일 트리 펼치기" : "파일 트리 접기"}
              type="button"
            >
              <FolderOpen size={16} />
            </button>
          ) : null}
        </div>
        {demoStatus && demoStatus.scope !== "github" ? (
          <p
            className="runtime-status project-panel-status"
            data-ok={demoStatus.ok}
            key={statusRevision}
            role="status"
          >
            {demoStatus.message}
          </p>
        ) : null}
      </div>
      <div className="project-files-main">
        {preview ? (
          <div className="project-file-preview">
            <div className="project-file-preview-path">
              {getProjectFilePathSegments(preview.path).map((segment, index, segments) => (
                <span data-current={index === segments.length - 1 ? "true" : undefined} key={`${segment}-${index}`}>
                  {segment}
                  {index < segments.length - 1 ? <ChevronRight size={14} /> : null}
                </span>
              ))}
            </div>
            {preview.isLoading || preview.error ? (
              <div className="project-file-preview-state">
                {preview.error ?? "파일을 읽는 중입니다..."}
              </div>
            ) : (
              <div className="project-file-code" aria-label={`${preview.name} 미리보기`}>
                {getProjectFilePreviewLines(preview.content).map((line, index) => (
                  <div className="project-file-code-line" key={`${index}-${line}`}>
                    <span className="project-file-code-line-number">{index + 1}</span>
                    <code>{line || " "}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="project-files-preview-empty">
            <FolderOpen size={34} />
            <strong>파일 열기</strong>
            <span>워크스페이스 트리에서 파일을 선택하세요</span>
          </div>
        )}
      </div>
      {!isSelectedSourceFile ? (
        <div className="project-files-tree-pane">
          <div
            aria-label="파일 트리 크기 조절"
            aria-orientation="vertical"
            aria-valuemax={MAX_PROJECT_FILE_TREE_WIDTH}
            aria-valuemin={MIN_PROJECT_FILE_TREE_WIDTH}
            aria-valuenow={treeWidth}
            className="project-files-tree-resize-handle"
            onMouseDown={onTreeResizeStart}
            role="separator"
          />
          <label className="project-files-search">
            <Search size={15} />
            <input
              aria-label="파일 필터링"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="파일 필터링..."
              type="text"
              value={query}
            />
            {query ? (
              <button
                aria-label="파일 필터 지우기"
                onClick={() => onQueryChange("")}
                title="파일 필터 지우기"
                type="button"
              >
                <X size={14} />
              </button>
            ) : null}
          </label>
          {treeAttachments.length > 0 ? (
            filteredTreeFiles.length > 0 ? (
              <ProjectFileTree
                entries={filteredTreeFiles}
                onDelete={onRequestDelete}
                onSelect={onSelectFile}
                onToggle={onToggleFile}
                pendingDeleteEntryId={pendingDeleteEntryId}
                selectedEntryId={preview?.id}
              />
            ) : (
              <p className="overview-empty-text">
                <Search size={17} />
                검색 결과가 없습니다.
              </p>
            )
          ) : (
            <p className="overview-empty-text">
              <FolderOpen size={18} />
              아직 열린 프로젝트 폴더가 없습니다.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
