import { useId, type ComponentProps, type ReactNode } from "react";
import {
  Alert,
  Autocomplete,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
  Select,
  TextArea,
} from "@heroui/react";
import { Field, FieldDescription } from "./forms/field.js";
import { cn } from "./utils.js";

type TextFieldDetails = {
  label: string;
  description?: ReactNode;
};
export type TextFieldProps = TextFieldDetails &
  (
    | (Omit<ComponentProps<typeof Input>, "children"> & { multiline?: false })
    | (Omit<ComponentProps<typeof TextArea>, "children"> & { multiline: true })
  );

export function TextField({ label, description, ...props }: TextFieldProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const descriptionId = `${id}-description`;
  const describedBy =
    [props["aria-describedby"], description && descriptionId]
      .filter(Boolean)
      .join(" ") || undefined;
  let control: ReactNode;
  if (props.multiline) {
    const { multiline: _multiline, ...textareaProps } = props;
    control = (
      <TextArea
        {...textareaProps}
        variant={textareaProps.variant ?? "secondary"}
        id={id}
        aria-describedby={describedBy}
      />
    );
  } else {
    const { multiline: _multiline, ...inputProps } = props;
    control = (
      <Input
        {...inputProps}
        variant={inputProps.variant ?? "secondary"}
        id={id}
        aria-describedby={describedBy}
      />
    );
  }
  return (
    <Field>
      <Label htmlFor={id} isRequired={props.required}>
        {label}
      </Label>
      {control}
      {description && (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
    </Field>
  );
}

export type ChoiceProps = Omit<
  ComponentProps<typeof Select>,
  "children" | "selectedKey" | "onSelectionChange" | "onChange" | "items"
> & {
  label: string;
  value: string;
  onChange: (key: string) => void;
  items: { id: string; name: string }[];
  disabled?: boolean;
  search?: boolean;
};

export function Choice({
  label,
  value,
  onChange,
  items,
  disabled,
  search = false,
  ...props
}: ChoiceProps) {
  const options = (
    <ListBox>
      {items.map((item) => (
        <ListBox.Item key={item.id} id={item.id} textValue={item.name}>
          {item.name}
          <ListBox.ItemIndicator />
        </ListBox.Item>
      ))}
    </ListBox>
  );
  return (
    <Select
      fullWidth
      {...props}
      variant={props.variant ?? "secondary"}
      selectedKey={value}
      onSelectionChange={(key) => typeof key === "string" && onChange(key)}
      isDisabled={disabled ?? props.isDisabled}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          {items.find((item) => item.id === value)?.name ?? "Choose…"}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        {search ? (
          <Autocomplete.Filter
            filter={(text, query) =>
              text.toLowerCase().includes(query.toLowerCase())
            }
          >
            <SearchField
              aria-label={`Search ${label.toLowerCase()}`}
              className="px-2 pt-2"
              variant="secondary"
            >
              <SearchField.Group className="rounded-md">
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Search…" />
                <SearchField.ClearButton aria-label="Clear search" />
              </SearchField.Group>
            </SearchField>
            {options}
          </Autocomplete.Filter>
        ) : (
          options
        )}
      </Select.Popover>
    </Select>
  );
}

export type DialogProps = Omit<
  ComponentProps<typeof Modal.Dialog>,
  "children" | "title"
> & {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
};

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  className,
  ...props
}: DialogProps) {
  return (
    <Modal.Backdrop isOpen={open} onOpenChange={(value) => !value && onClose()}>
      <Modal.Container size={wide ? "lg" : "md"}>
        <Modal.Dialog
          {...props}
          className={cn(wide && "mill-dialog wide", className)}
        >
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

export function ErrorMessage({ children, ...props }: ComponentProps<"div">) {
  return children ? (
    <Alert status="danger" role="alert" {...props}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
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
