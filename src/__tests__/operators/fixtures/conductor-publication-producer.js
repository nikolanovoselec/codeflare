// Test-only external parent transport. All Review validation/history/presentation
// comes from the unchanged immutable artifact's entrypoint and imported modules.
import producer from './index.js';
const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const base64 = value => btoa(String.fromCharCode(...value));
const finding = { id: 'code-reviewer-guard', severity: 'HIGH', path: 'src/guard.ts', line: 12,
  message: 'Authorization check missing', evidence: 'A caller reaches the write before the guard.' };

export default { async fetch(request) {
  const { mode, previous = null, round = 2 } = await request.json();
  const head = (round === 1 ? 'a' : 'b').repeat(40), base = 'c'.repeat(40), mergeBase = 'd'.repeat(40);
  const activityId = `producer-round-${round}`;
  const boundary = { activityId, generation: round, workflowId: 531, runId: 87 + round, runAttempt: 1,
    commentAuthorId: 777, checkAppId: 888, inputDigest: '1'.repeat(64), packageDigest: 'e'.repeat(64),
    resourceDigest: '2'.repeat(64), policyDigest: '3'.repeat(64) };
  const context = { repositoryId: 138, pullRequest: 34, head, base, mergeBase };
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews', activityId,
    operatorId: 'review-operator', runId: activityId, source: { kind: 'session', reference: 'owner/repo' },
    revision: { reference: head, digest: 'f'.repeat(64) }, inputDigest: boundary.inputDigest,
    input: { context, boundary, acknowledgedHead: null }, attachments: [],
    resources: { inference: null, session: { profileId: 'review-profile' }, storage: null } };
  const objects = new Map();
  let checkpoint = null, packetDigest;
  const parent = { async fetch(req) {
    const path = new URL(req.url).pathname, body = await req.json();
    if (path === '/v1/packets/prepare') {
      const lane = body.lane;
      const evidence = { lane, callSites: [], anchorsCitingChanged: [], indexIntegrity: {},
        dependencyGraph: {}, anchors: [], references: [], docsCitingChanged: [] };
      const packet = bytes({ scope: 'all', workSet: 'whole-requested-tree', lane, files: [],
        changedInputs: [], patch: '', evidence });
      return Response.json({ preparationId: body.preparationId, bytes: base64(packet), attachment: {
        name: `packet-${lane}.json`, locator: `packet-${lane}`, mediaType: 'application/json',
        size: packet.length, sha256: await hash(packet) } });
    }
    if (path === '/v1/session/ensure') return Response.json({ status: 'ready' });
    if (path === '/v1/session/stop') return Response.json({ status: 'stopped' });
    if (path === '/v1/storage/restore') return Response.json({ status: 'restored', path: `input/${body.attachment.locator}` });
    if (path === '/v1/pi/ensure') return Response.json({ ready: true, conversationId: 'conversation-1' });
    if (path === '/v1/pi/tasks') return Response.json({ taskId: body.taskId, status: 'completed' });
    if (path === '/v1/sync/seal') {
      const files = [];
      for (const [index, lane] of lanes.entries()) {
        if (mode === 'missing-report' && lane === 'doc-updater') continue;
        const report = { schemaVersion: 1, lane, packetDigest, generation: round, head, complete: true,
          omissions: [], findings: mode === 'red' && lane === 'code-reviewer' ? [finding] : [] };
        if (mode === 'incomplete-report' && lane === 'doc-updater') report.complete = false;
        if (mode === 'omitted-evidence' && lane === 'doc-updater') report.omissions.push('Unreviewed required evidence');
        const value = bytes(report), reportPath = body.paths[index];
        files.push({ path: reportPath, sha256: await hash(value), size: value.length });
        objects.set(`sealed/files/${reportPath}`, value);
      }
      const manifest = bytes({ operationId: body.operationId, files });
      objects.set('sealed/manifest.json', manifest);
      return Response.json({ status: 'sealed', manifestDigest: await hash(manifest), prefix: 'sealed/', filePrefix: 'sealed/files/' });
    }
    if (path === '/v1/storage/read') {
      const value = objects.get(body.key);
      return value ? Response.json({ bytes: base64(value) }) : new Response(null, { status: 404 });
    }
    if (path === '/v1/history/read') {
      if (mode === 'unavailable-history') return Response.json({ complete: false });
      const prior = previous?.artifact?.body;
      const values = {
        repository: { id: 138, permissions: { pull: true } },
        'pr-context': { number: 34, state: 'open', head: { sha: head, repo: { id: 138 } },
          base: { sha: base, repo: { id: 138 } } },
        'head-association': [{ number: 34, state: 'open', head: { sha: head } }],
        'merge-base': { merge_base_commit: { sha: mergeBase } },
        'comments-page': body.page === 1 && previous ? [previous.comment] : [],
        comment: previous?.comment,
        'artifact-list': previous ? [{ id: previous.artifact.id, name: previous.artifact.name }] : [],
        artifact: previous ? { id: previous.artifact.id, bytes: base64(bytes(prior)) } : null,
        run: prior ? { id: prior.binding.admission.runId, run_attempt: prior.binding.admission.runAttempt,
          workflow_id: prior.binding.admission.workflowId, repository: { id: 138 }, event: 'pull_request_target' } : null,
        'checks-page': { total_count: previous ? 1 : 0, check_runs: previous ? [previous.check] : [] },
        check: previous?.check,
      };
      return Object.hasOwn(values, body.operation) && values[body.operation] !== undefined
        ? Response.json({ complete: true, value: values[body.operation] }) : Response.json({ complete: false });
    }
    return new Response(null, { status: 404 });
  } };
  for (let generation = 1; generation <= 4; generation++) {
    const response = await producer.fetch(new Request('https://producer.internal/', { method: 'POST',
      body: JSON.stringify({ generation, checkpoint, invocation }) }), { OPERATOR: parent });
    const update = await response.json();
    if (update.status !== 'waiting') return Response.json({ update, boundary, context, packetDigest });
    checkpoint = update.checkpoint;
    packetDigest = checkpoint.packetDigest;
  }
  throw Error('Producer did not settle in the fixture drive bound');
} };
