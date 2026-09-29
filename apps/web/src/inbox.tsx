// Adapted from Towbar's Apache-2.0 notification-center Widget and row composition.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Link,
  Popover,
  ScrollShadow,
  TypographyParagraph,
  Widget,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Notification02Icon } from "@hugeicons/core-free-icons";
import { api, errorText, navigate } from "./api.js";

type Notification = {
  id: string;
  taskId: string;
  boardId: string;
  kind: string;
  actorName: string | null;
  identifier: string;
  title: string;
  readAt: string | null;
  createdAt: string;
};
type NotificationPage = {
  items: Notification[];
  unreadCount: number;
  hasMore: boolean;
  nextCursor: string | null;
};
type ListState = NotificationPage & { loading: boolean; error: string };
type MarkTarget = "all" | string;
const emptyList: ListState = {
  items: [],
  unreadCount: 0,
  hasMore: false,
  nextCursor: null,
  loading: true,
  error: "",
};

export function NotificationsPopover({
  userId,
  timeZone,
  unreadCount,
  onRead,
}: {
  userId: string;
  timeZone: string;
  unreadCount: number;
  onRead: () => void;
}) {
  const unreadDescriptionId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const markFocus = useRef<HTMLElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<ListState>(emptyList);
  const [marking, setMarking] = useState<MarkTarget | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [markError, setMarkError] = useState<{
    target: MarkTarget;
    message: string;
    href?: string;
  } | null>(null);
  const sequence = useRef(0);
  const markSequence = useRef(0);
  const markPending = useRef(false);
  const openingSequence = useRef(0);
  const attemptedCursor = useRef<string | undefined>(undefined);
  const currentOpen = useRef(isOpen);
  const currentState = useRef(state);
  currentOpen.current = isOpen;
  currentState.current = state;

  const load = useCallback(
    async (cursor?: string) => {
      const request = ++sequence.current;
      attemptedCursor.current = cursor;
      setState((previous) =>
        cursor ? { ...previous, loading: true, error: "" } : { ...emptyList },
      );
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      try {
        const result = await api<NotificationPage>(`/notifications?${query}`);
        if (request !== sequence.current) return;
        setState((previous) => ({
          ...result,
          items: cursor
            ? [
                ...new Map(
                  [...previous.items, ...result.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ]
            : result.items,
          loading: false,
          error: "",
        }));
      } catch (cause) {
        if (request !== sequence.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: errorText(cause),
        }));
      }
    },
    [userId],
  );
  const currentLoad = useRef(load);
  currentLoad.current = load;
  useEffect(() => {
    if (isOpen) void load();
    return () => {
      sequence.current++;
    };
  }, [isOpen, load]);
  useEffect(() => {
    setIsOpen(false);
    setState({ ...emptyList });
    markPending.current = false;
    setMarking(null);
    setOpening(null);
    setMarkError(null);
    return () => {
      markSequence.current++;
      openingSequence.current++;
    };
  }, [userId]);
  useEffect(() => {
    const previousFocus = markFocus.current;
    if (
      isOpen &&
      previousFocus &&
      (!previousFocus.isConnected ||
        (previousFocus instanceof HTMLButtonElement &&
          previousFocus.disabled)) &&
      (document.activeElement === previousFocus ||
        document.activeElement === document.body)
    )
      dialog.current?.focus();
    if (!marking) markFocus.current = null;
  }, [isOpen, marking, state.items, state.unreadCount]);

  function changeOpen(open: boolean) {
    currentOpen.current = open;
    if (!open) openingSequence.current++;
    else setMarkError(null);
    setIsOpen(open);
  }

  async function mark(target: MarkTarget, href?: string) {
    if (markPending.current) return;
    const activeElement = document.activeElement;
    markFocus.current =
      !href &&
      activeElement instanceof HTMLElement &&
      dialog.current?.contains(activeElement)
        ? activeElement
        : null;
    markPending.current = true;
    const request = ++markSequence.current;
    const openingView = openingSequence.current;
    setMarking(target);
    setOpening(href ? target : null);
    setMarkError(null);
    try {
      const result = await api<{ ok: boolean; updated: number }>(
        "/notifications",
        target === "all"
          ? { all: true, read: true }
          : { ids: [target], read: true },
        "PATCH",
      );
      if (
        result?.ok !== true ||
        !Number.isInteger(result.updated) ||
        result.updated < 0
      )
        throw new Error(
          "The notification update could not be confirmed. Try again.",
        );
      if (request !== markSequence.current) return;
      sequence.current++;
      if (currentState.current.loading) {
        if (currentOpen.current) void currentLoad.current();
      } else {
        setState((previous) => {
          const readAt = new Date().toISOString();
          const marked = (item: Notification) =>
            target === "all" || item.id === target;
          const newlyRead = previous.items.filter(
            (item) => marked(item) && !item.readAt,
          ).length;
          return {
            ...previous,
            items: previous.items.map((item) =>
              marked(item) ? { ...item, readAt } : item,
            ),
            unreadCount:
              target === "all"
                ? 0
                : Math.max(0, previous.unreadCount - newlyRead),
          };
        });
      }
      onRead();
      if (
        href &&
        currentOpen.current &&
        openingView === openingSequence.current
      ) {
        changeOpen(false);
        navigate(href);
      }
    } catch (cause) {
      if (request === markSequence.current)
        setMarkError({ target, message: errorText(cause), href });
    } finally {
      if (request === markSequence.current) {
        markPending.current = false;
        setMarking(null);
        setOpening(null);
      }
    }
  }

  const markFailure = (target: MarkTarget) =>
    markError?.target === target ? (
      <div className="grid gap-2">
        <ErrorMessage>{markError.message}</ErrorMessage>
        <Button
          variant="secondary"
          className="min-h-11 justify-self-start"
          isPending={marking === target}
          isDisabled={!!marking && marking !== target}
          onPress={() => void mark(target, markError.href)}
        >
          {markError.href ? "Retry opening task" : "Retry marking read"}
        </Button>
      </div>
    ) : null;
  const content = (
    <ScrollShadow
      className="max-h-[min(26rem,calc(100dvh-8rem))] min-w-0 overflow-y-auto overscroll-contain"
      size={16}
      aria-busy={state.loading}
    >
      {markError &&
        (markError.target === "all" ||
          !state.items.some((item) => item.id === markError.target)) && (
          <div className="p-4">{markFailure(markError.target)}</div>
        )}
      {state.loading && state.items.length === 0 ? null : state.error &&
        state.items.length === 0 ? (
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>
              Notifications could not be loaded
            </EmptyState.Title>
            <EmptyState.Description>
              <span role="alert">{state.error}</span>
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button
              className="min-h-11"
              onPress={() => void load(attemptedCursor.current)}
            >
              Retry notifications
            </Button>
          </EmptyState.Content>
        </EmptyState>
      ) : state.items.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">
          No notifications yet
        </p>
      ) : (
        <ul
          aria-label="Notification list"
          className="divide-y divide-separator"
        >
          {state.items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/boards/${item.boardId}/tasks/${item.taskId}`}
                onKeyDown={(event) => {
                  if (
                    !item.readAt &&
                    event.key === "Enter" &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  )
                    event.preventDefault();
                  else event.continuePropagation();
                }}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  if (item.readAt) {
                    changeOpen(false);
                    return;
                  }
                  event.preventDefault();
                  if (!state.loading)
                    void mark(
                      item.id,
                      `/boards/${item.boardId}/tasks/${item.taskId}`,
                    );
                }}
                className="flex min-h-11 items-start gap-3 rounded-xl px-4 py-3 text-foreground no-underline outline-none transition-colors hover:bg-default/60 focus-visible:bg-default/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
              >
                <span
                  aria-hidden="true"
                  className={`mt-1 size-2 shrink-0 rounded-full ${item.readAt ? "bg-muted/40" : "bg-accent"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <TypographyParagraph
                      size="sm"
                      weight="medium"
                      className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]"
                    >
                      {item.actorName ?? "A teammate"}{" "}
                      {item.kind === "assignment"
                        ? "assigned you a task"
                        : "mentioned you"}
                    </TypographyParagraph>
                    <time
                      className="shrink-0 text-xs text-muted"
                      dateTime={item.createdAt}
                    >
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        timeZone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </div>
                  <TypographyParagraph
                    size="sm"
                    color="muted"
                    className="mt-0.5 [overflow-wrap:anywhere]"
                  >
                    {item.title}
                  </TypographyParagraph>
                  <p className="mt-1 text-xs text-muted">{item.identifier}</p>
                  <span className="sr-only">
                    {item.readAt ? "Read" : "Unread"}
                  </span>
                </div>
              </Link>
              {opening === item.id && (
                <span role="status" className="sr-only">
                  Opening task…
                </span>
              )}
              {markError?.target === item.id && (
                <div className="grid gap-3 px-4 pb-3">
                  {markFailure(item.id)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.items.length > 0 && state.error && (
        <div className="grid gap-3 border-t border-separator p-4">
          <ErrorMessage>{state.error}</ErrorMessage>
          <Button
            className="min-h-11 justify-self-start"
            variant="secondary"
            onPress={() => void load(attemptedCursor.current)}
          >
            Retry older notifications
          </Button>
        </div>
      )}
      {state.items.length > 0 &&
        !state.error &&
        (state.loading || state.hasMore) && (
          <div className="border-t border-separator px-4 py-3">
            <Button
              variant="secondary"
              className="min-h-11"
              isDisabled={state.loading || !!marking}
              onPress={() => {
                dialog.current?.focus();
                void load(state.nextCursor ?? undefined);
              }}
            >
              Load older notifications
            </Button>
          </div>
        )}
    </ScrollShadow>
  );
  return (
    <Popover isOpen={isOpen} onOpenChange={changeOpen}>
      <Popover.Trigger
        aria-label="Open notifications"
        aria-describedby={unreadCount > 0 ? unreadDescriptionId : undefined}
        className="notification-center__trigger relative isolate grid size-8 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-full bg-default text-muted outline-none transition-[color,background-color,transform] hover:bg-default/80 hover:text-foreground active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none pointer-coarse:size-11"
      >
        <HugeiconsIcon aria-hidden="true" icon={Notification02Icon} size={18} />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            aria-label={`${unreadCount} unread notifications`}
            className="absolute end-0.5 top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-danger px-1 font-mono text-[0.625rem] leading-4 font-medium text-danger-foreground"
          >
            {Math.min(unreadCount, 9)}
          </span>
        )}
        {unreadCount > 0 && (
          <span id={unreadDescriptionId} className="sr-only">
            {unreadCount} unread notifications
          </span>
        )}
      </Popover.Trigger>
      <Popover.Content
        placement="bottom end"
        offset={8}
        containerPadding={16}
        className="w-[min(24rem,calc(100vw-2rem))] min-w-0 max-w-none overflow-hidden rounded-2xl bg-transparent p-0"
      >
        <Popover.Dialog
          ref={dialog}
          aria-label="Notifications"
          className="min-w-0 p-0 outline-none"
        >
          <Widget className="min-w-0">
            <Widget.Header
              className="widget__header--notification"
              endContent={
                <Button
                  variant="secondary"
                  className="min-h-8 shrink-0 px-2 text-xs pointer-coarse:min-h-11"
                  isPending={marking === "all"}
                  isDisabled={
                    (!!marking && marking !== "all") ||
                    state.loading ||
                    !!state.error ||
                    state.unreadCount === 0
                  }
                  onPress={() => void mark("all")}
                >
                  {marking === "all" ? "Marking all read…" : "Mark all read"}
                </Button>
              }
            >
              <Popover.Heading className="flex min-w-0">
                <Widget.Title
                  help={false}
                  icon={<HugeiconsIcon icon={Notification02Icon} />}
                >
                  Notifications
                </Widget.Title>
              </Popover.Heading>
            </Widget.Header>
            <Widget.Content className="min-w-0 p-0">{content}</Widget.Content>
          </Widget>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
