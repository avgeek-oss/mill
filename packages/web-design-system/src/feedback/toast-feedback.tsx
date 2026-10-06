"use client";

import { isValidElement, useEffect, useRef, type ReactNode } from "react";
import { toast } from "@avgeek-oss/design-system/overlays/toast";

function feedbackText(content: ReactNode): string {
  if (typeof content === "string" || typeof content === "number")
    return String(content);
  if (Array.isArray(content)) return content.map(feedbackText).join("");
  if (isValidElement<{ children?: ReactNode }>(content))
    return feedbackText(content.props.children);
  return "";
}

export function useErrorToast(message: ReactNode) {
  const text = feedbackText(message).replace(/\s+/g, " ").trim();
  const previous = useRef("");
  useEffect(() => {
    if (previous.current === text) return;
    previous.current = text;
    if (text) toast.danger(message);
  }, [message, text]);
}
