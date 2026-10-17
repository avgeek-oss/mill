import { useRef } from "react";
import { parseDate } from "@internationalized/date";
import {
  Calendar,
  CloseButton,
  DateField,
  DatePicker,
  Label,
} from "@heroui/react";

export function DatePickerField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const calendarTrigger = useRef<HTMLButtonElement>(null);
  return (
    <DatePicker
      className="w-full"
      value={value ? parseDate(value) : null}
      onChange={(date) => onChange(date?.toString() ?? null)}
      isDisabled={disabled}
    >
      <Label>{label}</Label>
      <DateField.Group variant="secondary" fullWidth>
        <DateField.Input>
          {(segment) => <DateField.Segment segment={segment} />}
        </DateField.Input>
        <DateField.Suffix className="gap-1">
          {value && !disabled && (
            <CloseButton
              slot={null}
              aria-label={`Clear ${label.toLowerCase()}`}
              onPress={() => {
                onChange(null);
                calendarTrigger.current?.focus();
              }}
            />
          )}
          <DatePicker.Trigger
            ref={calendarTrigger}
            className="w-auto"
            aria-label={`Choose ${label.toLowerCase()}`}
          >
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover placement="bottom end">
        <Calendar aria-label={`Choose ${label.toLowerCase()}`}>
          <Calendar.Header>
            <Calendar.YearPickerTrigger>
              <Calendar.YearPickerTriggerHeading />
              <Calendar.YearPickerTriggerIndicator />
            </Calendar.YearPickerTrigger>
            <Calendar.NavButton slot="previous" />
            <Calendar.NavButton slot="next" />
          </Calendar.Header>
          <Calendar.Grid>
            <Calendar.GridHeader>
              {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
            </Calendar.GridHeader>
            <Calendar.GridBody>
              {(date) => <Calendar.Cell date={date} />}
            </Calendar.GridBody>
          </Calendar.Grid>
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  );
}
