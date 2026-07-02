import {
  AlertTriangle,
  ArrowRight,
  Check,
  FileText,
  Flame,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fetchPaimJson, getErrorMessage } from "./paimApi";
import type {
  ProjectMemoryCategory,
  ProjectMemoryItem,
  ProjectWorkspace,
} from "./types";

type MemoryLoadState = "idle" | "loading" | "loaded" | "error";
type MemoryTone = ProjectMemoryCategory;

type ProjectMemoryPanelProps = {
  isMaximized: boolean;
  project: ProjectWorkspace;
};

const SUMMARY_ITEM_LIMIT = 5;
const MEMORY_CATEGORIES: ProjectMemoryCategory[] = ["decision", "action", "issue", "risk"];
const MEMORY_CATEGORY_META: Record<
  ProjectMemoryCategory,
  {
    Icon: typeof Check;
    empty: string;
    label: string;
    tone: MemoryTone;
  }
> = {
  decision: {
    Icon: Check,
    empty: "서버에 저장된 결정사항이 없습니다",
    label: "Decision",
    tone: "decision",
  },
  action: {
    Icon: ArrowRight,
    empty: "서버에 저장된 액션이 없습니다",
    label: "Action",
    tone: "action",
  },
  issue: {
    Icon: AlertTriangle,
    empty: "서버에 저장된 이슈가 없습니다",
    label: "Issue",
    tone: "issue",
  },
  risk: {
    Icon: Flame,
    empty: "서버에 저장된 리스크가 없습니다",
    label: "Risk",
    tone: "risk",
  },
};

function isProjectMemoryItem(value: ProjectMemoryItem) {
  return MEMORY_CATEGORIES.includes(value.category) && Boolean(value.content?.trim());
}

function groupMemoryItems(items: ProjectMemoryItem[]) {
  return MEMORY_CATEGORIES.reduce(
    (groups, category) => ({
      ...groups,
      [category]: items.filter((item) => item.category === category),
    }),
    {} as Record<ProjectMemoryCategory, ProjectMemoryItem[]>,
  );
}

function getMemoryItemMeta(item: ProjectMemoryItem) {
  return [item.topic, item.owner, item.date, item.source].filter(Boolean).join(" · ");
}

function getMemoryItemKey(item: ProjectMemoryItem, index: number) {
  return `${item.id}-${item.category}-${index}`;
}

function MemoryItemRows({
  category,
  items,
  limit,
}: {
  category: ProjectMemoryCategory;
  items: ProjectMemoryItem[];
  limit?: number;
}) {
  const visibleItems = typeof limit === "number" ? items.slice(0, limit) : items;
  const hiddenCount = Math.max(items.length - visibleItems.length, 0);

  if (items.length === 0) {
    return <p className="project-memory-empty-row">{MEMORY_CATEGORY_META[category].empty}</p>;
  }

  return (
    <>
      {visibleItems.map((item, index) => {
        const meta = getMemoryItemMeta(item);

        return (
          <p key={getMemoryItemKey(item, index)}>
            <span>·</span>
            {item.content}
            {meta ? <small className="project-memory-meta">{meta}</small> : null}
          </p>
        );
      })}
      {hiddenCount > 0 ? (
        <p className="project-memory-summary-more">외 {hiddenCount}개</p>
      ) : null}
    </>
  );
}

export function ProjectMemoryPanel({ isMaximized, project }: ProjectMemoryPanelProps) {
  const [memoryItems, setMemoryItems] = useState<ProjectMemoryItem[]>([]);
  const [loadState, setLoadState] = useState<MemoryLoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const apiProjectId = project.apiProjectId;
  const groupedItems = useMemo(() => groupMemoryItems(memoryItems), [memoryItems]);
  const totalCount = memoryItems.length;

  async function loadProjectMemory() {
    if (typeof apiProjectId !== "number") {
      setMemoryItems([]);
      setLoadState("idle");
      setErrorMessage("");
      return;
    }

    setLoadState("loading");
    setErrorMessage("");

    try {
      const items = await fetchPaimJson<ProjectMemoryItem[]>(
        `/projects/${apiProjectId}/memory`,
      );

      setMemoryItems(items.filter(isProjectMemoryItem));
      setLoadState("loaded");
    } catch (error) {
      setMemoryItems([]);
      setErrorMessage(getErrorMessage(error, "프로젝트 메모리를 불러올 수 없습니다"));
      setLoadState("error");
    }
  }

  useEffect(() => {
    void loadProjectMemory();
  }, [apiProjectId]);

  return (
    <div className="project-panel-content project-memory" data-mode={isMaximized ? "manage" : "summary"}>
      <div className="project-memory-header">
        <div className="project-memory-heading">
          <p className="project-panel-project-name">{project.name}</p>
          <p className="project-memory-description">
            {typeof apiProjectId === "number"
              ? "서버 분석 결과로 저장된 프로젝트 메모리를 표시합니다"
              : "FastAPI 프로젝트 연결 후 메모리를 표시합니다"}
          </p>
          {!isMaximized ? (
            <div className="project-memory-summary-row">
              {MEMORY_CATEGORIES.map((category) => (
                <span
                  className="project-memory-summary-stat"
                  data-tone={category}
                  key={category}
                >
                  <strong>{groupedItems[category].length}</strong>
                  {MEMORY_CATEGORY_META[category].label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <button
          disabled={loadState === "loading" || typeof apiProjectId !== "number"}
          onClick={() => void loadProjectMemory()}
          type="button"
        >
          <RefreshCw size={13} />
          새로고침
        </button>
      </div>

      {typeof apiProjectId !== "number" ? (
        <div className="project-memory-server-state" role="status">
          서버 프로젝트가 연결되면 메모리를 불러옵니다.
        </div>
      ) : loadState === "loading" ? (
        <div className="project-memory-server-state" role="status">
          서버에서 프로젝트 메모리를 불러오는 중입니다.
        </div>
      ) : loadState === "error" ? (
        <div className="project-memory-server-state" data-error="true" role="status">
          {errorMessage}
        </div>
      ) : totalCount === 0 ? (
        <div className="project-memory-server-state" role="status">
          서버에 저장된 프로젝트 메모리가 없습니다.
        </div>
      ) : isMaximized ? (
        <>
          <div className="project-memory-stats" aria-label="프로젝트 메모리 요약">
            {MEMORY_CATEGORIES.map((category) => (
              <div data-tone={category} key={category}>
                <span>{MEMORY_CATEGORY_META[category].label}</span>
                <strong>{groupedItems[category].length}</strong>
              </div>
            ))}
          </div>

          <section className="project-memory-manage" aria-label="프로젝트 메모리">
            {MEMORY_CATEGORIES.map((category) => {
              const { Icon, label, tone } = MEMORY_CATEGORY_META[category];

              return (
                <article className="overview-memory-card" data-tone={tone} key={category}>
                  <div className="overview-memory-label">
                    <Icon size={13} />
                    <span>{label}</span>
                    <small>{groupedItems[category].length}</small>
                  </div>
                  <MemoryItemRows category={category} items={groupedItems[category]} />
                </article>
              );
            })}
          </section>
        </>
      ) : (
        <div className="project-memory-summary-body">
          <section className="project-memory-summary-section" data-tone="action" aria-label="프로젝트 액션">
            <div className="overview-memory-label">
              <ArrowRight size={13} />
              <span>Action</span>
              <small>{groupedItems.action.length}</small>
            </div>
            <div className="project-memory-summary-actions">
              {groupedItems.action.slice(0, SUMMARY_ITEM_LIMIT).map((item, index) => {
                const meta = getMemoryItemMeta(item);

                return (
                  <div className="project-memory-summary-action" key={getMemoryItemKey(item, index)}>
                    <FileText size={16} />
                    <span>{item.content}</span>
                    {meta ? <em>{meta}</em> : null}
                  </div>
                );
              })}
              {groupedItems.action.length === 0 ? (
                <p className="project-memory-empty-row">{MEMORY_CATEGORY_META.action.empty}</p>
              ) : null}
              {groupedItems.action.length > SUMMARY_ITEM_LIMIT ? (
                <p className="project-memory-summary-more">
                  외 {groupedItems.action.length - SUMMARY_ITEM_LIMIT}개
                </p>
              ) : null}
            </div>
          </section>

          <section className="project-memory-summary-rest" aria-label="프로젝트 메모">
            {(["decision", "issue", "risk"] as const).map((category) => {
              const { Icon, label, tone } = MEMORY_CATEGORY_META[category];

              return (
                <article
                  className="project-memory-summary-section"
                  data-tone={tone}
                  key={category}
                >
                  <div className="overview-memory-label">
                    <Icon size={13} />
                    <span>{label}</span>
                    <small>{groupedItems[category].length}</small>
                  </div>
                  <MemoryItemRows
                    category={category}
                    items={groupedItems[category]}
                    limit={2}
                  />
                </article>
              );
            })}
          </section>
        </div>
      )}
    </div>
  );
}
