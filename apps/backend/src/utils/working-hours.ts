const DAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type WorkingHoursConfig = {
  enabled: boolean;
  timezone: string;
  workDays: number[];
  startTime: string;
  endTime: string;
};

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === 'weekday')?.value || 'Sun';
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);

  return { day: DAY_MAP[weekday] ?? 0, minutes: hour * 60 + minute };
}

function parseTime(value: string): number {
  const [h, m] = value.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

export function isWithinWorkingHours(config: WorkingHoursConfig, at = new Date()): boolean {
  if (!config.enabled) return true;

  const { day, minutes } = localParts(at, config.timezone);
  if (!config.workDays.includes(day)) return false;

  const start = parseTime(config.startTime);
  const end = parseTime(config.endTime);
  return minutes >= start && minutes < end;
}

export function startOfLocalDay(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

  return new Date(`${parts}T00:00:00`);
}
