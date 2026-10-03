import { resolve } from 'node:path';
import { patchRpivHostPeers } from './patch-rpiv-host-peers.mjs';
import { verifyRpivExtensionStartup } from './ci/smoke-openvscode-sidebar-image.mjs';

if (process.argv.length < 3 || process.argv.length > 4) throw new Error('usage: verify-rpiv-host-peers.mjs EXTENSION_NODE_MODULES_ROOT [SDK_NODE_MODULES_ROOT]');
const root = resolve(process.argv[2]);
await patchRpivHostPeers(root);
console.log(await verifyRpivExtensionStartup(root, process.argv[3] ? resolve(process.argv[3]) : root));
