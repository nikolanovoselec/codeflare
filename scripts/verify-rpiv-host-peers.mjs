import { resolve } from 'node:path';
import { patchRpivHostPeers } from './patch-rpiv-host-peers.mjs';
import { verifyRpivExtensionStartup } from './ci/smoke-openvscode-sidebar-image.mjs';

if (process.argv.length !== 3) throw new Error('usage: verify-rpiv-host-peers.mjs NODE_MODULES_ROOT');
const root = resolve(process.argv[2]);
await patchRpivHostPeers(root);
console.log(await verifyRpivExtensionStartup(root));
