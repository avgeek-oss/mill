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
  low: { label: "Low", iconClassName: "text-accent", color: "accent" },
  none: {
    label: "No priority",
    iconClassName: "text-muted",
    color: "default",
  },
};

function PriorityIcon({ priority }: { priority: Priority }) {
  return (
    <HugeiconsIcon
      icon={Flag01Icon}
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
      size="sm"
      icon={<PriorityIcon priority={priority} />}
      label={presentation[priority].label}
    />
  );
}
