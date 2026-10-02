import { HugeiconsIcon } from "@hugeicons/react";
import { Flag01Icon } from "@hugeicons/core-free-icons";
import { Chip, type ChipProps } from "@mill/web-design-system";
import type { Task } from "../../../packages/contracts/src/index.js";

type Priority = Task["priority"];

const presentation: Record<
  Priority,
  {
    label: string;
    iconClassName: string;
    chipVariant: NonNullable<ChipProps["variant"]>;
  }
> = {
  urgent: {
    label: "Urgent",
    iconClassName: "text-danger",
    chipVariant: "destructive",
  },
  high: {
    label: "High",
    iconClassName: "text-orange-600 dark:text-orange-400",
    chipVariant: "orange",
  },
  medium: {
    label: "Medium",
    iconClassName: "text-yellow-600 dark:text-yellow-400",
    chipVariant: "yellow",
  },
  low: { label: "Low", iconClassName: "text-accent", chipVariant: "info" },
  none: {
    label: "No priority",
    iconClassName: "text-muted",
    chipVariant: "secondary",
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
    <Chip
      variant={presentation[priority].chipVariant}
      size="small"
      className={priority === "none" ? "text-muted" : undefined}
      icon={<PriorityIcon priority={priority} />}
    >
      {presentation[priority].label}
    </Chip>
  );
}
