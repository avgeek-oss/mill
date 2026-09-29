import type { ReactNode } from "react";
import {
  TypographyHeading,
  TypographyParagraph,
  TooltipText,
} from "@mill/web-design-system";

// Adapted from Towbar's ApplicationPage and DashboardPage title composition.
export function PageHeading({
  title,
  icon,
  actions,
  description,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  description?: string;
}) {
  return (
    <div className="pb-3">
      <header className="flex flex-wrap items-center justify-between gap-5">
        <TypographyHeading
          elementType="h1"
          level={3}
          className="flex min-w-0 items-center text-xl font-medium"
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
            <TooltipText className="truncate" tooltip={title}>
              {title}
            </TooltipText>
          </span>
        </TypographyHeading>
        {actions}
      </header>
      {description && (
        <TypographyParagraph className="mt-2" color="muted">
          {description}
        </TypographyParagraph>
      )}
    </div>
  );
}
