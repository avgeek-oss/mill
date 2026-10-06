import { HugeiconsIcon } from "@hugeicons/react";
import { Bug02Icon, Task01Icon } from "@hugeicons/core-free-icons";
import { TooltipText } from "@mill/web-design-system";
import {
  TASK_TYPES,
  type TaskType,
} from "../../../packages/contracts/src/index.js";

const presentation = {
  task: { name: "Task", icon: Task01Icon, className: "text-accent" },
  bug: {
    name: "Bug",
    icon: Bug02Icon,
    className: "text-danger-soft-foreground",
  },
};

export function TaskTypeIcon({ type }: { type: TaskType }) {
  const { icon, className } = presentation[type];
  return (
    <HugeiconsIcon
      icon={icon}
      size={16}
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    />
  );
}

export function TaskTypeIndicator({
  type,
  focusable = true,
}: {
  type: TaskType;
  focusable?: boolean;
}) {
  const { name } = presentation[type];
  return (
    <TooltipText
      role="img"
      aria-label={name}
      tooltip={name}
      tabIndex={focusable ? 0 : -1}
      className="inline-flex shrink-0"
    >
      <TaskTypeIcon type={type} />
    </TooltipText>
  );
}

export const taskTypeOptions = TASK_TYPES.map((id) => ({
  id,
  name: presentation[id].name,
  startContent: <TaskTypeIcon type={id} />,
}));
