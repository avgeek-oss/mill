import { RouterProvider } from "react-aria-components";
import { ErrorPage as SharedErrorPage } from "@avgeek-oss/design-system/patterns/feedback/error-page";

export function errorPageCode(status: number) {
  if (status === 0) return "Connection";
  if (status >= 400 && status < 600) return String(status);
  return "Error";
}

export function ErrorPage({
  code = "Error",
  onRetry,
  title,
  description,
  showBoards = true,
  pending = false,
}: {
  code?: string;
  onRetry?: () => void;
  title?: string;
  description?: string;
  showBoards?: boolean;
  pending?: boolean;
}) {
  const status =
    code === "404"
      ? "not-found"
      : code === "403"
        ? "forbidden"
        : ["Connection", "503", "Load error"].includes(code)
          ? "unavailable"
          : "server-error";
  return (
    <RouterProvider navigate={(href) => window.location.assign(href)}>
      <SharedErrorPage
        status={status}
        title={title}
        description={description}
        isPending={pending}
        onRetry={
          onRetry ??
          (status === "server-error" || status === "unavailable"
            ? () => window.location.reload()
            : undefined)
        }
        returnHref={showBoards ? "/boards" : undefined}
        returnLabel="Go to boards"
      />
    </RouterProvider>
  );
}
