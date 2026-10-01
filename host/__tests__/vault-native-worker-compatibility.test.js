import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_NATIVE_SERVICE_WORKER_JS as worker } from '../../src/routes/vault/native-sw.ts';

// Execute the shipped worker's message branches, including their closure-owned
// logout generation. No real storage, network, timer or browser is involved.
async function recover({ config = false, logout = false, expired = false } = {}) {
  const start = worker.indexOf('async function __cfRecover()');
  const end = worker.indexOf('catch(cfe){}}', start) + 'catch(cfe){}}'.length;
  const type = config ? 'config' : 'get-encryption-key';
  const messageStart = worker.indexOf(`case"${type}":{`);
  const messageEnd = config ? worker.indexOf('if(g.setSpacePrefixes', messageStart) : worker.indexOf('case"set-encryption-key"', messageStart);
  const message = worker.slice(messageStart, messageEnd) + (config ? 'return i;}' : '');
  const state = { active: false };
  const run = new Function('D', 'fetch', 'self', `let z,ne=0;D.expire=()=>{ne++};
    async function Kt(value){return value}async function $e(value){return value}
    ${worker.slice(start, end)}
    return async function(){let reply;let o={data:{type:"${type}",config:{}},source:{postMessage(value){reply=value.key}}};let e=o.data;
    switch(e.type){${message}}return reply;};`)(state, async () => ({
    ok: true, json: async () => {
      if (logout) state.active = true;
      if (expired) state.expire();
      return { key: 'RECOVERED-KEY' };
    },
  }), { registration: { scope: 'https://vault.test/' } });
  return run();
}

test('REQ-VAULT-017: vendored worker imports and served artifact parses', () => {
  assert.doesNotThrow(() => new Function(worker));
});

for (const config of [false, true]) {
  const name = config ? 'config' : 'query';
  test(`REQ-VAULT-017: ${name} consumes the recovered key`, async () => {
    assert.equal(await recover({ config }), 'RECOVERED-KEY');
  });
  test(`REQ-VAULT-017: ${name} rejects recovery interrupted by logout`, async () => {
    assert.equal(await recover({ config, logout: true }), undefined);
    assert.equal(await recover({ config, expired: true }), undefined);
  });
}
