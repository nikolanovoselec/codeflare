import { getUsageState } from '../stores/session';
import { formatDuration } from '../lib/format';

/** Inline usage badge for dropdown menus (shared between Header and Dashboard). */
const UsageInlineBadge = () => {
  const usage = getUsageState();
  if (usage.monthlyQuotaSeconds !== null) {
    return <span class="header-usage-inline">{formatDuration(usage.monthlySeconds)} / {formatDuration(usage.monthlyQuotaSeconds)}</span>;
  }
  if (usage.monthlySeconds > 0) {
    return <span class="header-usage-inline">{formatDuration(usage.monthlySeconds)}</span>;
  }
  return null;
};

export default UsageInlineBadge;
