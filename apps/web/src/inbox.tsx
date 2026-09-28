// Adapted from Towbar's Apache-2.0 notification-center Widget and row composition.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Link,
  Popover,
  ScrollShadow,
  Spinner,
  Tabs,
  TypographyParagraph,
  Widget,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Notification01Icon } from "@hugeicons/core-free-icons";
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
type Filter = "all" | "unread";
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
  const [filter, setFilter] = useState<Filter>("all");
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
  const currentFilter = useRef(filter);
  const currentState = useRef(state);
  currentOpen.current = isOpen;
  currentFilter.current = filter;
  currentState.current = state;

  const load = useCallback(
    async (cursor?: string) => {
      const request = ++sequence.current;
      attemptedCursor.current = cursor;
      setState((previous) =>
        cursor ? { ...previous, loading: true, error: "" } : { ...emptyList },
      );
      const query = new URLSearchParams({ limit: "100" });
      if (filter === "unread") query.set("unread", "true");
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
    [filter, userId],
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
    setFilter("all");
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
      dialog.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    if (!marking) markFocus.current = null;
  }, [isOpen, marking, state.items, state.unreadCount]);

  function changeOpen(open: boolean) {
    currentOpen.current = open;
    if (!open) openingSequence.current++;
    else setMarkError(null);
    setIsOpen(open);
  }

  function selectFilter(key: string | number) {
    if ((key !== "all" && key !== "unread") || key === filter) return;
    openingSequence.current++;
    sequence.current++;
    currentFilter.current = key;
    setState({ ...emptyList });
    setFilter(key);
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
    const startingFilter = currentFilter.current;
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
      if (
        currentState.current.loading ||
        startingFilter !== currentFilter.current
      ) {
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
            items:
              currentFilter.current === "unread"
                ? previous.items.filter((item) => !marked(item))
                : previous.items.map((item) =>
                    marked(item) ? { ...item, readAt } : item,
                  ),
            unreadCount:
              target === "all"
                ? 0
                : Math.max(0, previous.unreadCount - newlyRead),
            ...(target === "all" && currentFilter.current === "unread"
              ? { hasMore: false, nextCursor: null }
              : {}),
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
      className="max-h-[min(30rem,calc(100dvh-14rem))] min-w-0 overflow-y-auto overscroll-contain"
      size={16}
    >
      {markError &&
        (markError.target === "all" ||
          !state.items.some((item) => item.id === markError.target)) && (
          <div className="p-4">{markFailure(markError.target)}</div>
        )}
      {state.loading && state.items.length === 0 ? (
        <div
          role="status"
          className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted"
        >
          <Spinner size="sm" /> Loading notifications…
        </div>
      ) : state.error && state.items.length === 0 ? (
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
        <EmptyState>
          <EmptyState.Media>
            <HugeiconsIcon icon={Notification01Icon} size={28} />
          </EmptyState.Media>
          <EmptyState.Header>
            <EmptyState.Title>
              {filter === "unread"
                ? "You’re all caught up"
                : "No notifications yet"}
            </EmptyState.Title>
            <EmptyState.Description>
              New assignments and mentions will appear here.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : (
        <ul
          aria-label="Notification list"
          className="divide-y divide-separator"
        >
          {state.items.map((item) => (
            <li key={item.id} className="grid gap-3 px-4 py-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <span
                  aria-hidden="true"
                  className={`mt-2 size-2 shrink-0 rounded-full ${item.readAt ? "bg-muted/40" : "bg-accent"}`}
                />
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
                  className="block min-w-0 flex-1 basis-40 rounded-sm text-foreground no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <TypographyParagraph
                    size="sm"
                    weight="medium"
                    className="[overflow-wrap:anywhere]"
                  >
                    {item.actorName ?? "A teammate"}{" "}
                    {item.kind === "assignment"
                      ? "assigned you"
                      : "mentioned you in"}{" "}
                    {item.identifier}
                  </TypographyParagraph>
                  <TypographyParagraph
                    size="sm"
                    color="muted"
                    className="mt-1 [overflow-wrap:anywhere]"
                  >
                    {item.title}
                  </TypographyParagraph>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted">
                    <span>{item.readAt ? "Read" : "Unread"}</span>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        timeZone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </div>
                </Link>
                {!item.readAt && (
                  <Button
                    variant="ghost"
                    className="min-h-11 shrink-0"
                    aria-label={`Mark notification from ${item.actorName ?? "a teammate"} read`}
                    isPending={marking === item.id}
                    isDisabled={
                      (!!marking && marking !== item.id) || state.loading
                    }
                    onPress={() => void mark(item.id)}
                  >
                    {marking === item.id ? "Marking read…" : "Mark read"}
                  </Button>
                )}
              </div>
              {opening === item.id && (
                <p role="status" className="text-sm text-muted">
                  Opening task…
                </p>
              )}
              {markFailure(item.id)}
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
            {state.loading ? (
              <p role="status" className="text-sm text-muted">
                Loading older notifications…
              </p>
            ) : (
              <Button
                variant="secondary"
                className="min-h-11"
                isDisabled={!!marking}
                onPress={() => void load(state.nextCursor ?? undefined)}
              >
                Load older notifications
              </Button>
            )}
          </div>
        )}
    </ScrollShadow>
  );
  return (
    <Popover isOpen={isOpen} onOpenChange={changeOpen}>
      <Button
        variant="ghost"
        isIconOnly
        aria-label="Open notifications"
        aria-describedby={unreadCount > 0 ? unreadDescriptionId : undefined}
        className="relative size-11 shrink-0 text-muted"
      >
        <HugeiconsIcon aria-hidden="true" icon={Notification01Icon} size={20} />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            aria-label={`${unreadCount} unread notifications`}
            className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-medium text-accent-foreground"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        {unreadCount > 0 && (
          <span id={unreadDescriptionId} className="sr-only">
            {unreadCount} unread notifications
          </span>
        )}
      </Button>
      <Popover.Content
        placement="bottom end"
        offset={8}
        containerPadding={12}
        className="w-[min(28rem,calc(100vw-1.5rem))] min-w-0 max-w-none overflow-hidden rounded-2xl bg-transparent p-0"
      >
        <Popover.Dialog
          ref={dialog}
          aria-label="Notifications"
          className="min-w-0 p-0"
        >
          <Widget className="min-w-0">
            <Widget.Header
              className="widget__header--touch-targets"
              endContent={
                <Button
                  variant="ghost"
                  className="min-h-11 shrink-0"
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
                  icon={<HugeiconsIcon icon={Notification01Icon} size={16} />}
                >
                  Notifications
                </Widget.Title>
              </Popover.Heading>
            </Widget.Header>
            <Widget.Content className="min-w-0 p-0">
              <Tabs
                selectedKey={filter}
                onSelectionChange={selectFilter}
                className="min-w-0"
              >
                <Tabs.ListContainer className="border-b border-separator px-4">
                  <Tabs.List aria-label="Notifications filter">
                    <Tabs.Tab id="all" className="min-h-11">
                      All
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab id="unread" className="min-h-11">
                      Unread
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
                <Tabs.Panel id="all" className="p-0">
                  {filter === "all" ? content : null}
                </Tabs.Panel>
                <Tabs.Panel id="unread" className="p-0">
                  {filter === "unread" ? content : null}
                </Tabs.Panel>
              </Tabs>
            </Widget.Content>
          </Widget>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
