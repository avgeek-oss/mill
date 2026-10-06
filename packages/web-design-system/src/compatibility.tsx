import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Autocomplete,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
  Select,
  TextArea,
} from "@heroui/react";
import { Field, FieldDescription } from "@avgeek-oss/design-system/forms/field";
import { cn } from "./utils.js";
import { useErrorToast } from "./feedback/toast-feedback.js";

const SuspendedAppContext = createContext(false);
export const SuspendedAppProvider = SuspendedAppContext.Provider;
export const useAppSuspended = () => useContext(SuspendedAppContext);

type TextFieldDetails = {
  label: string;
  description?: ReactNode;
  hideLabel?: boolean;
};
export type TextFieldProps = TextFieldDetails &
  (
    | (Omit<ComponentProps<typeof Input>, "children"> & { multiline?: false })
    | (Omit<ComponentProps<typeof TextArea>, "children"> & { multiline: true })
  );

export function TextField({
  label,
  description,
  hideLabel = false,
  ...props
}: TextFieldProps) {
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
      <Label
        htmlFor={id}
        isRequired={props.required}
        className={hideLabel ? "sr-only" : undefined}
      >
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
  items: {
    id: string;
    name: string;
    startContent?: ReactNode;
    endContent?: string;
    description?: string;
    muted?: boolean;
  }[];
  disabled?: boolean;
  search?: boolean;
  hideLabel?: boolean;
};

export function Choice({
  label,
  value,
  onChange,
  items,
  disabled,
  search = false,
  hideLabel = false,
  ...props
}: ChoiceProps) {
  const selected = items.find((item) => item.id === value);
  const options = (
    <ListBox shouldSelectOnPressUp={false}>
      {items.map((item) => (
        <ListBox.Item
          key={item.id}
          id={item.id}
          aria-label={item.name}
          textValue={[item.name, item.description, item.endContent]
            .filter(Boolean)
            .join(" ")}
        >
          {item.startContent ? (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {item.startContent}
            </span>
          ) : null}
          <span className="grid min-w-0 flex-1 gap-0.5 text-sm/5 font-normal">
            <span className={item.muted ? "truncate text-muted" : "truncate"}>
              {item.name}
            </span>
            {item.description ? (
              <span className="truncate text-xs/4 font-normal text-muted">
                {item.description}
              </span>
            ) : null}
          </span>
          {item.endContent ? (
            <span className="shrink-0 text-sm/5 font-normal text-muted tabular-nums">
              {item.endContent}
            </span>
          ) : null}
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
      <Label
        className={
          hideLabel
            ? "sr-only"
            : "[[data-secondary-menu]_&]:pl-2 [[data-secondary-menu]_&]:text-xs [[data-secondary-menu]_&]:text-muted"
        }
      >
        {label}
      </Label>
      <Select.Trigger className="min-w-0">
        <Select.Value className="flex min-w-0 flex-1 items-center gap-2 [&_[data-slot=avatar]]:size-5">
          {selected?.startContent ? (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {selected.startContent}
            </span>
          ) : null}
          <span
            className={
              selected?.muted
                ? "min-w-0 flex-1 truncate text-muted"
                : "min-w-0 flex-1 truncate"
            }
          >
            {selected?.name ?? "Choose…"}
          </span>
          {selected?.endContent ? (
            <span className="shrink-0 text-sm/5 font-normal text-muted tabular-nums">
              {selected.endContent}
            </span>
          ) : null}
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
  size?: ComponentProps<typeof Modal.Container>["size"];
  scroll?: ComponentProps<typeof Modal.Container>["scroll"];
  isDismissDisabled?: boolean;
};

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  size,
  scroll = "inside",
  isDismissDisabled = false,
  className,
  ...props
}: DialogProps) {
  const suspended = useContext(SuspendedAppContext);
  return (
    <Modal.Backdrop
      isOpen={open && !suspended}
      isDismissable={!isDismissDisabled}
      isKeyboardDismissDisabled={isDismissDisabled}
      onOpenChange={(value) =>
        !value && !suspended && !isDismissDisabled && onClose()
      }
    >
      <Modal.Container size={size ?? (wide ? "lg" : "md")} scroll={scroll}>
        <Modal.Dialog
          {...props}
          className={cn(wide && "mill-dialog wide", className)}
        >
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.CloseTrigger
              aria-label="Close dialog"
              isDisabled={isDismissDisabled}
            />
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
          {footer && <Modal.Footer>{footer}</Modal.Footer>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function ErrorMessage({ children }: ComponentProps<"div">) {
  useErrorToast(children);
  return null;
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
  const suspended = useContext(SuspendedAppContext);
  return (
    <Modal.Backdrop
      isOpen={open && !suspended}
      onOpenChange={(value) => !value && !suspended && onClose()}
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
