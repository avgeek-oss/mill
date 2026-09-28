import { Button } from "@mill/web-design-system";
import { navigate } from "./api.js";
export function ErrorPage({
  code = "500",
  onRetry,
}: {
  code?: string;
  onRetry?: () => void;
}) {
  return (
    <section className="error-page">
      <p className="muted mono">{code}</p>
      <h1>
        {code === "404"
          ? "This page could not be found"
          : "Something went wrong"}
      </h1>
      <p className="muted">
        {code === "404"
          ? "The link may be outdated or the page may have moved."
          : "Try again to reconnect to Mill. Your saved work is kept on the server."}
      </p>
      <div className="row">
        <Button onPress={onRetry ?? (() => window.location.reload())}>
          {onRetry ? "Try again" : "Reload"}
        </Button>
        <Button variant="secondary" onPress={() => navigate("/")}>
          Go to boards
        </Button>
      </div>
    </section>
  );
}
