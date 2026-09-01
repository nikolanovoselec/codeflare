import { describe, expect, it } from 'vitest';
import {
  environmentContext,
  executionOutcome,
  formatAdminTimestamp,
  operatorTaskLabel,
} from '../../components/admin/administration-presentation';
import type { ConfigurationSection } from '../../types';

const sections: ConfigurationSection[] = [
  'access', 'domain', 'aiRouting', 'codingAgents', 'browserRendering', 'securityEgress',
  'dataGovernance', 'managedEnvironment', 'github', 'cloudflareConnection', 'usageReports',
];

describe('Administration presentation', () => {
  it('uses operator language while preserving unknown task identifiers', () => {
    expect(operatorTaskLabel('configure_usage_reports')).toBe('Update monthly usage reports');
    expect(operatorTaskLabel('configure_model_routing')).toBe('Update model routing');
    expect(operatorTaskLabel('provider_task_added_later')).toBe('provider_task_added_later');
  });

  it('formats Activity timestamps in explicit UTC', () => {
    expect(formatAdminTimestamp('2026-09-01T19:42:00.000Z')).toBe('1 Sep 2026, 19:42 UTC');
  });

  it('provides concise local context for every bounded Environment section', () => {
    for (const section of sections) {
      expect(environmentContext(section)).toEqual({
        source: expect.any(String),
        operation: expect.any(String),
        effect: expect.any(String),
      });
    }
  });

  it('summarizes a successful persisted revision in operator language', () => {
    expect(executionOutcome('usageReports', 3)).toBe('Monthly usage reports updated. Revision 3 is active.');
  });
});
