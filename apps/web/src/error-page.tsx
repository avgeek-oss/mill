import {
  Button,
  TypographyHeading,
  TypographyParagraph,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { MillMark } from "./brand.js";

// Adapted from Towbar's Apache-2.0 ErrorScreen composition.
export function ErrorPage({
  code = "500",
  onRetry,
  title,
  description,
  showBoards = true,
}: {
  code?: string;
  onRetry?: () => void;
  title?: string;
  description?: string;
  showBoards?: boolean;
}) {
  const missing = code === "404";
  const forbidden = code === "403";
  const unavailable = missing || forbidden;
  return (
    <section className="grid min-h-[calc(100dvh-10rem)] place-items-center px-4 py-12">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <MillMark />
          <span>Mill</span>
        </div>
        <HugeiconsIcon
          aria-hidden="true"
          icon={missing ? Search01Icon : AlertCircleIcon}
          className="mb-6 size-12 shrink-0 text-muted"
        />
        <p className="mb-2 font-mono text-xs font-medium tracking-widest text-muted">
          {code}
        </p>
        <TypographyHeading
          elementType="h1"
          level={2}
          align="center"
          className="font-semibold sm:text-3xl"
        >
          {title ??
            (missing
              ? "This page could not be found"
              : forbidden
                ? "You can't access this page"
                : "Mill could not load this page")}
        </TypographyHeading>
        <TypographyParagraph
          size="sm"
          color="muted"
          align="center"
          className="mt-3 max-w-sm leading-6"
        >
          {description ??
            (missing
              ? "The link may be outdated or the page may have moved."
              : forbidden
                ? "Ask an administrator for access, or return to your boards."
                : "Try again. If the problem continues, return to your boards.")}
        </TypographyParagraph>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {(onRetry || !unavailable) && (
            <Button onPress={onRetry ?? (() => window.location.reload())}>
              {onRetry ? "Try again" : "Reload"}
            </Button>
          )}
          {showBoards && (
            <Button
              variant={onRetry || !unavailable ? "secondary" : "primary"}
              onPress={() => window.location.assign("/")}
            >
              Go to boards
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
