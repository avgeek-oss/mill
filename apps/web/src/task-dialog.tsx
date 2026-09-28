import { useEffect, useState, type FormEvent } from "react";
import {
  Button,
  Chip,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
} from "@mill/web-design-system";
import { Check, Link, Plus, Trash2 } from "lucide-react";
import type {
  Activity,
  ChecklistItem,
  Column,
  Comment,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import { ApiError, api, errorText, type User } from "./api.js";
import { Markdown } from "./markdown.js";
export type TaskSelection = {
  id?: string;
  columnId?: string;
  parentId?: string;
};
const priorities = ["none", "low", "medium", "high", "urgent"];
type TaskDetail = {
  task: Task;
  comments: Comment[];
  activity: Activity[];
  subtasks?: Pick<Task, "id" | "identifier" | "title">[];
  parent?: Pick<Task, "id" | "identifier" | "title"> | null;
  commentsPage?: { hasMore: boolean; nextCursor: string | null };
  activityPage?: { hasMore: boolean; nextCursor: string | null };
  subtasksPage?: { hasMore: boolean; nextCursor: string | null };
};
export function TaskDialog({
  selection,
  boardId,
  columns,
  members,
  tasks,
  user,
  readOnly = false,
  onClose,
  onSaved,
  onSelect,
}: {
  selection: TaskSelection;
  boardId: string;
  columns: Column[];
  members: Member[];
  tasks: Task[];
  user: User;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onSelect: (next: TaskSelection) => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    columnId: selection.columnId ?? columns[0]?.id ?? "",
    assigneeId: "",
    priority: "none",
    labels: "",
    dueDate: "",
    parentId: selection.parentId ?? "",
  });
  const [taskOptions, setTaskOptions] = useState<Task[]>(tasks);
  const [optionsCursor, setOptionsCursor] = useState<string | null>(null);
  const [beforeId, setBeforeId] = useState("keep");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [itemText, setItemText] = useState("");
  const [subtasksCursor, setSubtasksCursor] = useState<string | null>(null);
  const [subtasksMore, setSubtasksMore] = useState(false);
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [commentsMore, setCommentsMore] = useState(false);
  const [activityMore, setActivityMore] = useState(false);
  const [comment, setComment] = useState("");
  const [commentEdit, setCommentEdit] = useState<Comment | null>(null);
  const [preview, setPreview] = useState(!!selection.id);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!selection.id);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState("comments");
  const [copyNotice, setCopyNotice] = useState("");
  const writable = user.role !== "viewer" && !readOnly;
  async function load() {
    if (!selection.id) return;
    setLoading(true);
    setError("");
    try {
      const next = await api<TaskDetail>(`/tasks/${selection.id}`);
      setDetail(next);
      setCommentsCursor(
        next.commentsPage?.nextCursor ?? next.comments.at(-1)?.id ?? null,
      );
      setSubtasksCursor(next.subtasksPage?.nextCursor ?? null);
      setSubtasksMore(next.subtasksPage?.hasMore ?? false);
      setActivityCursor(
        next.activityPage?.nextCursor ?? next.activity.at(-1)?.id ?? null,
      );
      setCommentsMore(
        next.commentsPage?.hasMore ?? next.comments.length === 100,
      );
      setActivityMore(
        next.activityPage?.hasMore ?? next.activity.length === 100,
      );
      setForm({
        title: next.task.title,
        description: next.task.description,
        columnId: next.task.columnId,
        assigneeId: next.task.assigneeId ?? "",
        priority: next.task.priority,
        labels: next.task.labels.join(", "),
        dueDate: next.task.dueDate?.slice(0, 10) ?? "",
        parentId: next.task.parentId ?? "",
      });
      setChecklist(next.task.checklist);
      setConflict(false);
      setBeforeId("keep");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    void loadOptions();
  }, [selection.id]);
  async function loadOptions(cursor?: string) {
    try {
      const page = await api<{ items: Task[]; nextCursor?: string | null }>(
        `/boards/${boardId}/tasks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setTaskOptions((prev) =>
        cursor ? [...prev, ...page.items] : page.items,
      );
      setOptionsCursor(page.nextCursor ?? null);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (detail) document.title = `${detail.task.identifier} · Mill`;
  }, [detail?.task.identifier]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const payload = {
        ...form,
        assigneeId: form.assigneeId || null,
        parentId: form.parentId || null,
        dueDate: form.dueDate || null,
        labels: form.labels
          .split(",")
          .map((i) => i.trim())
          .filter(Boolean),
        checklist,
        ...(beforeId === "keep" ? {} : { beforeId: beforeId || null }),
        ...(detail ? { version: detail.task.version } : {}),
      };
      const result = await api<{ task: Task }>(
        detail ? `/tasks/${detail.task.id}` : `/boards/${boardId}/tasks`,
        payload,
        detail ? "PATCH" : "POST",
      );
      if (detail) {
        setDetail({ ...detail, task: result.task });
        setCopyNotice("Changes saved.");
      } else onSelect({ id: result.task.id });
    });
  }
  function patch(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setCopyNotice("");
  }
  async function loadDiscussion(kind: "comments" | "activity") {
    await run(async () => {
      const cursor = kind === "comments" ? commentsCursor : activityCursor;
      const page = await api<{
        items: (Comment | Activity)[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(
        `/tasks/${detail!.task.id}/${kind}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      setDetail((prev) => {
        if (!prev) return prev;
        const merged = [...prev[kind], ...page.items].filter(
          (item, index, list) =>
            list.findIndex((i) => i.id === item.id) === index,
        );
        return {
          ...prev,
          [kind]: merged.sort((a, b) =>
            kind === "comments"
              ? a.createdAt.localeCompare(b.createdAt)
              : b.createdAt.localeCompare(a.createdAt),
          ),
        };
      });
      if (kind === "comments") {
        setCommentsCursor(page.nextCursor);
        setCommentsMore(page.hasMore);
      } else {
        setActivityCursor(page.nextCursor);
        setActivityMore(page.hasMore);
      }
    });
  }
  async function loadSubtasks() {
    await run(async () => {
      const next = await api<{
        items: Pick<Task, "id" | "identifier" | "title">[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(
        `/tasks/${detail!.task.id}/subtasks?limit=100${subtasksCursor ? `&cursor=${subtasksCursor}` : ""}`,
      );
      setDetail((prev) =>
        prev
          ? { ...prev, subtasks: [...(prev.subtasks ?? []), ...next.items] }
          : prev,
      );
      setSubtasksMore(next.hasMore);
      setSubtasksCursor(next.nextCursor);
    });
  }
  async function submitComment() {
    await run(async () => {
      const result = await api<{ comment: Comment }>(
        commentEdit
          ? `/comments/${commentEdit.id}`
          : `/tasks/${detail!.task.id}/comments`,
        {
          body: comment,
          ...(commentEdit ? { version: commentEdit.version } : {}),
        },
        commentEdit ? "PATCH" : "POST",
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              comments: commentEdit
                ? prev.comments.map((c) =>
                    c.id === commentEdit.id ? result.comment : c,
                  )
                : [...prev.comments, result.comment],
            }
          : prev,
      );
      setComment("");
      setCommentEdit(null);
      const activity = await api<{ items: Activity[] }>(
        `/tasks/${detail!.task.id}/activity?limit=100`,
      );
      setDetail((prev) =>
        prev ? { ...prev, activity: activity.items } : prev,
      );
      setActivityCursor(activity.items.at(-1)?.id ?? null);
      setActivityMore(activity.items.length === 100);
    });
  }
  async function lifecycle(action: "archive" | "restore" | "delete") {
    await run(async () => {
      if (action === "delete")
        await api(
          `/tasks/${detail!.task.id}`,
          { version: detail!.task.version },
          "DELETE",
        );
      else if (detail!.task.deletedAt)
        await api(`/tasks/${detail!.task.id}/restore`, {
          version: detail!.task.version,
        });
      else
        await api(
          `/tasks/${detail!.task.id}`,
          { version: detail!.task.version, archived: action === "archive" },
          "PATCH",
        );
      onClose();
    });
  }
  const subtasks = detail
    ? (detail.subtasks ?? tasks.filter((t) => t.parentId === detail.task.id))
    : [];
  const parents = [
    ...taskOptions,
    ...(detail?.parent && !taskOptions.some((t) => t.id === detail.parent?.id)
      ? [detail.parent]
      : []),
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={
        detail
          ? detail.task.identifier
          : selection.parentId
            ? "New subtask"
            : "New task"
      }
      footer={
        <>
          <span className="dialog-status" role="status">
            {busy ? "Saving…" : copyNotice}
          </span>
          <Button variant="secondary" onPress={onClose}>
            Close
          </Button>
          {writable && !detail?.task.deletedAt && (
            <Button isDisabled={busy || loading} type="submit" form="task-form">
              {detail ? "Save changes" : "Create task"}
            </Button>
          )}
        </>
      }
    >
      {loading ? (
        <p role="status">Loading task…</p>
      ) : (
        <>
          <ErrorMessage>{error}</ErrorMessage>
          {conflict && (
            <div className="conflict">
              <p>
                Another person changed this task. Reload the current version
                before saving again. Your draft stays here until you reload.
              </p>
              <Button variant="secondary" onPress={() => void load()}>
                Reload task
              </Button>
            </div>
          )}
          <form
            id="task-form"
            className="task-layout"
            onSubmit={(e) => void save(e)}
          >
            <div className="task-content">
              <TextField
                label="Title"
                value={form.title}
                onChange={(e) => patch("title", e.target.value)}
                required
                maxLength={300}
                disabled={!writable || !!detail?.task.deletedAt}
                autoFocus={!selection.id}
              />
              <div className="field">
                <div className="row space-between">
                  <span className="field-label">Description</span>
                  <div className="segmented">
                    <Button
                      variant={preview ? "ghost" : "secondary"}
                      onPress={() => setPreview(false)}
                    >
                      Write
                    </Button>
                    <Button
                      variant={preview ? "secondary" : "ghost"}
                      onPress={() => setPreview(true)}
                    >
                      Preview
                    </Button>
                  </div>
                </div>
                {preview ? (
                  <div className="markdown-preview">
                    {form.description ? (
                      <Markdown>{form.description}</Markdown>
                    ) : (
                      <p className="muted">No description yet.</p>
                    )}
                  </div>
                ) : (
                  <TextField
                    label="Markdown description"
                    multiline
                    value={form.description}
                    onChange={(e) => patch("description", e.target.value)}
                    maxLength={50000}
                    disabled={!writable}
                    placeholder="Add context, links, or a plan…"
                  />
                )}
              </div>
              <div className="field">
                <div className="row space-between">
                  <span className="field-label">Checklist</span>
                  <span className="small muted">
                    {checklist.filter((i) => i.done).length}/{checklist.length}
                  </span>
                </div>
                {checklist.map((item) => (
                  <div className="checklist-row" key={item.id}>
                    <input
                      aria-label={item.text}
                      type="checkbox"
                      checked={item.done}
                      disabled={!writable}
                      onChange={(e) =>
                        setChecklist((prev) =>
                          prev.map((i) =>
                            i.id === item.id
                              ? { ...i, done: e.target.checked }
                              : i,
                          ),
                        )
                      }
                    />
                    <span className={item.done ? "completed" : ""}>
                      {item.text}
                    </span>
                    {writable && (
                      <Button
                        variant="ghost"
                        aria-label={`Remove ${item.text}`}
                        onPress={() =>
                          setChecklist((prev) =>
                            prev.filter((i) => i.id !== item.id),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                ))}
                {writable && (
                  <div className="row">
                    <TextField
                      label="New checklist item"
                      value={itemText}
                      onChange={(e) => setItemText(e.target.value)}
                      maxLength={500}
                    />
                    <Button
                      variant="secondary"
                      isDisabled={!itemText.trim()}
                      onPress={() => {
                        setChecklist((prev) => [
                          ...prev,
                          {
                            id: crypto.randomUUID(),
                            text: itemText.trim(),
                            done: false,
                          },
                        ]);
                        setItemText("");
                      }}
                      aria-label="Add checklist item"
                    >
                      <Plus />
                    </Button>
                  </div>
                )}
              </div>
              {detail && (
                <div className="field">
                  <div className="row space-between">
                    <span className="field-label">Subtasks</span>
                    {writable && (
                      <Button
                        variant="ghost"
                        onPress={() =>
                          onSelect({
                            parentId: detail.task.id,
                            columnId: detail.task.columnId,
                          })
                        }
                      >
                        <Plus />
                        Add subtask
                      </Button>
                    )}
                  </div>
                  {subtasks.length ? (
                    subtasks.map((task) => (
                      <Button
                        key={task.id}
                        variant="ghost"
                        className="subtask-link"
                        onPress={() => onSelect({ id: task.id })}
                      >
                        <span className="mono muted">{task.identifier}</span>
                        <span>{task.title}</span>
                      </Button>
                    ))
                  ) : (
                    <p className="small muted">No subtasks yet.</p>
                  )}
                  {subtasksMore && (
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void loadSubtasks()}
                    >
                      Load more subtasks
                    </Button>
                  )}
                </div>
              )}
            </div>
            <aside className="task-properties">
              <Choice
                label="Status"
                value={form.columnId}
                onChange={(value) => patch("columnId", value)}
                items={columns}
                disabled={!writable}
                search
              />
              <Choice
                label="Assignee"
                value={form.assigneeId}
                onChange={(value) => patch("assigneeId", value)}
                items={[{ id: "", name: "Unassigned" }, ...members]}
                disabled={!writable}
                search
              />
              <Choice
                label="Priority"
                value={form.priority}
                onChange={(value) => patch("priority", value)}
                items={priorities.map((id) => ({
                  id,
                  name:
                    id === "none"
                      ? "No priority"
                      : id[0].toUpperCase() + id.slice(1),
                }))}
                disabled={!writable}
              />
              <TextField
                label="Labels"
                value={form.labels}
                onChange={(e) => patch("labels", e.target.value)}
                description="Separate labels with commas."
                maxLength={500}
                disabled={!writable}
              />
              <TextField
                label="Due date"
                type="date"
                value={form.dueDate}
                onChange={(e) => patch("dueDate", e.target.value)}
                disabled={!writable}
              />
              <Choice
                label="Parent task"
                value={form.parentId}
                onChange={(value) => patch("parentId", value)}
                items={[
                  { id: "", name: "No parent" },
                  ...parents
                    .filter((t) => t.id !== selection.id)
                    .map((t) => ({
                      id: t.id,
                      name: `${t.identifier} · ${t.title}`,
                    })),
                ]}
                disabled={!writable}
                search
              />
              {optionsCursor && (
                <Button
                  variant="ghost"
                  onPress={() => void loadOptions(optionsCursor)}
                >
                  Load more parent choices
                </Button>
              )}
              {detail && (
                <Choice
                  label="Position in status"
                  value={beforeId}
                  onChange={setBeforeId}
                  items={[
                    { id: "keep", name: "Keep current order" },
                    { id: "", name: "Move to the end" },
                    ...taskOptions
                      .filter(
                        (t) =>
                          t.id !== detail.task.id &&
                          t.columnId === form.columnId,
                      )
                      .map((t) => ({
                        id: t.id,
                        name: `Before ${t.identifier} · ${t.title}`,
                      })),
                  ]}
                  disabled={!writable}
                  search
                />
              )}
              {detail && (
                <>
                  <p className="small muted">
                    Created{" "}
                    {new Date(detail.task.createdAt).toLocaleDateString(
                      undefined,
                      { timeZone: user.timeZone },
                    )}
                    <br />
                    Updated{" "}
                    {new Date(detail.task.updatedAt).toLocaleDateString(
                      undefined,
                      { timeZone: user.timeZone },
                    )}
                  </p>
                  <Button
                    variant="ghost"
                    onPress={() =>
                      void navigator.clipboard
                        .writeText(
                          `${window.location.origin}/boards/${boardId}/tasks/${detail.task.id}`,
                        )
                        .then(() => setCopyNotice("Task link copied."))
                        .catch(() =>
                          setError(
                            "Your browser could not copy this link. Copy it from the address bar.",
                          ),
                        )
                    }
                  >
                    <Link />
                    Copy task link
                  </Button>
                  {detail.task.archived && <Chip>Archived</Chip>}
                  {detail.task.deletedAt && <Chip color="danger">Deleted</Chip>}
                  {writable && (
                    <div className="stack compact">
                      {detail.task.deletedAt ? (
                        <Button
                          variant="secondary"
                          onPress={() => void lifecycle("restore")}
                          isDisabled={busy}
                        >
                          Restore task
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            onPress={() =>
                              void lifecycle(
                                detail.task.archived ? "restore" : "archive",
                              )
                            }
                            isDisabled={busy}
                          >
                            {detail.task.archived
                              ? "Restore from archive"
                              : "Archive task"}
                          </Button>
                          <Button
                            variant="danger-ghost"
                            onPress={() => setConfirm(true)}
                          >
                            Delete task
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </aside>
          </form>
          {detail && (
            <section className="task-discussion">
              <div className="segmented">
                <Button
                  variant={tab === "comments" ? "secondary" : "ghost"}
                  onPress={() => setTab("comments")}
                >
                  Comments ({detail.comments.length})
                </Button>
                <Button
                  variant={tab === "activity" ? "secondary" : "ghost"}
                  onPress={() => setTab("activity")}
                >
                  Activity
                </Button>
              </div>
              {tab === "activity" ? (
                <div>
                  <ol className="activity-list">
                    {detail.activity.map((item) => (
                      <li key={item.id}>
                        <span className="activity-dot" />
                        <div>
                          <strong>{item.actorName}</strong>
                          {item.actorKind === "agent" && (
                            <Chip>Agent</Chip>
                          )}{" "}
                          {item.action.replaceAll("_", " ")}
                          <time>
                            {new Date(item.createdAt).toLocaleString(
                              undefined,
                              {
                                timeZone: user.timeZone,
                              },
                            )}
                          </time>
                        </div>
                      </li>
                    ))}
                    {!detail.activity.length && (
                      <li className="muted">No activity yet.</li>
                    )}
                  </ol>
                  {activityMore && (
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void loadDiscussion("activity")}
                    >
                      Load earlier activity
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <div className="comment-list">
                    {detail.comments.map((item) => (
                      <article className="comment" key={item.id}>
                        <div className="row space-between">
                          <strong>{item.authorName}</strong>
                          <time className="muted small">
                            {new Date(item.createdAt).toLocaleString(
                              undefined,
                              { timeZone: user.timeZone },
                            )}
                          </time>
                        </div>
                        <Markdown>{item.body}</Markdown>
                        {writable &&
                          (item.authorId === user.id ||
                            user.role === "admin") && (
                            <div className="row">
                              <Button
                                variant="ghost"
                                onPress={() => {
                                  setCommentEdit(item);
                                  setComment(item.body);
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="danger-ghost"
                                onPress={() =>
                                  void run(async () => {
                                    await api(
                                      `/comments/${item.id}`,
                                      { version: item.version },
                                      "DELETE",
                                    );
                                    setDetail({
                                      ...detail,
                                      comments: detail.comments.filter(
                                        (c) => c.id !== item.id,
                                      ),
                                    });
                                  })
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          )}
                      </article>
                    ))}
                  </div>
                  {commentsMore && (
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void loadDiscussion("comments")}
                    >
                      Load more comments
                    </Button>
                  )}
                  {writable && !detail.task.deletedAt && (
                    <div className="stack compact">
                      <TextField
                        label={commentEdit ? "Edit comment" : "Add a comment"}
                        multiline
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        maxLength={10000}
                        description="Use @email to mention a teammate. Markdown is supported."
                      />
                      <div className="row">
                        <Button
                          isDisabled={!comment.trim() || busy}
                          onPress={() => void submitComment()}
                        >
                          <Check />
                          {commentEdit ? "Save comment" : "Comment"}
                        </Button>
                        {commentEdit && (
                          <Button
                            variant="ghost"
                            onPress={() => {
                              setCommentEdit(null);
                              setComment("");
                            }}
                          >
                            Cancel edit
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this task?"
        footer={
          <>
            <Button variant="secondary" onPress={() => setConfirm(false)}>
              Keep task
            </Button>
            <Button
              variant="danger"
              onPress={() => void lifecycle("delete")}
              isDisabled={busy}
            >
              Delete task
            </Button>
          </>
        }
      >
        <p>
          This task moves to deleted tasks. You can restore it from the board’s
          deleted view.
        </p>
        <ErrorMessage>{error}</ErrorMessage>
      </Dialog>
    </Dialog>
  );
}
