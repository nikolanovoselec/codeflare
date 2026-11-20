import { describe, expect, it } from 'vitest';
import { applicationSchedule, applicationSetting, applicationWriteRepositories } from '../../operators/application-configuration';
import type { OperatorApplicationDefinition } from '../../operators/distribution';

const definition: OperatorApplicationDefinition = {
  controlVersion: 1,
  configurationSchema: { type: 'object', properties: {
    delivery: { type: 'object', properties: {
      enabled: { type: 'boolean', default: false }, period: { type: 'integer', default: 300 },
    } },
    'project/name': { type: 'string', default: 'sample' },
  } },
  schedule: { enabledPath: '/delivery/enabled', intervalSecondsPath: '/delivery/period' },
};

describe('application-owned configuration with generic runtime scheduling', () => {
  it('REQ-OPERATOR-014: resolves mutation resources only from a declared saved configuration path', () => {
    const scoped = { ...definition, githubWriteRepositoriesPath: '/resources' };
    expect(applicationWriteRepositories(scoped, { resources: ['Owner/Repo', 'owner/repo'] })).toEqual(['owner/repo']);
    expect(applicationWriteRepositories(definition, { resources: 'owner/repo' })).toEqual([]);
    for (const resources of [undefined, ['owner/repo', '../other'], '*', 'owner/../other', 'https://example.test']) {
      expect(applicationWriteRepositories(scoped, { resources })).toEqual([]);
    }
  });

  it('REQ-OPERATOR-061: reads package defaults without writing or enabling an undeclared schedule', () => {
    const configuration = { unrelated: ['preserved'] };
    expect(applicationSchedule(definition, configuration)).toEqual({ automaticRuns: false, repetitionIntervalSeconds: 300 });
    expect(configuration).toEqual({ unrelated: ['preserved'] });
    expect(applicationSchedule(undefined, configuration)).toBeNull();
    expect(applicationSchedule({ controlVersion: 1 }, configuration)).toBeNull();
  });

  it('REQ-OPERATOR-061: uses the same saved configuration independently of manual or timer delivery', () => {
    const configuration = { delivery: { enabled: true, period: 127 }, unrelated: ['preserved'] };
    expect(applicationSchedule(definition, configuration)).toEqual({ automaticRuns: true, repetitionIntervalSeconds: 127 });
    expect(applicationSchedule(definition, { ...configuration, delivery: { ...configuration.delivery, enabled: false } }))
      .toEqual({ automaticRuns: false, repetitionIntervalSeconds: 127 });
    expect(configuration.delivery.enabled).toBe(true);
  });

  it.each([0, -1, 1.5, '300', null, Number.MAX_SAFE_INTEGER])(
    'REQ-OPERATOR-061: invalid interval %s cannot arm a schedule', period => {
      expect(applicationSchedule(definition, { delivery: { enabled: true, period } })).toBeNull();
    },
  );

  it('REQ-OPERATOR-014: reads escaped own keys but never inherits configuration or schema properties', () => {
    expect(applicationSetting(definition, { 'project/name': 'configured' }, '/project~1name')).toBe('configured');
    const inherited = Object.create({ delivery: { enabled: true, period: 1 } });
    expect(applicationSchedule(definition, inherited)).toEqual({ automaticRuns: false, repetitionIntervalSeconds: 300 });
    expect(applicationSetting(definition, {}, '/constructor/prototype')).toBeUndefined();
  });
});
