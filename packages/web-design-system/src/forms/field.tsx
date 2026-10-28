"use client";

import type { ComponentProps } from "react";
import { useErrorToast } from "../feedback/toast-feedback.js";

export function FieldError({ children }: ComponentProps<"p">) {
  useErrorToast(children);
  return null;
}
