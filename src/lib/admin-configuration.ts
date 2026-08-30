import type { Env } from '../types';
import { isOnboardingLandingPageActive, isSaasModeActive } from './onboarding';
import { isEnterpriseMode } from './subscription';

export const CONFIGURATION_SECTIONS = [
  'access',
  'domain',
  'aiRouting',
  'codingAgents',
  'browserRendering',
  'securityEgress',
  'dataGovernance',
  'managedEnvironment',
  'github',
  'cloudflareConnection',
  'usageReports',
] as const;

export type ConfigurationSection = typeof CONFIGURATION_SECTIONS[number];
export type AdministrationMode = 'default' | 'onboarding' | 'saas' | 'enterprise';

const COMMON_SECTIONS: ConfigurationSection[] = [
  'access',
  'domain',
  'managedEnvironment',
  'github',
  'cloudflareConnection',
  'usageReports',
];

const ENTERPRISE_SECTIONS: ConfigurationSection[] = [
  'access',
  'domain',
  'aiRouting',
  'codingAgents',
  'browserRendering',
  'securityEgress',
  'dataGovernance',
  'managedEnvironment',
  'github',
  'usageReports',
];

export function resolveAdministrationMode(env: Env): AdministrationMode {
  if (isEnterpriseMode(env)) return 'enterprise';
  if (isSaasModeActive(env.SAAS_MODE)) return 'saas';
  if (isOnboardingLandingPageActive(env.ONBOARDING_LANDING_PAGE)) return 'onboarding';
  return 'default';
}

export function applicableConfigurationSections(mode: AdministrationMode): ConfigurationSection[] {
  return [...(mode === 'enterprise' ? ENTERPRISE_SECTIONS : COMMON_SECTIONS)];
}
