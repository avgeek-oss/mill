import { QueryFeedback } from "./query-feedback.js";
import { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import { usePageBreadcrumbs } from "./app-breadcrumbs.js";
import { ChoiceField, ActionConfirmation } from "@avgeek-oss/design-system";
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
import { Copy01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type {
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
import {
  hasBoardResponse,
  hasOkResponse,
  hasTaskResponse,
} from "./responses.js";
import { ErrorPage, errorPageCode } from "./error-page.js";
import { LinkIcon, MoreHorizontal, Trash2 } from "./icons.js";
import { Markdown } from "./markdown.js";
import { priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";
import { taskTypeOptions } from "./task-type.js";
import { TaskDiscussion } from "./task-discussion.js";
import {
  CreateTaskDialog,
  type DuplicateTaskSource,
} from "./create-task-dialog.js";
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
    <div
      className="flex flex-wrap items-center gap-2"
      id={`task-${field}-error`}
    >
      <ErrorMessage key={status.feedbackRevision}>
        {status.message}
      </ErrorMessage>
      <Button variant="secondary" onPress={() => editor.retryField(field)}>
        {status.conflict ? "Keep my change" : "Retry"}
      </Button>
      <Button variant="secondary" onPress={() => editor.discardField(field)}>
        Use saved value
      </Button>
    </div>
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
  const breadcrumbs = usePageBreadcrumbs();
  const editor = useTaskEditor(taskId);
  const { task, values } = editor;
  const writable = user.role !== "viewer";
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] =
    useState<DuplicateTaskSource | null>(null);
  const [closingDetails, setClosingDetails] = useState(false);
  const [boardError, setBoardError] = useState("");
  const [boardRevision, setBoardRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    if (editor.accessDenied)
      window.dispatchEvent(new Event("mill:route-access-denied"));
  }, [editor.accessDenied]);

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
  }, [boardId, onBoardLoaded, sessionRevision, boardRevision]);

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
    editor.updateField("assigneeId", assigneeId);
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
    try {
      if (!deleteAttempt.current) {
        if (!(await editor.flushAll())) {
          throw new Error(
            "Resolve the unsaved changes before deleting this task.",
          );
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
      toast.success("Task deleted.");
      window.history.replaceState(
        { ...window.history.state, millFocusAfterTaskDeletion: true },
        "",
        returnHref,
      );
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
      throw error;
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  }

  const error = editor.loadError;
  const loadFailure = (
    <ErrorPage
      code={errorPageCode(editor.loadErrorStatus)}
      pending={editor.loading}
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
  if (!editor.loading && (!task || !values)) {
    if (![403, 404].includes(editor.loadErrorStatus)) {
      return (
        <QueryFeedback
          message={error || "This task could not be opened."}
          onRetry={() => void editor.reload()}
        />
      );
    }
    return loadFailure;
  }
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

  return (
    <>
      {!editor.accessDenied && (
        <AppShellBreadcrumb items={breadcrumbs} title={task?.title ?? "Task"} />
      )}
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
              {boardError && (
                <QueryFeedback
                  message={boardError}
                  onRetry={() => setBoardRevision((revision) => revision + 1)}
                />
              )}
              {error && !editor.accessDenied && task && (
                <QueryFeedback
                  message={error}
                  onRetry={() => void editor.reload()}
                />
              )}
              {task && values && (
                <section
                  aria-label="Task details"
                  className="content-grid min-w-0 items-start pt-5 min-[701px]:grid-cols-[minmax(0,1fr)_20rem] min-[701px]:gap-x-8"
                >
                  <header className="task-page-header col-span-full grid min-w-0">
                    <Button
                      variant="ghost"
                      className="task-back-button"
                      onPress={() => navigate(returnHref)}
                      isDisabled={deleting || leaving}
                    >
                      Back to board
                    </Button>
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <section
                        className="min-w-0 flex-1"
                        aria-label="Task title"
                      >
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
                      <div className="flex shrink-0 items-center gap-3">
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
                                  if (key === "copy") {
                                    void (async () => {
                                      try {
                                        await navigator.clipboard.writeText(
                                          `${window.location.origin}/boards/${boardId}/tasks/${taskId}`,
                                        );
                                        toast.success("Link copied.");
                                      } catch {
                                        toast.danger(
                                          "Copy the task link from your address bar.",
                                        );
                                      }
                                    })();
                                  }
                                  if (key === "delete") {
                                    const openConfirmation = () => {
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
                                  if (key === "duplicate" && writable) {
                                    setDuplicateSource({
                                      title: values.title,
                                      description: values.description,
                                      type: values.type,
                                      priority: values.priority,
                                    });
                                  }
                                }}
                              >
                                <Dropdown.Item id="copy" textValue="Copy link">
                                  <LinkIcon />
                                  Copy link
                                </Dropdown.Item>
                                {writable && (
                                  <Dropdown.Item
                                    id="duplicate"
                                    textValue="Duplicate task"
                                    isDisabled={disabled}
                                  >
                                    <HugeiconsIcon
                                      icon={Copy01Icon}
                                      size={16}
                                    />
                                    Duplicate task
                                  </Dropdown.Item>
                                )}
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
                    </div>
                  </header>
                  <div className="task-page-main contents min-w-0 min-[701px]:block">
                    <div className="task-page-content col-start-1 row-start-2 grid min-w-0 gap-8">
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
                    <section className="task-page-discussion col-start-1 row-start-4 min-w-0 pt-6">
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
                    className="task-page-properties col-start-1 row-start-3 grid min-w-0 grid-cols-2 gap-4 min-[701px]:col-start-2 min-[701px]:row-start-2 min-[701px]:grid-cols-1 min-[701px]:gap-5"
                    aria-label="Task properties"
                  >
                    <div className="grid min-w-0 grid-cols-1 gap-2">
                      <ChoiceField
                        label="Type"
                        value={values.type}
                        options={taskTypeOptions.map((option) => ({
                          id: option.id,
                          label: option.name,
                          icon: option.startContent,
                        }))}
                        isDisabled={disabled}
                        onChange={(value) =>
                          editor.updateField("type", value as Task["type"])
                        }
                      />
                      <FieldFeedback editor={editor} field="type" />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-2">
                      <ChoiceField
                        label="Status"
                        value={values.status}
                        options={statusOptions.map((option) => ({
                          id: option.id,
                          label: option.name,
                          icon: option.startContent,
                        }))}
                        isDisabled={disabled}
                        onChange={(value) =>
                          editor.updateField("status", value as Task["status"])
                        }
                      />
                      <FieldFeedback editor={editor} field="status" />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-2">
                      <Choice
                        className="min-w-0"
                        label="Assignee"
                        value={values.assigneeId ?? ""}
                        items={assigneeOptions}
                        disabled={disabled}
                        search
                        onChange={(value) => changeAssignee(value || null)}
                      />
                      <FieldFeedback editor={editor} field="assigneeId" />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-2">
                      <ChoiceField
                        label="Priority"
                        value={values.priority}
                        options={priorityOptions.map((option) => ({
                          id: option.id,
                          label: option.name,
                          icon: option.startContent,
                        }))}
                        isDisabled={disabled}
                        onChange={(value) =>
                          editor.updateField(
                            "priority",
                            value as Task["priority"],
                          )
                        }
                      />
                      <FieldFeedback editor={editor} field="priority" />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-2">
                      <DatePickerField
                        label="Start date"
                        value={values.startDate?.slice(0, 10) ?? null}
                        disabled={disabled}
                        onChange={(value) =>
                          editor.updateField("startDate", value)
                        }
                      />
                      <FieldFeedback editor={editor} field="startDate" />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-2">
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
                </section>
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
                      />
                      <FieldFeedback editor={editor} field="description" />
                    </div>
                  </div>
                )}
              </Dialog>
              {duplicateSource && (
                <CreateTaskDialog
                  boardId={boardId}
                  members={members}
                  user={user}
                  open
                  duplicateSource={duplicateSource}
                  onClose={() => setDuplicateSource(null)}
                  onCreated={(created) => {
                    setDuplicateSource(null);
                    navigate(
                      `/boards/${boardId}/tasks/${created.id}${window.location.search}`,
                    );
                  }}
                />
              )}
              <ActionConfirmation
                isOpen={confirmDelete}
                onOpenChange={setConfirmDelete}
                title="Delete this task?"
                description={`Permanently delete “${task?.title}” and its comments and history? This cannot be undone.`}
                confirmLabel="Delete task"
                variant="danger"
                onConfirm={removeTask}
              />
            </div>
          </PortalProvider>
        </SuspendedAppProvider>
      </div>
    </>
  );
}
