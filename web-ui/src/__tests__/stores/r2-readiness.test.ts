import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerR2ReadinessDeps,
  startR2Polling,
  stopR2Polling,
  isR2Ready,
  _resetR2Ready,
} from '../../stores/r2-readiness';

describe('R2 Readiness Store', () => {
  const mockGetR2Status = vi.fn();
  const mockEnsureR2Token = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetR2Ready();
    registerR2ReadinessDeps({
      getR2Status: mockGetR2Status,
      ensureR2Token: mockEnsureR2Token,
    });
  });

  it('starts as not ready', () => {
    expect(isR2Ready()).toBe(false);
  });

  it('becomes ready immediately if ensureR2Token returns ready', async () => {
    mockEnsureR2Token.mockResolvedValue({ ready: true });

    await startR2Polling();

    expect(isR2Ready()).toBe(true);
    expect(mockGetR2Status).not.toHaveBeenCalled();
  });

  it('polls if ensureR2Token returns not ready', async () => {
    mockEnsureR2Token.mockResolvedValue({ ready: false });
    mockGetR2Status.mockResolvedValue({ ready: false });

    await startR2Polling();

    // checkR2Status called once eagerly
    expect(mockGetR2Status).toHaveBeenCalledTimes(1);
    expect(isR2Ready()).toBe(false);
  });

  it('stops polling when R2 becomes ready', async () => {
    mockEnsureR2Token.mockResolvedValue({ ready: false });
    mockGetR2Status
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValueOnce({ ready: true });

    await startR2Polling();

    // First check: not ready
    expect(isR2Ready()).toBe(false);

    // Advance timer to trigger second poll
    await vi.advanceTimersByTimeAsync(3000);

    expect(isR2Ready()).toBe(true);
  });

  it('handles ensureR2Token failure gracefully', async () => {
    mockEnsureR2Token.mockRejectedValue(new Error('Network error'));
    mockGetR2Status.mockResolvedValue({ ready: false });

    await startR2Polling();

    // Should fall through to polling
    expect(mockGetR2Status).toHaveBeenCalledTimes(1);
    expect(isR2Ready()).toBe(false);
  });

  it('handles getR2Status failure gracefully', async () => {
    mockEnsureR2Token.mockResolvedValue({ ready: false });
    mockGetR2Status.mockRejectedValue(new Error('Network error'));

    await startR2Polling();

    // Should not throw, still not ready
    expect(isR2Ready()).toBe(false);
  });

  it('does not start duplicate polling', async () => {
    mockEnsureR2Token.mockResolvedValue({ ready: false });
    mockGetR2Status.mockResolvedValue({ ready: false });

    await startR2Polling();
    await startR2Polling(); // duplicate call

    // Only one eager check
    expect(mockGetR2Status).toHaveBeenCalledTimes(1);
  });

  it('stopR2Polling clears the interval', async () => {
    mockEnsureR2Token.mockResolvedValue({ ready: false });
    mockGetR2Status.mockResolvedValue({ ready: false });

    await startR2Polling();
    stopR2Polling();

    // Advance timer — no new calls
    await vi.advanceTimersByTimeAsync(6000);
    // Only the initial eager call
    expect(mockGetR2Status).toHaveBeenCalledTimes(1);
  });
});
