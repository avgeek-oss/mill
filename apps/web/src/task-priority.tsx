import { HugeiconsIcon } from "@hugeicons/react";
import { Flag01Icon } from "@hugeicons/core-free-icons";
import {
  StatusIndicator,
  type StatusDescriptor,
} from "@avgeek-oss/design-system";
import type { Task } from "../../../packages/contracts/src/index.js";

type Priority = Task["priority"];

const presentation: Record<
  Priority,
  {
    label: string;
    iconClassName: string;
    color: StatusDescriptor["color"];
  }
> = {
  urgent: {
    label: "Urgent",
    iconClassName: "text-danger",
    color: "danger",
  },
  high: {
    label: "High",
    iconClassName: "text-warning",
    color: "warning",
  },
  medium: {
    label: "Medium",
    iconClassName: "text-warning",
    color: "warning",
  },
  low: { label: "Low", iconClassName: "priority-low-icon", color: "default" },
  none: {
    label: "No priority",
    iconClassName: "text-muted",
    color: "default",
  },
};

export function PriorityIcon({ priority = "none" }: { priority?: Priority }) {
  return (
    <HugeiconsIcon
      icon={Flag01Icon}
      fill="currentColor"
      size={16}
      aria-hidden="true"
      className={`shrink-0 ${presentation[priority].iconClassName}`}
    />
  );
}

const priorities: Priority[] = ["urgent", "high", "medium", "low", "none"];

export const priorityOptions = priorities.map((id) => ({
  id,
  name: presentation[id].label,
  startContent: <PriorityIcon priority={id} />,
}));

export function PriorityChip({ priority }: { priority: Priority }) {
  return (
    <StatusIndicator
      color={presentation[priority].color}
      className={priority === "low" ? "priority-low-chip" : undefined}
      size="sm"
      icon={<PriorityIcon priority={priority} />}
      label={presentation[priority].label}
    />
  );
}
