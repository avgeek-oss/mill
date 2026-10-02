import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  Button,
  Choice,
  Dialog,
  Dropdown,
  ErrorMessage,
  PortalProvider,
  SuspendedAppProvider,
  useAppSuspended,
  TextField,
  TypographyHeading,
  TypographyParagraph,
  toast,
} from "@mill/web-design-system";
import { DatePickerField } from "@mill/web-design-system/date-picker-field";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  BotIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import type {
  Agent,
  Board,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  navigate,
  requestNavigation,
  type NavigationRequest,
  type User,
} from "./api.js";
import { useAgentDirectory } from "./agents-settings.js";
import {
  hasBoardResponse,
  hasOkResponse,
  hasTaskResponse,
} from "./responses.js";
import { ErrorPage } from "./error-page.js";
import { LinkIcon, MoreHorizontal, Trash2 } from "./icons.js";
import { Markdown } from "./markdown.js";
import { priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";
import { TaskDiscussion } from "./task-discussion.js";
import {
  useTaskEditor,
  type TaskEditor,
  type TaskField,
} from "./use-task-editor.js";

function FieldFeedback({
  editor,
  field,
}: {
  editor: TaskEditor;
  field: TaskField;
}) {
  const status = editor.fields[field];
  if (status?.state !== "error") return null;
  return (
    <div className="grid gap-2" id={`task-${field}-error`}>
      <ErrorMessage>{status.message}</ErrorMessage>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onPress={() => editor.retryField(field)}>
          {status.conflict ? "Keep my change" : "Retry"}
        </Button>
        <Button variant="secondary" onPress={() => editor.discardField(field)}>
          Use saved value
        </Button>
      </div>
    </div>
  );
}

function agentAvailable(agent: Agent, assigneeId: string | null) {
  return (
    !assigneeId ||
    (agent.scope === "personal"
      ? agent.creatorId === assigneeId
      : agent.allMembers || agent.memberIds.includes(assigneeId))
  );
}

export function TaskPage({
  boardId,
  taskId,
  user,
  members,
  returnHref,
  onBoardLoaded,
  onTaskLoaded,
  sessionRevision,
}: {
  boardId: string;
  taskId: string;
  user: User;
  members: Member[];
  returnHref: string;
  onBoardLoaded: (board: Board) => void;
  onTaskLoaded: (task: Task) => void;
  sessionRevision: number;
}) {
  const editor = useTaskEditor(taskId);
  const { task, values } = editor;
  const writable = user.role !== "viewer";
  const directory = useAgentDirectory(`${user.id}:${user.role}`);
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);
  const [closingDetails, setClosingDetails] = useState(false);
  const [boardError, setBoardError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [deleteKey] = useState(createRetryKey);
  const deleteAttempt = useRef<{ version: number } | null>(null);
  const deletePending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigationPending = useRef(false);
  const focusedTask = useRef<string | null>(null);
  const taskContent = useRef<HTMLDivElement>(null);
  const appSuspended = useAppSuspended();
  const lastSessionRevision = useRef(sessionRevision);

  useEffect(() => {
    if (lastSessionRevision.current === sessionRevision) return;
    lastSessionRevision.current = sessionRevision;
    void editor.reload();
  }, [sessionRevision, editor.reload]);

  useEffect(() => {
    let current = true;
    setBoardError("");
    void api<{ board: Board }>(`/boards/${boardId}`, undefined, "GET", {
      validateResponse: hasBoardResponse,
    })
      .then((result) => {
        if (current) {
          onBoardLoaded(result.board);
        }
      })
      .catch((error) => {
        if (current) setBoardError(errorText(error));
      });
    return () => {
      current = false;
    };
  }, [boardId, onBoardLoaded, sessionRevision]);

  useEffect(() => {
    if (editor.accessDenied) {
      document.title = "Task unavailable · Mill";
      return;
    }
    if (task) {
      document.title = `${task.identifier} · Mill`;
      onTaskLoaded(task);
    }
    if (task && focusedTask.current !== task.id) {
      focusedTask.current = task.id;
      if (
        document.activeElement === document.body ||
        document.activeElement?.closest("#main-content")
      )
        heading.current?.focus({ preventScroll: true });
    }
  }, [task, onTaskLoaded, editor.accessDenied]);

  useEffect(() => {
    const beforeNavigate = (event: Event) => {
      if (!editor.needsFlush()) return;
      event.preventDefault();
      const destination = (event as CustomEvent<NavigationRequest>).detail;
      if (navigationPending.current) {
        destination.waitUntil(Promise.resolve(false));
        return;
      }
      navigationPending.current = true;
      setLeaving(true);
      destination.waitUntil(
        editor.flushAll().then((saved) => {
          navigationPending.current = false;
          setLeaving(false);
          return saved;
        }),
      );
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!editor.needsFlush()) return;
      event.preventDefault();
    };
    window.addEventListener("mill:before-navigate", beforeNavigate);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("mill:before-navigate", beforeNavigate);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [editor.flushAll, editor.needsFlush]);

  function changeAssignee(assigneeId: string | null) {
    if (!values || assigneeId === values.assigneeId) return;
    const assignedAgent = directory.items.find(
      (agent) => agent.id === values.agentId,
    );
    if (
      values.agentId &&
      assignedAgent &&
      !agentAvailable(assignedAgent, assigneeId)
    ) {
      editor.updateAssignment({ assigneeId, agentId: null });
      toast.warning(
        "Agent cleared because it isn't available to this assignee.",
      );
    } else {
      editor.updateField("assigneeId", assigneeId);
    }
  }
  async function closeEditDetails() {
    if (closingDetails) return;
    setClosingDetails(true);
    try {
      if (await editor.flushAll()) setEditDetailsOpen(false);
    } finally {
      setClosingDetails(false);
    }
  }
  async function removeTask() {
    if (!task || deletePending.current) return;
    deletePending.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      if (!deleteAttempt.current) {
        if (!(await editor.flushAll())) {
          setDeleteError(
            "Resolve the unsaved changes before deleting this task.",
          );
          return;
        }
        const latest = await api<{ task: Task }>(
          `/tasks/${taskId}?commentLimit=0&activityLimit=0`,
          undefined,
          "GET",
          { validateResponse: hasTaskResponse },
        );
        deleteAttempt.current = { version: latest.task.version };
      }
      const payload = deleteAttempt.current;
      await api(`/tasks/${taskId}`, payload, "DELETE", {
        validateResponse: hasOkResponse,
        headers: {
          "Idempotency-Key": deleteKey.forRequest(
            `/tasks/${taskId}`,
            payload,
            "DELETE",
          ),
        },
      });
      deleteKey.reset();
      window.history.replaceState(window.history.state, "", returnHref);
      window.dispatchEvent(new Event("mill:navigate"));
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        deleteAttempt.current = null;
        deleteKey.reset();
      }
      setDeleteError(errorText(error));
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  }

  const error = editor.loadError;
  const loadFailure = (
    <ErrorPage
      code={
        [403, 404].includes(editor.loadErrorStatus)
          ? String(editor.loadErrorStatus)
          : "500"
      }
      title={
        editor.loadErrorStatus === 403
          ? "Task access required"
          : "Task unavailable"
      }
      description={
        editor.loadErrorStatus === 403
          ? "You do not have access to this task. Ask an administrator or return to your boards."
          : editor.loadErrorStatus === 404
            ? "This task may have been deleted or the link may be outdated."
            : error || "This task could not be opened. Try again."
      }
      onRetry={() => void editor.reload()}
    />
  );
  if (!editor.loading && (!task || !values)) return loadFailure;
  if (task && task.boardId !== boardId)
    return (
      <ErrorPage
        code="404"
        description="This task does not belong to this board."
      />
    );
  const disabled = !writable || deleting || leaving;
  const assigneeOptions = [
    { id: "", name: "Unassigned", muted: true },
    ...members.map((member) => ({
      id: member.id,
      name: member.name,
      startContent: (
        <Avatar
          className="size-5"
          size="sm"
          email={member.email}
          name={member.name}
        />
      ),
    })),
  ];
  const eligibleAgents = directory.items.filter((agent) =>
    agentAvailable(agent, values?.assigneeId ?? null),
  );
  const agentOptions = [
    { id: "", name: "Unassigned", muted: true },
    ...eligibleAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      startContent: (
        <HugeiconsIcon
          aria-hidden
          className="size-4 text-muted"
          icon={BotIcon}
        />
      ),
    })),
    ...(values?.agentId &&
    !eligibleAgents.some((agent) => agent.id === values.agentId)
      ? [
          {
            id: values.agentId,
            name: task?.agentName ?? "Unavailable agent",
            startContent: (
              <HugeiconsIcon
                aria-hidden
                className="size-4 text-muted"
                icon={BotIcon}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      {editor.accessDenied && loadFailure}
      <div
        ref={taskContent}
        className="w-full min-w-0"
        hidden={editor.accessDenied}
        inert={editor.accessDenied}
        aria-hidden={editor.accessDenied}
      >
        <SuspendedAppProvider value={appSuspended || editor.accessDenied}>
          <PortalProvider getContainer={() => taskContent.current}>
            <div
              className="task-page w-full min-w-0"
              aria-busy={editor.loading}
            >
              {boardError && <ErrorMessage>{boardError}</ErrorMessage>}
              {task && values && (
                <div className="task-page-layout">
                  <div className="task-page-main">
                    <header className="flex flex-wrap items-center justify-between gap-3">
                      <Button
                        variant="ghost"
                        className="task-back-button"
                        onPress={() => navigate(returnHref)}
                        isDisabled={deleting || leaving}
                      >
                        <HugeiconsIcon
                          aria-hidden
                          className="size-4"
                          icon={ArrowLeft01Icon}
                        />
                        Back to board
                      </Button>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="sr-only" role="status">
                          {leaving || editor.pending ? "Saving changes…" : ""}
                        </span>
                        {writable && task && (
                          <Button
                            variant="primary"
                            isIconOnly
                            aria-label="Edit task details"
                            isDisabled={disabled}
                            onPress={() => setEditDetailsOpen(true)}
                          >
                            <HugeiconsIcon
                              aria-hidden
                              className="size-4"
                              icon={PencilEdit02Icon}
                            />
                          </Button>
                        )}
                        {task && (
                          <Dropdown>
                            <Button
                              variant="secondary"
                              isIconOnly
                              aria-label="Task actions"
                              isDisabled={deleting}
                            >
                              <MoreHorizontal />
                            </Button>
                            <Dropdown.Popover
                              placement="bottom end"
                              className="min-w-44"
                            >
                              <Dropdown.Menu
                                aria-label="Task actions"
                                onAction={(key) => {
                                  if (key === "copy")
                                    void navigator.clipboard
                                      .writeText(
                                        `${window.location.origin}/boards/${boardId}/tasks/${taskId}`,
                                      )
                                      .then(() => toast.success("Link copied."))
                                      .catch(() =>
                                        toast.danger(
                                          "Copy the task link from your address bar.",
                                        ),
                                      );
                                  if (key === "delete") {
                                    const openConfirmation = () => {
                                      setDeleteError("");
                                      setConfirmDelete(true);
                                    };
                                    if (
                                      requestNavigation(
                                        returnHref,
                                        openConfirmation,
                                      )
                                    )
                                      openConfirmation();
                                  }
                                }}
                              >
                                <Dropdown.Item id="copy" textValue="Copy link">
                                  <LinkIcon />
                                  Copy link
                                </Dropdown.Item>
                                {writable && (
                                  <Dropdown.Item
                                    id="delete"
                                    variant="danger"
                                    className="text-danger-soft-foreground [&_svg]:text-danger-soft-foreground"
                                    textValue="Delete task"
                                  >
                                    <Trash2 className="text-danger-soft-foreground" />
                                    <span className="text-danger-soft-foreground">
                                      Delete task
                                    </span>
                                  </Dropdown.Item>
                                )}
                              </Dropdown.Menu>
                            </Dropdown.Popover>
                          </Dropdown>
                        )}
                      </div>
                    </header>
                    <section className="mb-1 mt-2" aria-label="Task title">
                      <TypographyHeading
                        ref={heading}
                        tabIndex={-1}
                        elementType="h1"
                        level={2}
                        className="task-page-title min-w-0 break-words text-lg font-medium leading-snug outline-none"
                      >
                        {values.title || task.identifier}
                      </TypographyHeading>
                    </section>
                    <div className="task-page-content grid min-w-0 gap-8">
                      <section
                        className="grid min-w-0 gap-3"
                        aria-label="Description"
                      >
                        <div className="task-description-preview min-w-0 text-sm text-muted">
                          {values.description ? (
                            <Markdown>{values.description}</Markdown>
                          ) : (
                            <TypographyParagraph size="sm" color="muted">
                              No description yet.
                            </TypographyParagraph>
                          )}
                        </div>
                      </section>
                    </div>
                    <section className="task-page-discussion mt-6 min-w-0 pt-6">
                      <TaskDiscussion
                        taskId={taskId}
                        user={user}
                        members={members}
                        editable={writable && !deleting && !leaving}
                        refreshKey={task.version}
                        sessionRevision={sessionRevision}
                      />
                    </section>
                  </div>
                  <aside
                    className="task-page-properties grid min-w-0 gap-5"
                    aria-label="Task properties"
                  >
                    <div className="grid gap-2">
                      <Choice
                        label="Status"
                        value={values.status}
                        items={statusOptions}
                        disabled={disabled}
                        onChange={(value) =>
                          editor.updateField("status", value as Task["status"])
                        }
                      />
                      <FieldFeedback editor={editor} field="status" />
                    </div>
                    <div className="grid gap-2">
                      <Choice
                        label="Assignee"
                        value={values.assigneeId ?? ""}
                        items={assigneeOptions}
                        disabled={disabled}
                        search
                        onChange={(value) => changeAssignee(value || null)}
                      />
                      <FieldFeedback editor={editor} field="assigneeId" />
                    </div>
                    <div className="grid gap-2">
                      <Choice
                        label="Agent"
                        value={values.agentId ?? ""}
                        items={agentOptions}
                        disabled={disabled || directory.pending}
                        search
                        onChange={(value) =>
                          editor.updateField("agentId", value || null)
                        }
                      />
                      <FieldFeedback editor={editor} field="agentId" />
                      {directory.error && (
                        <>
                          <ErrorMessage>{directory.error}</ErrorMessage>
                          <Button
                            variant="secondary"
                            onPress={() => void directory.reload()}
                          >
                            Retry loading agents
                          </Button>
                        </>
                      )}
                    </div>
                    <div className="grid gap-2">
                      <Choice
                        label="Priority"
                        value={values.priority}
                        items={priorityOptions}
                        disabled={disabled}
                        onChange={(value) =>
                          editor.updateField(
                            "priority",
                            value as Task["priority"],
                          )
                        }
                      />
                      <FieldFeedback editor={editor} field="priority" />
                    </div>
                    <div className="grid gap-2">
                      <DatePickerField
                        label="Due date"
                        value={values.dueDate?.slice(0, 10) ?? null}
                        disabled={disabled}
                        onChange={(value) =>
                          editor.updateField("dueDate", value)
                        }
                      />
                      <FieldFeedback editor={editor} field="dueDate" />
                    </div>
                  </aside>
                </div>
              )}
              <Dialog
                open={editDetailsOpen}
                wide
                onClose={() => void closeEditDetails()}
                isDismissDisabled={closingDetails}
                title="Edit task"
                footer={
                  <Button
                    variant="secondary"
                    isDisabled={closingDetails}
                    onPress={() => void closeEditDetails()}
                  >
                    {closingDetails ? "Saving…" : "Close"}
                  </Button>
                }
              >
                {values && (
                  <div className="grid min-w-0 gap-5">
                    <div className="grid gap-2">
                      <TextField
                        label="Title"
                        value={values.title}
                        maxLength={300}
                        required
                        disabled={disabled || closingDetails}
                        onChange={(event) =>
                          editor.textChange("title", event.target.value)
                        }
                        onBlur={() => void editor.flushField("title")}
                        aria-invalid={editor.fields.title?.state === "error"}
                        aria-describedby={
                          editor.fields.title?.state === "error"
                            ? "task-title-error"
                            : undefined
                        }
                      />
                      <FieldFeedback editor={editor} field="title" />
                    </div>
                    <div className="grid gap-2">
                      <TextField
                        label="Description"
                        multiline
                        rows={10}
                        value={values.description}
                        maxLength={100000}
                        disabled={disabled || closingDetails}
                        onChange={(event) =>
                          editor.textChange("description", event.target.value)
                        }
                        onBlur={() => void editor.flushField("description")}
                        aria-invalid={
                          editor.fields.description?.state === "error"
                        }
                        aria-describedby={
                          editor.fields.description?.state === "error"
                            ? "task-description-error"
                            : undefined
                        }
                      />
                      <FieldFeedback editor={editor} field="description" />
                    </div>
                  </div>
                )}
              </Dialog>
              <Dialog
                open={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                isDismissDisabled={deleting}
                title="Delete this task?"
                footer={
                  <>
                    <Button
                      variant="secondary"
                      isDisabled={deleting}
                      onPress={() => setConfirmDelete(false)}
                    >
                      Keep task
                    </Button>
                    <Button
                      variant="danger"
                      isDisabled={deleting}
                      onPress={() => void removeTask()}
                    >
                      {deleting ? "Deleting…" : "Delete task"}
                    </Button>
                  </>
                }
              >
                <TypographyParagraph size="sm">
                  Permanently delete “{task?.title}” and its comments and
                  history? This cannot be undone.
                </TypographyParagraph>
                <ErrorMessage>{deleteError}</ErrorMessage>
              </Dialog>
            </div>
          </PortalProvider>
        </SuspendedAppProvider>
      </div>
    </>
  );
}
