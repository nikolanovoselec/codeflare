import type { DeployKeys, Env } from '../types';
import { decryptFromKV, encryptForKV, getOrImportKey } from './kv-crypto';
import { getDeployKeysKey } from './kv-keys';
import { deployKeyOwnerEpoch } from './mcp-portal-state';

export type DeployKeyScope = 'github' | 'cloudflare' | 'both' | 'cloudflare-account';
export interface DeployKeyFence {
  revision: string;
  github: string;
  cloudflare: string;
  epoch: string;
}
export interface DeployKeySnapshot extends DeployKeyFence {
  keys: DeployKeys | null;
}
interface StoredDeployKeys {
  revision: string;
  github: string;
  cloudflare: string;
  reset: string;
  sealed: string | null;
}

const RECORD = 'deploy-keys';

/** Authoritative record in the verified bucket-owner DO; KV is a one-time import only. */
export class DeployKeyState {
  private readonly key: string;

  constructor(private readonly env: Env, private readonly storage: DurableObjectStorage, bucket: string,
    private readonly cleanupId?: string) {
    this.key = getDeployKeysKey(bucket);
  }

  private async decode(sealed: string | null, key: CryptoKey | null): Promise<DeployKeys | null> {
    if (sealed === null) return null;
    if (sealed.startsWith('v1:') && !key) throw new Error('Deploy credential encryption key unavailable');
    try {
      const value: unknown = JSON.parse(sealed.startsWith('v1:') && key
        ? await decryptFromKV(sealed.slice(3), key, this.key) : sealed);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as DeployKeys;
    } catch { /* Do not propagate parser diagnostics that might contain credential text. */ }
    throw new Error('Invalid deploy credentials');
  }

  private async encode(keys: DeployKeys | null): Promise<string | null> {
    if (keys === null) return null;
    const key = await getOrImportKey(this.env);
    const json = JSON.stringify(keys);
    return key ? encryptForKV(json, key, this.key) : json;
  }

  private async importLegacy(ownerEpoch: string): Promise<StoredDeployKeys> {
    const raw = await this.env.KV.get(this.key, 'text');
    const key = raw && !raw.startsWith('v1:') ? await getOrImportKey(this.env) : null;
    const sealed = raw && key ? await encryptForKV(raw, key, this.key) : raw;
    const initialId = crypto.randomUUID();
    const imported = await this.storage.transaction(async txn => {
      if (await deployKeyOwnerEpoch(txn, this.cleanupId) !== ownerEpoch) return null;
      const saved = await txn.get<StoredDeployKeys>(RECORD);
      if (saved) return saved;
      const initial = { revision: initialId, github: initialId, cloudflare: initialId, reset: initialId, sealed };
      await txn.put(RECORD, initial);
      return initial;
    });
    if (!imported) throw new Error('Deploy credentials unavailable during offboarding');
    return imported;
  }

  async read(): Promise<DeployKeySnapshot> {
    const { ownerEpoch, saved } = await this.storage.transaction(async txn => ({
      ownerEpoch: await deployKeyOwnerEpoch(txn, this.cleanupId),
      saved: await txn.get<StoredDeployKeys>(RECORD),
    }));
    if (!ownerEpoch) throw new Error('Deploy credentials unavailable during offboarding');
    const record = saved ?? await this.importLegacy(ownerEpoch);
    const key = record.sealed === null ? null : await getOrImportKey(this.env);
    const keys = await this.decode(record.sealed, key);
    if (key && record.sealed !== null && !record.sealed.startsWith('v1:')) {
      // Preserve the AD32 plaintext-to-encrypted upgrade, but never write an
      // older plaintext snapshot over an intervening replacement or reset.
      const sealed = await encryptForKV(record.sealed, key, this.key);
      await this.storage.transaction(async txn => {
        if (await deployKeyOwnerEpoch(txn, this.cleanupId) !== ownerEpoch) return;
        const current = await txn.get<StoredDeployKeys>(RECORD);
        if (current?.revision === record.revision && current.sealed === record.sealed) {
          await txn.put(RECORD, { ...current, sealed });
        }
      });
    }
    return { revision: record.revision, github: record.github, cloudflare: record.cloudflare,
      epoch: `${ownerEpoch}:${record.reset}`, keys };
  }

  async compare(expected: DeployKeyFence, scope: DeployKeyScope, keys: DeployKeys | null): Promise<boolean> {
    if (!expected || typeof expected.revision !== 'string' || typeof expected.epoch !== 'string'
      || !['github', 'cloudflare', 'both', 'cloudflare-account'].includes(scope)
      || (keys !== null && (!keys || typeof keys !== 'object' || Array.isArray(keys)))) {
      throw new Error('Invalid deploy credential update');
    }
    // A successful read already initialized the authoritative record. Never
    // reload credentials from KV in the commit path, even after an eviction.
    const sealed = await this.encode(keys);
    const revision = crypto.randomUUID();
    return this.storage.transaction(async txn => {
      const ownerEpoch = await deployKeyOwnerEpoch(txn, this.cleanupId);
      const record = await txn.get<StoredDeployKeys>(RECORD);
      if (!ownerEpoch || !record || `${ownerEpoch}:${record.reset}` !== expected.epoch || record.revision !== expected.revision) return false;
      await txn.put(RECORD, {
        ...record, sealed, revision,
        github: scope === 'github' || scope === 'both' ? revision : record.github,
        cloudflare: scope === 'cloudflare' || scope === 'both' ? revision : record.cloudflare,
      } satisfies StoredDeployKeys);
      return true;
    });
  }

  async reset(): Promise<void> {
    const cleared = await this.storage.transaction(async txn => {
      if (!await deployKeyOwnerEpoch(txn, this.cleanupId)) return false;
      const revision = crypto.randomUUID();
      await txn.put(RECORD, { sealed: null, revision, github: revision, cloudflare: revision, reset: revision } satisfies StoredDeployKeys);
      return true;
    });
    if (!cleared) throw new Error('Deploy credentials unavailable during offboarding');
    await this.env.KV.delete(this.key);
  }
}
