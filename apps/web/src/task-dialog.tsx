import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Chip,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
  Alert,
  Checkbox,
  Field,
  FieldLabel,
  FieldSeparator,
  Label,
  Tabs,
  TextArea,
  TypographyParagraph,
  TypographyText,
} from "@mill/web-design-system";
import { Check, LinkIcon, Plus, Trash2 } from "./icons.js";
import type {
  Activity,
  Agent,
  ChecklistItem,
  Comment,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import { ApiError, api, createRetryKey, errorText, type User } from "./api.js";
import { Markdown } from "./markdown.js";
import { activityLabel, taskStatusLabel } from "./activity-label.js";
import {
  TASK_STATUSES,
  type TaskStatus,
} from "../../../packages/contracts/src/index.js";
import {
  hasAgentsResponse,
  hasCommentResponse,
  hasOkResponse,
  hasTaskResponse,
} from "./responses.js";
export type TaskSelection = {
  id?: string;
};
const priorities = ["none", "low", "medium", "high", "urgent"];
type TaskDetail = {
  task: Task;
  comments: Comment[];
  activity: Activity[];
  commentsPage?: { hasMore: boolean; nextCursor: string | null };
  activityPage?: { hasMore: boolean; nextCursor: string | null };
};
export function TaskDialog({
  selection,
  boardId,
  members,
  user,
  readOnly = false,
  onClose,
  onSaved,
  onSelect,
}: {
  selection: TaskSelection;
  boardId: string;
  members: Member[];
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
    status: "todo" as TaskStatus,
    assigneeId: "",
    agentId: "",
    priority: "none",
    dueDate: "",
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const latestAgentsLoad = useRef(0);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [itemText, setItemText] = useState("");
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [commentsMore, setCommentsMore] = useState(false);
  const [activityMore, setActivityMore] = useState(false);
  const [comment, setComment] = useState("");
  const [commentEdit, setCommentEdit] = useState<Comment | null>(null);
  const [taskCreateKey] = useState(createRetryKey);
  const [commentCreateKey] = useState(createRetryKey);
  const [taskDeleteKey] = useState(createRetryKey);
  const [commentToDelete, setCommentToDelete] = useState<Comment | null>(null);
  const [preview, setPreview] = useState(!!selection.id);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!selection.id);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState<
    "task" | "discussion" | "lifecycle"
  >("task");
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState("comments");
  const [copyNotice, setCopyNotice] = useState("");
  const writable = user.role !== "viewer" && !readOnly;
  const editable = writable;
  function close() {
    if (busy) return;
    taskCreateKey.reset();
    commentCreateKey.reset();
    onClose();
  }
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
        status: next.task.status,
        assigneeId: next.task.assigneeId ?? "",
        agentId: next.task.agentId ?? "",
        priority: next.task.priority,
        dueDate: next.task.dueDate?.slice(0, 10) ?? "",
      });
      setChecklist(next.task.checklist);
      setConflict(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  async function loadAgents() {
    const request = ++latestAgentsLoad.current;
    setAgentsLoading(true);
    setAgentsError("");
    try {
      const collected: Agent[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: "100" });
        if (cursor) params.set("cursor", cursor);
        const page = await api<{
          items: Agent[];
          hasMore: boolean;
          nextCursor: string | null;
        }>(`/agents?${params}`, undefined, "GET", {
          validateResponse: hasAgentsResponse,
        });
        if (request !== latestAgentsLoad.current) return;
        collected.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      if (request === latestAgentsLoad.current) setAgents(collected);
    } catch (error) {
      if (request === latestAgentsLoad.current)
        setAgentsError(errorText(error));
    } finally {
      if (request === latestAgentsLoad.current) setAgentsLoading(false);
    }
  }
  useEffect(() => {
    if (writable) void loadAgents();
    return () => {
      ++latestAgentsLoad.current;
    };
  }, [writable, user.id]);
  function agentBindingError() {
    if (!form.agentId) return "";
    if (!members.some((member) => member.id === form.assigneeId))
      return "Choose an active human assignee before assigning an agent.";
    if (
      detail?.task.agentId === form.agentId &&
      detail.task.assigneeId === form.assigneeId
    )
      return "";
    const selected = agents.find((agent) => agent.id === form.agentId);
    if (!selected)
      return "Choose an agent available to you, or clear the agent.";
    const available =
      selected.scope === "personal"
        ? selected.creatorId === form.assigneeId
        : selected.memberIds.includes(form.assigneeId);
    return available
      ? ""
      : "This agent is not available to the selected assignee.";
  }
  useEffect(() => {
    void load();
  }, [selection.id]);
  useEffect(() => {
    if (detail) document.title = `${detail.task.identifier} · Mill`;
  }, [detail?.task.identifier]);
  async function run(
    action: () => Promise<void>,
    context: "task" | "discussion" | "lifecycle" = "task",
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setErrorAction(context);
      if (context !== "discussion")
        setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (selection.id && !detail) return;
    const bindingError = agentBindingError();
    if (bindingError) {
      setError(bindingError);
      setErrorAction("task");
      setConflict(false);
      return;
    }
    await run(async () => {
      const payload = {
        ...form,
        assigneeId: form.assigneeId || null,
        agentId: form.agentId || null,
        dueDate: form.dueDate || null,
        checklist,
        ...(detail ? { version: detail.task.version } : {}),
      };
      const path = detail
        ? `/tasks/${detail.task.id}`
        : `/boards/${boardId}/tasks`;
      const result = await api<{ task: Task }>(
        path,
        payload,
        detail ? "PATCH" : "POST",
        {
          validateResponse: hasTaskResponse,
          ...(!detail
            ? {
                headers: {
                  "Idempotency-Key": taskCreateKey.forRequest(path, payload),
                },
              }
            : {}),
        },
      );
      if (detail) {
        setDetail({ ...detail, task: result.task });
        setCopyNotice("Changes saved.");
      } else {
        taskCreateKey.reset();
        onSelect({ id: result.task.id });
      }
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
    }, "discussion");
  }
  async function submitComment() {
    await run(async () => {
      const path = commentEdit
        ? `/comments/${commentEdit.id}`
        : `/tasks/${detail!.task.id}/comments`;
      const payload = {
        body: comment,
        ...(commentEdit ? { version: commentEdit.version } : {}),
      };
      const result = await api<{ comment: Comment }>(
        path,
        payload,
        commentEdit ? "PATCH" : "POST",
        {
          validateResponse: hasCommentResponse,
          ...(!commentEdit
            ? {
                headers: {
                  "Idempotency-Key": commentCreateKey.forRequest(path, payload),
                },
              }
            : {}),
        },
      );
      if (!commentEdit) commentCreateKey.reset();
      const savedComment = {
        ...result.comment,
        authorName:
          result.comment.authorName ?? commentEdit?.authorName ?? user.name,
      };
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              comments: commentEdit
                ? prev.comments.map((c) =>
                    c.id === commentEdit.id ? savedComment : c,
                  )
                : [...prev.comments, savedComment],
            }
          : prev,
      );
      setComment("");
      setCommentEdit(null);
      setCopyNotice(commentEdit ? "Comment updated." : "Comment added.");
      const activity = await api<{ items: Activity[] }>(
        `/tasks/${detail!.task.id}/activity?limit=100`,
      );
      setDetail((prev) =>
        prev ? { ...prev, activity: activity.items } : prev,
      );
      setActivityCursor(activity.items.at(-1)?.id ?? null);
      setActivityMore(activity.items.length === 100);
    }, "discussion");
  }
  async function deleteTask() {
    if (!detail) return;
    await run(async () => {
      await api(
        `/tasks/${detail.task.id}`,
        { version: detail.task.version },
        "DELETE",
        {
          validateResponse: hasOkResponse,
          headers: {
            "Idempotency-Key": taskDeleteKey.forRequest(
              `/tasks/${detail.task.id}`,
              { version: detail.task.version },
              "DELETE",
            ),
          },
        },
      );
      taskDeleteKey.reset();
      setConfirm(false);
      onClose();
    }, "lifecycle");
  }
  function addChecklistItem() {
    if (!itemText.trim()) return;
    setChecklist((prev) => [
      ...prev,
      { id: crypto.randomUUID(), text: itemText.trim(), done: false },
    ]);
    setItemText("");
  }
  return (
    <Dialog
      data-task-dialog
      isDismissDisabled={busy}
      open
      onClose={close}
      wide
      title={
        detail ? detail.task.identifier : selection.id ? "Task" : "New task"
      }
      footer={
        <div className="grid w-full gap-3">
          {(!conflict || errorAction !== "task") &&
            (!selection.id || detail) && <ErrorMessage>{error}</ErrorMessage>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <TypographyText
              className="mr-auto text-sm"
              color="muted"
              role="status"
            >
              {busy ? "Saving…" : copyNotice}
            </TypographyText>
            <Button variant="secondary" onPress={close} isDisabled={busy}>
              Close
            </Button>
            {writable && (!selection.id || detail) && (
              <Button
                isDisabled={busy || loading}
                type="submit"
                form="task-form"
              >
                {detail ? "Save changes" : "Create task"}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {loading ? (
        <TypographyParagraph size="sm" color="muted" role="status">
          Loading task…
        </TypographyParagraph>
      ) : selection.id && !detail ? (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Unable to load this task</Alert.Title>
            <Alert.Description>
              {error || "Try loading the task again."}
            </Alert.Description>
            <Button
              variant="secondary"
              className="mt-3"
              onPress={() => void load()}
            >
              Reload task
            </Button>
          </Alert.Content>
        </Alert>
      ) : (
        <>
          {conflict && (
            <Alert status="warning" role="alert" className="mb-4">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Your draft is preserved</Alert.Title>
                <Alert.Description>
                  Another person changed this task. Reload the current version
                  before trying again. Your draft stays here until you reload.
                </Alert.Description>
                <Button
                  variant="secondary"
                  className="mt-3"
                  isDisabled={busy}
                  onPress={() => void load()}
                >
                  Reload task
                </Button>
              </Alert.Content>
            </Alert>
          )}
          <div className="task-layout">
            <form
              id="task-form"
              className="task-content"
              onSubmit={(e) => void save(e)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  e.target instanceof HTMLTextAreaElement
                ) {
                  e.preventDefault();
                  e.currentTarget.requestSubmit();
                }
              }}
            >
              <TextField
                className="min-w-0 w-full"
                label="Title"
                value={form.title}
                onChange={(e) => patch("title", e.target.value)}
                required
                maxLength={300}
                disabled={!writable}
                autoFocus={
                  !selection.id &&
                  !window.matchMedia("(pointer: coarse)").matches
                }
              />
              <Field className="min-w-0">
                <Tabs
                  selectedKey={preview ? "preview" : "write"}
                  onSelectionChange={(key) => setPreview(key === "preview")}
                  className="min-w-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <FieldLabel htmlFor="task-description">
                      Description
                    </FieldLabel>
                    <Tabs.ListContainer>
                      <Tabs.List aria-label="Description mode">
                        <Tabs.Tab id="write">
                          Write
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="preview">
                          Preview
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>
                  </div>
                  <Tabs.Panel id="write" className="pt-3">
                    <TextArea
                      id="task-description"
                      variant="secondary"
                      className="min-w-0 w-full"
                      value={form.description}
                      onChange={(e) => patch("description", e.target.value)}
                      maxLength={50000}
                      disabled={!editable}
                      placeholder="Add context, links, or a plan…"
                    />
                  </Tabs.Panel>
                  <Tabs.Panel id="preview" className="markdown-preview text-sm">
                    {form.description ? (
                      <Markdown>{form.description}</Markdown>
                    ) : (
                      <TypographyParagraph size="sm" color="muted">
                        No description yet.
                      </TypographyParagraph>
                    )}
                  </Tabs.Panel>
                </Tabs>
              </Field>
              <div className="content-grid min-w-0">
                <div className="row space-between">
                  <TypographyText textRole="label">Checklist</TypographyText>
                  <span className="small muted">
                    {checklist.filter((i) => i.done).length}/{checklist.length}
                  </span>
                </div>
                <div className="grid">
                  {checklist.map((item) => (
                    <div
                      className="flex min-w-0 items-start gap-2 border-b border-separator py-3 first:pt-0 last:border-0 last:pb-0"
                      key={item.id}
                    >
                      <Checkbox
                        variant="secondary"
                        isSelected={item.done}
                        isDisabled={!editable}
                        onChange={(done) =>
                          setChecklist((prev) =>
                            prev.map((i) =>
                              i.id === item.id ? { ...i, done } : i,
                            ),
                          )
                        }
                        className="min-w-0 flex-1 items-start"
                      >
                        <Checkbox.Content className="min-w-0 items-start">
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Label
                            className={
                              item.done
                                ? "min-w-0 text-sm text-muted line-through [overflow-wrap:anywhere]"
                                : "min-w-0 text-sm [overflow-wrap:anywhere]"
                            }
                          >
                            {item.text}
                          </Label>
                        </Checkbox.Content>
                      </Checkbox>
                      {editable && (
                        <Button
                          variant="ghost"
                          isIconOnly
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
                </div>
                {editable && (
                  <div className="flex min-w-0 items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <TextField
                        label="New checklist item"
                        value={itemText}
                        onChange={(e) => setItemText(e.target.value)}
                        maxLength={500}
                        className="min-w-0 w-full"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addChecklistItem();
                          }
                        }}
                      />
                    </div>
                    <Button
                      variant="secondary"
                      isIconOnly
                      isDisabled={!itemText.trim()}
                      onPress={addChecklistItem}
                      aria-label="Add checklist item"
                    >
                      <Plus />
                    </Button>
                  </div>
                )}
              </div>
            </form>
            <aside className="task-properties">
              <Choice
                className="min-w-0 w-full"
                label="Status"
                value={form.status}
                onChange={(value) => patch("status", value as TaskStatus)}
                items={TASK_STATUSES.map((id) => ({
                  id,
                  name: taskStatusLabel(id),
                }))}
                disabled={!editable}
              />
              <Choice
                className="min-w-0 w-full"
                label="Assignee"
                value={form.assigneeId}
                onChange={(value) => patch("assigneeId", value)}
                items={[{ id: "", name: "Unassigned" }, ...members]}
                disabled={!editable}
                search
              />
              <Choice
                className="min-w-0 w-full"
                label="Agent"
                value={form.agentId}
                onChange={(value) => patch("agentId", value)}
                items={[
                  { id: "", name: "No agent" },
                  ...agents,
                  ...(form.agentId &&
                  !agents.some((agent) => agent.id === form.agentId) &&
                  detail?.task.agentId === form.agentId
                    ? [
                        {
                          id: form.agentId,
                          name: detail.task.agentName ?? "Unavailable agent",
                        },
                      ]
                    : []),
                ]}
                disabled={!editable || agentsLoading || busy}
                search
              />
              {agentsError && (
                <div className="content-grid">
                  <ErrorMessage>{agentsError}</ErrorMessage>
                  <Button
                    variant="secondary"
                    isDisabled={agentsLoading || busy}
                    onPress={() => void loadAgents()}
                  >
                    Retry loading agents
                  </Button>
                </div>
              )}
              {form.agentId && !form.assigneeId && (
                <TypographyParagraph size="sm" color="muted">
                  Choose a human assignee to use an agent.
                </TypographyParagraph>
              )}
              <Choice
                className="min-w-0 w-full"
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
                disabled={!editable}
              />
              <TextField
                className="min-w-0 w-full"
                form="task-form"
                label="Due date"
                type="date"
                value={form.dueDate}
                onChange={(e) => patch("dueDate", e.target.value)}
                disabled={!editable}
              />
              {detail && (
                <>
                  <TypographyParagraph size="sm" color="muted">
                    Created{" "}
                    {new Date(detail.task.createdAt).toLocaleDateString(
                      undefined,
                      { timeZone: user.timeZone, dateStyle: "medium" },
                    )}
                    <br />
                    Updated{" "}
                    {new Date(detail.task.updatedAt).toLocaleDateString(
                      undefined,
                      { timeZone: user.timeZone, dateStyle: "medium" },
                    )}
                  </TypographyParagraph>
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
                    <LinkIcon />
                    Copy task link
                  </Button>
                  {writable && (
                    <Button
                      variant="danger-ghost"
                      isDisabled={busy}
                      onPress={() => {
                        setError("");
                        setConfirm(true);
                      }}
                    >
                      Delete task
                    </Button>
                  )}
                </>
              )}
            </aside>
            {detail && (
              <section className="task-discussion">
                <Tabs
                  selectedKey={tab}
                  onSelectionChange={(key) => setTab(String(key))}
                  className="min-w-0"
                >
                  <Tabs.ListContainer className="w-fit max-w-full">
                    <Tabs.List aria-label="Task discussion">
                      <Tabs.Tab id="comments" className="whitespace-nowrap">
                        Comments ({detail.comments.length})<Tabs.Indicator />
                      </Tabs.Tab>
                      <Tabs.Tab id="activity" className="whitespace-nowrap">
                        Activity
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    </Tabs.List>
                  </Tabs.ListContainer>
                  <Tabs.Panel id="activity" className="pt-4">
                    <ol className="activity-list">
                      {detail.activity.map((item, index) => (
                        <li key={item.id} className="group grid min-w-0">
                          <div className="grid gap-1 py-3 group-first:pt-0 group-last:pb-0">
                            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm">
                              <TypographyText textRole="label">
                                {item.actorName}
                              </TypographyText>
                              {item.actorKind === "agent" && (
                                <Chip variant="secondary" size="small">
                                  Agent
                                </Chip>
                              )}
                              <span>{activityLabel(item.action)}</span>
                            </div>
                            <time
                              dateTime={item.createdAt}
                              className="text-sm text-muted"
                            >
                              {new Date(item.createdAt).toLocaleString(
                                undefined,
                                {
                                  timeZone: user.timeZone,
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                },
                              )}
                            </time>
                          </div>
                          {index < detail.activity.length - 1 && (
                            <FieldSeparator />
                          )}
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
                  </Tabs.Panel>
                  <Tabs.Panel id="comments" className="pt-4">
                    <div className="comment-list">
                      {detail.comments.map((item) => (
                        <article className="comment text-sm" key={item.id}>
                          <div className="row space-between">
                            <TypographyText textRole="label">
                              {item.authorName}
                            </TypographyText>
                            <time className="muted small">
                              {new Date(item.createdAt).toLocaleString(
                                undefined,
                                {
                                  timeZone: user.timeZone,
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                },
                              )}
                            </time>
                          </div>
                          <Markdown>{item.body}</Markdown>
                          {editable &&
                            (item.authorId === user.id ||
                              user.role === "admin") && (
                              <div className="row">
                                <Button
                                  variant="ghost"
                                  isDisabled={busy}
                                  onPress={() => {
                                    setCommentEdit(item);
                                    setComment(item.body);
                                  }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="danger-ghost"
                                  isDisabled={busy}
                                  onPress={() => setCommentToDelete(item)}
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
                    {writable && (
                      <form
                        className="content-grid min-w-0"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void submitComment();
                        }}
                      >
                        <TextField
                          className="min-w-0 w-full"
                          label={commentEdit ? "Edit comment" : "Add a comment"}
                          disabled={busy}
                          multiline
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          maxLength={10000}
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                          description="Use @email to mention a teammate. Markdown is supported."
                        />
                        <div className="row">
                          <Button
                            isDisabled={!comment.trim() || busy}
                            type="submit"
                          >
                            <Check />
                            {commentEdit ? "Save comment" : "Comment"}
                          </Button>
                          {commentEdit && (
                            <Button
                              variant="ghost"
                              isDisabled={busy}
                              onPress={() => {
                                setCommentEdit(null);
                                setComment("");
                              }}
                            >
                              Cancel edit
                            </Button>
                          )}
                        </div>
                      </form>
                    )}
                  </Tabs.Panel>
                </Tabs>
              </section>
            )}
          </div>
        </>
      )}
      <Dialog
        open={!!commentToDelete}
        isDismissDisabled={busy}
        onClose={() => setCommentToDelete(null)}
        title="Delete comment?"
        footer={
          <>
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => setCommentToDelete(null)}
            >
              Keep comment
            </Button>
            <Button
              variant="danger"
              isDisabled={busy}
              onPress={() =>
                void run(async () => {
                  if (!commentToDelete) return;
                  await api(
                    `/comments/${commentToDelete.id}`,
                    { version: commentToDelete.version },
                    "DELETE",
                  );
                  setDetail((prev) =>
                    prev
                      ? {
                          ...prev,
                          comments: prev.comments.filter(
                            (item) => item.id !== commentToDelete.id,
                          ),
                        }
                      : prev,
                  );
                  if (commentEdit?.id === commentToDelete.id) {
                    setCommentEdit(null);
                    setComment("");
                  }
                  setCommentToDelete(null);
                  setCopyNotice("Comment deleted.");
                }, "discussion")
              }
            >
              Delete comment
            </Button>
          </>
        }
      >
        <TypographyParagraph size="sm">
          This comment will be removed from the task discussion.
        </TypographyParagraph>
        <ErrorMessage>{errorAction === "discussion" ? error : ""}</ErrorMessage>
      </Dialog>
      <Dialog
        isDismissDisabled={busy}
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this task?"
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setConfirm(false)}
              isDisabled={busy}
            >
              Keep task
            </Button>
            <Button
              variant="danger"
              onPress={() => void deleteTask()}
              isPending={busy}
            >
              Delete task
            </Button>
          </>
        }
      >
        <TypographyParagraph size="sm">
          Permanently delete this task and its comments? This cannot be undone.
          There is no restore.
        </TypographyParagraph>
        <ErrorMessage>{errorAction === "lifecycle" ? error : ""}</ErrorMessage>
        {conflict && errorAction === "lifecycle" && (
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              setConfirm(false);
              void load();
            }}
          >
            Reload task
          </Button>
        )}
      </Dialog>
    </Dialog>
  );
}
