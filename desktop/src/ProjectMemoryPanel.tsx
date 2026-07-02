import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  FileText,
  Flame,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { type DragEvent, type FormEvent, useEffect, useMemo, useState } from "react";

import { fetchPaimJson, getErrorMessage, isPaimApiError } from "./paimApi";
import type {
  ProjectMemoryCategory,
  ProjectMemoryItem,
  ProjectWorkspace,
} from "./types";

type MemoryLoadState = "idle" | "loading" | "loaded" | "error";
type MemoryTone = ProjectMemoryCategory;

type ProjectMemoryPanelProps = {
  canManage: boolean;
  isMaximized: boolean;
  project: ProjectWorkspace;
};

type MemoryDraft = {
  content: string;
  owner: string;
  date: string;
};

type MemoryPatchPayload = {
  content?: string;
  owner?: string;
  date?: string | null;
  completed?: boolean;
  sort_order?: number | null;
};

const SUMMARY_ITEM_LIMIT = 5;
const MEMORY_CATEGORIES: ProjectMemoryCategory[] = ["action", "decision", "issue", "risk"];
const EDITABLE_MEMORY_FIELDS = ["content", "owner", "date"] as const;
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

function createEmptyDraft(): MemoryDraft {
  return {
    content: "",
    owner: "",
    date: "",
  };
}

function createDraftFromItem(item: ProjectMemoryItem): MemoryDraft {
  return {
    content: item.content,
    owner: item.owner ?? "",
    date: item.date ?? "",
  };
}

function isMemoryItemCompleted(item: ProjectMemoryItem) {
  return Boolean(item.completed_at);
}

function isMemoryItemVerified(item: ProjectMemoryItem) {
  return item.created_by === "user" || Boolean(item.is_user_verified);
}

function formatMemoryDate(value?: string | null) {
  if (!value) {
    return "";
  }

  return value.split("T")[0] || value;
}

function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatActionDueDate(value?: string | null) {
  const normalizedDate = formatMemoryDate(value);

  if (!normalizedDate) {
    return "";
  }

  const [, month, day] = normalizedDate.split("-");

  return month && day ? `~ ${month}.${day}` : `~ ${normalizedDate}`;
}

function isActionOverdue(item: ProjectMemoryItem) {
  const dueDate = formatMemoryDate(item.date);

  return Boolean(dueDate) && !isMemoryItemCompleted(item) && dueDate < getTodayDateString();
}

function getActionDisplayItems(items: ProjectMemoryItem[]) {
  return items
    .map((item, index) => ({ index, item }))
    .sort((left, right) => {
      const leftDone = isMemoryItemCompleted(left.item);
      const rightDone = isMemoryItemCompleted(right.item);

      if (leftDone !== rightDone) {
        return leftDone ? 1 : -1;
      }

      const leftOrder = left.item.sort_order;
      const rightOrder = right.item.sort_order;
      const leftHasOrder = typeof leftOrder === "number";
      const rightHasOrder = typeof rightOrder === "number";

      if (leftHasOrder && rightHasOrder && leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      if (leftHasOrder !== rightHasOrder) {
        return leftHasOrder ? -1 : 1;
      }

      return left.index - right.index;
    })
    .map(({ item }) => item);
}

function getActionTodoItems(items: ProjectMemoryItem[]) {
  return getActionDisplayItems(items).filter((item) => !isMemoryItemCompleted(item));
}

function createMemoryPatch(item: ProjectMemoryItem, draft: MemoryDraft): MemoryPatchPayload {
  const payload: MemoryPatchPayload = {};
  const nextValues = {
    content: draft.content.trim(),
    owner: draft.owner.trim(),
    date: draft.date.trim(),
  };

  for (const field of EDITABLE_MEMORY_FIELDS) {
    const currentValue = item[field] ?? "";
    const nextValue = nextValues[field];

    if (currentValue === nextValue) {
      continue;
    }

    if (field === "date") {
      payload.date = nextValue || null;
    } else {
      payload[field] = nextValue;
    }
  }

  return payload;
}

function createMemoryPostBody(category: ProjectMemoryCategory, draft: MemoryDraft) {
  const body: Record<string, string> = {
    category,
    content: draft.content.trim(),
  };
  const owner = draft.owner.trim();
  const date = draft.date.trim();

  if (owner) {
    body.owner = owner;
  }
  if (date) {
    body.date = date;
  }

  return body;
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
  variant = "manage",
}: {
  category: ProjectMemoryCategory;
  items: ProjectMemoryItem[];
  limit?: number;
  variant?: "manage" | "summary";
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

        if (variant === "summary") {
          return (
            <p
              className="project-memory-summary-item"
              data-completed={isMemoryItemCompleted(item)}
              key={getMemoryItemKey(item, index)}
            >
              <span className="project-memory-bullet">·</span>
              <span className="project-memory-content" title={item.content}>
                {item.content}
              </span>
              {meta ? (
                <small className="project-memory-meta" title={meta}>
                  {meta}
                </small>
              ) : null}
            </p>
          );
        }

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

export function ProjectMemoryPanel({ canManage, isMaximized, project }: ProjectMemoryPanelProps) {
  const [memoryItems, setMemoryItems] = useState<ProjectMemoryItem[]>([]);
  const [loadState, setLoadState] = useState<MemoryLoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [operationError, setOperationError] = useState("");
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<MemoryDraft>(createEmptyDraft);
  const [addingCategory, setAddingCategory] = useState<ProjectMemoryCategory | null>(null);
  const [addDraft, setAddDraft] = useState<MemoryDraft>(createEmptyDraft);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [savingItemIds, setSavingItemIds] = useState<number[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [draggingActionId, setDraggingActionId] = useState<number | null>(null);
  const [dragOverActionId, setDragOverActionId] = useState<number | null>(null);
  const apiProjectId = project.apiProjectId;
  const groupedItems = useMemo(() => groupMemoryItems(memoryItems), [memoryItems]);
  const actionItems = useMemo(() => getActionDisplayItems(groupedItems.action), [groupedItems]);
  const actionTodoItems = useMemo(() => getActionTodoItems(groupedItems.action), [groupedItems]);
  const actionCompletedCount = groupedItems.action.filter(isMemoryItemCompleted).length;
  const totalCount = memoryItems.length;
  const showManageUi = isMaximized && canManage && typeof apiProjectId === "number";

  function setItemSaving(memoryId: number, saving: boolean) {
    setSavingItemIds((current) =>
      saving
        ? [...new Set([...current, memoryId])]
        : current.filter((itemId) => itemId !== memoryId),
    );
  }

  function isItemSaving(memoryId: number) {
    return savingItemIds.includes(memoryId) || isReordering;
  }

  function replaceMemoryItem(nextItem: ProjectMemoryItem) {
    setMemoryItems((current) =>
      current.map((item) => (item.id === nextItem.id ? nextItem : item)),
    );
  }

  async function patchMemoryItem(memoryId: number, payload: MemoryPatchPayload) {
    return fetchPaimJson<ProjectMemoryItem>(
      `/projects/${apiProjectId}/memory/${memoryId}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  }

  async function loadProjectMemory() {
    if (typeof apiProjectId !== "number") {
      setMemoryItems([]);
      setLoadState("idle");
      setErrorMessage("");
      setOperationError("");
      return;
    }

    setLoadState("loading");
    setErrorMessage("");
    setOperationError("");

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

  useEffect(() => {
    setEditingItemId(null);
    setEditDraft(createEmptyDraft());
    setAddingCategory(null);
    setAddDraft(createEmptyDraft());
    setPendingDeleteId(null);
    setOperationError("");
    setDraggingActionId(null);
    setDragOverActionId(null);
  }, [apiProjectId, isMaximized]);

  function startEdit(item: ProjectMemoryItem) {
    setEditingItemId(item.id);
    setEditDraft(createDraftFromItem(item));
    setPendingDeleteId(null);
    setOperationError("");
  }

  function startAdd(category: ProjectMemoryCategory) {
    setAddingCategory(category);
    setAddDraft(createEmptyDraft());
    setEditingItemId(null);
    setPendingDeleteId(null);
    setOperationError("");
  }

  async function handleSaveEdit(item: ProjectMemoryItem, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (typeof apiProjectId !== "number") {
      return;
    }

    const content = editDraft.content.trim();
    if (!content) {
      setOperationError("내용을 입력해 주세요.");
      return;
    }

    const payload = createMemoryPatch(item, editDraft);
    if (Object.keys(payload).length === 0) {
      setEditingItemId(null);
      return;
    }

    const previousItem = item;
    const optimisticItem: ProjectMemoryItem = {
      ...item,
      content,
      owner: editDraft.owner.trim(),
      date: editDraft.date.trim() || item.date,
      is_user_verified: 1,
      updated_by: "user",
    };

    setOperationError("");
    setItemSaving(item.id, true);
    replaceMemoryItem(optimisticItem);

    try {
      const updatedItem = await patchMemoryItem(item.id, payload);
      replaceMemoryItem(updatedItem);
      setEditingItemId(null);
    } catch (error) {
      replaceMemoryItem(previousItem);
      setOperationError(getErrorMessage(error, "메모리를 수정할 수 없습니다"));
    } finally {
      setItemSaving(item.id, false);
    }
  }

  async function handleCreateMemory(category: ProjectMemoryCategory, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (typeof apiProjectId !== "number") {
      return;
    }

    if (!addDraft.content.trim()) {
      setOperationError("내용을 입력해 주세요.");
      return;
    }

    setOperationError("");
    setIsAdding(true);

    try {
      const createdItem = await fetchPaimJson<ProjectMemoryItem>(
        `/projects/${apiProjectId}/memory`,
        {
          method: "POST",
          body: JSON.stringify(createMemoryPostBody(category, addDraft)),
        },
      );

      setMemoryItems((current) => [createdItem, ...current]);
      setAddingCategory(null);
      setAddDraft(createEmptyDraft());
    } catch (error) {
      setOperationError(getErrorMessage(error, "메모리를 추가할 수 없습니다"));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleDeleteMemory(item: ProjectMemoryItem) {
    if (typeof apiProjectId !== "number") {
      return;
    }

    if (pendingDeleteId !== item.id) {
      setPendingDeleteId(item.id);
      setOperationError("");
      return;
    }

    const previousItems = memoryItems;
    setOperationError("");
    setItemSaving(item.id, true);
    setMemoryItems((current) => current.filter((candidate) => candidate.id !== item.id));

    try {
      await fetchPaimJson<void>(`/projects/${apiProjectId}/memory/${item.id}`, {
        method: "DELETE",
      });
      setPendingDeleteId(null);
    } catch (error) {
      if (isPaimApiError(error) && error.status === 404) {
        setPendingDeleteId(null);
        return;
      }

      setMemoryItems(previousItems);
      setOperationError(getErrorMessage(error, "메모리를 삭제할 수 없습니다"));
    } finally {
      setItemSaving(item.id, false);
    }
  }

  async function handleToggleCompleted(item: ProjectMemoryItem) {
    if (typeof apiProjectId !== "number") {
      return;
    }

    const previousItem = item;
    const completed = !isMemoryItemCompleted(item);

    setOperationError("");
    setItemSaving(item.id, true);
    replaceMemoryItem({
      ...item,
      completed_at: completed ? new Date().toISOString() : null,
    });

    try {
      const updatedItem = await patchMemoryItem(item.id, { completed });
      replaceMemoryItem(updatedItem);
    } catch (error) {
      replaceMemoryItem(previousItem);
      setOperationError(getErrorMessage(error, "완료 상태를 변경할 수 없습니다"));
    } finally {
      setItemSaving(item.id, false);
    }
  }

  async function reorderActionItems(sourceId: number, targetId: number) {
    if (typeof apiProjectId !== "number") {
      return;
    }

    const currentIndex = actionTodoItems.findIndex((candidate) => candidate.id === sourceId);
    const nextIndex = actionTodoItems.findIndex((candidate) => candidate.id === targetId);

    if (currentIndex < 0 || nextIndex < 0 || currentIndex === nextIndex) {
      return;
    }

    const reorderedItems = [...actionTodoItems];
    const [movedItem] = reorderedItems.splice(currentIndex, 1);
    reorderedItems.splice(nextIndex, 0, movedItem);
    const nextOrders = new Map(reorderedItems.map((candidate, index) => [candidate.id, index + 1]));
    const changedItems = reorderedItems
      .map((candidate) => ({
        id: candidate.id,
        sort_order: nextOrders.get(candidate.id) ?? null,
      }))
      .filter(({ id, sort_order }) => {
        const currentItem = memoryItems.find((candidate) => candidate.id === id);
        return currentItem?.sort_order !== sort_order;
      });

    if (changedItems.length === 0) {
      return;
    }

    const previousItems = memoryItems;
    setOperationError("");
    setIsReordering(true);
    setMemoryItems((current) =>
      current.map((candidate) => {
        const nextOrder = nextOrders.get(candidate.id);

        return typeof nextOrder === "number"
          ? { ...candidate, sort_order: nextOrder }
          : candidate;
      }),
    );

    try {
      for (const changedItem of changedItems) {
        const updatedItem = await patchMemoryItem(changedItem.id, {
          sort_order: changedItem.sort_order,
        });
        replaceMemoryItem(updatedItem);
      }
    } catch (error) {
      setMemoryItems(previousItems);
      setOperationError(getErrorMessage(error, "액션 순서를 변경할 수 없습니다"));
    } finally {
      setIsReordering(false);
    }
  }

  function handleActionDragStart(event: DragEvent<HTMLDivElement>, item: ProjectMemoryItem) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(item.id));
    setDraggingActionId(item.id);
    setDragOverActionId(null);
  }

  function handleActionDragOver(event: DragEvent<HTMLDivElement>, item: ProjectMemoryItem) {
    if (draggingActionId === null || draggingActionId === item.id) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverActionId(item.id);
  }

  function handleActionDragEnd() {
    setDraggingActionId(null);
    setDragOverActionId(null);
  }

  async function handleActionDrop(event: DragEvent<HTMLDivElement>, item: ProjectMemoryItem) {
    event.preventDefault();

    const sourceId = Number(event.dataTransfer.getData("text/plain") || draggingActionId);
    setDraggingActionId(null);
    setDragOverActionId(null);

    if (!Number.isFinite(sourceId)) {
      return;
    }

    await reorderActionItems(sourceId, item.id);
  }

  function renderDraftFields(
    draft: MemoryDraft,
    onChange: (draft: MemoryDraft) => void,
    disabled: boolean,
  ) {
    return (
      <>
        <textarea
          aria-label="메모리 내용"
          onChange={(event) => onChange({ ...draft, content: event.currentTarget.value })}
          placeholder="내용"
          required
          rows={3}
          value={draft.content}
          disabled={disabled}
        />
        <div className="project-memory-form-grid">
          <input
            aria-label="담당자"
            onChange={(event) => onChange({ ...draft, owner: event.currentTarget.value })}
            placeholder="담당자"
            value={draft.owner}
            disabled={disabled}
          />
          <input
            aria-label="마감일"
            onChange={(event) => onChange({ ...draft, date: event.currentTarget.value })}
            type="date"
            value={draft.date}
            disabled={disabled}
          />
        </div>
      </>
    );
  }

  function renderAddForm(category: ProjectMemoryCategory) {
    const disabled = isAdding;

    return (
      <form
        className="project-memory-edit-form"
        onSubmit={(event) => void handleCreateMemory(category, event)}
      >
        {renderDraftFields(addDraft, setAddDraft, disabled)}
        <div className="project-memory-form-actions">
          <button disabled={disabled || !addDraft.content.trim()} type="submit">
            <Save size={13} />
            저장
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              setAddingCategory(null);
              setAddDraft(createEmptyDraft());
            }}
            type="button"
          >
            <X size={13} />
            취소
          </button>
        </div>
      </form>
    );
  }

  function renderActionTags(item: ProjectMemoryItem) {
    const dueDateLabel = formatActionDueDate(item.date);
    const completedAt = formatMemoryDate(item.completed_at);

    if (!item.owner && !dueDateLabel && !completedAt) {
      return null;
    }

    return (
      <div className="project-memory-action-tags">
        {item.owner ? <span>담당 {item.owner}</span> : null}
        {dueDateLabel ? (
          <span data-overdue={isActionOverdue(item) ? "true" : undefined}>
            {dueDateLabel}
          </span>
        ) : null}
        {completedAt ? <span>완료 {completedAt}</span> : null}
      </div>
    );
  }

  function renderMemoryItem(item: ProjectMemoryItem, category: ProjectMemoryCategory) {
    const completed = isMemoryItemCompleted(item);
    const verified = isMemoryItemVerified(item);
    const meta = getMemoryItemMeta(item);
    const saving = isItemSaving(item.id);
    const isEditing = editingItemId === item.id;
    const isAction = category === "action";
    const canDragAction = isAction && !completed && !isEditing && !saving;

    if (isEditing) {
      return (
        <form
          className="project-memory-edit-form project-memory-manage-item"
          data-completed={completed}
          data-editing="true"
          key={item.id}
          onSubmit={(event) => void handleSaveEdit(item, event)}
        >
          {renderDraftFields(editDraft, setEditDraft, saving)}
          <div className="project-memory-form-actions">
            <button disabled={saving || !editDraft.content.trim()} type="submit">
              <Save size={13} />
              저장
            </button>
            <button
              disabled={saving}
              onClick={() => setEditingItemId(null)}
              type="button"
            >
              <X size={13} />
              취소
            </button>
          </div>
        </form>
      );
    }

    return (
      <div
        className="project-memory-manage-item"
        data-action={isAction ? "true" : undefined}
        data-completed={completed}
        data-drag-over={dragOverActionId === item.id ? "true" : undefined}
        data-dragging={draggingActionId === item.id ? "true" : undefined}
        draggable={canDragAction}
        key={item.id}
        onDragEnd={canDragAction ? handleActionDragEnd : undefined}
        onDragOver={canDragAction ? (event) => handleActionDragOver(event, item) : undefined}
        onDragStart={canDragAction ? (event) => handleActionDragStart(event, item) : undefined}
        onDrop={canDragAction ? (event) => void handleActionDrop(event, item) : undefined}
      >
        {isAction ? (
          <input
            aria-label={`${item.content} 완료`}
            checked={completed}
            disabled={saving}
            onChange={() => void handleToggleCompleted(item)}
            type="checkbox"
          />
        ) : null}
        <div className="project-memory-manage-copy">
          <p title={item.content}>{item.content}</p>
          <div className="project-memory-manage-meta">
            {verified ? (
              <span className="project-memory-verified-badge">
                <CheckCircle2 size={11} />
                검증됨
              </span>
            ) : null}
            {isAction ? renderActionTags(item) : meta ? <span>{meta}</span> : null}
          </div>
        </div>
        <div className="project-memory-item-actions">
          {canDragAction ? (
            <span className="project-memory-drag-handle" aria-hidden="true" title="드래그로 순서 변경">
              <GripVertical size={13} />
            </span>
          ) : null}
          <button
            aria-label="메모리 수정"
            disabled={saving}
            onClick={() => startEdit(item)}
            title="수정"
            type="button"
          >
            <Pencil size={13} />
          </button>
          <button
            aria-label={pendingDeleteId === item.id ? "메모리 삭제 확인" : "메모리 삭제"}
            data-confirming={pendingDeleteId === item.id ? "true" : undefined}
            disabled={saving}
            onClick={() => void handleDeleteMemory(item)}
            title={pendingDeleteId === item.id ? "삭제 확인" : "삭제"}
            type="button"
          >
            {pendingDeleteId === item.id ? <Check size={13} /> : <Trash2 size={13} />}
          </button>
        </div>
      </div>
    );
  }

  function renderManageSection(category: ProjectMemoryCategory) {
    const { Icon, label, tone } = MEMORY_CATEGORY_META[category];
    const items = category === "action" ? actionItems : groupedItems[category];

    return (
      <article className="overview-memory-card" data-tone={tone} key={category}>
        <div className="project-memory-manage-label">
          <div className="overview-memory-label">
            <Icon size={13} />
            <span>{label}</span>
            <small>{groupedItems[category].length}</small>
          </div>
          <button
            disabled={isAdding || addingCategory === category}
            onClick={() => startAdd(category)}
            type="button"
          >
            <Plus size={13} />
            추가
          </button>
        </div>
        {addingCategory === category ? renderAddForm(category) : null}
        <div className="project-memory-manage-list">
          {items.length === 0 ? (
            <p className="project-memory-empty-row">{MEMORY_CATEGORY_META[category].empty}</p>
          ) : (
            items.map((item) => renderMemoryItem(item, category))
          )}
        </div>
      </article>
    );
  }

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
                  {category === "action" && groupedItems.action.length > 0 ? (
                    <em>완료 {actionCompletedCount}/{groupedItems.action.length}</em>
                  ) : null}
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
      {operationError ? (
        <p className="project-memory-operation-error" role="alert">
          {operationError}
        </p>
      ) : null}

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
      ) : totalCount === 0 && !showManageUi ? (
        <div className="project-memory-server-state" role="status">
          서버에 저장된 프로젝트 메모리가 없습니다.
        </div>
      ) : showManageUi ? (
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
            {MEMORY_CATEGORIES.map((category) => renderManageSection(category))}
          </section>
        </>
      ) : (
        <div className="project-memory-summary-body">
          <section className="project-memory-summary-section" data-tone="action" aria-label="프로젝트 액션">
            <div className="overview-memory-label">
              <ArrowRight size={13} />
              <span>Action</span>
              <small>
                {groupedItems.action.length > 0
                  ? `완료 ${actionCompletedCount}/${groupedItems.action.length}`
                  : groupedItems.action.length}
              </small>
            </div>
            <div className="project-memory-summary-actions">
              {actionItems.slice(0, SUMMARY_ITEM_LIMIT).map((item, index) => (
                <div
                  className="project-memory-summary-action"
                  data-completed={isMemoryItemCompleted(item)}
                  key={getMemoryItemKey(item, index)}
                >
                  <FileText size={16} />
                  <span className="project-memory-summary-content" title={item.content}>
                    {item.content}
                  </span>
                  {renderActionTags(item)}
                </div>
              ))}
              {groupedItems.action.length === 0 ? (
                <p className="project-memory-empty-row">{MEMORY_CATEGORY_META.action.empty}</p>
              ) : null}
              {actionItems.length > SUMMARY_ITEM_LIMIT ? (
                <p className="project-memory-summary-more">
                  외 {actionItems.length - SUMMARY_ITEM_LIMIT}개
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
                    variant="summary"
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
