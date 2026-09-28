"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { Input } from "./input.js";
import { Field, FieldDescription, FieldError, FieldLabel } from "./field.js";

export type FileFieldProps = Omit<
  ComponentProps<typeof Input>,
  "children" | "type"
> & {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
};

export function FileField({
  label,
  description,
  error,
  ...props
}: FileFieldProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy =
    [props["aria-describedby"], description && descriptionId, error && errorId]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <Field>
      <FieldLabel htmlFor={id} isRequired={props.required}>
        {label}
      </FieldLabel>
      <Input
        {...props}
        id={id}
        type="file"
        variant={props.variant ?? "secondary"}
        aria-describedby={describedBy}
        aria-invalid={error ? true : props["aria-invalid"]}
      />
      {description && (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}
