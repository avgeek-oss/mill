import { Table } from "@avgeek-oss/design-system/data-display/table";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Checkbox } from "@mill/web-design-system";
import type { Task } from "../../../packages/contracts/src/index.js";

export function TaskTable({
  label,
  items,
  columns,
  writable,
  disabled,
  selected,
  onSelectionChange,
}: {
  label: string;
  items: Task[];
  columns: ResourceTableColumn<Task>[];
  writable: boolean;
  disabled: boolean;
  selected: Set<string>;
  onSelectionChange: (selected: Set<string>) => void;
}) {
  if (!writable)
    return (
      <ResourceTable
        ariaLabel={label ? `${label} tasks` : "Task list"}
        items={items}
        columns={columns}
        getRowKey={(task) => task.id}
        tableClassName="task-table"
        emptyTitle="No tasks yet"
        emptyDescription="Tasks created by your team will appear here."
      />
    );
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content
          aria-label={label ? `${label} tasks` : "Task list"}
          className="task-table"
          selectionMode="multiple"
          selectionBehavior="toggle"
          selectedKeys={
            new Set(
              items
                .filter((task) => selected.has(task.id))
                .map((task) => task.id),
            )
          }
          disabledKeys={disabled ? items.map((task) => task.id) : []}
          disabledBehavior="selection"
          onSelectionChange={(keys) => {
            if (disabled) return;
            const next = new Set(selected);
            for (const task of items) {
              if (keys === "all" || keys.has(task.id)) next.add(task.id);
              else next.delete(task.id);
            }
            onSelectionChange(next);
          }}
        >
          <Table.Header>
            <Table.Column id="selection" className="task-selection-column">
              <Checkbox
                slot="selection"
                variant="secondary"
                aria-label={
                  label
                    ? `Select all ${label} tasks on this page`
                    : "Select all tasks on this page"
                }
                isDisabled={disabled}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                </Checkbox.Content>
              </Checkbox>
            </Table.Column>
            {columns.map((column) => (
              <Table.Column
                id={column.key}
                key={column.key}
                isRowHeader={column.isRowHeader}
                className={column.headerClassName}
              >
                {column.header}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body items={items} dependencies={[columns, disabled]}>
            {(task) => (
              <Table.Row
                id={task.id}
                textValue={`${task.identifier}: ${task.title}`}
              >
                <Table.Cell className="task-selection-column">
                  <Checkbox
                    slot="selection"
                    variant="secondary"
                    aria-label={`Select ${task.identifier}`}
                    isDisabled={disabled}
                    data-task-checkbox={task.id}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </Checkbox.Content>
                  </Checkbox>
                </Table.Cell>
                {columns.map((column) => (
                  <Table.Cell
                    key={column.key}
                    className={`align-middle ${column.className ?? ""}`}
                  >
                    {column.cell(task)}
                  </Table.Cell>
                ))}
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
