import { QueryFeedback } from "./query-feedback.js";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight02Icon,
  Delete02Icon,
  ReplyIcon,
} from "@hugeicons/core-free-icons";
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
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Tabs } from "@avgeek-oss/design-system/navigation/tabs";
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

import { MAX_COMMENT_REPLY_DEPTH } from "../../../packages/contracts/src/index.js";

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
  refreshKey?: number | string;
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
      className="shrink-0 whitespace-nowrap text-sm/5 text-muted"
    >
      {dateText}
    </TooltipText>
  );
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
            ["human", "oauth", "team"].includes(String(item.actorKind)) &&
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
  parentId?: string,
  enabled = true,
  refreshKey?: string,
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
          if (parentId) params.set("parentId", parentId);
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
          if (
            page.items.some(
              (item) =>
                item.taskId !== taskId ||
                (kind === "comments" &&
                  parentId &&
                  (item as Comment).parentId !==
                    (parentId === "root" ? null : parentId)),
            )
          )
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
    [taskId, kind, parentId, update, runQuery],
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
    if (enabled) void load(false);
  }, [load, enabled, refreshKey]);

  const refresh = useCallback(() => load(false), [load]);
  const loadMore = useCallback(() => load(true), [load]);
  const updateItems = useCallback(
    (change: (items: T[]) => T[]) =>
      update((state) => ({ ...state, items: change(state.items) })),
    [update],
  );
  return { ...collection, refresh, loadMore, updateItems };
}

type CommentThreadsState = {
  taskId: string;
  user: User;
  busy: boolean;
  writable: boolean;
  replying: Comment | null;
  composer: ReactNode;
  refreshKey: string;
  canChange: (comment: Comment) => boolean;
  avatar: (id: string | null, name: string, className: string) => ReactNode;
  onReply: (comment: Comment, path: string[]) => boolean;
  onCollapse: (commentId: string) => boolean;
  onDelete: (comment: Comment) => void;
};
const CommentThreads = createContext<CommentThreadsState | null>(null);

function CommentThread({
  comment,
  nested = false,
  ancestors = [],
}: {
  comment: Comment;
  nested?: boolean;
  ancestors?: string[];
}) {
  const context = useContext(CommentThreads);
  if (!context) throw new Error("Comment threads require a discussion.");
  const {
    taskId,
    user,
    busy,
    writable,
    replying,
    composer,
    canChange,
    avatar,
    onReply,
    onCollapse,
    onDelete,
    refreshKey,
  } = context;
  const [expanded, setExpanded] = useState(false);
  const repliesId = useId();
  const replies = useDiscussionPages<Comment>(
    taskId,
    "comments",
    comment.id,
    expanded,
    refreshKey,
  );
  const name =
    comment.authorName ||
    (comment.authorId === user.id ? user.name : "Unknown member");
  return (
    <article
      className="task-comment min-w-0"
      aria-label={`${nested ? "Reply" : "Comment"} by ${name}`}
    >
      <div className="task-comment-row flex min-w-0 items-start gap-3">
        {!nested && avatar(comment.authorId, name, "mt-0.5 shrink-0")}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div
            className={`task-comment-header flex min-h-7 min-w-0 items-center gap-2${nested && ancestors.length <= MAX_COMMENT_REPLY_DEPTH ? " comment-reply-header" : ""}`}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <TypographyText className="min-w-0 truncate text-sm/5 font-medium">
                {name}
              </TypographyText>
              <CommentDate value={comment.createdAt} user={user} />
            </div>
            {canChange(comment) && (
              <Button
                variant="danger-soft"
                isIconOnly
                className="task-comment-delete shrink-0"
                aria-label={`Delete ${nested ? "reply" : "comment"} by ${name}`}
                isDisabled={busy}
                onPress={() => onDelete(comment)}
              >
                <HugeiconsIcon aria-hidden icon={Delete02Icon} />
              </Button>
            )}
          </div>
          <div className="min-w-0 break-words text-sm text-muted">
            <Markdown>{comment.body}</Markdown>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4">
            {writable && ancestors.length < MAX_COMMENT_REPLY_DEPTH && (
              <Button
                variant="ghost"
                className="comment-thread-link"
                isDisabled={busy}
                onPress={() => {
                  if (onReply(comment, [...ancestors, comment.id]))
                    setExpanded(true);
                }}
              >
                <HugeiconsIcon aria-hidden icon={ReplyIcon} size={16} />
                Reply
              </Button>
            )}
            {comment.replyCount > 0 && (
              <Button
                variant="ghost"
                className="comment-thread-link"
                aria-expanded={expanded}
                aria-controls={repliesId}
                onPress={() => {
                  if (!expanded || onCollapse(comment.id))
                    setExpanded((value) => !value);
                }}
              >
                {expanded ? "Hide replies" : "Show replies"} (
                {comment.replyCount})
              </Button>
            )}
          </div>
          {replying?.id === comment.id && (
            <div className="pt-2">{composer}</div>
          )}
        </div>
      </div>
      <div id={repliesId} hidden={!expanded}>
        {expanded && (
          <>
            {replies.error && (
              <QueryFeedback
                message={`Unable to load replies. ${replies.error}`}
                onRetry={
                  replies.busy ? undefined : () => void replies.refresh()
                }
              />
            )}
            {replies.busy && !replies.ready && (
              <QueryLoading className="sr-only">Loading replies…</QueryLoading>
            )}
            <ul
              className={`comment-replies${nested ? " comment-replies-nested" : ""}`}
              aria-label={`Replies to ${name}`}
            >
              {replies.items.map((reply) => (
                <li
                  key={reply.id}
                  className={`comment-reply${ancestors.length >= MAX_COMMENT_REPLY_DEPTH ? " comment-reply-flat" : ""}`}
                >
                  <CommentThread
                    comment={reply}
                    nested
                    ancestors={[...ancestors, comment.id]}
                  />
                </li>
              ))}
            </ul>
            {replies.hasMore && (
              <Button
                variant="ghost"
                className="comment-thread-link"
                isDisabled={busy || replies.busy}
                onPress={() => void replies.loadMore()}
              >
                Load more replies
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  );
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
  const comments = useDiscussionPages<Comment>(taskId, "comments", "root");
  const activity = useDiscussionPages<Activity>(taskId, "activity");
  const [tab, setTab] = useState("comments");
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState<Comment | null>(null);
  const [replyPath, setReplyPath] = useState<string[]>([]);
  const [threadRevision, setThreadRevision] = useState(0);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentError, setCommentError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const navigationDecision = useRef<((leave: boolean) => void) | null>(null);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const mentionListId = useId();
  const [createKey] = useState(createRetryKey);
  const [deleteKey] = useState(createRetryKey);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const returnToCommentInput = useRef(false);
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

  useLayoutEffect(() => {
    if (replying || returnToCommentInput.current) commentInput.current?.focus();
    returnToCommentInput.current = false;
  }, [replying]);

  function humanAvatar(id: string | null, name: string, className: string) {
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
  }

  function hasUnsentDraft() {
    return Boolean(currentDraft.current.trim());
  }

  function confirmLeavingDraft() {
    navigationDecision.current?.(false);
    setMention(null);
    setConfirmLeave(true);
    return new Promise<boolean>((resolve) => {
      navigationDecision.current = resolve;
    });
  }

  function finishNavigationDecision(leave: boolean) {
    const resolve = navigationDecision.current;
    navigationDecision.current = null;
    setConfirmLeave(false);
    resolve?.(leave);
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
          return confirmLeavingDraft();
        }),
      );
    } else if (hasUnsentDraft()) {
      event.preventDefault();
      destination.waitUntil(confirmLeavingDraft());
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
      finishNavigationDecision(false);
    }
    return () => {
      mounted.current = false;
      ++generation.current;
      finishPendingMutation.current?.(false);
      navigationDecision.current?.(false);
      navigationDecision.current = null;
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
      ...(replying ? { parentId: replying.id } : {}),
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
      if (!saved.parentId)
        comments.updateItems((items) => mergeItems(items, [saved]));
      setThreadRevision((value) => value + 1);
      setReplying(null);
      void comments.refresh();
      changeDraft("");
      toast.success(saved.parentId ? "Reply added." : "Comment added.");
      succeeded = true;
    } catch (error) {
      if (isCurrent()) {
        if (replying && error instanceof ApiError && error.status === 404)
          setReplying(null);
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
      setThreadRevision((value) => value + 1);
      if (replying?.id === target.id) setReplying(null);
      toast.success("Comment deleted.");
      void comments.refresh();
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
      const { comment: latest } = await runMutation((signal) =>
        api<{ comment: Comment }>(`/comments/${target.id}`, undefined, "GET", {
          signal,
          validateResponse: hasCommentResponse,
        }),
      );
      if (!isCurrent()) return;
      setDeleting((current) => (current?.id === target.id ? latest : current));
      setDeleteConflict(false);
    } catch (error) {
      if (isCurrent()) setDeleteError(errorText(error));
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

  const composer = writable ? (
    <div className="grid min-w-0 gap-2">
      {replying && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-sm italic text-muted">
            Replying to {replying.authorName}
          </span>
          <Button
            variant="ghost"
            className="comment-thread-link"
            isDisabled={busy}
            onPress={() => {
              returnToCommentInput.current = true;
              setMention(null);
              setReplying(null);
            }}
          >
            Cancel reply
          </Button>
        </div>
      )}

      <form
        className="grid min-w-0 gap-3"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submitComment();
        }}
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div ref={mentionContainer} className="relative min-w-0">
            <Textarea
              ref={commentInput}
              variant="primary"
              aria-label={replying ? "Add a reply" : "Add a comment"}
              placeholder={replying ? "Add a reply…" : "Add a comment…"}
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
                updateMention(event.target.value, event.target.selectionStart);
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
            aria-label={replying ? "Send reply" : "Send comment"}
            className="shrink-0 self-start rounded-lg"
            isDisabled={!canSubmitComment}
            isPending={busy && !deleting}
          >
            <HugeiconsIcon aria-hidden icon={ArrowRight02Icon} />
          </Button>
        </div>
        <ErrorMessage>{commentError}</ErrorMessage>
      </form>
    </div>
  ) : null;

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
              Comments
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
          {!replying && composer}
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
          <CommentThreads.Provider
            value={{
              taskId,
              user,
              busy: busy || comments.busy,
              writable,
              replying,
              composer,
              refreshKey: `${threadRevision}:${sessionRevision}`,
              canChange,
              avatar: humanAvatar,
              onDelete: (item) => {
                setDeleting(item);
                setDeleteError("");
                setDeleteConflict(false);
              },
              onCollapse: (commentId) => {
                if (replying && replyPath.includes(commentId)) {
                  if (hasUnsentDraft()) {
                    toast.danger(
                      "Send or clear your reply before hiding this thread.",
                    );
                    commentInput.current?.focus();
                    return false;
                  }
                  setReplying(null);
                }
                return true;
              },
              onReply: (item, path) => {
                if (path.length > MAX_COMMENT_REPLY_DEPTH) return false;
                if (mutationPending.current) return false;
                if (hasUnsentDraft() && replying?.id !== item.id) {
                  toast.danger(
                    "Send or clear your current draft before replying to another comment.",
                  );
                  commentInput.current?.focus();
                  return false;
                }
                setReplyPath(path);
                setReplying(item);
                setCommentError("");
                return true;
              },
            }}
          >
            <div className="grid min-w-0 gap-6">
              {comments.items.map((item) => (
                <CommentThread key={item.id} comment={item} />
              ))}
            </div>
          </CommentThreads.Provider>
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
              emptyDescription="Task changes and attachment actions appear here."
              isLoading={!activity.ready && activity.busy}
              isRefreshing={activity.ready && activity.busy}
              columns={[
                {
                  key: "action",
                  header: "Action",
                  isRowHeader: true,
                  cell: (item) =>
                    activityLabel(item.action).replace(/^./, (letter) =>
                      letter.toUpperCase(),
                    ),
                },
                {
                  key: "actor",
                  header: "Actor",
                  headerClassName: "w-52",
                  cell: (item) => (
                    <div className="flex min-w-0 items-center gap-2">
                      {humanAvatar(
                        item.actorKind === "team" ? null : item.actorId,
                        item.actorName,
                        "shrink-0",
                      )}
                      <span className="min-w-0 break-words">
                        {item.actorName}
                      </span>
                    </div>
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
        isOpen={confirmLeave && !appSuspended}
        onOpenChange={(open) => {
          if (!open) finishNavigationDecision(false);
        }}
      >
        <Modal.Backdrop isDismissable>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Unsaved changes</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body>
                <TypographyParagraph className="text-sm">
                  You have an unsent {replying ? "reply" : "comment"}. If you
                  leave this task, your draft will be lost.
                </TypographyParagraph>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  autoFocus
                  onPress={() => finishNavigationDecision(false)}
                >
                  Stay
                </Button>
                <Button
                  variant="danger"
                  onPress={() => finishNavigationDecision(true)}
                >
                  Leave without saving
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
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
                  cannot be undone. Replies will be kept and moved up one level.
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
