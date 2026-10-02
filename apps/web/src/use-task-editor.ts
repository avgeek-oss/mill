import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Task } from "../../../packages/contracts/src/index.js";
import { ApiError, api, errorText, isResponseObject } from "./api.js";
import { hasTaskResponse } from "./responses.js";

export type EditableTaskValues = Pick<
  Task,
  | "title"
  | "description"
  | "status"
  | "assigneeId"
  | "agentId"
  | "priority"
  | "dueDate"
>;
export type TaskField = keyof EditableTaskValues;
export type FieldSaveState = {
  state: "saving" | "saved" | "error";
  message?: string;
  conflict?: boolean;
  status?: number;
};
type EditorSnapshot = {
  task: Task | null;
  values: EditableTaskValues | null;
  loading: boolean;
  loadError: string;
  loadErrorStatus: number;
  accessDenied: boolean;
  fields: Partial<Record<TaskField, FieldSaveState>>;
  pending: boolean;
  hasUnsavedChanges: boolean;
};
export type TaskAssignment = Pick<EditableTaskValues, "assigneeId" | "agentId">;
export type TaskEditor = EditorSnapshot & {
  needsFlush: () => boolean;
  updateField: <K extends TaskField>(
    field: K,
    value: EditableTaskValues[K],
  ) => void;
  updateAssignment: (assignment: TaskAssignment) => void;
  textChange: (field: "title" | "description", value: string) => void;
  flushField: (field: TaskField) => Promise<boolean>;
  flushAll: () => Promise<boolean>;
  retryField: (field: TaskField) => void;
  discardField: (field: TaskField) => void;
  reload: () => Promise<void>;
};
type UnitKey = TaskField | "assignment";
type SaveUnit = {
  fields: TaskField[];
  baseline: EditableTaskValues;
  sequence: number;
  ready: boolean;
  blocked: boolean;
};
const editableFields: TaskField[] = [
  "title",
  "description",
  "status",
  "assigneeId",
  "agentId",
  "priority",
  "dueDate",
];

function editable(task: Task): EditableTaskValues {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    assigneeId: task.assigneeId,
    agentId: task.agentId,
    priority: task.priority,
    dueDate: task.dueDate?.slice(0, 10) ?? null,
  };
}
function copyValues(values: EditableTaskValues): EditableTaskValues {
  return { ...values };
}
function same(
  left: EditableTaskValues[TaskField],
  right: EditableTaskValues[TaskField],
) {
  return left === right;
}
function validTask(value: unknown, taskId: string) {
  if (
    !hasTaskResponse(value) ||
    !isResponseObject(value) ||
    !isResponseObject(value.task)
  )
    return false;
  const task = value.task;
  return (
    task.id === taskId &&
    typeof task.description === "string" &&
    (task.assigneeId === null ||
      (typeof task.assigneeId === "string" && task.assigneeId.length > 0)) &&
    (task.dueDate === null || typeof task.dueDate === "string") &&
    typeof task.priority === "string" &&
    ["none", "low", "medium", "high", "urgent"].includes(task.priority) &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string"
  );
}

class TaskEditorController {
  private active = false;
  private generation = 0;
  private loadSequence = 0;
  private task: Task | null = null;
  private values: EditableTaskValues | null = null;
  private loading = true;
  private loadError = "";
  private loadErrorStatus = 0;
  private accessDenied = false;
  private fields: EditorSnapshot["fields"] = {};
  private units = new Map<UnitKey, SaveUnit>();
  private queue = new Set<UnitKey>();
  private timers = new Map<UnitKey, ReturnType<typeof setTimeout>>();
  private running: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;
  private inFlight: TaskField[] = [];
  private listeners = new Set<() => void>();
  private snapshot: EditorSnapshot = {
    task: null,
    values: null,
    loading: true,
    loadError: "",
    loadErrorStatus: 0,
    accessDenied: false,
    fields: {},
    pending: false,
    hasUnsavedChanges: false,
  };

  constructor(private taskId: string) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  needsFlush = () =>
    this.active &&
    (this.units.size > 0 ||
      this.queue.size > 0 ||
      this.timers.size > 0 ||
      this.inFlight.length > 0 ||
      this.running !== null);
  private current(generation: number) {
    return this.active && generation === this.generation;
  }
  private publish() {
    if (!this.active) return;
    this.snapshot = {
      task: this.task,
      values: this.values,
      loading: this.loading,
      loadError: this.loadError,
      loadErrorStatus: this.loadErrorStatus,
      accessDenied: this.accessDenied,
      fields: { ...this.fields },
      pending:
        !!this.running ||
        this.inFlight.length > 0 ||
        this.queue.size > 0 ||
        this.timers.size > 0,
      hasUnsavedChanges: this.units.size > 0,
    };
    for (const listener of this.listeners) listener();
  }
  start() {
    this.active = true;
    void this.reload();
  }
  stop() {
    this.active = false;
    this.generation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queue.clear();
  }
  private cancelTimer(key: UnitKey) {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }
  private keyFor(field: TaskField): UnitKey {
    return (field === "assigneeId" || field === "agentId") &&
      this.units.has("assignment")
      ? "assignment"
      : field;
  }
  private mergeTask(task: Task) {
    const next = editable(task);
    this.task = task;
    const values = this.values ? copyValues(this.values) : next;
    for (const field of editableFields) {
      if (
        ![...this.units.values()].some((unit) => unit.fields.includes(field))
      ) {
        Object.assign(values, { [field]: next[field] });
      }
    }
    this.values = values;
  }
  private fetchTask() {
    return api<{ task: Task }>(
      `/tasks/${this.taskId}?commentLimit=0&activityLimit=0`,
      undefined,
      "GET",
      {
        validateResponse: (value) => validTask(value, this.taskId),
      },
    );
  }
  reload = async () => {
    if (!this.active) return;
    const generation = this.generation;
    const sequence = ++this.loadSequence;
    this.loading = true;
    this.loadError = "";
    if (!this.accessDenied) this.loadErrorStatus = 0;
    this.publish();
    const work = (async () => {
      await this.running;
      if (!this.current(generation) || sequence !== this.loadSequence) return;
      try {
        const result = await this.fetchTask();
        if (!this.current(generation) || sequence !== this.loadSequence) return;
        this.mergeTask(result.task);
        this.accessDenied = false;
        this.loadErrorStatus = 0;
      } catch (cause) {
        if (!this.current(generation) || sequence !== this.loadSequence) return;
        this.loadError = errorText(cause);
        this.loadErrorStatus = cause instanceof ApiError ? cause.status : 0;
        if (cause instanceof ApiError && [403, 404].includes(cause.status))
          this.accessDenied = true;
      } finally {
        if (this.current(generation) && sequence === this.loadSequence) {
          this.loading = false;
          this.publish();
        }
      }
    })();
    this.loadPromise = work;
    await work;
    if (this.loadPromise === work) this.loadPromise = null;
    if (this.current(generation)) void this.drain();
  };
  private mark(unit: SaveUnit, state: FieldSaveState) {
    for (const field of unit.fields) this.fields[field] = state;
  }
  private changed(unit: SaveUnit) {
    return (
      !!this.values &&
      unit.fields.some(
        (field) => !same(this.values![field], unit.baseline[field]),
      )
    );
  }
  private edit<K extends TaskField>(field: K, value: EditableTaskValues[K]) {
    if (!this.active || !this.task || !this.values) return null;
    const key = this.keyFor(field);
    const unit = this.units.get(key) ?? {
      fields: [field],
      baseline: editable(this.task),
      sequence: 0,
      ready: false,
      blocked: false,
    };
    this.values = copyValues({ ...this.values, [field]: value });
    unit.sequence++;
    const failure = this.fields[field];
    if (
      unit.blocked &&
      !failure?.conflict &&
      failure?.status !== 403 &&
      failure?.status !== 404
    ) {
      unit.blocked = false;
    }
    this.units.set(key, unit);
    if (
      !this.changed(unit) &&
      !unit.fields.some((item) => this.inFlight.includes(item))
    ) {
      this.units.delete(key);
      this.queue.delete(key);
      this.cancelTimer(key);
      for (const item of unit.fields) delete this.fields[item];
      this.publish();
      return null;
    }
    if (!unit.blocked) this.mark(unit, { state: "saving" });
    return { key, unit };
  }
  updateField = <K extends TaskField>(
    field: K,
    value: EditableTaskValues[K],
  ) => {
    const edit = this.edit(field, value);
    if (edit) this.enqueue(edit.key, edit.unit);
  };
  textChange = (field: "title" | "description", value: string) => {
    const edit = this.edit(field, value);
    if (!edit) return;
    this.cancelTimer(edit.key);
    this.queue.delete(edit.key);
    edit.unit.ready = false;
    if (!edit.unit.blocked) {
      this.timers.set(
        edit.key,
        setTimeout(() => {
          this.timers.delete(edit.key);
          this.enqueue(edit.key, edit.unit);
        }, 300),
      );
    }
    this.publish();
  };
  updateAssignment = (assignment: TaskAssignment) => {
    if (!this.active || !this.task || !this.values) return;
    const previous = this.units.get("assignment");
    const unit: SaveUnit = previous ?? {
      fields: ["assigneeId", "agentId"],
      baseline: editable(this.task),
      sequence: 0,
      ready: false,
      blocked: false,
    };
    for (const field of unit.fields) {
      const individual = this.units.get(field);
      if (individual) {
        Object.assign(unit.baseline, { [field]: individual.baseline[field] });
        unit.blocked ||= individual.blocked;
      }
      this.units.delete(field);
      this.queue.delete(field);
      this.cancelTimer(field);
    }
    this.values = { ...this.values, ...assignment };
    unit.sequence++;
    this.units.set("assignment", unit);
    if (
      !this.changed(unit) &&
      !unit.fields.some((field) => this.inFlight.includes(field))
    ) {
      this.units.delete("assignment");
      this.queue.delete("assignment");
      for (const field of unit.fields) delete this.fields[field];
      this.publish();
      return;
    }
    this.enqueue("assignment", unit);
  };
  private enqueue(key: UnitKey, unit: SaveUnit) {
    this.cancelTimer(key);
    if (!this.active || this.units.get(key) !== unit || unit.blocked) {
      this.publish();
      return;
    }
    unit.ready = true;
    this.mark(unit, { state: "saving" });
    this.queue.add(key);
    this.publish();
    void this.drain();
  }
  private validation(unit: SaveUnit) {
    if (!this.values) return "This task has not loaded. Try again.";
    if (unit.fields.includes("title")) {
      if (!this.values.title.trim()) return "Enter a task title.";
      if (this.values.title.trim().length > 300)
        return "Keep the task title to 300 characters or fewer.";
    }
    if (
      unit.fields.includes("description") &&
      this.values.description.length > 100000
    )
      return "Keep the description to 100,000 characters or fewer.";
    return "";
  }
  private fail(unit: SaveUnit, cause: unknown, conflict = false) {
    unit.blocked = true;
    unit.ready = false;
    this.mark(unit, {
      state: "error",
      message: errorText(cause),
      conflict,
      ...(cause instanceof ApiError ? { status: cause.status } : {}),
    });
  }
  private finish(key: UnitKey, unit: SaveUnit, sequence: number, task: Task) {
    const next = editable(task);
    this.mergeTask(task);
    for (const pending of this.units.values()) {
      for (const field of unit.fields)
        Object.assign(pending.baseline, { [field]: next[field] });
    }
    if (this.units.get(key) !== unit) return;
    if (sequence === unit.sequence) {
      this.values = {
        ...this.values!,
        ...Object.fromEntries(unit.fields.map((field) => [field, next[field]])),
      };
    }
    if (unit.fields.every((field) => same(this.values![field], next[field]))) {
      this.units.delete(key);
      this.queue.delete(key);
      this.cancelTimer(key);
      this.mark(unit, { state: "saved" });
    }
  }
  private async save(key: UnitKey, unit: SaveUnit, generation: number) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (
        !this.task ||
        !this.values ||
        this.units.get(key) !== unit ||
        !this.current(generation)
      )
        return;
      const validation = this.validation(unit);
      if (validation) {
        this.fail(unit, new Error(validation));
        return;
      }
      const current = editable(this.task);
      if (
        unit.fields.some((field) => !same(current[field], unit.baseline[field]))
      ) {
        this.fail(
          unit,
          new ApiError(
            409,
            "This field changed elsewhere. Retry to save your draft, or discard it to use the latest value.",
          ),
          true,
        );
        return;
      }
      const sequence = unit.sequence;
      const sent = copyValues(this.values);
      sent.title = sent.title.trim();
      const payload = Object.fromEntries(
        unit.fields.map((field) => [field, sent[field]]),
      );
      try {
        const result = await api<{ task: Task }>(
          `/tasks/${this.taskId}`,
          {
            version: this.task.version,
            ...payload,
          },
          "PATCH",
          { validateResponse: (value) => validTask(value, this.taskId) },
        );
        if (!this.current(generation)) return;
        this.finish(key, unit, sequence, result.task);
        return;
      } catch (cause) {
        if (!this.current(generation)) return;
        if (!(cause instanceof ApiError) || cause.status !== 409) {
          const active = this.units.get(key);
          if (active) this.fail(active, cause);
          return;
        }
        try {
          const latest = await this.fetchTask();
          if (!this.current(generation)) return;
          this.mergeTask(latest.task);
          if (this.units.get(key) !== unit) return;
          const actual = editable(latest.task);
          if (unit.fields.every((field) => same(actual[field], sent[field]))) {
            this.finish(key, unit, sequence, latest.task);
            return;
          }
          if (
            unit.fields.some(
              (field) => !same(actual[field], unit.baseline[field]),
            )
          ) {
            this.fail(
              unit,
              new ApiError(
                409,
                "This field changed elsewhere. Retry to save your draft, or discard it to use the latest value.",
              ),
              true,
            );
            return;
          }
          if (attempt > 0)
            this.fail(
              unit,
              new ApiError(
                409,
                "The task changed again. Retry saving this field.",
              ),
            );
        } catch (refreshError) {
          if (this.current(generation) && this.units.get(key) === unit)
            this.fail(unit, refreshError);
          return;
        }
      }
    }
  }
  private drain() {
    if (this.running) return this.running;
    if (
      !this.active ||
      this.loading ||
      this.accessDenied ||
      !this.task ||
      !this.queue.size
    )
      return Promise.resolve();
    const generation = this.generation;
    const work = (async () => {
      while (this.current(generation) && !this.loading && this.queue.size) {
        const key = this.queue.values().next().value;
        if (key === undefined) break;
        this.queue.delete(key);
        const unit = this.units.get(key);
        if (!unit || unit.blocked || !unit.ready) continue;
        unit.ready = false;
        this.inFlight = unit.fields;
        this.publish();
        await this.save(key, unit, generation);
        this.inFlight = [];
        this.publish();
      }
    })().finally(() => {
      if (this.running === work) this.running = null;
      this.publish();
    });
    this.running = work;
    return work;
  }
  flushField = async (field: TaskField) => {
    await this.loadPromise;
    if (!this.active) return false;
    const key = this.keyFor(field);
    const unit = this.units.get(key);
    if (unit) this.enqueue(key, unit);
    await this.drain();
    return (
      this.active &&
      !this.units.has(this.keyFor(field)) &&
      this.fields[field]?.state !== "error"
    );
  };
  flushAll = async () => {
    await this.loadPromise;
    if (!this.active || !this.task) return false;
    for (const [key, unit] of this.units) this.enqueue(key, unit);
    await this.drain();
    return (
      this.active &&
      !this.units.size &&
      !this.queue.size &&
      !this.timers.size &&
      !this.running
    );
  };
  retryField = (field: TaskField) => {
    if (!this.task) return;
    const key = this.keyFor(field);
    const unit = this.units.get(key);
    if (!unit) return;
    const current = editable(this.task);
    for (const item of unit.fields)
      Object.assign(unit.baseline, { [item]: current[item] });
    unit.blocked = false;
    this.enqueue(key, unit);
  };
  discardField = (field: TaskField) => {
    if (!this.task || !this.values) return;
    const key = this.keyFor(field);
    const unit = this.units.get(key);
    if (!unit) return;
    const current = editable(this.task);
    this.values = {
      ...this.values,
      ...Object.fromEntries(unit.fields.map((item) => [item, current[item]])),
    };
    unit.sequence++;
    unit.blocked = false;
    if (unit.fields.some((item) => this.inFlight.includes(item)))
      this.enqueue(key, unit);
    else {
      this.units.delete(key);
      this.queue.delete(key);
      this.cancelTimer(key);
      for (const item of unit.fields) delete this.fields[item];
      this.publish();
    }
  };
}

export function useTaskEditor(taskId: string): TaskEditor {
  const controller = useMemo(() => new TaskEditorController(taskId), [taskId]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return {
    ...snapshot,
    needsFlush: controller.needsFlush,
    updateField: controller.updateField,
    updateAssignment: controller.updateAssignment,
    textChange: controller.textChange,
    flushField: controller.flushField,
    flushAll: controller.flushAll,
    retryField: controller.retryField,
    discardField: controller.discardField,
    reload: controller.reload,
  };
}
