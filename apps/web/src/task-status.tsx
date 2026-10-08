import { HugeiconsIcon } from "@hugeicons/react";
import {
  NotepadTextDashedIcon,
  Note01Icon,
  ProgressIcon,
  CheckmarkCircle02Icon,
  OctagonXIcon,
} from "@hugeicons/core-free-icons";
import {
  StatusIndicator,
  type StatusDescriptor,
} from "@avgeek-oss/design-system";
import type { ComponentProps } from "react";
import {
  TASK_STATUSES,
  type TaskStatus,
} from "../../../packages/contracts/src/index.js";
import { taskStatusLabel } from "./activity-label.js";

const presentation: Record<
  TaskStatus,
  {
    icon: ComponentProps<typeof HugeiconsIcon>["icon"];
    iconClassName: string;
    color: StatusDescriptor["color"];
  }
> = {
  backlog: {
    icon: NotepadTextDashedIcon,
    iconClassName: "text-muted",
    color: "default",
  },
  todo: {
    icon: Note01Icon,
    iconClassName: "text-foreground",
    color: "default",
  },
  in_progress: {
    icon: ProgressIcon,
    iconClassName: "text-warning",
    color: "warning",
  },
  in_review: {
    icon: ProgressIcon,
    iconClassName: "text-accent",
    color: "accent",
  },
  done: {
    icon: CheckmarkCircle02Icon,
    iconClassName: "text-success",
    color: "success",
  },
  wont_do: {
    icon: OctagonXIcon,
    iconClassName: "text-danger",
    color: "danger",
  },
};

export function StatusIcon({
  status,
  size = 16,
}: {
  status: TaskStatus;
  size?: 16 | 20;
}) {
  return (
    <HugeiconsIcon
      icon={presentation[status].icon}
      size={size}
      aria-hidden="true"
      className={`shrink-0 ${presentation[status].iconClassName}`}
    />
  );
}

export const statusOptions = TASK_STATUSES.map((id) => ({
  id,
  name: taskStatusLabel(id),
  startContent: <StatusIcon status={id} />,
}));

export function StatusChip({ status }: { status: TaskStatus }) {
  return (
    <StatusIndicator
      color={presentation[status].color}
      size="sm"
      icon={<StatusIcon status={status} />}
      label={taskStatusLabel(status)}
    />
  );
}
