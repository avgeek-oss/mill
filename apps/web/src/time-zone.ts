export function timeZoneOffset(timeZone: string, date: Date): string {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")!.value;
  return offset === "GMT"
    ? "+00:00"
    : offset.replace("GMT", "").replace("-", "−");
}
