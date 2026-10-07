import type { ReactNode } from "react";
import { usePageBreadcrumbs } from "./app-breadcrumbs.js";
import { ApplicationPage, TooltipText } from "@mill/web-design-system";

// Adapted from Towbar's ApplicationPage and DashboardPage title composition.
export function PageHeading({
  title,
  icon,
  titleContent,
  actions,
  actionsPlacement = "end",
  truncateTitle = false,
}: {
  title: string;
  icon?: ReactNode;
  titleContent?: ReactNode;
  actions?: ReactNode;
  actionsPlacement?: "inline" | "end";
  truncateTitle?: boolean;
}) {
  const items = usePageBreadcrumbs();
  const current = items[items.length - 1];
  const ancestors = items.slice(0, -1);
  return (
    <ApplicationPage
      title={title}
      breadcrumbAncestors={ancestors}
      breadcrumbLabel={current?.label ?? title}
      breadcrumbContent={current?.content}
      breadcrumbContentKey={current?.contentKey}
      titleContent={
        titleContent ?? (
          <span className="inline-flex min-w-0 items-center gap-2">
            {icon ? (
              <span
                aria-hidden="true"
                className="inline-flex shrink-0 [&_img]:size-6 [&_svg]:size-6"
              >
                {icon}
              </span>
            ) : null}
            <TooltipText className="min-w-0 truncate" tooltip={title}>
              {title}
            </TooltipText>
          </span>
        )
      }
      badge={actionsPlacement === "inline" ? actions : undefined}
      actions={actionsPlacement === "inline" ? undefined : actions}
      titleOverflow={truncateTitle ? "truncate" : "wrap"}
    />
  );
}
