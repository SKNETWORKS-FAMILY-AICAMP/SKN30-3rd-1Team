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
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { CSSProperties, MouseEvent } from "react";

import { useI18n } from "./i18n";
import type {
  Attachment,
  DemoStatus,
  DirectoryChildEntry,
  ProjectDocumentStatus,
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

function getProjectDocumentStatusPriority(status?: ProjectDocumentStatus) {
  const priorities: Record<ProjectDocumentStatus, number> = {
    failed: 5,
    delayed: 4,
    uploading: 3,
    processing: 2,
    uploaded: 2,
    indexed: 1,
  };

  return status ? priorities[status] : 0;
}

function findProjectDocumentStatusSource(source: Attachment): Attachment | null {
  let currentSource = source.documentStatus ? source : null;

  for (const child of source.children ?? []) {
    const childSource = findProjectDocumentStatusSource(child);

    if (
      childSource &&
      getProjectDocumentStatusPriority(childSource.documentStatus) >
        getProjectDocumentStatusPriority(currentSource?.documentStatus)
    ) {
      currentSource = childSource;
    }
  }

  return currentSource;
}

function getProjectDocumentStatusMeta(source: Attachment) {
  const statusSource = findProjectDocumentStatusSource(source);

  if (!statusSource?.documentStatus) {
    return null;
  }

  if (statusSource.documentStatus === "uploading") {
    return { label: "업로드중", tone: "pending", title: "서버로 업로드 중" };
  }

  if (statusSource.documentStatus === "uploaded" || statusSource.documentStatus === "processing") {
    return { label: "처리중", tone: "pending", title: "서버에서 문서를 처리 중" };
  }

  if (statusSource.documentStatus === "indexed") {
    return { label: "완료", tone: "success", title: "서버 인덱싱 완료" };
  }

  if (statusSource.documentStatus === "delayed") {
    return {
      label: "처리 지연",
      tone: "muted",
      title: statusSource.lastError ?? "처리 지연 — 나중에 다시 확인",
    };
  }

  return {
    label: "실패",
    tone: "danger",
    title: statusSource.lastError ?? "문서 처리 실패",
  };
}

function getProjectDocumentStatusVariant(tone: string): BadgeVariant {
  if (tone === "success") {
    return "green";
  }

  if (tone === "danger") {
    return "red";
  }

  if (tone === "pending") {
    return "yellow";
  }

  return "neutral";
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

function getProjectFilePreviewLanguage(name: string) {
  const lowerName = name.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.split(".").pop() : "";
  const languageByExtension: Record<string, string> = {
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    py: "python",
    sh: "bash",
    svg: "svg",
    ts: "typescript",
    tsx: "tsx",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };

  return languageByExtension[extension ?? ""] ?? "plaintext";
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
  const { t } = useI18n();

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
                <IconButton
                  className="project-file-disclosure"
                  icon={<ChevronRight size={16} />}
                  label={t(isExpanded ? "{name} 접기" : "{name} 펼치기", { name: entry.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(entry);
                  }}
                  size="sm"
                  tooltip={t(isExpanded ? "{name} 접기" : "{name} 펼치기", { name: entry.name })}
                  variant="ghost"
                />
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
              <IconButton
                className="project-file-remove"
                icon={pendingDeleteEntryId === entry.id ? <Check size={13} /> : <X size={13} />}
                label={t(
                  pendingDeleteEntryId === entry.id ? "{name} 제거 확인" : "{name} 제거",
                  { name: entry.name },
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(entry);
                }}
                size="sm"
                tooltip={t(
                  pendingDeleteEntryId === entry.id ? "{name} 제거 확인" : "{name} 제거",
                  { name: entry.name },
                )}
                variant="ghost"
              />
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
  const { t } = useI18n();

  if (mode === "library") {
    return (
      <div className="project-panel-content project-sources-panel" data-drop-zone="project-files">
        <div className="project-sources-header">
          <div className="project-sources-actions">
            <DropdownMenu
              button={{
                className: "project-files-open-button",
                icon: <Upload size={15} />,
                label: t("업로드"),
                size: "sm",
                tooltip: t("프로젝트 자료 업로드"),
                variant: "secondary",
              }}
              items={[
                { label: t("파일"), onClick: onOpenFiles },
                { label: t("폴더"), onClick: onOpenDirectory },
              ]}
            />
          </div>
          {attachments.length > 0 ? (
            <TextInput
              className="project-files-search project-sources-search"
              hasClear
              isLabelHidden
              label={t("프로젝트 자료 검색")}
              onChange={onQueryChange}
              placeholder={t("자료 검색...")}
              startIcon={<Search size={15} />}
              value={query}
              width="100%"
            />
          ) : null}
        </div>

        <section className="project-sources-section" aria-label={t("프로젝트 자료")}>
          <div className="project-sources-section-title">
            <h2>{t("업로드한 자료")}</h2>
            <span>{t("{count}개", { count: attachments.length })}</span>
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
                        const documentStatusMeta = getProjectDocumentStatusMeta(source);

                        return (
                          <ClickableCard
                            className="project-source-card"
                            key={source.id}
                            label={t("{name} 열기", { name: source.name })}
                            onClick={() => onOpenSource(source)}
                            padding={2}
                          >
                            <div className="project-source-icon">
                              <SourceIcon size={18} style={{ color: sourceMeta.color }} />
                            </div>
                            <div className="project-source-body">
                              <strong title={source.path}>{source.name}</strong>
                              <span>
                                {source.kind === "directory"
                                  ? t("폴더 · {count}개 항목", { count: sourceCount })
                                  : t("파일")}
                              </span>
                              {documentStatusMeta ? (
                                <Badge
                                  className="project-document-status"
                                  label={t(documentStatusMeta.label)}
                                  variant={getProjectDocumentStatusVariant(documentStatusMeta.tone)}
                                />
                              ) : null}
                            </div>
                            <div className="project-source-actions">
                              <DropdownMenu
                                button={{
                                  icon: <Ellipsis size={15} />,
                                  isIconOnly: true,
                                  label: t("{name} 관리", { name: source.name }),
                                  size: "sm",
                                  tooltip: t("{name} 관리", { name: source.name }),
                                  variant: "ghost",
                                }}
                                items={[
                                  {
                                    label: pendingDeleteEntryId === source.id ? t("삭제 확인") : t("삭제"),
                                    onClick: () => onRequestDelete(source),
                                  },
                                ]}
                                menuWidth={112}
                              />
                            </div>
                          </ClickableCard>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                className="project-panel-empty-state"
                icon={<Search size={17} />}
                isCompact
                title={t("검색 결과가 없습니다.")}
              />
            )
          ) : (
            <EmptyState
              className="project-sources-empty"
              description={t("PaiM에게 제공할 파일이나 폴더를 업로드하세요.")}
              icon={<FolderOpen size={32} />}
              title={t("등록된 자료가 없습니다")}
            />
          )}
        </section>
      </div>
    );
  }

  return (
    <div
      className="project-panel-content project-files-panel"
      data-drop-zone="project-files"
      data-single-file={isSelectedSourceFile ? "true" : undefined}
      data-tree-collapsed={isTreeCollapsed}
      onMouseDown={(event) => {
        if (!isTreeCollapsed || isSelectedSourceFile || (event.target as Element).closest("button")) {
          return;
        }

        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX >= bounds.right - 56) {
          onTreeResizeStart(event);
        }
      }}
    >
      <div className="project-files-header">
        <div className="project-files-toolbar">
          <Button
            className="project-sources-secondary"
            label={t("자료함")}
            onClick={onBackToLibrary}
            size="sm"
            variant="ghost"
          />
          <Badge className="project-files-count" label={treeFileCount} />
        </div>
        <div className="project-files-pathbar">
          <p className="project-files-root">{getProjectFileRootLabel(treeAttachments)}</p>
          {!isSelectedSourceFile ? (
            <IconButton
              className="project-files-tree-toggle"
              icon={<FolderOpen size={16} />}
              label={isTreeCollapsed ? t("파일 트리 펼치기") : t("파일 트리 접기")}
              onClick={onToggleTreeCollapsed}
              size="sm"
              tooltip={isTreeCollapsed ? t("파일 트리 펼치기") : t("파일 트리 접기")}
              variant="ghost"
            />
          ) : null}
        </div>
        {demoStatus && demoStatus.scope !== "github" ? (
          <Banner
            className="runtime-status project-panel-status"
            container="card"
            key={statusRevision}
            status={demoStatus.ok ? "info" : "error"}
            title={t(demoStatus.message)}
          />
        ) : null}
      </div>
      <div className="project-files-main">
        {preview ? (
          <div className="project-file-preview">
            <Breadcrumbs
              className="project-file-preview-path"
              label={t("{name} 경로", { name: preview.name })}
              separator={<ChevronRight size={14} />}
              variant="supporting"
            >
              {getProjectFilePathSegments(preview.path).map((segment, index, segments) => (
                <BreadcrumbItem
                  isCurrent={index === segments.length - 1}
                  key={`${segment}-${index}`}
                >
                  {segment}
                </BreadcrumbItem>
              ))}
            </Breadcrumbs>
            {preview.isLoading ? (
              <Center height="100%" minHeight={0} width="100%">
                <Spinner label={t("파일을 읽는 중입니다...")} shade="subtle" />
              </Center>
            ) : preview.error ? (
              <Center height="100%" minHeight={0} width="100%">
                <EmptyState isCompact title={preview.error} />
              </Center>
            ) : (
              <CodeBlock
                className="project-file-code"
                code={preview.content}
                container="section"
                hasLineNumbers
                language={getProjectFilePreviewLanguage(preview.name)}
                maxHeight="100%"
                size="sm"
                title={preview.name}
                width="100%"
              />
            )}
          </div>
        ) : (
          <EmptyState
            className="project-files-preview-empty"
            description={t("워크스페이스 트리에서 파일을 선택하세요")}
            icon={<FolderOpen size={34} />}
            title={t("파일 열기")}
          />
        )}
      </div>
      {!isSelectedSourceFile ? (
        <div
          className="project-files-tree-pane"
          onMouseDown={(event) => {
            if (!isTreeCollapsed || (event.target as Element).closest("button")) {
              return;
            }
            onTreeResizeStart(event);
          }}
        >
          <div
            aria-label={t("파일 트리 크기 조절")}
            aria-orientation="vertical"
            aria-valuemax={MAX_PROJECT_FILE_TREE_WIDTH}
            aria-valuemin={MIN_PROJECT_FILE_TREE_WIDTH}
            aria-valuenow={treeWidth}
            className="project-files-tree-resize-handle"
            onMouseDown={onTreeResizeStart}
            role="separator"
          />
          <TextInput
            className="project-files-search"
            hasClear
            isLabelHidden
            label={t("파일 필터링")}
            onChange={onQueryChange}
            placeholder={t("파일 필터링...")}
            startIcon={<Search size={15} />}
            value={query}
            width="100%"
          />
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
              <EmptyState
                className="project-panel-empty-state"
                icon={<Search size={17} />}
                isCompact
                title={t("검색 결과가 없습니다.")}
              />
            )
          ) : (
            <EmptyState
              className="project-panel-empty-state"
              icon={<FolderOpen size={18} />}
              isCompact
              title={t("아직 열린 프로젝트 폴더가 없습니다.")}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
