// Adapted from Towbar's Apache-2.0 BreadcrumbTrail composition.
import type { ReactNode } from "react";
import { Link } from "@heroui/react";
import { TooltipText } from "../overlays/tooltip.js";

export type BreadcrumbItem = {
  label: string;
  href?: string;
  content?: ReactNode;
};

export function BreadcrumbTrail({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li
              key={`${item.label}-${index}`}
              aria-current={current ? "page" : undefined}
              className={`flex min-w-0 items-center gap-2 ${current && !item.content ? "shrink-0 max-w-[min(16rem,50vw)]" : index === 0 ? "shrink-0" : "shrink"}`}
            >
              {index > 0 && (
                <span aria-hidden="true" className="shrink-0 text-muted">
                  /
                </span>
              )}
              {item.content ??
                (item.href && !current ? (
                  <Link
                    href={item.href}
                    className="min-w-0 truncate text-sm font-normal text-muted hover:text-foreground"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <TooltipText
                    tooltip={item.label}
                    className="block min-w-0 truncate font-medium text-foreground"
                  >
                    {item.label}
                  </TooltipText>
                ))}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
