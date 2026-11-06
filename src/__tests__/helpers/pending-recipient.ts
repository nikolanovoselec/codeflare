/** External recipient seam: the real interceptor/Activity remains the system under test. */
export function pendingRecipient(ignoreAbort = false) {
  let enter!: (request: Request) => void;
  const entered = new Promise<Request>(resolve => { enter = resolve; });
  const settlers = new Set<(response: Response) => void>();
  let released: Response | undefined;
  let observedAbort = false;
  const activeUrls: string[] = [];
  const fetch = (request: Request): Promise<Response> => new Promise((resolve, reject) => {
    const cleanup = () => { request.signal.removeEventListener('abort', abort); settlers.delete(settle); };
    const abort = () => {
      observedAbort = true;
      if (!ignoreAbort) { cleanup(); reject(new DOMException('Recipient cancelled', 'AbortError')); }
    };
    const settle = (response: Response) => { cleanup(); resolve(response); };
    settlers.add(settle);
    request.signal.addEventListener('abort', abort, { once: true });
    enter(request);
    if (request.signal.aborted) abort();
    else activeUrls.push(request.url);
    if (released) settle(released.clone());
  });
  return { fetch, entered, activeUrls, aborted: () => observedAbort,
    release: (response = new Response('late-recipient-response')) => {
      released = response; for (const settle of settlers) settle(response.clone());
    } };
}

/** Fail with a bounded behavioral/setup diagnostic, not an unhandled suite timeout. */
export async function within<T>(promise: Promise<T>, label: string, milliseconds = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Bounded wait expired: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
