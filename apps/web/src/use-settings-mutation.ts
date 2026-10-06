import { useCallback, useLayoutEffect, useRef } from "react";
import { useOverlaySuspension } from "@avgeek-oss/design-system";

function canceledSettingsRequest() {
  return new DOMException("Account action canceled.", "AbortError");
}

export function useSettingsMutation(owner: string) {
  const suspension = useOverlaySuspension();
  const capture = useRef(suspension.capture);
  const active = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  useLayoutEffect(() => {
    capture.current = suspension.capture;
  }, [suspension.capture]);
  useLayoutEffect(() => {
    active.current = !suspension.isSuspended;
    const requests = controllers.current;
    return () => {
      active.current = false;
      for (const request of requests) request.abort();
      requests.clear();
    };
  }, [owner, suspension.isSuspended]);

  return useCallback(async <T>(action: (signal: AbortSignal) => Promise<T>) => {
    const isCurrent = capture.current();
    if (!active.current || !isCurrent()) throw canceledSettingsRequest();
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const abort = () => reject(canceledSettingsRequest());
        controller.signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) throw canceledSettingsRequest();
            return action(controller.signal);
          })
          .then(
            (value) => {
              controller.signal.removeEventListener("abort", abort);
              resolve(value);
            },
            (cause: unknown) => {
              controller.signal.removeEventListener("abort", abort);
              reject(cause);
            },
          );
      });
      if (!isCurrent()) throw canceledSettingsRequest();
      return result;
    } finally {
      controllers.current.delete(controller);
    }
  }, []);
}
