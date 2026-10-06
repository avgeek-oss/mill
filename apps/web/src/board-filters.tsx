import { HugeiconsIcon } from "@hugeicons/react";
import {
  FilterResetIcon,
  Flag01Icon,
  Layers01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import {
  Avatar,
  Button,
  Choice,
  SecondarySection,
  useAppSuspended,
} from "@mill/web-design-system";
import type { Member } from "../../../packages/contracts/src/index.js";
import type { BoardUrlState } from "./board-url.js";
import { priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";

export function BoardFilters({
  filters,
  members,
  hasFilters,
  onChange,
  onClear,
}: {
  filters: BoardUrlState;
  members: Member[];
  hasFilters: boolean;
  onChange: (value: Partial<BoardUrlState>) => void;
  onClear: () => void;
}) {
  const suspended = useAppSuspended();
  if (suspended) return null;
  return (
    <div className="grid min-w-0 gap-3" aria-label="Task filters">
      <SecondarySection title="Sort tasks">
        <Choice
          label="Sort order"
          value={filters.sort}
          onChange={(sort) => onChange({ sort, page: 1 })}
          items={[
            { id: "createdAt", name: "Newest first" },
            { id: "title", name: "Title" },
            { id: "updatedAt", name: "Recently updated" },
            { id: "dueDate", name: "Due date" },
            { id: "priority", name: "Priority" },
            { id: "status", name: "Status" },
          ].map((item) => ({
            ...item,
            startContent: (
              <HugeiconsIcon
                icon={Layers01Icon}
                className="size-4 shrink-0"
                aria-hidden="true"
              />
            ),
          }))}
        />
      </SecondarySection>
      <SecondarySection title="Filter tasks">
        <div className="grid min-w-0 gap-4">
          <Choice
            label="Assignee"
            value={filters.assigneeId}
            onChange={(assigneeId) => onChange({ assigneeId, page: 1 })}
            items={[
              {
                id: "",
                name: "All assignees",
                startContent: (
                  <HugeiconsIcon
                    icon={UserGroupIcon}
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                ),
              },
              {
                id: "unassigned",
                name: "Unassigned",
                muted: true,
                startContent: (
                  <HugeiconsIcon
                    icon={UserGroupIcon}
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                ),
              },
              ...members.map((member) => ({
                id: member.id,
                name: member.name,
                startContent: (
                  <Avatar
                    className="size-5"
                    email={member.email}
                    name={member.name}
                    size="sm"
                  />
                ),
              })),
            ]}
            search
          />
          <Choice
            label="Priority"
            value={filters.priority}
            onChange={(priority) => onChange({ priority, page: 1 })}
            items={[
              {
                id: "",
                name: "All priorities",
                startContent: (
                  <HugeiconsIcon
                    icon={Flag01Icon}
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                ),
              },
              ...priorityOptions,
            ]}
          />
          <Choice
            label="Status"
            value={filters.status}
            onChange={(status) => onChange({ status, page: 1 })}
            items={[
              {
                id: "",
                name: "All statuses",
                startContent: (
                  <HugeiconsIcon
                    icon={Layers01Icon}
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                ),
              },
              ...statusOptions,
            ]}
          />
          {(hasFilters || filters.sort !== "createdAt") && (
            <Button variant="secondary" onPress={onClear}>
              <HugeiconsIcon icon={FilterResetIcon} aria-hidden="true" />
              Clear filters
            </Button>
          )}
        </div>
      </SecondarySection>
    </div>
  );
}
