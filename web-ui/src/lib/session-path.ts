const SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/;
const SESSION_PATH_PATTERN = /^\/app\/session\/([a-z0-9]{8,24})$/;

export function sessionPath(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
  return `/app/session/${encodeURIComponent(sessionId)}`;
}

export function parseSessionPath(pathname: string): string | undefined {
  return SESSION_PATH_PATTERN.exec(pathname)?.[1];
}

export function dashboardPath(): string {
  return '/app/';
}
