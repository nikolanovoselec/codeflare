/**
 * Coding-agent statusline footer: a slow, calm idle animation on the hero
 * terminal foot so the page feels alive without churning. The context percent
 * ticks up slowly, and now and then a compaction beat tints the reasoning
 * segment for a couple of seconds before it settles back.
 *
 * Reduced motion: do nothing. The server-rendered foot is the resolved state
 * (context 18% / opus-4.8 / reasoning high), fully legible and still. No JS, no
 * change: the static foot is correct on its own.
 */
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  for (const foot of document.querySelectorAll<HTMLElement>('[data-agentfoot]')) {
    const ctxEl = foot.querySelector<HTMLElement>('[data-tf-ctx]');
    const reasonEl = foot.querySelector<HTMLElement>('[data-tf-reason]');
    const baseReason = reasonEl?.textContent ?? 'reasoning high';
    let pct = 18;

    // Slow context tick: +1 roughly every 3.6s, wrapping inside a realistic band
    // so it never reads as a progress bar racing to 100.
    setInterval(() => {
      pct = pct >= 41 ? 12 : pct + 1;
      if (ctxEl) ctxEl.textContent = `context ${pct}%`;
    }, 3600);

    // Occasional compaction beat: about every 24s, held ~2.8s, then it settles.
    setInterval(() => {
      if (!reasonEl) return;
      foot.classList.add('is-compacting');
      reasonEl.textContent = '⟳ compacting…';
      setTimeout(() => {
        foot.classList.remove('is-compacting');
        reasonEl.textContent = baseReason;
      }, 2800);
    }, 24000);
  }
}
