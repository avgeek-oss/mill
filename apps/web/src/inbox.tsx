import { useCallback, useEffect, useRef, useState } from "react";
import {
  AsyncActionButton,
  Button,
  QueryLoading,
} from "@avgeek-oss/design-system";
import {
  NotificationMenu,
  type NotificationItem,
} from "@avgeek-oss/design-system/patterns/notifications";
import { useOverlaySuspension } from "@avgeek-oss/design-system/overlays/overlay-suspension";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { ErrorMessage } from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Message01Icon, Task01Icon } from "@hugeicons/core-free-icons";
import { relativeDate, useCurrentTime } from "./relative-date-time.js";
import { api, errorText, navigate } from "./api.js";
import type { NotificationPage } from "../../../packages/contracts/src/index.js";
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
  unreadCount,
  onRead,
  suspended,
  sessionRevision,
}: {
  userId: string;
  timeZone: string;
  unreadCount: number;
  onRead: () => void;
  suspended: boolean;
  sessionRevision: number;
}) {
  const overlay = useOverlaySuspension();
  const currentTime = useCurrentTime();
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
    showFeedback: boolean;
  } | null>(null);
  const sequence = useRef(0);
  const markSequence = useRef(0);
  const markPending = useRef(false);
  const openingSequence = useRef(0);
  const attemptedCursor = useRef<string | undefined>(undefined);
  const attemptedRefresh = useRef(false);
  const loadedPages = useRef(1);
  const currentOpen = useRef(isOpen);
  const suspendedRef = useRef(suspended);
  currentOpen.current = isOpen;
  suspendedRef.current = suspended;

  useEffect(() => {
    const onExpired = () => {
      suspendedRef.current = true;
    };
    window.addEventListener("mill:expired", onExpired);
    return () => window.removeEventListener("mill:expired", onExpired);
  }, []);

  useEffect(() => {
    const onAccessDenied = () => {
      currentOpen.current = false;
      openingSequence.current++;
      setIsOpen(false);
    };
    window.addEventListener("mill:route-access-denied", onAccessDenied);
    return () =>
      window.removeEventListener("mill:route-access-denied", onAccessDenied);
  }, []);

  const load = useCallback(
    async (cursor?: string, refreshLoaded = false) => {
      if (suspendedRef.current) return;
      const request = ++sequence.current;
      attemptedCursor.current = cursor;
      attemptedRefresh.current = refreshLoaded;
      setState((previous) =>
        cursor || refreshLoaded
          ? { ...previous, loading: true, error: "" }
          : { ...emptyList },
      );
      try {
        const targetPages = refreshLoaded ? loadedPages.current : 1;
        let nextCursor = cursor;
        let result: NotificationPage;
        const collected: NotificationPage["items"] = [];
        let fetchedPages = 0;
        const cursors = new Set<string>();
        do {
          const query = new URLSearchParams({ limit: "100" });
          if (nextCursor) query.set("cursor", nextCursor);
          result = await api<NotificationPage>(`/notifications?${query}`);
          if (request !== sequence.current || suspendedRef.current) return;
          collected.push(...result.items);
          fetchedPages++;
          nextCursor = result.nextCursor ?? undefined;
          if (nextCursor && cursors.has(nextCursor))
            throw new Error(
              "The notification list could not be completed. Try again.",
            );
          if (nextCursor) cursors.add(nextCursor);
        } while (nextCursor && fetchedPages < targetPages);
        if (request !== sequence.current) return;
        loadedPages.current = cursor
          ? loadedPages.current + fetchedPages
          : fetchedPages;
        setState((previous) => ({
          ...result,
          items: [
            ...new Map(
              [...(cursor ? previous.items : []), ...collected].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ],
          loading: false,
          error: "",
        }));
      } catch (cause) {
        if (request !== sequence.current || suspendedRef.current) return;
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
    if (isOpen && !suspended) void load();
    return () => {
      sequence.current++;
    };
  }, [isOpen, load, suspended, sessionRevision]);
  useEffect(() => {
    setIsOpen(false);
    setState({ ...emptyList });
    loadedPages.current = 1;
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
    if (!open && suspendedRef.current) return;
    currentOpen.current = open;
    if (!open) openingSequence.current++;
    else setMarkError(null);
    setIsOpen(open);
  }

  async function mark(
    target: MarkTarget,
    href?: string,
    feedbackOwner: "app" | "native" = "app",
  ): Promise<void | false> {
    if (markPending.current || suspendedRef.current) return false;
    const isCurrent = overlay.capture();
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
    setMarkError((previous) =>
      previous?.target === target ? { ...previous, showFeedback: false } : null,
    );
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
      if (request !== markSequence.current || !isCurrent()) return false;
      sequence.current++;
      // Receipts and concurrent arrivals are authoritative on the server.
      if (currentOpen.current && !suspendedRef.current) {
        if (markFocus.current && document.activeElement === markFocus.current)
          dialog.current?.focus({ preventScroll: true });
        await currentLoad.current(undefined, true);
      }
      if (request !== markSequence.current || !isCurrent()) return false;
      setMarkError(null);
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
      if (request !== markSequence.current || !isCurrent()) return false;
      setMarkError({
        target,
        message: errorText(cause),
        href,
        showFeedback: feedbackOwner === "app",
      });
      if (feedbackOwner === "native") throw cause;
    } finally {
      if (request === markSequence.current) {
        markPending.current = false;
        setMarking(null);
        setOpening(null);
      }
    }
  }

  const retryQuery = () =>
    void load(attemptedCursor.current, attemptedRefresh.current);
  const pendingQuery = state.loading ? (
    <QueryLoading aria-busy="true">Loading notifications…</QueryLoading>
  ) : null;
  const emptyContent = state.loading ? (
    pendingQuery
  ) : state.error ? (
    <div className="p-4">
      <ErrorMessage>{state.error}</ErrorMessage>
      <Button variant="secondary" onPress={retryQuery}>
        Retry notifications
      </Button>
    </div>
  ) : undefined;
  const hasFooter =
    !!markError ||
    !!opening ||
    (state.items.length > 0 &&
      (state.loading || !!state.error || state.hasMore));
  const footer = hasFooter ? (
    <div className="grid gap-3">
      {state.items.length > 0 && pendingQuery}
      {opening && <QueryLoading>Opening task…</QueryLoading>}
      {markError && (
        <div>
          {markError.showFeedback && (
            <ErrorMessage>{markError.message}</ErrorMessage>
          )}
          <AsyncActionButton
            variant="secondary"
            isDisabled={!!marking}
            pendingLabel="Retrying…"
            onAction={async () => {
              await mark(markError.target, markError.href, "native");
            }}
          >
            {markError.href ? "Retry opening task" : "Retry marking read"}
          </AsyncActionButton>
        </div>
      )}
      {state.items.length > 0 && state.error && (
        <div>
          <ErrorMessage>{state.error}</ErrorMessage>
          <Button variant="secondary" onPress={retryQuery}>
            Retry older notifications
          </Button>
        </div>
      )}
      {state.items.length > 0 &&
        !state.error &&
        (state.loading || state.hasMore) && (
          <div>
            <Button
              variant="secondary"
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
    </div>
  ) : undefined;
  const items: NotificationItem[] = state.items.map((item) => ({
    id: item.id,
    title: `${item.actorName ?? "A teammate"} ${item.kind === "assignment" ? "assigned you a task" : "mentioned you"}`,
    message: item.title,
    source: item.readAt ? "Read" : "Unread",
    href: `/boards/${item.boardId}/tasks/${item.taskId}`,
    icon: (
      <HugeiconsIcon
        icon={item.kind === "assignment" ? Task01Icon : Message01Icon}
        className={item.readAt ? "text-muted" : "text-accent"}
      />
    ),
    time: Number.isNaN(Date.parse(item.createdAt))
      ? "—"
      : relativeDate(Date.parse(item.createdAt), currentTime),
    dateTime: item.createdAt,
    unread: !item.readAt,
  }));
  return (
    <NotificationMenu
      items={items}
      unreadCount={unreadCount}
      isOpen={isOpen && !suspended}
      onOpenChange={changeOpen}
      dialogRef={dialog}
      headerEnd={
        <Widget.Action
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
        </Widget.Action>
      }
      emptyContent={emptyContent}
      footer={footer}
      onActivate={async (item) => {
        if (!currentOpen.current || suspendedRef.current) return false;
        if (!item.unread) {
          changeOpen(false);
          navigate(item.href);
          return;
        }
        if (state.loading || markPending.current) return false;
        return mark(item.id, item.href, "native");
      }}
    />
  );
}
