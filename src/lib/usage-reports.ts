import { escapeXml } from './xml-utils';

export interface EnabledReportSettings {
  enabled: true;
  recipients: string[];
  day: number;
  hour: number;
  timezone: string;
}

export type ReportSettingsInput = EnabledReportSettings | { enabled: false };

function canonicalTimezone(timezone: string): boolean {
  if (timezone !== 'UTC' && !timezone.includes('/')) return false;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone === timezone;
  } catch {
    return false;
  }
}

export function normalizeReportSettings(input: ReportSettingsInput): ReportSettingsInput {
  if (!input.enabled) return { enabled: false };
  if (!Number.isInteger(input.day) || input.day < 1 || input.day > 31) throw new Error('Report day must be 1 through 31');
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw new Error('Report hour must be a whole local hour');
  if (!canonicalTimezone(input.timezone)) throw new Error('Report timezone must be canonical IANA');
  const recipients = [...new Set(input.recipients.map((email) => email.trim().toLowerCase()))].sort();
  if (recipients.length < 1 || recipients.length > 25 || recipients.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    throw new Error('Reports require 1 through 25 valid email recipients');
  }
  return { ...input, recipients };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function localParts(format: Intl.DateTimeFormat, date: Date): LocalParts {
  const values = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function nextMonth(year: number, month: number, offset: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function nextReportDelivery(
  settings: Pick<EnabledReportSettings, 'day' | 'hour' | 'timezone'>,
  after: Date,
): Date {
  if (!Number.isInteger(settings.day) || !Number.isInteger(settings.hour) || !canonicalTimezone(settings.timezone)) {
    throw new Error('Invalid report schedule');
  }
  const format = formatter(settings.timezone);
  const localAfter = localParts(format, after);
  for (let monthOffset = 0; monthOffset < 15; monthOffset += 1) {
    const target = nextMonth(localAfter.year, localAfter.month, monthOffset);
    const lastDay = new Date(Date.UTC(target.year, target.month, 0)).getUTCDate();
    const targetDay = Math.min(settings.day, lastDay);
    const scanStart = Date.UTC(target.year, target.month - 1, targetDay - 2);
    const scanEnd = scanStart + 5 * 24 * 60 * 60 * 1_000;
    let laterLocal: Date | undefined;
    for (let timestamp = scanStart; timestamp <= scanEnd; timestamp += 15 * 60 * 1_000) {
      if (timestamp <= after.getTime()) continue;
      const candidate = new Date(timestamp);
      const local = localParts(format, candidate);
      if (local.year !== target.year || local.month !== target.month || local.day !== targetDay || local.minute !== 0) continue;
      if (local.hour === settings.hour) return candidate;
      if (local.hour > settings.hour && !laterLocal) laterLocal = candidate;
    }
    if (laterLocal) return laterLocal;
  }
  throw new Error('Could not resolve next report delivery');
}

export function latestClosedMonth(now: Date): string {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface ReportRow {
  email: string;
  runtimeSeconds: number;
  sessionCount: number;
}

function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function buildReportArtifacts(reportMonth: string, input: ReportRow[]): { html: string; csv: string } {
  const rows = [...input].sort((a, b) => b.runtimeSeconds - a.runtimeSeconds || a.email.localeCompare(b.email));
  const runtimeSeconds = rows.reduce((sum, row) => sum + row.runtimeSeconds, 0);
  const sessionCount = rows.reduce((sum, row) => sum + row.sessionCount, 0);
  const csv = ['email,runtime_seconds,session_count', ...rows.map((row) => `${csvField(row.email)},${row.runtimeSeconds},${row.sessionCount}`)].join('\r\n') + '\r\n';
  const top = rows.slice(0, 10).map((row) => `<tr><td>${escapeXml(row.email)}</td><td>${row.runtimeSeconds}</td><td>${row.sessionCount}</td></tr>`).join('');
  const html = `<h2>Codeflare usage for ${escapeXml(reportMonth)}</h2><p>${runtimeSeconds} runtime seconds across ${sessionCount} distinct sessions.</p><table><thead><tr><th>User</th><th>Runtime seconds</th><th>Sessions</th></tr></thead><tbody>${top}</tbody></table>`;
  return { html, csv };
}

export function scheduledDispatchId(settingsRevision: number, reportMonth: string): string {
  return `scheduled:${settingsRevision}:${reportMonth}`;
}

export function testDispatchId(requestId: string): string {
  return `test:${requestId}`;
}

export function reportIdempotencyKey(settingsRevision: number, reportMonth: string, recipient: string): string {
  return `usage-report:${settingsRevision}:${reportMonth}:${recipient.trim().toLowerCase()}`;
}
