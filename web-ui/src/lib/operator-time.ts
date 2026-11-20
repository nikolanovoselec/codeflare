import { sessionStore } from '../stores/session';

type Timestamp = Date | number | string;
const date = (value: Timestamp) => value instanceof Date ? value : new Date(value);

/** Operator labels follow browser regional preferences and the saved IANA zone. */
export function formatOperatorTimestamp(value: Timestamp): string {
  return date(value).toLocaleString(navigator.languages.slice(), {
    timeZone: sessionStore.preferences.userTimezone,
  });
}

export function formatOperatorTime(value: Timestamp): string {
  return date(value).toLocaleTimeString(navigator.languages.slice(), {
    timeZone: sessionStore.preferences.userTimezone,
  });
}
