import { lstatSync, opendirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const roots = [
  '/opt/codeflare/jiti-cache', '/root/.cache/node-compile-cache', '/root/.cache/uv',
  '/root/.local/share/uv/tools/graphifyy', '/opt/codeflare/npm-tools/node_modules',
  '/opt/codeflare/pi-agent/npm/node_modules', '/opt/codeflare/impeccable', '/opt/code-server',
  '/opt/codeflare/openvscode',
  '/opt/codeflare/jiti-warm-tmp', '/tmp/code-server.tar.gz', '/tmp/node-tar.tgz',
  '/tmp/pacote.tgz', '/tmp/uv-x86_64-unknown-linux-gnu.tar.gz',
  '/tmp/uv-x86_64-unknown-linux-gnu', '/tmp/impeccable.tar.gz',
  '/usr/local/share/codeflare-brace-expansion.tgz', '/tmp/undici-npm.tgz', '/tmp/undici-ide.tgz',
  '/tmp/agy.tar.gz', '/tmp/agy', '/tmp/yazi.zip', '/tmp/yazi', '/tmp/zoxide.tar.gz',
  '/tmp/silverbullet.zip', '/tmp/silverbullet', '/tmp/gh.deb', '/tmp/herdr',
];
const empty = () => ({ entries: 0, apparentBytes: 0, uniqueApparentBytes: 0, allocatedBytes: 0 });
const integer = n => { if (!Number.isSafeInteger(n) || n < 0) throw Error('invalid measurement'); return n; };
const add = (a, b) => integer(a + b);

// Metadata only: no file reads, package imports, symlink traversal, or live-home discovery.
// Package buckets own their complete subtree (including nested dependencies), not just package files.
export function inventory(paths = roots, { maxEntries = 1000000, maxDepth = 80, maxMillis = 120000, maxBuckets = 4096 } = {}) {
  [maxEntries, maxDepth, maxMillis, maxBuckets].forEach(integer);
  const started = Date.now(), selectedSeen = new Set(), selected = empty();
  let visited = 0;
  const measurements = paths.map(path => {
    const totals = empty(), seen = new Set(), buckets = new Map();
    let status = 'available', incomplete = false, reason = null;
    const bucketSeen = new Map();
    function count(stat, target, inodes) {
      const key = `${stat.dev}:${stat.ino}`;
      target.entries++;
      target.apparentBytes = add(target.apparentBytes, integer(stat.size));
      if (!inodes.has(key)) {
        inodes.add(key);
        target.uniqueApparentBytes = add(target.uniqueApparentBytes, stat.size);
        target.allocatedBytes = add(target.allocatedBytes, integer(stat.blocks) * 512);
      }
    }
    function walk(file, depth, bucket = '') {
      if (visited >= maxEntries || depth > maxDepth || Date.now() - started >= maxMillis) {
        incomplete = true; reason = 'bound'; return;
      }
      const stat = lstatSync(file); visited++;
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw Error('unsupported inode');
      count(stat, totals, seen); count(stat, selected, selectedSeen);
      if (bucket) {
        if (!buckets.has(bucket) && buckets.size >= maxBuckets) { incomplete = true; reason = 'bound'; return; }
        if (!buckets.has(bucket)) { buckets.set(bucket, empty()); bucketSeen.set(bucket, new Set()); }
        count(stat, buckets.get(bucket), bucketSeen.get(bucket));
        if (bucket.endsWith('/binary')) {
          const parent = bucket.slice(0, -7); count(stat, buckets.get(parent), bucketSeen.get(parent));
        }
      }
      if (!stat.isDirectory()) return;
      // Streaming enumeration bounds memory even if a directory has millions of entries.
      const directory = opendirSync(file);
      try {
        let entry;
        while (!incomplete && (entry = directory.readSync())) {
          let next = bucket;
          if (path.endsWith('/node_modules') && (depth === 0 || (depth === 1 && bucket.startsWith('@')))) {
            if (!/^(?:@?[a-zA-Z0-9][a-zA-Z0-9._-]*)$/.test(entry.name)) next = '(other)';
            else next = depth === 0 ? entry.name : `${bucket}/${entry.name}`;
          } else if (path === '/root/.local/share/uv/tools/graphifyy' && file.endsWith('/site-packages')) {
            next = /^[a-zA-Z0-9_.-]+$/.test(entry.name) ? `site-packages/${entry.name}` : '(other)';
          } else if (path === '/opt/codeflare/impeccable' && depth <= 1) {
            next = /^\d+\.\d+\.\d+$/.test(entry.name) && depth === 0 ? entry.name
              : depth === 1 && entry.name === 'impeccable' ? `${bucket}/binary` : bucket;
          }
          walk(join(file, entry.name), depth + 1, next);
        }
      } finally { directory.closeSync(); }
    }
    try {
      for (let ancestor = dirname(path); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
        if (lstatSync(ancestor).isSymbolicLink()) throw Error('symlink ancestor');
      }
      walk(path, 0);
    } catch (error) {
      status = 'unavailable'; incomplete = true;
      reason = error.code === 'ENOENT' && totals.entries === 0 ? 'missing' : 'measurement-error';
    }
    const finish = value => ({ ...value, hardlinkDuplicateBytes: value.apparentBytes - value.uniqueApparentBytes });
    return { path, status, incomplete, reason, bytes: status === 'available' ? finish(totals) : null,
      buckets: [...buckets].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes]) => ({ name, ...finish(bytes) })) };
  });
  return { schema: 1, semantics: 'lstat apparent bytes include every name; allocated bytes count unique dev/inode; symlinks are not followed; allocated bytes describe the ephemeral CI rootfs, not Cloudflare peak; selected allocated and unique-apparent totals deduplicate inodes across roots',
    bounds: { maxEntries, maxDepth, maxMillis, maxBuckets }, incomplete: measurements.some(m => m.incomplete),
    selectedRoots: { ...selected, hardlinkDuplicateBytes: selected.apparentBytes - selected.uniqueApparentBytes }, measurements };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = inventory();
  console.log(JSON.stringify(result));
  if (result.measurements.some(m => m.incomplete && m.reason !== 'missing')) process.exitCode = 1;
}
