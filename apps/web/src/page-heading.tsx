import type { ReactNode } from "react";
import { TypographyHeading, TooltipText } from "@mill/web-design-system";

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
  return (
    <div className="py-5">
      <header
        className={`flex items-center ${actionsPlacement === "inline" ? "flex-nowrap gap-2" : `justify-between ${truncateTitle ? "flex-nowrap gap-3" : "flex-wrap gap-5"}`}`}
      >
        <TypographyHeading
          elementType="h1"
          level={3}
          className={`flex min-w-0 items-center text-xl font-medium${truncateTitle ? " flex-1" : ""}`}
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            {icon && (
              <span
                aria-hidden="true"
                className="inline-flex shrink-0 [&_svg]:size-5"
              >
                {icon}
              </span>
            )}
            <TooltipText className="min-w-0 truncate" tooltip={title}>
              {title}
            </TooltipText>
          </span>
        </TypographyHeading>
        {actions}
      </header>
    </div>
  );
}
