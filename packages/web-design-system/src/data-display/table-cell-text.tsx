// Adapted from Towbar's Apache-2.0 table-cell text recipe.
import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { cn } from "../utils.js";

export function TableCellStack({
  as: Tag = "span",
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & { as?: "div" | "span" }) {
  return (
    <Tag
      {...props}
      data-slot="table-cell-stack"
      className={cn(
        "grid min-w-0 gap-0.5 text-sm/5 font-normal text-foreground",
        className,
      )}
    />
  );
}

export function TableCellDescription({
  children,
  className,
  title,
  ...props
}: ComponentProps<"span">) {
  const characters = typeof children === "string" ? Array.from(children) : null;
  const truncated = characters !== null && characters.length > 48;
  return (
    <span
      {...props}
      title={title ?? (truncated ? characters.join("") : undefined)}
      data-slot="table-cell-description"
      className={cn("text-xs/4 font-normal text-muted", className)}
    >
      {truncated ? `${characters.slice(0, 47).join("")}…` : children}
    </span>
  );
}
