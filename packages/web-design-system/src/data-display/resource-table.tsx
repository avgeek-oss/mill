// Adapted from Towbar's Apache-2.0 ResourceTable composition; see NOTICE.
import type { ReactNode } from "react";
import { EmptyState } from "./empty-state.js";
import { Table } from "./table.js";

export type ResourceTableColumn<T> = {
  key: string;
  header: string;
  cell: (item: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  isRowHeader?: boolean;
};

export function ResourceTable<T>({
  ariaLabel,
  columns,
  emptyTitle,
  emptyDescription,
  getRowKey,
  items,
  tableClassName,
  footer,
}: {
  ariaLabel: string;
  columns: ResourceTableColumn<T>[];
  emptyTitle: string;
  emptyDescription?: string;
  getRowKey: (item: T) => string;
  items: T[];
  tableClassName?: string;
  footer?: ReactNode;
}) {
  if (!items.length)
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>{emptyTitle}</EmptyState.Title>
          {emptyDescription && (
            <EmptyState.Description>{emptyDescription}</EmptyState.Description>
          )}
        </EmptyState.Header>
      </EmptyState>
    );

  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={ariaLabel} className={tableClassName}>
          <Table.Header>
            {columns.map((column) => (
              <Table.Column
                key={column.key}
                className={column.headerClassName}
                isRowHeader={column.isRowHeader}
              >
                {column.header}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body>
            {items.map((item) => (
              <Table.Row key={getRowKey(item)} id={getRowKey(item)}>
                {columns.map((column) => (
                  <Table.Cell
                    key={column.key}
                    className={`align-middle ${column.className ?? ""}`}
                  >
                    {column.cell(item)}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
      {footer && <Table.Footer>{footer}</Table.Footer>}
    </Table>
  );
}
