// Adapted from Towbar's Apache-2.0 notification-center Widget and row composition.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Link,
  Spinner,
  Tabs,
  TypographyParagraph,
  Widget,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Notification01Icon } from "@hugeicons/core-free-icons";
import { api, errorText, navigate } from "./api.js";
import { PageHeading } from "./page-heading.js";

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

export function Inbox({
  userId,
  timeZone,
  onRead,
}: {
  userId: string;
  timeZone: string;
  onRead: () => void;
}) {
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
  const currentFilter = useRef(filter);
  const currentState = useRef(state);
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
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    markPending.current = false;
    setMarking(null);
    setOpening(null);
    setMarkError(null);
    return () => {
      markSequence.current++;
    };
  }, [userId]);

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
        void currentLoad.current();
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
      if (href && openingView === openingSequence.current) navigate(href);
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
          isDisabled={!!marking}
          onPress={() => void mark(target, markError.href)}
        >
          {markError.href ? "Retry opening task" : "Retry marking read"}
        </Button>
      </div>
    ) : null;
  const content = (
    <Widget role="region" aria-label="Notifications" className="min-w-0">
      <Widget.Header>
        <Widget.Title
          help={false}
          icon={<HugeiconsIcon icon={Notification01Icon} size={16} />}
        >
          Notifications
        </Widget.Title>
      </Widget.Header>
      <Widget.Content className="min-w-0 p-0">
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
                    }}
                    onClick={(event) => {
                      if (
                        item.readAt ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
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
                      isDisabled={!!marking || state.loading}
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
      </Widget.Content>
    </Widget>
  );
  return (
    <section className="content-grid min-w-0" aria-label="Inbox">
      <PageHeading
        title="Inbox"
        icon={<HugeiconsIcon icon={Notification01Icon} size={24} />}
        description="Assignments and mentions that need your attention."
        actions={
          <Button
            variant="secondary"
            className="min-h-11"
            isDisabled={
              !!marking ||
              state.loading ||
              !!state.error ||
              state.unreadCount === 0
            }
            onPress={() => void mark("all")}
          >
            {marking === "all" ? "Marking all read…" : "Mark all read"}
          </Button>
        }
      />
      <Tabs
        selectedKey={filter}
        onSelectionChange={selectFilter}
        className="min-w-0"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Inbox filter">
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
        <Tabs.Panel id="all" className="pt-4">
          {filter === "all" ? content : null}
        </Tabs.Panel>
        <Tabs.Panel id="unread" className="pt-4">
          {filter === "unread" ? content : null}
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}
