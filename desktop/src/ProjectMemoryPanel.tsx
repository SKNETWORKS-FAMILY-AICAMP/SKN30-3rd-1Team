import { Check, ChevronDown, GripVertical, Pencil, Save, Trash2, X } from "lucide-react";
import {
  Fragment,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import { fetchPaimJson, getErrorMessage, isPaimApiError } from "./paimApi";
import type {
  ProjectMemoryCategory,
  ProjectMemoryItem,
  ProjectMemorySuggestion,
  ProjectWorkspace,
} from "./types";
import type { SuggestionMinConfidence } from "./settings";

type MemoryLoadState = "idle" | "loading" | "loaded" | "error";
type MemoryTone = ProjectMemoryCategory;

type ProjectMemoryPanelProps = {
  canManage: boolean;
  isMaximized: boolean;
  project: ProjectWorkspace;
  reloadRevision: number;
  suggestionMin: SuggestionMinConfidence;
};

type MemoryDraft = {
  content: string;
  owner: string;
  dueDate: string;
};

type MemoryPatchPayload = {
  content?: string;
  owner?: string;
  due_date?: string | null;
  completed?: boolean;
  sort_order?: number | null;
};

type ActionDropPlacement = "before" | "after";

type ActionDropTarget = {
  id: number;
  placement: ActionDropPlacement;
};

const SUMMARY_ITEM_LIMIT = 5;
const MANAGE_DECISION_LIMIT = 8;
const MEMORY_CATEGORIES: ProjectMemoryCategory[] = ["action", "decision", "issue", "risk"];
const MEMORY_CATEGORY_META: Record<
  ProjectMemoryCategory,
  {
    empty: string;
    label: string;
    tone: MemoryTone;
  }
> = {
  decision: {
    empty: "서버에 저장된 결정사항이 없습니다",
    label: "Decision",
    tone: "decision",
  },
  action: {
    empty: "서버에 저장된 액션이 없습니다",
    label: "Action",
    tone: "action",
  },
  issue: {
    empty: "서버에 저장된 이슈가 없습니다",
    label: "Issue",
    tone: "issue",
  },
  risk: {
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
    dueDate: "",
  };
}

function createDraftFromItem(item: ProjectMemoryItem): MemoryDraft {
  return {
    content: item.content,
    owner: item.owner ?? "",
    dueDate: item.due_date ?? "",
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

function formatCompactMemoryDate(value?: string | null) {
  const normalizedDate = formatMemoryDate(value);

  if (!normalizedDate) {
    return "";
  }

  const [, month, day] = normalizedDate.split("-");

  return month && day ? `${Number(month)}/${Number(day)}` : normalizedDate;
}

function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatActionDueDate(value?: string | null) {
  const compactDate = formatCompactMemoryDate(value);

  if (!compactDate) {
    return "";
  }

  return `~ ${compactDate}`;
}

function formatActionCompletedDate(value?: string | null) {
  const compactDate = formatCompactMemoryDate(value);

  return compactDate ? `${compactDate} 완료` : "";
}

function isActionOverdue(item: ProjectMemoryItem) {
  const dueDate = formatMemoryDate(item.due_date);

  return Boolean(dueDate) && !isMemoryItemCompleted(item) && dueDate < getTodayDateString();
}

function getActionDropTarget(clientX: number, clientY: number): ActionDropTarget | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-action-drop-row="true"]'));

  if (rows.length === 0) {
    return null;
  }

  const firstRect = rows[0].getBoundingClientRect();
  const lastRect = rows[rows.length - 1].getBoundingClientRect();
  const bottomDropPadding = Math.max(64, lastRect.height * 1.5);
  const left = Math.min(...rows.map((row) => row.getBoundingClientRect().left));
  const right = Math.max(...rows.map((row) => row.getBoundingClientRect().right));

  if (
    clientX < left ||
    clientX > right ||
    clientY < firstRect.top - 12 ||
    clientY > lastRect.bottom + bottomDropPadding
  ) {
    return null;
  }

  let row = rows.find((candidate) => {
    const rect = candidate.getBoundingClientRect();

    return clientY >= rect.top && clientY <= rect.bottom;
  });

  if (!row) {
    row = clientY > lastRect.bottom ? rows[rows.length - 1] : rows[0];
  }

  const rect = row.getBoundingClientRect();
  const rawId = Number(row.dataset.actionId);

  if (!Number.isFinite(rawId)) {
    return null;
  }

  return {
    id: rawId,
    placement: clientY > rect.top + rect.height / 2 ? "after" : "before",
  };
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

function formatSuggestionTitle(title: string) {
  const trimmed = title.trim();

  return trimmed.length > 56 ? `${trimmed.slice(0, 56).trim()}...` : trimmed;
}

function createMemoryPatch(item: ProjectMemoryItem, draft: MemoryDraft): MemoryPatchPayload {
  const payload: MemoryPatchPayload = {};

  const content = draft.content.trim();
  const owner = draft.owner.trim();
  const dueDate = draft.dueDate.trim();

  if (item.content !== content) {
    payload.content = content;
  }
  if ((item.owner ?? "") !== owner) {
    payload.owner = owner;
  }
  if ((item.due_date ?? "") !== dueDate) {
    payload.due_date = dueDate || null;
  }

  return payload;
}

function createMemoryPostBody(category: ProjectMemoryCategory, draft: MemoryDraft) {
  const body: Record<string, string> = {
    category,
    content: draft.content.trim(),
  };
  const owner = draft.owner.trim();
  const dueDate = draft.dueDate.trim();

  if (owner) {
    body.owner = owner;
  }
  if (dueDate) {
    body.due_date = dueDate;
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

function getActionMetaParts(item: ProjectMemoryItem) {
  const completedAt = formatActionCompletedDate(item.completed_at);
  const dueDateLabel = formatActionDueDate(item.due_date);
  const parts: Array<{
    isOverdue?: boolean;
    isVerified?: boolean;
    key: string;
    label: string;
  }> = [];

  if (isMemoryItemVerified(item)) {
    parts.push({ isVerified: true, key: "verified", label: "✓ 검증됨" });
  }

  if (item.owner && !completedAt) {
    parts.push({ key: "owner", label: `담당 ${item.owner}` });
  }

  if (completedAt) {
    parts.push({ key: "completed", label: completedAt });
  } else if (dueDateLabel) {
    parts.push({
      isOverdue: isActionOverdue(item),
      key: "due",
      label: isActionOverdue(item) ? `${dueDateLabel} 지남` : dueDateLabel,
    });
  }

  return parts;
}

function renderMetaParts(parts: ReturnType<typeof getActionMetaParts>) {
  if (parts.length === 0) {
    return null;
  }

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 ? <i>·</i> : null}
          <em
            data-overdue={part.isOverdue ? "true" : undefined}
            data-verified={part.isVerified ? "true" : undefined}
          >
            {part.label}
          </em>
        </Fragment>
      ))}
    </>
  );
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

export function ProjectMemoryPanel({
  canManage,
  isMaximized,
  project,
  reloadRevision,
  suggestionMin,
}: ProjectMemoryPanelProps) {
  const [memoryItems, setMemoryItems] = useState<ProjectMemoryItem[]>([]);
  const [memorySuggestions, setMemorySuggestions] = useState<ProjectMemorySuggestion[]>([]);
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
  const [resolvingSuggestionIds, setResolvingSuggestionIds] = useState<number[]>([]);
  const [draggingActionId, setDraggingActionId] = useState<number | null>(null);
  const [dragOverActionId, setDragOverActionId] = useState<number | null>(null);
  const [dragOverPlacement, setDragOverPlacement] = useState<ActionDropPlacement | null>(null);
  const [dragPreview, setDragPreview] = useState<{ content: string; x: number; y: number } | null>(null);
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const [showCompletedActions, setShowCompletedActions] = useState(false);
  const [pendingCompletedActionDelete, setPendingCompletedActionDelete] = useState(false);
  const [isDeletingCompletedActions, setIsDeletingCompletedActions] = useState(false);
  const apiProjectId = project.apiProjectId;
  const groupedItems = useMemo(() => groupMemoryItems(memoryItems), [memoryItems]);
  const memoryItemsById = useMemo(
    () => new Map(memoryItems.map((item) => [item.id, item])),
    [memoryItems],
  );
  const actionItems = useMemo(() => getActionDisplayItems(groupedItems.action), [groupedItems]);
  const actionTodoItems = useMemo(() => getActionTodoItems(groupedItems.action), [groupedItems]);
  const completedActionItems = useMemo(
    () => actionItems.filter(isMemoryItemCompleted),
    [actionItems],
  );
  const visibleMemorySuggestions = useMemo(
    () =>
      suggestionMin === "high"
        ? memorySuggestions.filter((suggestion) => suggestion.confidence === "high")
        : memorySuggestions,
    [memorySuggestions, suggestionMin],
  );
  const suggestedActionIds = useMemo(
    () => new Set(visibleMemorySuggestions.map((suggestion) => suggestion.memory_id)),
    [visibleMemorySuggestions],
  );
  const actionCompletedCount = groupedItems.action.filter(isMemoryItemCompleted).length;
  const actionCompletionPercent = groupedItems.action.length > 0
    ? Math.round((actionCompletedCount / groupedItems.action.length) * 100)
    : 0;
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

  function setSuggestionResolving(suggestionId: number, resolving: boolean) {
    setResolvingSuggestionIds((current) =>
      resolving
        ? [...new Set([...current, suggestionId])]
        : current.filter((itemId) => itemId !== suggestionId),
    );
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
      setMemorySuggestions([]);
      setLoadState("idle");
      setErrorMessage("");
      setOperationError("");
      return;
    }

    setLoadState("loading");
    setErrorMessage("");
    setOperationError("");

    try {
      const [items, suggestions] = await Promise.all([
        fetchPaimJson<ProjectMemoryItem[]>(`/projects/${apiProjectId}/memory`),
        canManage
          ? fetchPaimJson<ProjectMemorySuggestion[]>(
              `/projects/${apiProjectId}/suggestions?status=pending`,
            )
          : Promise.resolve([]),
      ]);

      setMemoryItems(items.filter(isProjectMemoryItem));
      setMemorySuggestions(suggestions);
      setLoadState("loaded");
    } catch (error) {
      setMemoryItems([]);
      setMemorySuggestions([]);
      setErrorMessage(getErrorMessage(error, "프로젝트 메모리를 불러올 수 없습니다"));
      setLoadState("error");
    }
  }

  useEffect(() => {
    void loadProjectMemory();
  }, [apiProjectId, canManage, reloadRevision]);

  useEffect(() => {
    setEditingItemId(null);
    setEditDraft(createEmptyDraft());
    setAddingCategory(null);
    setAddDraft(createEmptyDraft());
    setPendingDeleteId(null);
    setOperationError("");
    setResolvingSuggestionIds([]);
    setDraggingActionId(null);
    setDragOverActionId(null);
    setDragOverPlacement(null);
    setDragPreview(null);
    setShowAllDecisions(false);
    setShowCompletedActions(false);
    setPendingCompletedActionDelete(false);
  }, [apiProjectId, isMaximized]);

  useEffect(() => {
    if (completedActionItems.length === 0) {
      setShowCompletedActions(false);
      setPendingCompletedActionDelete(false);
    }
  }, [completedActionItems.length]);

  useEffect(() => {
    if (draggingActionId === null) {
      return;
    }

    const sourceId = draggingActionId;

    function handlePointerMove(event: PointerEvent) {
      const target = getActionDropTarget(event.clientX, event.clientY);

      setDragPreview((current) =>
        current ? { ...current, x: event.clientX, y: event.clientY } : current,
      );
      setDragOverActionId(target && target.id !== sourceId ? target.id : null);
      setDragOverPlacement(target && target.id !== sourceId ? target.placement : null);
    }

    function handlePointerUp(event: PointerEvent) {
      const target = getActionDropTarget(event.clientX, event.clientY) ??
        (dragOverActionId !== null && dragOverPlacement !== null
          ? { id: dragOverActionId, placement: dragOverPlacement }
          : null);

      setDraggingActionId(null);
      setDragOverActionId(null);
      setDragOverPlacement(null);
      setDragPreview(null);

      if (target && target.id !== sourceId) {
        void reorderActionItems(sourceId, target);
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggingActionId, dragOverActionId, dragOverPlacement, actionTodoItems, memoryItems]);

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
      due_date: editDraft.dueDate.trim() || null,
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

  async function handleDeleteCompletedActions() {
    if (typeof apiProjectId !== "number" || completedActionItems.length === 0) {
      return;
    }

    if (!pendingCompletedActionDelete) {
      setPendingCompletedActionDelete(true);
      setOperationError("");
      return;
    }

    const itemsToDelete = completedActionItems;
    const deletingIds = itemsToDelete.map((item) => item.id);
    let nextItems = memoryItems;

    setOperationError("");
    setIsDeletingCompletedActions(true);
    setSavingItemIds((current) => [...new Set([...current, ...deletingIds])]);

    try {
      for (const item of itemsToDelete) {
        try {
          await fetchPaimJson<void>(`/projects/${apiProjectId}/memory/${item.id}`, {
            method: "DELETE",
          });
        } catch (error) {
          if (!(isPaimApiError(error) && error.status === 404)) {
            throw error;
          }
        }

        nextItems = nextItems.filter((candidate) => candidate.id !== item.id);
        setMemoryItems(nextItems);
      }

      setPendingCompletedActionDelete(false);
      setShowCompletedActions(false);
    } catch (error) {
      setOperationError(getErrorMessage(error, "완료 항목 삭제가 중단되었습니다"));
    } finally {
      setSavingItemIds((current) => current.filter((itemId) => !deletingIds.includes(itemId)));
      setIsDeletingCompletedActions(false);
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

  async function handleResolveSuggestion(suggestion: ProjectMemorySuggestion, resolution: "accept" | "reject") {
    if (typeof apiProjectId !== "number") {
      return;
    }

    const previousSuggestions = memorySuggestions;

    setOperationError("");
    setSuggestionResolving(suggestion.id, true);
    setMemorySuggestions((current) => current.filter((candidate) => candidate.id !== suggestion.id));

    try {
      await fetchPaimJson<void>(
        `/projects/${apiProjectId}/suggestions/${suggestion.id}/${resolution}`,
        { method: "POST" },
      );
      if (resolution === "accept") {
        await loadProjectMemory();
      }
    } catch (error) {
      if (isPaimApiError(error) && error.status === 404) {
        if (resolution === "accept") {
          await loadProjectMemory();
        }
        return;
      }

      setMemorySuggestions(previousSuggestions);
      setOperationError(getErrorMessage(error, "제안을 처리할 수 없습니다"));
    } finally {
      setSuggestionResolving(suggestion.id, false);
    }
  }

  async function reorderActionItems(sourceId: number, target: ActionDropTarget) {
    if (typeof apiProjectId !== "number") {
      return;
    }

    const currentIndex = actionTodoItems.findIndex((candidate) => candidate.id === sourceId);
    const targetIndex = actionTodoItems.findIndex((candidate) => candidate.id === target.id);

    if (currentIndex < 0 || targetIndex < 0) {
      return;
    }

    const reorderedItems = [...actionTodoItems];
    const [movedItem] = reorderedItems.splice(currentIndex, 1);
    let nextIndex = target.placement === "after" ? targetIndex + 1 : targetIndex;

    if (currentIndex < nextIndex) {
      nextIndex -= 1;
    }

    nextIndex = Math.max(0, Math.min(nextIndex, reorderedItems.length));
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

  function handleActionPointerDown(event: ReactPointerEvent<HTMLElement>, item: ProjectMemoryItem) {
    if (event.button !== 0) {
      return;
    }

    if (event.target instanceof HTMLElement && event.target.closest("button, input, textarea, select, a")) {
      return;
    }

    event.preventDefault();
    setDraggingActionId(item.id);
    setDragOverActionId(null);
    setDragOverPlacement(null);
    setDragPreview({ content: item.content, x: event.clientX, y: event.clientY });
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
            onChange={(event) => onChange({ ...draft, dueDate: event.currentTarget.value })}
            type="date"
            value={draft.dueDate}
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

  function renderActionMeta(item: ProjectMemoryItem) {
    const parts = getActionMetaParts(item);
    const hasSuggestion = suggestedActionIds.has(item.id);

    if (parts.length === 0 && !hasSuggestion) {
      return null;
    }

    return (
      <div className="project-memory-action-meta project-memory-meta">
        {renderMetaParts(parts)}
        {parts.length > 0 && hasSuggestion ? <i>·</i> : null}
        {hasSuggestion ? <span className="project-memory-suggestion-mark">완료 제안</span> : null}
      </div>
    );
  }

  function renderSuggestionInbox() {
    if (!canManage || visibleMemorySuggestions.length === 0) {
      return null;
    }

    return (
      <section className="project-memory-suggestion-inbox" aria-label="완료 제안">
        <div className="project-memory-suggestion-head">
          <h2>제안 {visibleMemorySuggestions.length}건</h2>
        </div>
        <div className="project-memory-suggestion-list">
          {visibleMemorySuggestions.map((suggestion) => {
            const action = memoryItemsById.get(suggestion.memory_id);
            const resolving = resolvingSuggestionIds.includes(suggestion.id);
            const title = formatSuggestionTitle(suggestion.evidence.title);

            return (
              <article className="project-memory-suggestion-card" key={suggestion.id}>
                <div className="project-memory-suggestion-copy">
                  <p className="project-memory-suggestion-title">
                    PR #{suggestion.evidence.number} “{title}”이 이 액션을 해결한 것으로 보입니다
                    {suggestion.confidence === "medium" ? (
                      <span className="project-memory-suggestion-badge">추정</span>
                    ) : null}
                  </p>
                  <p className="project-memory-suggestion-action" title={action?.content ?? ""}>
                    {action?.content ?? "대상 액션을 찾을 수 없습니다"}
                  </p>
                  <p className="project-memory-suggestion-rationale">{suggestion.rationale}</p>
                  {suggestion.evidence.url ? (
                    <a
                      className="project-memory-suggestion-link"
                      href={suggestion.evidence.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      PR 링크
                    </a>
                  ) : null}
                </div>
                <div className="project-memory-suggestion-actions">
                  <button
                    className="project-memory-suggestion-accept"
                    disabled={resolving}
                    onClick={() => void handleResolveSuggestion(suggestion, "accept")}
                    type="button"
                  >
                    승인
                  </button>
                  <button
                    className="project-memory-suggestion-reject"
                    disabled={resolving}
                    onClick={() => void handleResolveSuggestion(suggestion, "reject")}
                    type="button"
                  >
                    거절
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
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
        data-action-drop-row={canDragAction ? "true" : undefined}
        data-action-id={canDragAction ? item.id : undefined}
        data-action={isAction ? "true" : undefined}
        data-bullet={!isAction ? "true" : undefined}
        data-completed={completed}
        data-draggable={canDragAction ? "true" : undefined}
        data-drag-over={dragOverActionId === item.id ? "true" : undefined}
        data-drag-placement={dragOverActionId === item.id ? dragOverPlacement ?? undefined : undefined}
        data-dragging={draggingActionId === item.id ? "true" : undefined}
        key={item.id}
        onPointerDown={canDragAction ? (event) => handleActionPointerDown(event, item) : undefined}
      >
        {isAction ? (
          <input
            aria-label={`${item.content} 완료`}
            checked={completed}
            className="project-memory-check-circle"
            disabled={saving}
            onChange={() => void handleToggleCompleted(item)}
            type="checkbox"
          />
        ) : (
          <span className="project-memory-bullet">·</span>
        )}
        <div className="project-memory-manage-copy">
          <p title={item.content}>{item.content}</p>
          <div className="project-memory-manage-meta">
            {isAction ? (
              renderActionMeta(item)
            ) : (
              <>
                {verified ? <em data-verified="true">✓ 검증됨</em> : null}
                {verified && meta ? <i>·</i> : null}
                {meta ? <span>{meta}</span> : null}
              </>
            )}
          </div>
        </div>
        <div className="project-memory-item-actions">
          {canDragAction ? (
            <span
              className="project-memory-drag-handle"
              aria-hidden="true"
              title="드래그로 순서 변경"
            >
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

  function renderCompletedActionGroup() {
    if (completedActionItems.length === 0) {
      return null;
    }

    const deleteLabel = pendingCompletedActionDelete
      ? `완료된 액션 ${completedActionItems.length}개를 삭제합니다 — 되돌릴 수 없음`
      : "완료 항목 모두 삭제";

    return (
      <div
        className="project-memory-completed-group"
        data-open={showCompletedActions ? "true" : undefined}
      >
        <button
          aria-expanded={showCompletedActions}
          className="project-memory-completed-toggle"
          onClick={() => {
            setShowCompletedActions((current) => !current);
            setPendingCompletedActionDelete(false);
          }}
          type="button"
        >
          <ChevronDown size={13} />
          완료됨 {completedActionItems.length}
        </button>
        {showCompletedActions ? (
          <div className="project-memory-completed-body">
            <div className="project-memory-completed-actions">
              <button
                className="project-memory-completed-delete"
                data-confirming={pendingCompletedActionDelete ? "true" : undefined}
                disabled={!showManageUi || isDeletingCompletedActions}
                onClick={() => void handleDeleteCompletedActions()}
                type="button"
              >
                <Trash2 size={13} />
                {deleteLabel}
              </button>
            </div>
            {completedActionItems.map((item) => renderMemoryItem(item, "action"))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderManageSection(category: ProjectMemoryCategory) {
    const { label, tone } = MEMORY_CATEGORY_META[category];
    const allItems = category === "action" ? actionTodoItems : groupedItems[category];
    const shouldLimitDecision = category === "decision" && !showAllDecisions;
    const items = shouldLimitDecision ? allItems.slice(0, MANAGE_DECISION_LIMIT) : allItems;
    const hiddenDecisionCount = Math.max(allItems.length - items.length, 0);
    const isActionSection = category === "action";
    const hasSectionItems = isActionSection ? groupedItems.action.length > 0 : allItems.length > 0;

    return (
      <article className="project-memory-manage-section" data-tone={tone} key={category}>
        <div className="project-memory-manage-label">
          <h2 data-tone={tone}>{label}</h2>
          <small>
            {category === "action" && groupedItems.action.length > 0
              ? `완료 ${actionCompletedCount}/${groupedItems.action.length}`
              : groupedItems[category].length}
          </small>
          <span className="project-memory-label-spacer" />
          <button
            disabled={isAdding || addingCategory === category}
            onClick={() => startAdd(category)}
            type="button"
          >
            ＋ 추가
          </button>
        </div>
        {addingCategory === category ? renderAddForm(category) : null}
        <div className="project-memory-manage-list">
          {!hasSectionItems ? (
            <p className="project-memory-empty-row">{MEMORY_CATEGORY_META[category].empty}</p>
          ) : (
            <>
              {items.map((item) => renderMemoryItem(item, category))}
              {isActionSection ? renderCompletedActionGroup() : null}
            </>
          )}
        </div>
        {category === "decision" && (hiddenDecisionCount > 0 || showAllDecisions) ? (
          <button
            className="project-memory-more-button"
            onClick={() => setShowAllDecisions((current) => !current)}
            type="button"
          >
            {showAllDecisions ? "접기" : `외 ${hiddenDecisionCount}개 모두 보기`}
          </button>
        ) : null}
      </article>
    );
  }

  function renderStatsStrip() {
    return (
      <div className="project-memory-stats" aria-label="프로젝트 메모리 요약">
        {MEMORY_CATEGORIES.map((category) => (
          <div className="project-memory-stat" data-tone={category} key={category}>
            <strong>{groupedItems[category].length}</strong>
            <span>{MEMORY_CATEGORY_META[category].label}</span>
            {category === "action" ? (
              <div
                className="project-memory-action-progress"
                title={`완료 ${actionCompletedCount}/${groupedItems.action.length}`}
              >
                <i style={{ width: `${actionCompletionPercent}%` }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
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
          {!isMaximized ? renderStatsStrip() : null}
        </div>
      </div>
      {operationError ? (
        <p className="project-memory-operation-error" role="alert">
          {operationError}
        </p>
      ) : null}
      {renderSuggestionInbox()}

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
          {renderStatsStrip()}

          <section className="project-memory-manage" aria-label="프로젝트 메모리">
            <div className="project-memory-manage-column">
              {renderManageSection("action")}
              {renderManageSection("issue")}
              {renderManageSection("risk")}
            </div>
            <div className="project-memory-manage-column">
              {renderManageSection("decision")}
            </div>
          </section>
          {dragPreview ? (
            <div
              className="project-memory-drag-preview"
              style={{ left: dragPreview.x + 12, top: dragPreview.y + 12 }}
            >
              {dragPreview.content}
            </div>
          ) : null}
        </>
      ) : (
        <div className="project-memory-summary-body">
          <section className="project-memory-summary-section" data-tone="action" aria-label="프로젝트 액션">
            <div className="project-memory-section-head">
              <h2 data-tone="action">Action</h2>
              <span className="project-memory-label-spacer" />
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
                  {canManage && typeof apiProjectId === "number" ? (
                    <input
                      aria-label={`${item.content} 완료`}
                      checked={isMemoryItemCompleted(item)}
                      className="project-memory-check-circle"
                      disabled={isItemSaving(item.id)}
                      onChange={() => void handleToggleCompleted(item)}
                      type="checkbox"
                    />
                  ) : (
                    <span className="project-memory-check-circle" aria-hidden="true" />
                  )}
                  <span className="project-memory-summary-content" title={item.content}>
                    {item.content}
                  </span>
                  {renderActionMeta(item)}
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
              const { label, tone } = MEMORY_CATEGORY_META[category];

              return (
                <article
                  className="project-memory-summary-section"
                  data-tone={tone}
                  key={category}
                >
                  <div className="project-memory-section-head">
                    <h2 data-tone={tone}>{label}</h2>
                    <span className="project-memory-label-spacer" />
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
