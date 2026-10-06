import { useEffect, useId, useRef, useState } from "react";
import type { Member, Task } from "../../../packages/contracts/src/index.js";
import {
  Avatar,
  Button,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
  toast,
} from "@mill/web-design-system";
import { api, createRetryKey, errorText, type User } from "./api.js";
import { hasTaskResponse } from "./responses.js";
import { taskTypeOptions } from "./task-type.js";
import { priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";

export type DuplicateTaskSource = Pick<
  Task,
  "title" | "description" | "type" | "priority"
>;

export function CreateTaskDialog({
  boardId,
  members,
  user,
  open,
  onClose,
  onCreated,
  duplicateSource,
}: {
  boardId: string;
  members: Member[];
  user: User;
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
  duplicateSource?: DuplicateTaskSource;
}) {
  const formId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [type, setType] = useState<Task["type"]>("task");
  const [priority, setPriority] = useState<Task["priority"]>("none");
  const [status, setStatus] = useState<Task["status"]>("backlog");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [retryKey] = useState(createRetryKey);
  const requestGeneration = useRef(0);
  const inFlight = useRef(false);
  const writable = user.role !== "viewer";

  useEffect(() => {
    requestGeneration.current++;
    inFlight.current = false;
    setPending(false);
    setTitle(duplicateSource ? `[Copy] ${duplicateSource.title}` : "");
    setDescription(duplicateSource?.description ?? "");
    setAssigneeId("");
    setType(duplicateSource?.type ?? "task");
    setPriority(duplicateSource?.priority ?? "none");
    setStatus("backlog");
    setError("");
    retryKey.reset();
    return () => {
      requestGeneration.current++;
    };
  }, [boardId, open, user.id, retryKey, duplicateSource]);

  function close() {
    if (!inFlight.current) onClose();
  }

  async function create() {
    if (!open || !writable || inFlight.current) return;
    setError("");
    if (!title.trim()) {
      toast.danger("Enter a title.");
      return;
    }
    if (title.trim().length > 300) {
      toast.danger("Use 300 characters or fewer for the title.");
      return;
    }
    if (assigneeId && !members.some((member) => member.id === assigneeId)) {
      toast.danger("Choose an available assignee.");
      return;
    }
    const generation = requestGeneration.current;
    const path = `/boards/${boardId}/tasks`;
    const payload = {
      title: title.trim(),
      description,
      assigneeId: assigneeId || null,
      type,
      ...(duplicateSource
        ? { priority, status, startDate: null, dueDate: null }
        : {}),
    };
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = await api<{ task: Task }>(path, payload, "POST", {
        validateResponse: hasTaskResponse,
        headers: {
          "Idempotency-Key": retryKey.forRequest(path, payload),
        },
      });
      if (generation !== requestGeneration.current) return;
      retryKey.reset();
      toast.success("Task created.");
      onClose();
      onCreated(result.task);
    } catch (cause) {
      if (generation === requestGeneration.current) setError(errorText(cause));
    } finally {
      if (generation === requestGeneration.current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  if (!open) return null;
  return (
    <Dialog
      open
      wide
      data-create-task-dialog
      title={duplicateSource ? "Duplicate task" : "New task"}
      onClose={close}
      isDismissDisabled={pending}
      footer={
        <>
          <Button variant="secondary" isDisabled={pending} onPress={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            isDisabled={!writable || pending || !title.trim()}
            isPending={pending}
          >
            Create task
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="content-grid min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            event.target instanceof HTMLTextAreaElement
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <TextField
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={300}
          disabled={!writable || pending}
          autoFocus={!window.matchMedia("(pointer: coarse)").matches}
          className="max-md:text-base!"
        />
        <TextField
          label="Description"
          multiline
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={100000}
          rows={10}
          disabled={!writable || pending}
          className="min-w-0 w-full max-md:text-base!"
        />
        <Choice
          label="Type"
          value={type}
          onChange={(value) => setType(value as Task["type"])}
          disabled={!writable || pending}
          items={taskTypeOptions}
        />
        {duplicateSource && (
          <>
            <Choice
              label="Status"
              value={status}
              onChange={(value) => setStatus(value as Task["status"])}
              disabled={!writable || pending}
              items={statusOptions}
            />
            <Choice
              label="Priority"
              value={priority}
              onChange={(value) => setPriority(value as Task["priority"])}
              disabled={!writable || pending}
              items={priorityOptions}
            />
          </>
        )}
        <Choice
          label="Assignee"
          value={assigneeId}
          onChange={setAssigneeId}
          disabled={!writable || pending}
          search
          items={[
            { id: "", name: "Unassigned", muted: true },
            ...members.map((member) => ({
              id: member.id,
              name: member.name,
              startContent: (
                <Avatar
                  email={member.email}
                  name={member.name}
                  size="sm"
                  className="size-5"
                />
              ),
            })),
          ]}
        />
        <ErrorMessage>{error}</ErrorMessage>
      </form>
    </Dialog>
  );
}
