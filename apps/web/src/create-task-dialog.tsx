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

export function CreateTaskDialog({
  boardId,
  members,
  user,
  open,
  onClose,
  onCreated,
}: {
  boardId: string;
  members: Member[];
  user: User;
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const formId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
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
    setTitle("");
    setDescription("");
    setAssigneeId("");
    setError("");
    retryKey.reset();
    return () => {
      requestGeneration.current++;
    };
  }, [boardId, open, user.id, retryKey]);

  function close() {
    if (!inFlight.current) onClose();
  }

  async function create() {
    if (!open || !writable || inFlight.current) return;
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    if (assigneeId && !members.some((member) => member.id === assigneeId)) {
      setError("Choose an available assignee.");
      return;
    }
    const generation = requestGeneration.current;
    const path = `/boards/${boardId}/tasks`;
    const payload = {
      title: title.trim(),
      description,
      assigneeId: assigneeId || null,
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
      title="New task"
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
