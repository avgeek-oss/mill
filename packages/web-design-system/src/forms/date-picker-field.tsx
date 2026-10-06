import { parseDate } from "@internationalized/date";
import { Calendar, DateField, DatePicker, Label } from "@heroui/react";
import { Button } from "../button.js";

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
        <DateField.Suffix>
          <DatePicker.Trigger aria-label={`Choose ${label.toLowerCase()}`}>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      {value && !disabled ? (
        <Button
          slot={null}
          variant="secondary"
          aria-label={`Clear ${label.toLowerCase()}`}
          className="mt-1 w-fit"
          onPress={() => onChange(null)}
        >
          Clear date
        </Button>
      ) : null}
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
