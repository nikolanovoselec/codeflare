/**
 * Maps scroll progress to the governed session's elapsed time. The status
 * bar and the prompt-label timestamps both derive from this single mapping
 * so the page's clock can never disagree with itself.
 */
export function sessionClock(scrollProgress: number, totalMinutes = 47): string {
  const clamped = Math.min(1, Math.max(0, scrollProgress));
  const totalSeconds = Math.round(clamped * totalMinutes * 60);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
