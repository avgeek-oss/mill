"use client";

import { isValidElement, useEffect, useRef, type ReactNode } from "react";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { useOverlaySuspension } from "@avgeek-oss/design-system/overlays/overlay-suspension";

function feedbackText(content: ReactNode): string {
  if (typeof content === "string" || typeof content === "number")
    return String(content);
  if (Array.isArray(content)) return content.map(feedbackText).join("");
  if (isValidElement<{ children?: ReactNode }>(content))
    return feedbackText(content.props.children);
  return "";
}

export function useErrorToast(message: ReactNode) {
  const { isSuspended } = useOverlaySuspension();
  const text = feedbackText(message).replace(/\s+/g, " ").trim();
  const previous = useRef("");
  useEffect(() => {
    if (previous.current === text) return;
    previous.current = text;
    if (text && !isSuspended) toast.danger(message);
  }, [isSuspended, message, text]);
}
