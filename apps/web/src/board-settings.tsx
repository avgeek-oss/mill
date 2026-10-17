import { useEffect, useRef, useState } from "react";
import {
  ActionConfirmation,
  Button,
  ErrorMessage,
  QueryLoading,
  TextField,
  Widget,
  toast,
  useAppSuspended,
  useOverlaySuspension,
} from "@mill/web-design-system";
import type { Board } from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  navigate,
  type NavigationRequest,
  type User,
} from "./api.js";
import { ErrorPage, errorPageCode } from "./error-page.js";
import { PageHeading } from "./page-heading.js";
import { Save, Settings2, Trash2 } from "./icons.js";
import { hasBoardResponse, hasOkResponse } from "./responses.js";
import { useSettingsMutation } from "./use-settings-mutation.js";

export function BoardSettingsPage({
  section,
  boardId,
  boards,
  user,
  sessionRevision,
  onBoardLoaded,
  onSaved,
  onDeleted,
}: {
  section: "general" | "delete";
  boardId: string;
  boards: Board[];
  user: User;
  sessionRevision: number;
  onBoardLoaded: (board: Board) => void;
  onSaved: () => void;
  onDeleted: (boardId: string) => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "" });
  const [prefix, setPrefix] = useState("");
  const initializedDraft = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{
    status: number;
    message: string;
  } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [pending, setPending] = useState<
    "details" | "prefix" | "delete" | null
  >(null);
  const busy = pending !== null;
  const [reload, setReload] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteKey] = useState(createRetryKey);
  const canAccess =
    user.role !== "viewer" && (section !== "delete" || user.role === "admin");
  const title = section === "delete" ? "Delete board" : "General settings";
  const appSuspended = useAppSuspended();
  const suspension = useOverlaySuspension();
  const mutate = useSettingsMutation(`board-settings:${boardId}:${user.id}`);
  const mutationOutcome = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    const beforeNavigate = (event: Event) => {
      if (!mutationOutcome.current) return;
      event.preventDefault();
      (event as CustomEvent<NavigationRequest>).detail.waitUntil(
        mutationOutcome.current,
      );
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!mutationOutcome.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
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
    return (saved: boolean) => {
      if (mutationOutcome.current === outcome) mutationOutcome.current = null;
      settle(saved);
    };
  }

  useEffect(() => {
    setPending(null);
    setConfirmDelete(false);
    setSaveError("");
  }, [appSuspended, sessionRevision, boardId, user.id, canAccess]);

  useEffect(() => {
    if (appSuspended || !canAccess) return;
    const request = new AbortController();
    setLoading(true);
    setLoadError(null);
    void api<{ board: Board }>(`/boards/${boardId}`, undefined, "GET", {
      signal: request.signal,
      validateResponse: hasBoardResponse,
    }).then(
      ({ board: loaded }) => {
        if (request.signal.aborted) return;
        setBoard(loaded);
        onBoardLoaded(loaded);
        if (!initializedDraft.current) {
          initializedDraft.current = true;
          setDraft({ name: loaded.name, description: loaded.description });
          setPrefix(loaded.prefix);
        }
        setLoading(false);
      },
      (cause: unknown) => {
        if (request.signal.aborted) return;
        const status = cause instanceof ApiError ? cause.status : 0;
        if ([403, 404].includes(status))
          window.dispatchEvent(new Event("mill:route-access-denied"));
        setLoadError({ status, message: errorText(cause) });
        setLoading(false);
      },
    );
    return () => request.abort();
  }, [
    boardId,
    canAccess,
    appSuspended,
    sessionRevision,
    reload,
    onBoardLoaded,
  ]);

  const boardName =
    board?.name ?? boards.find((item) => item.id === boardId)?.name;
  useEffect(() => {
    document.title = `${title}${boardName ? ` · ${boardName}` : ""} · Mill`;
  }, [boardName, title]);

  async function save(widget: "details" | "prefix") {
    if (
      !board ||
      mutationOutcome.current ||
      loading ||
      appSuspended ||
      user.role === "viewer"
    )
      return;
    const isCurrent = suspension.capture();
    const finish = beginMutation();
    let saved = false;
    setPending(widget);
    setSaveError("");
    try {
      const result = await mutate((signal) =>
        api<{ board: Board }>(
          `/boards/${boardId}`,
          {
            version: board.version,
            ...(widget === "prefix" ? { prefix } : draft),
          },
          "PATCH",
          { signal, validateResponse: hasBoardResponse },
        ),
      );
      if (!isCurrent()) return;
      setBoard(result.board);
      if (widget === "details")
        setDraft({
          name: result.board.name,
          description: result.board.description,
        });
      else setPrefix(result.board.prefix);
      onBoardLoaded(result.board);
      onSaved();
      toast.success(
        widget === "prefix" ? "Board prefix updated." : "Board updated.",
      );
      saved = true;
    } catch (cause) {
      if (
        !isCurrent() ||
        (cause instanceof DOMException && cause.name === "AbortError")
      )
        return;
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        cause.code !== "BOARD_PREFIX_TAKEN"
      ) {
        setSaveError(
          "This board changed elsewhere. Your edits are kept. Review them and save again.",
        );
        setReload((value) => value + 1);
      } else setSaveError(errorText(cause));
    } finally {
      if (isCurrent()) setPending(null);
      finish(saved);
    }
  }

  async function deleteBoard() {
    if (
      !board ||
      mutationOutcome.current ||
      loading ||
      appSuspended ||
      user.role !== "admin"
    )
      throw new Error("This board cannot be deleted right now. Try again.");
    const isCurrent = suspension.capture();
    const finish = beginMutation();
    let deleted = false;
    setPending("delete");
    try {
      await mutate((signal) =>
        api(`/boards/${boardId}`, { version: board.version }, "DELETE", {
          signal,
          validateResponse: hasOkResponse,
          headers: {
            "Idempotency-Key": deleteKey.forRequest(
              `/boards/${boardId}`,
              { version: board.version },
              "DELETE",
            ),
          },
        }),
      );
      if (!isCurrent()) return;
      deleteKey.reset();
      setConfirmDelete(false);
      onDeleted(boardId);
      toast.success("Board deleted.");
      deleted = true;
      navigate("/boards");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && isCurrent()) {
        setReload((value) => value + 1);
        throw new Error(
          "This board changed elsewhere. Review it before confirming deletion again.",
        );
      }
      throw cause;
    } finally {
      if (isCurrent()) setPending(null);
      finish(deleted);
    }
  }

  if (!canAccess)
    return (
      <ErrorPage
        code="403"
        title="Board settings access required"
        description={
          section === "delete"
            ? "Only administrators can delete boards."
            : "Members and administrators can update board settings."
        }
      />
    );
  if (loadError)
    return (
      <ErrorPage
        code={errorPageCode(loadError.status)}
        title={
          loadError.status === 403
            ? "Board access required"
            : "Board unavailable"
        }
        description={loadError.message}
        onRetry={() => setReload((value) => value + 1)}
        pending={loading}
      />
    );
  return (
    <section className="settings-page">
      <PageHeading
        title={title}
        icon={section === "delete" ? <Trash2 /> : <Settings2 />}
      />
      <ErrorMessage>{saveError}</ErrorMessage>
      {!board ? (
        <QueryLoading className="sr-only">Loading board settings…</QueryLoading>
      ) : (
        <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
          {section === "delete" ? (
            <Widget
              role="region"
              aria-label="Delete board"
              className="min-w-0"
              aria-busy={busy || loading}
            >
              <Widget.Header>
                <Widget.Title>
                  <h2 className="font-medium">Delete board</h2>
                </Widget.Title>
              </Widget.Header>
              <Widget.Content>
                <div className="content-grid min-w-0">
                  <p className="text-sm text-muted">
                    Permanently delete this board and all of its tasks,
                    comments, and attachments. This cannot be undone.
                  </p>
                  <div className="flex">
                    <Button
                      variant="danger"
                      isDisabled={loading || busy}
                      onPress={() => setConfirmDelete(true)}
                    >
                      <Trash2 aria-hidden />
                      Delete board
                    </Button>
                  </div>
                </div>
              </Widget.Content>
            </Widget>
          ) : (
            <>
              <Widget
                role="region"
                aria-label="Board details"
                aria-busy={busy || loading}
                className="min-w-0"
              >
                <Widget.Header>
                  <Widget.Title>
                    <h2 className="font-medium">Board details</h2>
                  </Widget.Title>
                </Widget.Header>
                <Widget.Content>
                  <form
                    className="content-grid min-w-0"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save("details");
                    }}
                  >
                    <TextField
                      label="Board name"
                      name="name"
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      required
                      maxLength={100}
                      disabled={busy || loading}
                    />
                    <TextField
                      label="Description"
                      name="description"
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                      multiline
                      maxLength={2000}
                      disabled={busy || loading}
                    />
                    <div className="flex">
                      <Button
                        type="submit"
                        isPending={pending === "details"}
                        isDisabled={loading || busy}
                      >
                        <Save aria-hidden />
                        <span className="grid">
                          <span
                            aria-hidden
                            className="invisible [grid-area:1/1]"
                          >
                            Save board
                          </span>
                          <span className="[grid-area:1/1]">
                            {pending === "details" ? "Saving…" : "Save board"}
                          </span>
                        </span>
                      </Button>
                    </div>
                  </form>
                </Widget.Content>
              </Widget>
              <Widget
                role="region"
                aria-label="Board prefix"
                aria-busy={busy || loading}
                className="min-w-0"
              >
                <Widget.Header>
                  <Widget.Title>
                    <h2 className="font-medium">Board prefix</h2>
                  </Widget.Title>
                </Widget.Header>
                <Widget.Content>
                  <form
                    className="content-grid min-w-0"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save("prefix");
                    }}
                  >
                    <p className="text-sm text-muted">
                      The prefix identifies tasks on this board. Changing it
                      updates existing task IDs while keeping their numbers and
                      links.
                    </p>
                    <TextField
                      label="Prefix"
                      name="prefix"
                      value={prefix}
                      onChange={(event) =>
                        setPrefix(event.target.value.toUpperCase())
                      }
                      required
                      minLength={2}
                      maxLength={10}
                      pattern="[A-Z][A-Z0-9]{1,9}"
                      disabled={busy || loading}
                      aria-describedby="board-prefix-hint"
                    />
                    <p id="board-prefix-hint" className="text-xs text-muted">
                      Use 2–10 letters or numbers, starting with a letter. Each
                      board must have a unique prefix.
                    </p>
                    <div className="flex">
                      <Button
                        type="submit"
                        isPending={pending === "prefix"}
                        isDisabled={loading || busy}
                      >
                        <Save aria-hidden />
                        <span className="grid">
                          <span
                            aria-hidden
                            className="invisible [grid-area:1/1]"
                          >
                            Save prefix
                          </span>
                          <span className="[grid-area:1/1]">
                            {pending === "prefix" ? "Saving…" : "Save prefix"}
                          </span>
                        </span>
                      </Button>
                    </div>
                  </form>
                </Widget.Content>
              </Widget>
            </>
          )}
        </div>
      )}
      {confirmDelete && board && user.role === "admin" && (
        <ActionConfirmation
          isOpen
          onOpenChange={setConfirmDelete}
          title="Delete board?"
          description={`Permanently delete “${board.name}” and all of its tasks and comments? This cannot be undone. There is no restore.`}
          confirmLabel="Delete board"
          variant="danger"
          onConfirm={deleteBoard}
        />
      )}
    </section>
  );
}
