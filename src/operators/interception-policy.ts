/**
 * Shared operator restriction decisions for direct Worker and container transports.
 *
 * Navigation: normalized destination matching, specialized GitHub authorization,
 * and storage operation authorization. Inputs are already parent-bound policy and
 * canonical transport facts; no caller identity, credential lookup or forwarding
 * occurs here. Empty declarations deny and these decisions never grant human access.
 */
import type { OperatorPolicy } from './policy';

export type OperatorPolicyDecision = { allowed: true } | { allowed: false; reason: string };
const allow = (): OperatorPolicyDecision => ({ allowed: true });
const deny = (reason: string): OperatorPolicyDecision => ({ allowed: false, reason });
const STANDARD_SPECIALIZED_HOSTS = new Set(['github.com', 'api.github.com', 'api.githubcopilot.com',
  'raw.githubusercontent.com', 'objects.githubusercontent.com']);

function canonicalHostname(value: string): string | null {
  if (value !== value.toLowerCase() || value.endsWith('.') || value.length > 253) return null;
  if (/^[\d.]+$/.test(value) || value.includes(':')) return null;
  return value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? value : null;
}
function matchesHost(rule: string, host: string): boolean {
  if (!rule.startsWith('*.')) return rule === host;
  const suffix = rule.slice(2);
  return host !== suffix && host.endsWith(`.${suffix}`);
}

/** General Internet decision; specialized GitHub/storage/inference destinations never fall through. */
export function decideOperatorNetwork(policy: OperatorPolicy, hostname: string,
  specializedHosts: readonly string[] = [...STANDARD_SPECIALIZED_HOSTS]): OperatorPolicyDecision {
  const host = canonicalHostname(hostname);
  if (!host) return deny('invalid-host');
  if ([...STANDARD_SPECIALIZED_HOSTS, ...specializedHosts].some(value => value.toLowerCase() === host)) {
    return deny('specialized-destination');
  }
  return policy.networkHosts.some(rule => matchesHost(rule, host)) ? allow() : deny('host-not-allowed');
}

function githubRepository(request: Request, hosts: { apiHost: string; webHost: string }): string | null {
  const url = new URL(request.url);
  const host = canonicalHostname(url.hostname);
  let parts: string[];
  try { parts = decodeURIComponent(url.pathname).split('/').filter(Boolean); } catch { return null; }
  if (parts.some(part => part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) return null;
  if (host === hosts.apiHost.toLowerCase()) {
    if (parts[0] !== 'repos' || parts.length < 3) return null;
    return `${parts[1]}/${parts[2]}`.toLowerCase();
  }
  if (host === hosts.webHost.toLowerCase()) {
    if (parts.length < 3 || !parts[1].endsWith('.git')) return null;
    return `${parts[0]}/${parts[1].slice(0, -4)}`.toLowerCase();
  }
  return null;
}

/** Repository/method decision made before a GitHub credential can be resolved. */
export function decideOperatorGithub(policy: OperatorPolicy, request: Request,
  hosts: { apiHost: string; webHost: string } = { apiHost: 'api.github.com', webHost: 'github.com' }): OperatorPolicyDecision {
  const repository = githubRepository(request, hosts);
  if (!repository) return deny('repository-unresolved');
  if (!policy.github.methods.includes(request.method.toUpperCase())) return deny('method-not-allowed');
  return policy.github.repositories.includes(repository) ? allow() : deny('repository-not-allowed');
}

export type OperatorStorageOperation = 'read' | 'list' | 'write' | 'multipart-write'
  | 'multipart-abort' | 'copy' | 'delete' | 'control';

function canonicalStoragePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.includes('\\')
    && !path.includes('\0') && !path.includes('//')
    && path.split('/').every((part, index, all) => part !== '.' && part !== '..' && (part.length > 0 || index === all.length - 1));
}
function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => path.startsWith(prefix));
}

/** Owner-relative canonical path decision; bucket and operation identity remain parent-bound. */
export function decideOperatorStorage(policy: OperatorPolicy, operation: OperatorStorageOperation,
  path: string, ownedMultipart = false): OperatorPolicyDecision {
  if (!canonicalStoragePath(path)) return deny('invalid-path');
  if (operation === 'read' || operation === 'list') {
    return matchesPrefix(path, policy.storage.readPrefixes) ? allow() : deny('read-not-allowed');
  }
  if (operation === 'write' || operation === 'multipart-write') {
    return matchesPrefix(path, policy.storage.writePrefixes) ? allow() : deny('write-not-allowed');
  }
  if (operation === 'multipart-abort') {
    return ownedMultipart && matchesPrefix(path, policy.storage.writePrefixes) ? allow() : deny('abort-not-owned');
  }
  return deny('operation-not-allowed');
}
