/*
 * Authored browser-realm source injected into SilverBullet pages.
 *
 * These values are source strings deliberately: the Worker is bundled before it
 * renders HTML, so Function#toString would capture esbuild keepNames helpers
 * such as __name without their bundle-scope definitions. Dynamic values remain
 * arguments supplied as escaped JSON literals by vault-view.ts.
 */

export const VAULT_PREWARM_FOCUS_GUARD_SOURCE = String.raw`function (windowRef, documentRef, prewarmId) {
  try {
    function valid(value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
    }
    var resolvedPrewarmId = prewarmId;
    if (!valid(resolvedPrewarmId)) {
      var SearchParams = windowRef.URLSearchParams || URLSearchParams;
      var params = new SearchParams(windowRef.location ? windowRef.location.search : '');
      if (params.get('codeflarePrewarm') === '1') resolvedPrewarmId = params.get('prewarmId');
    }
    if (!valid(resolvedPrewarmId)) return false;
    windowRef.__codeflareVaultPrewarmNoFocus = true;
    var noop = function () {};
    function replace(proto, name) {
      try {
        if (proto && typeof proto[name] === 'function') {
          Object.defineProperty(proto, name, { configurable: true, writable: true, value: noop });
        }
      } catch (_) {}
    }
    replace(windowRef.HTMLElement && windowRef.HTMLElement.prototype, 'focus');
    replace(windowRef.SVGElement && windowRef.SVGElement.prototype, 'focus');
    replace(windowRef.HTMLInputElement && windowRef.HTMLInputElement.prototype, 'select');
    replace(windowRef.HTMLTextAreaElement && windowRef.HTMLTextAreaElement.prototype, 'select');
    try { windowRef.focus = noop; } catch (_) {}
    if (documentRef && typeof documentRef.addEventListener === 'function') {
      documentRef.addEventListener('focusin', function (event) {
        try {
          var target = event.target;
          if (target && typeof target.blur === 'function') target.blur();
        } catch (_) {}
      }, true);
    }
    return true;
  } catch (_) {
    return false;
  }
}`;

export const VAULT_PREWARM_BRIDGE_SOURCE = String.raw`function (windowRef, documentRef, navigatorRef, fetchRef, suppliedPrewarmId, requiredFiles) {
  var prewarmId = suppliedPrewarmId;
  var expectedScope;
  var spaceSyncCompleted = false;
  try {
    if (!prewarmId) {
      var params = new URLSearchParams(windowRef.location.search);
      if (params.get('codeflarePrewarm') === '1') prewarmId = params.get('prewarmId');
    }
    if (!prewarmId || prewarmId.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(prewarmId)) return;
    expectedScope = new URL('.', documentRef.baseURI).href;
    var expected = new URL(expectedScope);
    if (expected.origin !== windowRef.location.origin || !/^\/api\/vault\/[0-9a-f]{32}\/$/.test(expected.pathname)) return;
    windowRef.sbRuntime = windowRef.sbRuntime || {};
    windowRef.sbRuntime.headless = true;
  } catch (_) {
    return;
  }

  function post(status, message, proof) {
    if (!windowRef.parent || windowRef.parent === windowRef) return;
    var payload = { source: 'codeflare-vault-prewarm', prewarmId: prewarmId, status: status };
    if (message) payload.message = message;
    if (proof) payload.proof = proof;
    windowRef.parent.postMessage(payload, windowRef.location.origin);
  }
  var serviceWorker = navigatorRef.serviceWorker;
  if (serviceWorker && typeof serviceWorker.addEventListener === 'function') {
    serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'space-sync-complete') spaceSyncCompleted = true;
    });
  }

  async function buildContentProof() {
    try {
      var client = windowRef.client;
      if (!spaceSyncCompleted && (!client || client.fullSyncCompleted !== true)) return null;
      if (!client || client.systemReady !== true || client.pageListLoaded !== true) return null;
      if (!client.clientSystem || client.clientSystem.scriptsLoaded !== true) return null;
      if (!client.objectIndex || typeof client.objectIndex.hasFullIndexCompleted !== 'function') return null;
      if (client.mq && typeof client.mq.getQueueStats === 'function') {
        var stats = await client.mq.getQueueStats('indexQueue');
        if (!stats || stats.queued !== 0 || stats.processing !== 0 || stats.dlq !== 0) return null;
      } else if (client.mq && typeof client.mq.isQueueEmpty === 'function'
        && !(await client.mq.isQueueEmpty('indexQueue'))) return null;
      if (!(await client.objectIndex.hasFullIndexCompleted())) return null;
      var response = await fetchRef('.fs/', { cache: 'no-store' });
      if (!response || !response.ok) return null;
      var listing = await response.json();
      if (!Array.isArray(listing)) return null;
      var names = new Set(listing.map(function (entry) { return entry && entry.name; }).filter(function (name) { return typeof name === 'string'; }));
      if (requiredFiles.some(function (name) { return !names.has(name); })) return null;
      return {
        scope: expectedScope,
        contentReady: true,
        spaceSyncCompleted: true,
        indexReady: true,
        requiredFiles: requiredFiles.slice(),
        listedFileCount: listing.length
      };
    } catch (_) {
      return null;
    }
  }

  var inFlight = false;
  var readyStreak = 0;
  var requiredReadyStreak = 2;
  var timer = windowRef.setInterval(async function () {
    if (inFlight) return;
    inFlight = true;
    try {
      var proof = windowRef.sbRuntime && windowRef.sbRuntime.ready === true ? await buildContentProof() : null;
      readyStreak = proof ? readyStreak + 1 : 0;
      if (proof && readyStreak >= requiredReadyStreak) {
        windowRef.clearInterval(timer);
        post('ready', undefined, proof);
      }
    } catch (error) {
      windowRef.clearInterval(timer);
      post('error', error instanceof Error ? error.message : String(error));
    } finally {
      inFlight = false;
    }
  }, 250);
}`;

export const VAULT_CONTROLLED_RELOAD_SOURCE = String.raw`function (windowRef, navigatorRef, storageRef) {
  try {
    if (windowRef.parent !== windowRef) return;
    var sw = navigatorRef && navigatorRef.serviceWorker;
    if (!sw) return;
    var expectedScope = new URL('.', windowRef.document.baseURI).href;
    var expectedUrl = new URL(expectedScope);
    if (expectedUrl.origin !== windowRef.location.origin
      || !/^\/api\/vault\/[0-9a-f]{32}\/$/.test(expectedUrl.pathname)) return;
    var expectedScript = new URL('service_worker.js', expectedScope).href;
    function controlsCurrentScope() {
      return !!(sw.controller && sw.controller.scriptURL === expectedScript);
    }
    var key = 'cf-vault-sw-controlled-reload';
    if (controlsCurrentScope()) {
      try { if (storageRef) storageRef.removeItem(key); } catch (_) {}
      return;
    }
    sw.getRegistration(expectedScope).then(function (registration) {
      if (controlsCurrentScope()) return;
      if (!registration || registration.scope !== expectedScope || !registration.active) return;
      var already = false;
      try { already = !!(storageRef && storageRef.getItem(key) === '1'); } catch (_) {}
      if (already) return;
      try { if (storageRef) storageRef.setItem(key, '1'); } catch (_) {}
      windowRef.location.reload();
    }).catch(function () {});
  } catch (_) {}
}`;

export const VAULT_UNREGISTER_STALE_WORKERS_SOURCE = String.raw`async function (serviceWorkerRef, expectedScope) {
  if (!serviceWorkerRef || typeof serviceWorkerRef.getRegistrations !== 'function') {
    throw new Error('service worker registration enumeration is unavailable');
  }
  var expected = new URL(expectedScope);
  function isStaleVaultScope(scopeValue) {
    if (typeof scopeValue !== 'string' || scopeValue === expected.href) return false;
    try {
      var scopeUrl = new URL(scopeValue);
      return scopeUrl.origin === expected.origin && scopeUrl.pathname.startsWith('/api/vault/');
    } catch (_) {
      return false;
    }
  }
  var registrations = await serviceWorkerRef.getRegistrations();
  var stale = registrations.filter(function (registration) { return isStaleVaultScope(registration && registration.scope); });
  await Promise.all(stale.map(function (registration) { return registration.unregister(); }));
  var remaining = await serviceWorkerRef.getRegistrations();
  if (remaining.some(function (registration) { return isStaleVaultScope(registration && registration.scope); })) {
    throw new Error('stale Vault service worker remains after unregister');
  }
  return stale.length;
}`;

export const VAULT_REGISTER_CANONICAL_WORKER_SOURCE = String.raw`async function (serviceWorkerRef, scope, expectedScope, unregisterRef) {
  await unregisterRef(serviceWorkerRef, expectedScope);
  return serviceWorkerRef.register(scope + 'service_worker.js', { scope: scope });
}`;

export const VAULT_COMPLETE_BOOTSTRAP_SOURCE = String.raw`function (storageRef, documentRef, locationRef, cookieName, scope, redirectSearch) {
  storageRef.setItem('enableEncryption', 'true');
  documentRef.cookie = cookieName + '=1; Path=' + scope + '; SameSite=Lax; Secure';
  locationRef.replace(scope + redirectSearch);
}`;
