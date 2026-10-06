import type { ComponentProps, ReactNode } from "react";
import { usePageBreadcrumbs } from "./app-breadcrumbs.js";
import { ApplicationPage, TooltipText } from "@mill/web-design-system";

// Adapted from Towbar's ApplicationPage and DashboardPage title composition.
export function PageHeading({
  title,
  icon,
  actions,
  actionsPlacement = "end",
  truncateTitle = false,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  actionsPlacement?: "inline" | "end";
  truncateTitle?: boolean;
}) {
  const items = usePageBreadcrumbs();
  const current = items[items.length - 1];
  const ancestors: ComponentProps<
    typeof ApplicationPage
  >["breadcrumbAncestors"] =
    items.length > 1
      ? [items[0], ...items.slice(1, -1)]
      : [{ label: "Mill", href: "/boards" }];
  return (
    <ApplicationPage
      title={title}
      breadcrumbAncestors={ancestors}
      breadcrumbLabel={current?.label ?? title}
      breadcrumbContent={current?.content}
      breadcrumbContentKey={current?.contentKey}
      titleContent={
        <span className="inline-flex min-w-0 items-center gap-2">
          {icon}
          <TooltipText className="min-w-0 truncate" tooltip={title}>
            {title}
          </TooltipText>
        </span>
      }
      badge={actionsPlacement === "inline" ? actions : undefined}
      actions={actionsPlacement === "inline" ? undefined : actions}
      className={truncateTitle ? "min-w-0" : undefined}
    />
  );
}
