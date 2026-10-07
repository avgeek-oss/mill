import { QueryFeedback } from "./query-feedback.js";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRight02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button,
  HistoryTable,
  QueryLoading,
  TypographyParagraph,
  TypographyText,
  useOverlaySuspension,
} from "@avgeek-oss/design-system";
import { ErrorMessage, useAppSuspended } from "@mill/web-design-system";
import { UserAvatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Tabs } from "@avgeek-oss/design-system/navigation/tabs";
import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";
import { Textarea } from "@avgeek-oss/design-system/forms/textarea";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import type {
  Activity,
  Comment,
  Member,
} from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  isResponseObject,
  type NavigationRequest,
  type User,
} from "./api.js";
import { activityLabel } from "./activity-label.js";
import { Markdown } from "./markdown.js";
import { mentionPopupPosition, textareaCaretRect } from "./mention-caret.js";
import { RelativeDateTime } from "./relative-date-time.js";
import { formatDate, formatDateTime } from "./date-time-preferences.js";
import { hasCommentResponse, hasOkResponse } from "./responses.js";
import { useSettingsMutation } from "./use-settings-mutation.js";

type DiscussionKind = "comments" | "activity";
type DiscussionItem = Comment | Activity;
type Boundary = Pick<DiscussionItem, "id" | "createdAt">;
type MentionMatch = {
  start: number;
  end: number;
  query: string;
};
type Page<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
};
type Collection<T> = Page<T> & {
  ready: boolean;
  busy: boolean;
  error: string;
  boundary: Boundary | null;
};

export type TaskDiscussionProps = {
  taskId: string;
  user: User;
  editable: boolean;
  refreshKey?: number;
  sessionRevision: number;
  members?: Member[];
};

function compareItems(a: Boundary, b: Boundary) {
  const order =
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  return -order;
}

function itemVersion(item: DiscussionItem) {
  return "version" in item ? item.version : 0;
}

function CommentDate({ value, user }: { value: string; user: User }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const dateText = formatDate(date, user);
  const fullDate = formatDateTime(date, user);
  return (
    <TooltipText
      as="time"
      dateTime={value}
      tooltip={fullDate}
      tabIndex={0}
      aria-label={`Commented: ${fullDate}`}
      className="shrink-0 whitespace-nowrap text-xs/4 text-muted"
    >
      {dateText}
    </TooltipText>
  );
}

function activityEntity(action: string) {
  if (action.startsWith("comment.")) return "Comment";
  if (action.startsWith("task.")) return "Task";
  return "Change";
}

function activityConnectionLabel(detail: unknown) {
  if (!isResponseObject(detail) || !isResponseObject(detail.connection))
    return null;
  switch (detail.connection.type) {
    case "session":
      return "Browser";
    case "api-key":
      return "API key";
    case "oauth":
      return "MCP";
    default:
      return null;
  }
}

function mentionAtCaret(
  value: string,
  caret: number,
): Omit<MentionMatch, "source"> | null {
  const match = /(^|[^\p{L}\p{N}_])@([^\n@]{0,60})$/u.exec(
    value.slice(0, caret),
  );
  if (!match || /\s$/.test(match[2])) return null;
  return { start: caret - match[2].length - 1, end: caret, query: match[2] };
}

function mergeItems<T extends DiscussionItem>(previous: T[], incoming: T[]) {
  const items = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = items.get(item.id);
    if (existing && itemVersion(existing) > itemVersion(item)) continue;
    items.set(item.id, item);
  }
  return [...items.values()].sort(compareItems);
}

function hasDiscussionPage(value: unknown, kind: DiscussionKind) {
  if (
    !isResponseObject(value) ||
    !Array.isArray(value.items) ||
    typeof value.hasMore !== "boolean"
  )
    return false;
  if (
    !value.items.every(
      (item: unknown) =>
        isResponseObject(item) &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.taskId === "string" &&
        typeof item.createdAt === "string" &&
        (kind === "comments"
          ? hasCommentResponse({ comment: item })
          : typeof item.actorId === "string" &&
            typeof item.actorName === "string" &&
            (item.actorKind === "human" || item.actorKind === "oauth") &&
            typeof item.action === "string"),
    )
  )
    return false;
  return value.hasMore
    ? value.items.length > 0 &&
        typeof value.nextCursor === "string" &&
        value.nextCursor === value.items.at(-1)?.id
    : value.nextCursor === null;
}

function useDiscussionPages<T extends DiscussionItem>(
  taskId: string,
  kind: DiscussionKind,
) {
  const overlay = useOverlaySuspension();
  const capture = useRef(overlay.capture);
  const runQuery = useSettingsMutation(`${taskId}:${kind}`);
  const [collection, setCollection] = useState<Collection<T>>({
    items: [],
    hasMore: false,
    nextCursor: null,
    ready: false,
    busy: true,
    error: "",
    boundary: null,
  });
  const current = useRef(collection);
  const mounted = useRef(true);
  const latestRequest = useRef(0);
  useLayoutEffect(() => {
    capture.current = overlay.capture;
  }, [overlay.capture]);
  const update = useCallback(
    (change: (previous: Collection<T>) => Collection<T>) => {
      const next = change(current.current);
      current.current = next;
      setCollection(next);
      return next;
    },
    [],
  );

  const load = useCallback(
    async (more: boolean): Promise<T[] | null> => {
      const captured = capture.current();
      if (!mounted.current || !captured()) return null;
      const previous = current.current;
      if (more && (!previous.hasMore || !previous.nextCursor || previous.busy))
        return null;
      const request = ++latestRequest.current;
      const isCurrent = () =>
        mounted.current && captured() && request === latestRequest.current;
      const lastVisible = previous.items.at(-1);
      const refreshBoundary =
        previous.boundary &&
        (!lastVisible || compareItems(previous.boundary, lastVisible) >= 0)
          ? previous.boundary
          : (lastVisible ?? null);
      update((state) => ({ ...state, busy: true, error: "" }));
      try {
        const collected: T[] = [];
        const seenCursors = new Set<string>();
        let cursor = more ? previous.nextCursor : null;
        if (cursor) seenCursors.add(cursor);
        let page: Page<T>;
        do {
          const params = new URLSearchParams({ limit: "100" });
          if (cursor) params.set("cursor", cursor);
          page = await runQuery((signal) =>
            api<Page<T>>(
              `/tasks/${taskId}/${kind}?${params}`,
              undefined,
              "GET",
              {
                signal,
                validateResponse: (value) => hasDiscussionPage(value, kind),
              },
            ),
          );
          if (!isCurrent()) return null;
          if (page.items.some((item) => item.taskId !== taskId))
            throw new Error(
              "The server returned discussion for a different task. Try again.",
            );
          collected.push(...page.items);
          const last = page.items.at(-1);
          if (
            more ||
            !page.hasMore ||
            !refreshBoundary ||
            (last && compareItems(last, refreshBoundary) >= 0)
          )
            break;
          cursor = page.nextCursor;
          if (!cursor || seenCursors.has(cursor))
            throw new Error(
              "The discussion page did not advance. Try loading it again.",
            );
          seenCursors.add(cursor);
        } while (cursor);
        const boundary = page.items.at(-1) ?? null;
        const next = update((state) => {
          const retained = more
            ? state.items
            : page.hasMore && boundary
              ? state.items.filter((item) => compareItems(item, boundary) > 0)
              : [];
          return {
            items: mergeItems(retained, collected),
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            ready: true,
            busy: false,
            error: "",
            boundary,
          };
        });
        return next.items;
      } catch (error) {
        if (isCurrent())
          update((state) => ({ ...state, error: errorText(error) }));
        return null;
      } finally {
        if (isCurrent()) update((state) => ({ ...state, busy: false }));
      }
    },
    [taskId, kind, update, runQuery],
  );

  useLayoutEffect(() => {
    mounted.current = !overlay.isSuspended;
    if (overlay.isSuspended) {
      ++latestRequest.current;
      update((state) => ({ ...state, busy: false }));
    }
    return () => {
      mounted.current = false;
      ++latestRequest.current;
    };
  }, [overlay.isSuspended, update]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(false), [load]);
  const loadMore = useCallback(() => load(true), [load]);
  const updateItems = useCallback(
    (change: (items: T[]) => T[]) =>
      update((state) => ({ ...state, items: change(state.items) })),
    [update],
  );
  return { ...collection, refresh, loadMore, updateItems };
}

export function TaskDiscussion(props: TaskDiscussionProps) {
  return (
    <TaskDiscussionContent
      key={`${props.taskId}:${props.user.id}`}
      {...props}
    />
  );
}

function TaskDiscussionContent({
  taskId,
  user,
  editable,
  refreshKey,
  sessionRevision,
  members,
}: TaskDiscussionProps) {
  const appSuspended = useAppSuspended();
  const overlay = useOverlaySuspension();
  const runMutation = useSettingsMutation(`${taskId}:${user.id}`);
  const comments = useDiscussionPages<Comment>(taskId, "comments");
  const activity = useDiscussionPages<Activity>(taskId, "activity");
  const [tab, setTab] = useState("comments");
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentError, setCommentError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [navigationNotice, setNavigationNotice] = useState(false);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const mentionListId = useId();
  const [createKey] = useState(createRetryKey);
  const [deleteKey] = useState(createRetryKey);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const pendingMentionCaret = useRef<number | null>(null);
  const mentionContainer = useRef<HTMLDivElement>(null);
  const mentionPopup = useRef<HTMLDivElement>(null);
  const [mentionPosition, setMentionPosition] = useState<ReturnType<
    typeof mentionPopupPosition
  > | null>(null);
  const selectedMentions = useRef<{ id: string; token: string }[]>([]);
  const currentDraft = useRef("");
  const mutationPending = useRef(false);
  const mutationOutcome = useRef<Promise<boolean> | null>(null);
  const finishPendingMutation = useRef<((saved: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const previousSessionRevision = useRef(sessionRevision);
  const writable = editable && user.role !== "viewer" && !appSuspended;
  const canSubmitComment =
    writable && !!draft.trim() && !busy && !comments.busy && comments.ready;
  const canChange = (item: Comment) =>
    writable && (item.authorId === user.id || user.role === "admin");
  const mentionCandidates = mention
    ? (members ?? [])
        .filter((member) =>
          `${member.name} ${member.email}`
            .toLocaleLowerCase()
            .includes(mention.query.toLocaleLowerCase()),
        )
        .slice(0, 8)
    : [];

  function updateMention(value: string, caret: number) {
    const match = mentionAtCaret(value, caret);
    const selected =
      match &&
      selectedMentions.current.some(
        (item) => item.token === value.slice(match.start, match.end),
      );
    setMention(selected ? null : match);
    setActiveMention(0);
  }

  function insertMention(member: Member) {
    if (!mention) return;
    if (
      selectedMentions.current.length >= 50 &&
      !selectedMentions.current.some((item) => item.id === member.id)
    ) {
      toast.danger("A comment can mention up to 50 people.");
      return;
    }
    const token = `@${member.name}`;
    const current = currentDraft.current;
    const before = current.slice(0, mention.start);
    const after = current.slice(mention.end);
    const separator = /^\s/.test(after) ? "" : " ";
    const next = `${before}${token}${separator}${after}`;
    const caret = before.length + token.length + separator.length;
    pendingMentionCaret.current = caret;
    changeDraft(next);
    selectedMentions.current = [
      ...selectedMentions.current.filter((item) => item.id !== member.id),
      { id: member.id, token },
    ];
    setMention(null);
    setCommentError("");
  }

  useLayoutEffect(() => {
    const caret = pendingMentionCaret.current;
    if (caret === null) return;
    pendingMentionCaret.current = null;
    const input = commentInput.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(caret, caret);
  }, [draft]);

  function humanAvatar(id: string, name: string, className: string) {
    const member = members?.find((item) => item.id === id);
    return (
      <UserAvatar
        email={member?.email ?? (id === user.id ? user.email : "")}
        name={member?.name ?? (id === user.id ? user.name : name)}
        size="sm"
        className={className}
      />
    );
  }

  function changeDraft(value: string) {
    currentDraft.current = value;
    setMention(null);
    selectedMentions.current = selectedMentions.current.filter((item) =>
      value.includes(item.token),
    );
    setDraft(value);
    if (!value.trim()) setNavigationNotice(false);
  }

  function hasUnsentDraft() {
    return Boolean(currentDraft.current.trim());
  }

  function warnAboutDraft() {
    setTab("comments");
    setNavigationNotice(true);
    toast.danger(
      "You have an unsent comment. Submit it or clear the draft before leaving this task.",
    );
    commentInput.current?.focus();
  }

  const beforeNavigate = useEffectEvent((event: Event) => {
    const destination = (event as CustomEvent<NavigationRequest>).detail;
    const outcome = mutationOutcome.current;
    if (outcome) {
      event.preventDefault();
      destination.waitUntil(
        outcome.then((saved) => {
          if (!saved || !mounted.current) return false;
          if (!hasUnsentDraft()) return true;
          warnAboutDraft();
          return false;
        }),
      );
    } else if (hasUnsentDraft()) {
      event.preventDefault();
      destination.waitUntil(Promise.resolve(false));
      warnAboutDraft();
    }
  });

  const beforeUnload = useEffectEvent((event: BeforeUnloadEvent) => {
    if (!mutationPending.current && !hasUnsentDraft()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  useEffect(() => {
    window.addEventListener("mill:before-navigate", beforeNavigate);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("mill:before-navigate", beforeNavigate);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  function beginMutation() {
    let settle!: (saved: boolean) => void;
    const outcome = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    mutationOutcome.current = outcome;
    mutationPending.current = true;
    setBusy(true);
    const finish = (saved: boolean) => {
      if (mutationOutcome.current === outcome) {
        mutationOutcome.current = null;
        mutationPending.current = false;
        finishPendingMutation.current = null;
        if (mounted.current) setBusy(false);
      }
      settle(saved);
    };
    finishPendingMutation.current = finish;
    return finish;
  }

  useLayoutEffect(() => {
    mounted.current = true;
    setBusy(false);
    if (appSuspended || overlay.isSuspended) {
      ++generation.current;
      finishPendingMutation.current?.(false);
    }
    return () => {
      mounted.current = false;
      ++generation.current;
      finishPendingMutation.current?.(false);
    };
  }, [appSuspended, overlay.isSuspended]);

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void activity.refresh();
  }, [refreshKey, activity.refresh]);

  useEffect(() => {
    if (previousSessionRevision.current === sessionRevision) return;
    previousSessionRevision.current = sessionRevision;
    void comments.refresh();
    void activity.refresh();
  }, [sessionRevision, comments.refresh, activity.refresh]);

  useEffect(() => {
    if (!mention) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const container = mentionContainer.current;
      if (
        !container?.contains(event.target as Node) &&
        !mentionPopup.current?.contains(event.target as Node)
      )
        setMention(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [mention]);

  useLayoutEffect(() => {
    const input = commentInput.current;
    if (!mention || !input || appSuspended) return;
    const positionPopup = () => {
      const caret = textareaCaretRect(input);
      const viewport = window.visualViewport;
      if (!caret.visible) {
        setMentionPosition(null);
        return;
      }
      setMentionPosition(
        mentionPopupPosition(
          caret,
          {
            left: viewport?.offsetLeft ?? 0,
            top: viewport?.offsetTop ?? 0,
            width: viewport?.width ?? window.innerWidth,
            height: viewport?.height ?? window.innerHeight,
          },
          mentionPopup.current?.scrollHeight ?? 256,
        ),
      );
    };
    positionPopup();
    const resize = new ResizeObserver(positionPopup);
    resize.observe(input);
    if (mentionPopup.current) resize.observe(mentionPopup.current);
    input.addEventListener("scroll", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    window.addEventListener("resize", positionPopup);
    window.visualViewport?.addEventListener("resize", positionPopup);
    window.visualViewport?.addEventListener("scroll", positionPopup);
    return () => {
      resize.disconnect();
      input.removeEventListener("scroll", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
      window.removeEventListener("resize", positionPopup);
      window.visualViewport?.removeEventListener("resize", positionPopup);
      window.visualViewport?.removeEventListener("scroll", positionPopup);
    };
  }, [mention, mentionCandidates.length, appSuspended]);

  useLayoutEffect(() => {
    if (!mention || appSuspended) return;
    const popup = mentionPopup.current;
    const active = document.getElementById(
      `${mentionListId}-${mentionCandidates[activeMention]?.id}`,
    );
    if (!popup || !active) return;
    if (active.offsetTop < popup.scrollTop) {
      popup.scrollTop = active.offsetTop;
    } else if (
      active.offsetTop + active.offsetHeight >
      popup.scrollTop + popup.clientHeight
    ) {
      popup.scrollTop =
        active.offsetTop + active.offsetHeight - popup.clientHeight;
    }
  }, [mention, activeMention, mentionListId, mentionCandidates, appSuspended]);

  async function submitComment() {
    const body = currentDraft.current;
    if (
      !writable ||
      !body.trim() ||
      !comments.ready ||
      comments.busy ||
      mutationPending.current
    )
      return;
    const requestGeneration = generation.current;
    const captured = overlay.capture();
    const isCurrent = () =>
      mounted.current && captured() && generation.current === requestGeneration;
    const path = `/tasks/${taskId}/comments`;
    const payload = {
      body,
      mentionIds: [...new Set(selectedMentions.current.map((item) => item.id))],
    };
    const finishMutation = beginMutation();
    let succeeded = false;
    setCommentError("");
    try {
      const result = await runMutation((signal) =>
        api<{ comment: Comment }>(path, payload, "POST", {
          signal,
          validateResponse: (value) =>
            hasCommentResponse(value) &&
            isResponseObject(value) &&
            isResponseObject(value.comment) &&
            value.comment.taskId === taskId,
          headers: {
            "Idempotency-Key": createKey.forRequest(path, payload),
          },
        }),
      );
      if (!isCurrent()) return;
      createKey.reset();
      const saved = {
        ...result.comment,
        authorName: result.comment.authorName ?? user.name,
      };
      comments.updateItems((items) => mergeItems(items, [saved]));
      changeDraft("");
      toast.success("Comment added.");
      void activity.refresh();
      succeeded = true;
    } catch (error) {
      if (isCurrent()) {
        setCommentError(errorText(error));
      }
    } finally {
      finishMutation(succeeded && isCurrent());
    }
  }

  async function deleteComment() {
    if (
      !deleting ||
      !canChange(deleting) ||
      comments.busy ||
      mutationPending.current
    )
      return;
    const target = deleting;
    const requestGeneration = generation.current;
    const captured = overlay.capture();
    const isCurrent = () =>
      mounted.current && captured() && generation.current === requestGeneration;
    const path = `/comments/${target.id}`;
    const payload = { version: target.version };
    const finishMutation = beginMutation();
    let succeeded = false;
    setDeleteError("");
    setDeleteConflict(false);
    try {
      await runMutation((signal) =>
        api(path, payload, "DELETE", {
          signal,
          validateResponse: hasOkResponse,
          headers: {
            "Idempotency-Key": deleteKey.forRequest(path, payload, "DELETE"),
          },
        }),
      );
      if (!isCurrent()) return;
      deleteKey.reset();
      comments.updateItems((items) =>
        items.filter((item) => item.id !== target.id),
      );
      setDeleting(null);
      toast.success("Comment deleted.");
      void comments.refresh();
      void activity.refresh();
      succeeded = true;
    } catch (error) {
      if (isCurrent()) {
        setDeleteError(errorText(error));
        setDeleteConflict(error instanceof ApiError && error.status === 409);
      }
    } finally {
      finishMutation(succeeded && isCurrent());
    }
  }

  async function reloadDeletingComment() {
    if (!deleting || appSuspended || mutationPending.current) return;
    const target = deleting;
    const requestGeneration = generation.current;
    const captured = overlay.capture();
    const isCurrent = () =>
      mounted.current && captured() && generation.current === requestGeneration;
    const finishMutation = beginMutation();
    setDeleteError("");
    try {
      const items = await comments.refresh();
      if (!isCurrent() || !items) return;
      const latest = items.find((item) => item.id === target.id);
      if (!latest) {
        setDeleteError(
          "This comment has already been deleted. Close this confirmation to continue.",
        );
        return;
      }
      setDeleting((current) => (current?.id === target.id ? latest : current));
      setDeleteConflict(false);
    } finally {
      finishMutation(false);
    }
  }

  function closeDelete() {
    if (mutationPending.current) return;
    setDeleting(null);
    setDeleteError("");
    setDeleteConflict(false);
  }

  function handleEditorKeyDown(
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    if (event.nativeEvent.isComposing) return;
    if (mention) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (event.key === "Tab" && !mentionCandidates.length) {
        setMention(null);
        return;
      }
      if (mentionCandidates.length) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveMention((activeMention + 1) % mentionCandidates.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveMention(
            (activeMention - 1 + mentionCandidates.length) %
              mentionCandidates.length,
          );
          return;
        }
        if (
          (event.key === "Enter" && !event.metaKey && !event.ctrlKey) ||
          event.key === "Tab"
        ) {
          event.preventDefault();
          insertMention(mentionCandidates[activeMention]);
          return;
        }
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function mentionOptions() {
    if (!mention || appSuspended) return null;
    return createPortal(
      <div
        ref={mentionPopup}
        className="popover fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-separator bg-overlay p-1"
        style={
          mentionPosition
            ? mentionPosition
            : { visibility: "hidden", width: 320, maxHeight: 256 }
        }
        onPointerDown={(event) => event.preventDefault()}
      >
        <div id={mentionListId} role="listbox" aria-label="Mention a person">
          {mentionCandidates.length ? (
            mentionCandidates.map((member, index) => (
              <div
                key={member.id}
                id={`${mentionListId}-${member.id}`}
                role="option"
                aria-label={member.name}
                aria-selected={index === activeMention}
                className={`flex min-h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm/5 text-foreground hover:bg-default ${index === activeMention ? "bg-default" : ""}`}
                onClick={() => insertMention(member)}
                onMouseEnter={() => setActiveMention(index)}
              >
                <span aria-hidden="true" className="shrink-0">
                  <UserAvatar
                    email={member.email}
                    name={member.name}
                    size="sm"
                  />
                </span>
                <span className="min-w-0 truncate">{member.name}</span>
              </div>
            ))
          ) : (
            <TypographyParagraph size="sm" color="muted" className="px-2 py-2">
              No people found.
            </TypographyParagraph>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <section
      className="task-page-discussion min-w-0"
      aria-label="Task discussion"
    >
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => setTab(String(key))}
        className="min-w-0"
      >
        <Tabs.ListContainer className="w-fit max-w-full">
          <Tabs.List aria-label="Task discussion">
            <Tabs.Tab id="comments" className="whitespace-nowrap">
              Comments{comments.ready ? ` (${comments.items.length})` : ""}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="activity" className="whitespace-nowrap">
              Activity
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel
          id="comments"
          className="grid min-w-0 gap-5 pt-4"
          aria-busy={comments.busy}
        >
          {writable && (
            <form
              className="grid min-w-0 gap-3"
              aria-busy={busy}
              onSubmit={(event) => {
                event.preventDefault();
                void submitComment();
              }}
            >
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                <div ref={mentionContainer} className="relative min-w-0">
                  <Textarea
                    ref={commentInput}
                    variant="primary"
                    aria-label="Add a comment"
                    placeholder="Add a comment…"
                    className="min-h-20 w-full min-w-0 resize-y"
                    rows={2}
                    value={draft}
                    disabled={busy}
                    maxLength={10000}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={!!mention}
                    aria-controls={mention ? mentionListId : undefined}
                    aria-activedescendant={
                      mention && mentionCandidates[activeMention]
                        ? `${mentionListId}-${mentionCandidates[activeMention].id}`
                        : undefined
                    }
                    onChange={(event) => {
                      changeDraft(event.target.value);
                      updateMention(
                        event.target.value,
                        event.target.selectionStart,
                      );
                    }}
                    onSelect={(event) =>
                      updateMention(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart,
                      )
                    }
                    onKeyDown={handleEditorKeyDown}
                    onCompositionStart={() => setMention(null)}
                    onCompositionEnd={(event) =>
                      updateMention(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart,
                      )
                    }
                  />
                  {mentionOptions()}
                </div>
                <Button
                  type="submit"
                  variant={canSubmitComment ? "primary" : "secondary"}
                  isIconOnly
                  aria-label="Send comment"
                  className="shrink-0 self-start rounded-lg"
                  isDisabled={!canSubmitComment}
                  isPending={busy && !deleting}
                >
                  <HugeiconsIcon aria-hidden icon={ArrowRight02Icon} />
                </Button>
              </div>
              <ErrorMessage>{commentError}</ErrorMessage>
            </form>
          )}
          {navigationNotice && (
            <div>
              <Button
                variant="secondary"
                className="w-fit"
                isDisabled={busy}
                onPress={() => {
                  if (mutationPending.current) return;
                  changeDraft("");
                  commentInput.current?.focus();
                }}
              >
                Clear draft
              </Button>
            </div>
          )}
          {comments.error && (
            <QueryFeedback
              message={`Unable to load comments. ${comments.error}`}
              onRetry={
                comments.busy || busy
                  ? undefined
                  : () => void comments.refresh()
              }
            />
          )}
          {comments.busy && !comments.ready && (
            <QueryLoading className="sr-only">Loading comments…</QueryLoading>
          )}
          <div className="grid min-w-0 gap-6">
            {comments.items.map((item) => {
              const name =
                item.authorName ||
                (item.authorId === user.id ? user.name : "Unknown member");
              return (
                <article
                  key={item.id}
                  className="task-comment min-w-0"
                  aria-label={`Comment by ${name}`}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    {humanAvatar(item.authorId, name, "mt-0.5 shrink-0")}
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <TypographyText className="min-w-0 truncate text-sm/5 font-medium">
                          {name}
                        </TypographyText>
                        <CommentDate value={item.createdAt} user={user} />
                      </div>
                      <div className="min-w-0 break-words text-sm text-muted">
                        <Markdown>{item.body}</Markdown>
                      </div>
                    </div>
                    {canChange(item) && (
                      <Button
                        variant="danger-soft"
                        isIconOnly
                        className="task-comment-delete shrink-0"
                        aria-label={`Delete comment by ${name}`}
                        isDisabled={busy || comments.busy}
                        onPress={() => {
                          setDeleting(item);
                          setDeleteError("");
                          setDeleteConflict(false);
                        }}
                      >
                        <HugeiconsIcon aria-hidden icon={Delete02Icon} />
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
            {comments.ready && !comments.error && !comments.items.length && (
              <TypographyParagraph size="sm" color="muted" className="py-3">
                No comments yet.
              </TypographyParagraph>
            )}
          </div>
          {comments.hasMore && (
            <Button
              variant="secondary"
              className="w-fit"
              isDisabled={busy || comments.busy}
              onPress={() => void comments.loadMore()}
            >
              Load more comments
            </Button>
          )}
        </Tabs.Panel>
        <Tabs.Panel
          id="activity"
          className="grid min-w-0 gap-4 pt-4"
          aria-busy={activity.busy}
        >
          {activity.error && (
            <QueryFeedback
              message={`Unable to load activity. ${activity.error}`}
              onRetry={
                activity.busy ? undefined : () => void activity.refresh()
              }
            />
          )}
          {(activity.ready || !activity.error) && (
            <HistoryTable
              label="Task activity"
              items={activity.items}
              emptyDescription="Task changes and comment actions appear here."
              isLoading={!activity.ready && activity.busy}
              isRefreshing={activity.ready && activity.busy}
              columns={[
                {
                  key: "action",
                  header: "Action",
                  isRowHeader: true,
                  cell: (item) => (
                    <TableCellStack>
                      <span>
                        {activityLabel(item.action).replace(/^./, (letter) =>
                          letter.toUpperCase(),
                        )}
                      </span>
                      <TableCellDescription className="flex min-w-0 items-center gap-1.5">
                        {humanAvatar(item.actorId, item.actorName, "shrink-0")}
                        <span className="min-w-0 break-words">
                          {item.actorName}
                        </span>
                        {activityConnectionLabel(item.detail) && (
                          <span className="shrink-0">
                            · {activityConnectionLabel(item.detail)}
                          </span>
                        )}
                      </TableCellDescription>
                    </TableCellStack>
                  ),
                },
                {
                  key: "entity",
                  header: "Entity",
                  headerClassName: "w-28",
                  cell: (item) => (
                    <Chip
                      color={
                        item.action.startsWith("task.") ? "accent" : "default"
                      }
                      size="sm"
                    >
                      <Chip.Label>{activityEntity(item.action)}</Chip.Label>
                    </Chip>
                  ),
                },
                {
                  key: "date",
                  header: "Date",
                  headerClassName: "w-44",
                  cell: (item) => (
                    <RelativeDateTime
                      value={item.createdAt}
                      dateFormat={user.dateFormat}
                      timeFormat={user.timeFormat}
                      timeZone={user.timeZone}
                      label="Activity date"
                      className="whitespace-nowrap"
                    />
                  ),
                },
              ]}
            />
          )}
          {activity.hasMore && (
            <Button
              variant="secondary"
              className="w-fit"
              isDisabled={activity.busy}
              onPress={() => void activity.loadMore()}
            >
              Load earlier activity
            </Button>
          )}
        </Tabs.Panel>
      </Tabs>
      <Modal
        isOpen={!!deleting && !appSuspended}
        onOpenChange={(open) => {
          if (!open && !appSuspended && !busy && !comments.busy) closeDelete();
        }}
      >
        <Modal.Backdrop
          isDismissable={!busy && !comments.busy}
          isKeyboardDismissDisabled={busy || comments.busy}
        >
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Delete comment?</Modal.Heading>
                <Modal.CloseTrigger isDisabled={busy || comments.busy} />
              </Modal.Header>
              <Modal.Body>
                <TypographyParagraph className="text-sm">
                  Permanently delete this comment from the task discussion? This
                  cannot be undone.
                </TypographyParagraph>
                <ErrorMessage>{deleteError}</ErrorMessage>
                {deleteConflict && (
                  <Button
                    variant="secondary"
                    className="mt-3"
                    isDisabled={busy || comments.busy}
                    onPress={() => void reloadDeletingComment()}
                  >
                    Reload comment
                  </Button>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  isDisabled={busy || comments.busy}
                  onPress={closeDelete}
                >
                  Keep comment
                </Button>
                <Button
                  variant="danger-soft"
                  isDisabled={
                    busy || comments.busy || !deleting || !canChange(deleting)
                  }
                  isPending={busy && !!deleting}
                  onPress={() => void deleteComment()}
                >
                  Delete comment
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  );
}
