import { HugeiconsIcon } from "@hugeicons/react";
import {
  NotepadTextDashedIcon,
  Note01Icon,
  ProgressIcon,
  CheckmarkCircle02Icon,
  OctagonXIcon,
} from "@hugeicons/core-free-icons";
import { Chip, type ChipProps } from "@mill/web-design-system";
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
    chipVariant: NonNullable<ChipProps["variant"]>;
  }
> = {
  backlog: {
    icon: NotepadTextDashedIcon,
    iconClassName: "text-muted",
    chipVariant: "secondary",
  },
  todo: {
    icon: Note01Icon,
    iconClassName: "text-foreground",
    chipVariant: "secondary",
  },
  in_progress: {
    icon: ProgressIcon,
    iconClassName: "text-yellow-600 dark:text-yellow-400",
    chipVariant: "yellow",
  },
  in_review: {
    icon: ProgressIcon,
    iconClassName: "text-accent",
    chipVariant: "info",
  },
  done: {
    icon: CheckmarkCircle02Icon,
    iconClassName: "text-success",
    chipVariant: "success",
  },
  wont_do: {
    icon: OctagonXIcon,
    iconClassName: "text-orange-600 dark:text-orange-400",
    chipVariant: "orange",
  },
};

function StatusIcon({ status }: { status: TaskStatus }) {
  return (
    <HugeiconsIcon
      icon={presentation[status].icon}
      size={16}
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
    <Chip
      variant={presentation[status].chipVariant}
      size="small"
      className={status === "backlog" ? "text-muted" : undefined}
      icon={<StatusIcon status={status} />}
    >
      {taskStatusLabel(status)}
    </Chip>
  );
}
