import "@fontsource-variable/inter";
import { useId, type ReactNode, type ComponentProps } from "react";
import {
  Autocomplete,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
  Select,
  TextArea,
  Chip as HeroChip,
} from "@heroui/react";
export { Button, ButtonLink } from "./button.js";
export {
  Input,
  Label,
  Modal,
  Select,
  ListBox,
  SearchField,
  TextArea,
  Checkbox,
  Switch,
  Spinner,
} from "@heroui/react";
export { cn } from "./utils.js";
export function Field({
  label,
  description,
  children,
}: {
  label?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {description && <p className="muted small">{description}</p>}
    </div>
  );
}
export function TextField({
  label,
  description,
  multiline,
  ...props
}: Omit<ComponentProps<typeof Input>, "children"> & {
  label: string;
  description?: string;
  multiline?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <TextArea {...(props as ComponentProps<typeof TextArea>)} id={id} />
      ) : (
        <Input {...props} id={id} />
      )}{" "}
      {description && <p className="muted small">{description}</p>}
    </div>
  );
}
export function Choice({
  label,
  value,
  onChange,
  items,
  disabled,
  search = false,
}: {
  label: string;
  value: string;
  onChange: (key: string) => void;
  items: { id: string; name: string }[];
  disabled?: boolean;
  search?: boolean;
}) {
  return (
    <Select
      fullWidth
      selectedKey={value}
      onSelectionChange={(key) => typeof key === "string" && onChange(key)}
      isDisabled={disabled}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          {items.find((i) => i.id === value)?.name ?? "Choose…"}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="choice-popover">
        {search ? (
          <Autocomplete.Filter
            filter={(text, query) =>
              text.toLowerCase().includes(query.toLowerCase())
            }
          >
            <SearchField
              aria-label={`Search ${label.toLowerCase()}`}
              className="px-2 pt-2"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Search…" />
                <SearchField.ClearButton aria-label="Clear search" />
              </SearchField.Group>
            </SearchField>
            <ListBox>
              {items.map((i) => (
                <ListBox.Item key={i.id} id={i.id} textValue={i.name}>
                  {i.name}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Autocomplete.Filter>
        ) : (
          <ListBox>
            {items.map((i) => (
              <ListBox.Item key={i.id} id={i.id} textValue={i.name}>
                {i.name}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        )}
      </Select.Popover>
    </Select>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(value) => !value && onClose()}>
      <Modal.Container size={wide ? "lg" : "md"}>
        <Modal.Dialog className={wide ? "mill-dialog wide" : "mill-dialog"}>
          <Modal.CloseTrigger aria-label="Close dialog" />
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
          {footer && <Modal.Footer>{footer}</Modal.Footer>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
export function Chip({
  children,
  color = "default",
}: {
  children: ReactNode;
  color?: "default" | "accent" | "success" | "warning" | "danger";
}) {
  return (
    <HeroChip color={color} size="sm" variant="soft">
      <HeroChip.Label>{children}</HeroChip.Label>
    </HeroChip>
  );
}
export function ErrorMessage({ children }: { children?: ReactNode }) {
  return children ? (
    <p role="alert" className="error-message">
      {children}
    </p>
  ) : null;
}

export function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(value) => !value && onClose()}
      className="drawer-backdrop"
    >
      <Modal.Container className="drawer-container" placement="top">
        <Modal.Dialog
          aria-label="Workspace navigation"
          className="drawer-dialog"
        >
          {children}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
