export type CustomFieldValueDefinition = {
  name: string;
  dataType: string;
  allowedValues: string[];
};

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateCustomFieldValue(
  definition: CustomFieldValueDefinition,
  value: string | null | undefined,
): string | null | undefined {
  if (!value) return value;
  if (definition.dataType === 'number' && (!/^-?(?:\d+|\d*\.\d+)$/.test(value) || !Number.isFinite(Number(value)))) {
    throw new Error(`${definition.name} must be a number`);
  }
  if (definition.dataType === 'checkbox') {
    const normalized = value.toLowerCase();
    if (!['true', 'false'].includes(normalized)) throw new Error(`${definition.name} must be true or false`);
    return normalized;
  }
  if (definition.dataType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`${definition.name} must be a valid email address`);
  }
  if (definition.dataType === 'date' && !isCalendarDate(value)) {
    throw new Error(`${definition.name} must be a date between 1900 and 2100`);
  }
  if (definition.dataType === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw new Error(`${definition.name} must be a valid time`);
  }
  if (definition.dataType === 'url') {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || value.length > 255) throw new Error();
    } catch {
      throw new Error(`${definition.name} must be a valid URL`);
    }
  }
  if (definition.dataType === 'list' && definition.allowedValues.length && !definition.allowedValues.includes(value)) {
    throw new Error(`${definition.name}: ${definition.allowedValues.join(' / ')}`);
  }
  return value;
}
