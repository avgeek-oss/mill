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
    const submit = (event: Event) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      const control = Array.from(event.target.elements).find(
        (element): element is HTMLInputElement =>
          element instanceof HTMLInputElement &&
          element.type === "text" &&
          element.required &&
          !element.disabled &&
          !element.readOnly &&
          element.value.length > 0 &&
          !element.value.trim(),
      );
      if (!control) return;
      event.preventDefault();
      event.stopPropagation();
      const label = (
        control.labels?.[0]?.textContent ??
        control.getAttribute("aria-label") ??
        "this field"
      )
        .replace(/\s*\*\s*$/, "")
        .trim();
      toast.danger(`Enter a value for ${label}.`);
      control.focus();
    };
    document.addEventListener("invalid", invalid, true);
    document.addEventListener("submit", submit, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("invalid", invalid, true);
      document.removeEventListener("submit", submit, true);
    };
  }, []);
  return null;
}
