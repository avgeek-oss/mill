import {
  Button,
  TypographyHeading,
  TypographyParagraph,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Search01Icon } from "@hugeicons/core-free-icons";

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
  const unavailable = missing || code === "403";
  return (
    <section className="grid min-h-[calc(100dvh-10rem)] place-items-center px-4 py-12">
      <div className="flex max-w-md flex-col items-center text-center">
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
            (missing ? "This page could not be found" : "Something went wrong")}
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
              : "Try again to reconnect to Mill. Your saved work is kept on the server.")}
        </TypographyParagraph>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {!unavailable && (
            <Button onPress={onRetry ?? (() => window.location.reload())}>
              {onRetry ? "Try again" : "Reload"}
            </Button>
          )}
          {showBoards && (
            <Button
              variant={unavailable ? "primary" : "secondary"}
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
