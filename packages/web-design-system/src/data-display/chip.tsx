"use client";

import { Chip as HeroChip, Spinner } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";
import { TooltipText } from "../overlays/tooltip.js";
import { cn } from "../utils.js";

type ChipVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "success"
  | "warning"
  | "info"
  | "orange"
  | "yellow";
type ChipSize = "small" | "default" | "large";
export type ChipProps = Omit<
  ComponentProps<typeof HeroChip>,
  "children" | "color" | "size" | "variant"
> & {
  children?: ReactNode;
  color?: ComponentProps<typeof HeroChip>["color"];
  loading?: boolean;
  icon?: ReactNode;
  size?: ChipSize;
  tooltip?: ReactNode;
  variant?: ChipVariant;
};

const colors = {
  default: "accent",
  secondary: "default",
  destructive: "danger",
  success: "success",
  warning: "warning",
  info: "accent",
  orange: "warning",
  yellow: "warning",
} as const;
const sizes = { small: "sm", default: "md", large: "lg" } as const;

export function Chip({
  children,
  color,
  loading,
  icon,
  size,
  tooltip,
  variant,
  className,
  ...props
}: ChipProps) {
  const numeric =
    typeof children === "number" ||
    (typeof children === "string" &&
      /^\s*[+-]?\d[\d,]*(?:\.\d+)?\s*$/.test(children));
  const chip = (
    <HeroChip
      aria-busy={loading || undefined}
      color={color ?? (variant ? colors[variant] : undefined)}
      size={size ? sizes[size] : undefined}
      variant="soft"
      className={cn(
        !color &&
          (variant === "orange" || variant === "yellow") &&
          `chip--${variant}`,
        className,
      )}
      {...props}
    >
      {loading ? <Spinner color="current" size="sm" /> : null}
      <HeroChip.Label
        className={`inline-flex items-center gap-[3px] whitespace-nowrap font-normal${numeric ? " font-mono tabular-nums" : ""}`}
      >
        {!loading && icon ? (
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 text-current [&_svg]:m-0 [&_svg]:size-3.5 [&_svg]:!text-current"
          >
            {icon}
          </span>
        ) : null}
        {children}
      </HeroChip.Label>
    </HeroChip>
  );
  return tooltip ? (
    <TooltipText className="inline-flex" tooltip={tooltip}>
      {chip}
    </TooltipText>
  ) : (
    chip
  );
}
