import { Button } from "@avgeek-oss/design-system";
import { ErrorMessage } from "@mill/web-design-system";

/** Mill's feedback policy keeps query explanations in toasts and recovery in place. */
export function QueryFeedback({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <>
      <ErrorMessage>{message}</ErrorMessage>
      {onRetry ? (
        <div>
          <Button variant="secondary" onPress={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </>
  );
}
