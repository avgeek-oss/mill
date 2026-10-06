"use client";

// Adapted from Towbar's Apache-2.0 CodeBlock; see NOTICE.
import { Copy01Icon, SourceCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "@heroui/react";
import { forwardRef, type ComponentPropsWithRef } from "react";
import { Button, type ButtonProps } from "../button.js";
import { Widget } from "../data-display/widget.js";
import { cn } from "../utils.js";

const Root = forwardRef<HTMLDivElement, ComponentPropsWithRef<"div">>(
  ({ className, ...props }, ref) => (
    <Widget
      ref={ref}
      className={cn("min-w-0", className)}
      data-slot="code-block"
      {...props}
    />
  ),
);

const Header = forwardRef<
  HTMLDivElement,
  ComponentPropsWithRef<typeof Widget.Header>
>((props, ref) => (
  <Widget.Header ref={ref} data-slot="code-block-header" {...props} />
));

const Filename = forwardRef<HTMLSpanElement, ComponentPropsWithRef<"span">>(
  ({ className, ...props }, ref) => (
    <Widget.Title
      ref={ref}
      icon={<HugeiconsIcon icon={SourceCodeIcon} />}
      className={cn("min-w-0 truncate text-muted", className)}
      data-slot="code-block-filename"
      {...props}
    />
  ),
);

const Code = forwardRef<
  HTMLPreElement,
  Omit<ComponentPropsWithRef<"pre">, "children"> & { code: string }
>(({ className, code, ...props }, ref) => (
  <Widget.Content className="p-0">
    <pre
      ref={ref}
      className={cn("m-0 overflow-x-auto p-4 text-sm", className)}
      data-slot="code-block-code"
      {...props}
    >
      <code>{code}</code>
    </pre>
  </Widget.Content>
));

const CopyButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "children" | "onPress"> & { code: string }
>(({ code, ...props }, ref) => {
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Copied to clipboard.");
    } catch {
      toast.danger(
        "Could not copy the configuration. Select it and copy it manually.",
      );
    }
  }

  return (
    <Button
      {...props}
      ref={ref}
      aria-label={props["aria-label"] ?? "Copy code"}
      data-slot="code-block-copy"
      isIconOnly
      onPress={() => void copyCode()}
      variant={props.variant ?? "ghost"}
    >
      <HugeiconsIcon aria-hidden="true" icon={Copy01Icon} size={16} />
    </Button>
  );
});

Root.displayName = "CodeBlock.Root";
Header.displayName = "CodeBlock.Header";
Filename.displayName = "CodeBlock.Filename";
Code.displayName = "CodeBlock.Code";
CopyButton.displayName = "CodeBlock.CopyButton";

export const CodeBlock = Object.assign(Root, {
  Root,
  Header,
  Filename,
  Code,
  CopyButton,
});
