export const CLOCK_TIME_ZONES = [
  "America/Los_Angeles",
  "America/New_York",
] as const;
export type ClockTimeZone = (typeof CLOCK_TIME_ZONES)[number];
export const DEFAULT_CLOCK_TIME_ZONE: ClockTimeZone = "America/Los_Angeles";
export const clockTimeZoneLabels: Record<
  ClockTimeZone,
  { label: string; heading: string }
> = {
  "America/Los_Angeles": {
    label: "Pacific — San Francisco",
    heading: "San Francisco · Pacific Time (PST/PDT)",
  },
  "America/New_York": {
    label: "Eastern — New York",
    heading: "New York · Eastern Time (EST/EDT)",
  },
};
const formatters = Object.fromEntries(
  CLOCK_TIME_ZONES.map((timeZone) => [
    timeZone,
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }),
  ]),
) as Record<ClockTimeZone, Intl.DateTimeFormat>;
export function formatClockTime(
  epochMs: number,
  timeZone: ClockTimeZone = DEFAULT_CLOCK_TIME_ZONE,
): string {
  const parts = formatters[timeZone].formatToParts(epochMs);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("hour")}:${part("minute")}`;
}
