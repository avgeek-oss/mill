import { useLayoutEffect, useRef, useState } from "react";
import { ChoiceField } from "@avgeek-oss/design-system";
import { Avatar, Button, Choice, Dialog } from "@mill/web-design-system";
import { DatePickerField } from "@mill/web-design-system/date-picker-field";
import type {
  BulkTaskChanges,
  Member,
} from "../../../packages/contracts/src/index.js";
import { priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";

export type BulkTaskField = keyof BulkTaskChanges;
const labels: Record<BulkTaskField, string> = {
  status: "Status",
  assigneeId: "Assignee",
  priority: "Priority",
  startDate: "Start date",
  dueDate: "Due date",
};

export function BulkTaskBar({
  count,
  disabled,
  onClear,
  onAction,
}: {
  count: number;
  disabled: boolean;
  onClear: () => void;
  onAction: (field: BulkTaskField) => void;
}) {
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const root = element.ownerDocument.documentElement;
    const updateHeight = () => {
      root.style.setProperty(
        "--mill-bulk-bar-height",
        `${element.getBoundingClientRect().height}px`,
      );
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--mill-bulk-bar-height");
    };
  }, []);
  return (
    <section
      ref={bar}
      className="task-bulk-bar shadow-lg"
      aria-label="Bulk task actions"
    >
      <div className="task-bulk-selection flex items-center gap-3">
        <span className="text-sm font-medium whitespace-nowrap" role="status">
          {count} selected
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="task-bulk-clear"
          isDisabled={disabled}
          onPress={onClear}
        >
          Clear selection
        </Button>
      </div>
      <div className="task-bulk-fields flex flex-wrap justify-center gap-2">
        {(Object.keys(labels) as BulkTaskField[]).map((field) => (
          <Button
            key={field}
            size="sm"
            variant="secondary"
            isDisabled={disabled}
            onPress={() => onAction(field)}
          >
            {labels[field]}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function BulkTaskDialog({
  field,
  count,
  pending,
  members,
  onApply,
  onClose,
}: {
  field: BulkTaskField;
  count: number;
  pending: boolean;
  members: Member[];
  onApply: (changes: BulkTaskChanges) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const isDate = field === "startDate" || field === "dueDate";
  const formId = "bulk-task-form";
  function submit() {
    if (pending || (isDate ? !date : !choice)) return;
    setClearing(false);
    if (field === "status")
      onApply({ status: choice as NonNullable<BulkTaskChanges["status"]> });
    else if (field === "priority")
      onApply({ priority: choice as NonNullable<BulkTaskChanges["priority"]> });
    else if (field === "assigneeId")
      onApply({ assigneeId: choice === "unassigned" ? null : choice });
    else onApply({ [field]: date });
  }
  return (
    <Dialog
      open
      title={`Update ${labels[field].toLowerCase()}`}
      size="sm"
      isDismissDisabled={pending}
      onClose={onClose}
      footer={
        <>
          {isDate && (
            <Button
              variant="secondary"
              className="mr-auto"
              isDisabled={pending}
              isPending={pending && clearing}
              onPress={() => {
                setClearing(true);
                onApply({ [field]: null });
              }}
            >
              Clear dates
            </Button>
          )}
          <Button variant="secondary" isDisabled={pending} onPress={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            isPending={pending && !clearing}
            isDisabled={count === 0 || (isDate ? !date : !choice)}
          >
            Apply
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {isDate ? (
          <DatePickerField
            label={labels[field]}
            value={date}
            onChange={setDate}
            disabled={pending}
          />
        ) : field === "assigneeId" ? (
          <Choice
            label="Assignee"
            value={choice}
            onChange={setChoice}
            disabled={pending}
            search
            items={[
              { id: "unassigned", name: "Unassigned", muted: true },
              ...members.map((member) => ({
                id: member.id,
                name: member.name,
                startContent: (
                  <Avatar
                    email={member.email}
                    name={member.name}
                    size="sm"
                    className="size-6 [&_[data-slot=avatar-fallback]]:text-[10px]"
                  />
                ),
              })),
            ]}
          />
        ) : (
          <ChoiceField
            label={labels[field]}
            value={choice}
            onChange={setChoice}
            isDisabled={pending}
            options={(field === "status" ? statusOptions : priorityOptions).map(
              (option) => ({
                id: option.id,
                label: option.name,
                icon: option.startContent,
              }),
            )}
          />
        )}
      </form>
    </Dialog>
  );
}
