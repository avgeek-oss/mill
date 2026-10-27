import { useCallback, useRef, useState } from "react";
import { ApiError } from "./api.js";
import { navigationCache } from "./navigation-cache.js";

export function useBoardAccess(boardId: string, initialStatus = 0) {
  const [errorStatus, setErrorStatus] = useState(initialStatus);
  const [accessDenied, setAccessDenied] = useState(
    [403, 404].includes(initialStatus),
  );
  const notifiedDenial = useRef(false);
  const failed = useCallback(
    (cause: unknown) => {
      const status = cause instanceof ApiError ? cause.status : -1;
      setErrorStatus(status);
      // A transient failure cannot establish access to previously denied data.
      if (![403, 404].includes(status)) return;
      navigationCache.forgetBoard(boardId);
      if (!notifiedDenial.current)
        window.dispatchEvent(new Event("mill:route-access-denied"));
      notifiedDenial.current = true;
      setAccessDenied(true);
    },
    [boardId],
  );
  const authorized = useCallback(() => {
    notifiedDenial.current = false;
    setAccessDenied(false);
    setErrorStatus(0);
  }, []);
  const clearError = useCallback(() => setErrorStatus(0), []);
  return { errorStatus, accessDenied, failed, authorized, clearError };
}
