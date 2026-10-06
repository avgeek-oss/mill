import { useEffect } from "react";
import { toast } from "@mill/web-design-system";

export function FormFeedback() {
  useEffect(() => {
    let firstInvalid:
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalid = (event: Event) => {
      const control = event.target;
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLTextAreaElement) &&
        !(control instanceof HTMLSelectElement)
      )
        return;
      event.preventDefault();
      if (firstInvalid) return;
      firstInvalid = control;
      timer = setTimeout(() => {
        const field = firstInvalid;
        firstInvalid = null;
        if (!field?.isConnected || field.validity.valid) return;
        const label = (
          field.labels?.[0]?.textContent ??
          field.getAttribute("aria-label") ??
          ""
        )
          .replace(/\s*\*\s*$/, "")
          .trim();
        toast.danger(
          label
            ? `${label}: ${field.validationMessage}`
            : field.validationMessage,
        );
        field.focus();
      });
    };
    document.addEventListener("invalid", invalid, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("invalid", invalid, true);
    };
  }, []);
  return null;
}
