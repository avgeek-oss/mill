import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import { ArrowRight02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  ErrorMessage,
  Tabs,
  Table,
  TextField,
  TooltipText,
  TypographyParagraph,
  TypographyText,
  toast,
} from "@mill/web-design-system";
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
import { RelativeDateTime } from "./relative-date-time.js";
import { hasCommentResponse, hasOkResponse } from "./responses.js";

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

function CommentDate({ value, timeZone }: { value: string; timeZone: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const dateText = new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
  }).format(date);
  const fullDate = new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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
            (item.actorKind === "human" || item.actorKind === "agent") &&
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
      const previous = current.current;
      if (more && (!previous.hasMore || !previous.nextCursor || previous.busy))
        return null;
      const request = ++latestRequest.current;
      const isCurrent = () =>
        mounted.current && request === latestRequest.current;
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
          page = await api<Page<T>>(
            `/tasks/${taskId}/${kind}?${params}`,
            undefined,
            "GET",
            {
              validateResponse: (value) => hasDiscussionPage(value, kind),
            },
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
    [taskId, kind, update],
  );

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
      ++latestRequest.current;
    };
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
  const comments = useDiscussionPages<Comment>(taskId, "comments");
  const activity = useDiscussionPages<Activity>(taskId, "activity");
  const [tab, setTab] = useState("comments");
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentError, setCommentError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [navigationNotice, setNavigationNotice] = useState("");
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const mentionListId = useId();
  const [createKey] = useState(createRetryKey);
  const [deleteKey] = useState(createRetryKey);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const mentionContainer = useRef<HTMLDivElement>(null);
  const selectedMentions = useRef<{ id: string; token: string }[]>([]);
  const currentDraft = useRef("");
  const mutationPending = useRef(false);
  const mutationOutcome = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const previousSessionRevision = useRef(sessionRevision);
  const writable = editable && user.role !== "viewer";
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
    setMention(match);
    setActiveMention(0);
  }

  function insertMention(member: Member) {
    if (!mention) return;
    if (
      selectedMentions.current.length >= 50 &&
      !selectedMentions.current.some((item) => item.id === member.id)
    ) {
      setCommentError("A comment can mention up to 50 people.");
      return;
    }
    const token = `@${member.name}`;
    const current = currentDraft.current;
    const before = current.slice(0, mention.start);
    const after = current.slice(mention.end);
    const separator = /^\s/.test(after) ? "" : " ";
    const next = `${before}${token}${separator}${after}`;
    const caret = before.length + token.length + separator.length;
    changeDraft(next);
    selectedMentions.current = [
      ...selectedMentions.current.filter((item) => item.id !== member.id),
      { id: member.id, token },
    ];
    setMention(null);
    setCommentError("");
    requestAnimationFrame(() => {
      const input = commentInput.current;
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  }

  function humanAvatar(id: string, name: string, className: string) {
    const member = members?.find((item) => item.id === id);
    return (
      <Avatar
        email={member?.email ?? (id === user.id ? user.email : "")}
        name={member?.name ?? (id === user.id ? user.name : name)}
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
    if (!value.trim()) setNavigationNotice("");
  }

  function hasUnsentDraft() {
    return Boolean(currentDraft.current.trim());
  }

  function warnAboutDraft() {
    setTab("comments");
    setNavigationNotice(
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
    return (saved: boolean) => {
      if (mutationOutcome.current === outcome) {
        mutationOutcome.current = null;
        mutationPending.current = false;
        if (mounted.current) setBusy(false);
      }
      settle(saved);
    };
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++generation.current;
    };
  }, []);

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
      if (!container?.contains(event.target as Node)) setMention(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [mention]);

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
    const isCurrent = () =>
      mounted.current && generation.current === requestGeneration;
    const path = `/tasks/${taskId}/comments`;
    const payload = {
      body,
      mentionIds: [...new Set(selectedMentions.current.map((item) => item.id))],
    };
    const finishMutation = beginMutation();
    let succeeded = false;
    setCommentError("");
    try {
      const result = await api<{ comment: Comment }>(path, payload, "POST", {
        validateResponse: (value) =>
          hasCommentResponse(value) &&
          isResponseObject(value) &&
          isResponseObject(value.comment) &&
          value.comment.taskId === taskId,
        headers: {
          "Idempotency-Key": createKey.forRequest(path, payload),
        },
      });
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
    const isCurrent = () =>
      mounted.current && generation.current === requestGeneration;
    const path = `/comments/${target.id}`;
    const payload = { version: target.version };
    const finishMutation = beginMutation();
    let succeeded = false;
    setDeleteError("");
    setDeleteConflict(false);
    try {
      await api(path, payload, "DELETE", {
        validateResponse: hasOkResponse,
        headers: {
          "Idempotency-Key": deleteKey.forRequest(path, payload, "DELETE"),
        },
      });
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
    if (!deleting || mutationPending.current) return;
    const target = deleting;
    const requestGeneration = generation.current;
    const items = await comments.refresh();
    if (!mounted.current || generation.current !== requestGeneration || !items)
      return;
    const latest = items.find((item) => item.id === target.id);
    if (!latest) {
      setDeleteError(
        "This comment has already been deleted. Close this confirmation to continue.",
      );
      return;
    }
    setDeleting((current) => (current?.id === target.id ? latest : current));
    setDeleteError("");
    setDeleteConflict(false);
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
    if (!mention) return null;
    return (
      <div className="popover absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-separator bg-overlay p-1">
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
                  <Avatar
                    email={member.email}
                    name={member.name}
                    className="size-6 rounded-[6px] [&_[data-slot=avatar-fallback]]:text-[9px]"
                  />
                </span>
                <span className="min-w-0 truncate">{member.name}</span>
              </div>
            ))
          ) : (
            <TypographyParagraph size="xs" color="muted" className="px-2 py-2">
              No people found.
            </TypographyParagraph>
          )}
        </div>
      </div>
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
          <Tabs.List aria-label="Task discussion" className="text-sm">
            <Tabs.Tab
              id="comments"
              className="whitespace-nowrap px-3 text-sm font-medium"
            >
              Comments{comments.ready ? ` (${comments.items.length})` : ""}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab
              id="activity"
              className="whitespace-nowrap px-3 text-sm font-medium"
            >
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
                  <TextField
                    ref={commentInput}
                    label="Add a comment"
                    hideLabel
                    aria-label="Add a comment"
                    placeholder="Add a comment…"
                    className="min-h-20 w-full min-w-0 resize-y"
                    rows={2}
                    multiline
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
                  className="size-9 min-w-9 shrink-0 self-start rounded-lg pointer-coarse:size-11 pointer-coarse:min-w-11"
                  isDisabled={!canSubmitComment}
                  isPending={busy && !deleting}
                >
                  <HugeiconsIcon
                    aria-hidden
                    className="size-4"
                    icon={ArrowRight02Icon}
                  />
                </Button>
              </div>
              <ErrorMessage>
                {commentError && (
                  <span className="text-xs">{commentError}</span>
                )}
              </ErrorMessage>
            </form>
          )}
          {navigationNotice && (
            <div className="grid gap-2">
              <TypographyParagraph className="text-xs text-muted" role="status">
                {navigationNotice}
              </TypographyParagraph>
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
            <div className="grid gap-2">
              <ErrorMessage>
                <span className="text-xs">
                  Unable to load comments. {comments.error}
                </span>
              </ErrorMessage>
              <Button
                variant="secondary"
                className="w-fit"
                isDisabled={comments.busy || busy}
                onPress={() => void comments.refresh()}
              >
                Retry loading comments
              </Button>
            </div>
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
                    {humanAvatar(item.authorId, name, "size-7")}
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <TypographyText className="min-w-0 truncate text-sm font-medium">
                          {name}
                        </TypographyText>
                        <CommentDate
                          value={item.createdAt}
                          timeZone={user.timeZone}
                        />
                        {canChange(item) && (
                          <Button
                            variant="secondary"
                            isIconOnly
                            className="task-comment-delete ml-auto shrink-0"
                            aria-label={`Delete comment by ${name}`}
                            isDisabled={busy || comments.busy}
                            onPress={() => {
                              setDeleting(item);
                              setDeleteError("");
                              setDeleteConflict(false);
                            }}
                          >
                            <HugeiconsIcon
                              aria-hidden
                              className="size-4"
                              icon={Delete02Icon}
                            />
                          </Button>
                        )}
                      </div>
                      <div className="min-w-0 break-words text-sm text-muted">
                        <Markdown>{item.body}</Markdown>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
            {comments.ready && !comments.items.length && (
              <TypographyParagraph className="py-3 text-xs text-muted">
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
            <div className="grid gap-2">
              <ErrorMessage>
                <span className="text-xs">
                  Unable to load activity. {activity.error}
                </span>
              </ErrorMessage>
              <Button
                variant="secondary"
                className="w-fit"
                isDisabled={activity.busy}
                onPress={() => void activity.refresh()}
              >
                Retry loading activity
              </Button>
            </div>
          )}
          <Table>
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Task activity"
                className="min-w-[34rem]"
              >
                <Table.Header>
                  <Table.Column isRowHeader>Action</Table.Column>
                  <Table.Column className="w-28">Entity</Table.Column>
                  <Table.Column className="w-44">Date</Table.Column>
                </Table.Header>
                <Table.Body>
                  {activity.items.map((item) => (
                    <Table.Row key={item.id} id={item.id}>
                      <Table.Cell>
                        <span className="grid gap-1">
                          <span className="text-sm font-normal">
                            {activityLabel(item.action).replace(
                              /^./,
                              (letter) => letter.toUpperCase(),
                            )}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                            {item.actorKind === "human" &&
                              humanAvatar(
                                item.actorId,
                                item.actorName,
                                "size-[18px] rounded-[5px] [&_[data-slot=avatar-fallback]]:text-[8px]",
                              )}
                            <span className="min-w-0 break-words">
                              {item.actorName}
                            </span>
                          </span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip
                          variant={
                            item.action.startsWith("comment.")
                              ? "orange"
                              : item.action.startsWith("task.")
                                ? "info"
                                : "secondary"
                          }
                          size="small"
                        >
                          {activityEntity(item.action)}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <RelativeDateTime
                          value={item.createdAt}
                          timeZone={user.timeZone}
                          label="Activity date"
                          className="whitespace-nowrap"
                        />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          {activity.ready && !activity.items.length && (
            <TypographyParagraph className="py-3 text-xs text-muted">
              No activity yet.
            </TypographyParagraph>
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
      <Dialog
        open={!!deleting}
        onClose={closeDelete}
        isDismissDisabled={busy || comments.busy}
        title="Delete comment?"
        footer={
          <>
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
          </>
        }
      >
        <TypographyParagraph className="text-sm">
          Permanently delete this comment from the task discussion? This cannot
          be undone.
        </TypographyParagraph>
        <ErrorMessage>
          {deleteError && <span className="text-sm">{deleteError}</span>}
        </ErrorMessage>
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
      </Dialog>
    </section>
  );
}
