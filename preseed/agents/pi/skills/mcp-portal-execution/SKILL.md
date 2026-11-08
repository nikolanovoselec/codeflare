---
name: mcp-portal-execution
description: Execute discovered portal Code Mode methods safely with sequential await, independent parallel batches, compact projections and no replay of uncertain writes.
disable-model-invocation: true
---

# Execute portal workflows

Complete [bootstrap](../mcp-portal-connect/SKILL.md) and [live discovery](../mcp-portal-discovery/SKILL.md) first. Discover the actual originating portal's execute tool and read its current JSON schema. Use the native `mcp` proxy with `tool` and `args`, or activate a verified deferred wrapper through `capability`. Every method name and argument object must come from that portal's live definitions.

## Single call and dependent steps

For a direct wrapper accepting `code`, this JSON envelope illustrates invocation mechanics only. Through the proxy, place the same argument object inside `{"tool":"<exact returned execute tool>","args":{"code":"<schema-valid code>"}}`. Replace the labelled placeholders with an actual returned sanitized name and valid arguments:

```json
{"code":"async () => { const actualName = '<name returned by this portal search>'; const args = {}; return await codemode[actualName](args); }"}
```

For dependent operations, use sequential `await`. Do not guess an upstream response property; inspect the discovered output contract or a bounded read result first:

```javascript
async () => {
  const readName = '<actual sanitized read name returned by search>';
  const readArgs = {}; // Replace with that method's schema-valid arguments.
  const nextName = '<actual sanitized dependent method name>';
  const outputField = '<verified first-result field>';
  const inputField = '<corresponding next-input field>';
  const first = await codemode[readName](readArgs);
  if (first == null || typeof first !== 'object' || !(outputField in first)) throw new Error('Inspect the first result before continuing');
  const next = await codemode[nextName]({ [inputField]: first[outputField] });
  const fields = ['<relevant output field>'];
  const project = (value) => Object.fromEntries(fields.filter(key => value != null && typeof value === 'object' && key in value).map(key => [key, value[key]]));
  return { first: project(first), next: project(next) };
}
```

Angle-bracket values and argument objects are substitution points, not invented method names or built-in globals. Populate every name, field and required argument from the live definitions/output contract before calling the wrapper. Keep concrete definitions inside the submitted function. External imports, SDK-only replay APIs, approval hooks and arbitrary `fetch` are not part of the portal contract.

## Independent parallel reads and partial failure

Batch only independent operations that the user authorized. For example, after defining concrete read-only jobs from the live schema inside your function:

```javascript
async () => {
  const jobs = [
    { name: '<actual sanitized independent read name>', args: {} },
    { name: '<another actual independent read name>', args: {} },
  ]; // Replace names and fill each argument object from its live schema.
  const results = await Promise.all(jobs.map(async (job) => {
    try {
      const value = await codemode[job.name](job.args);
      const fields = ['<relevant output field>'];
      const projected = Object.fromEntries(fields.filter(key => value != null && typeof value === 'object' && key in value).map(key => [key, value[key]]));
      return { name: job.name, ok: true, value: projected };
    } catch {
      return { name: job.name, ok: false, error: 'Read failed; inspect portal status' };
    }
  }));
  return results;
}
```

Use compact projections (IDs, status, relevant fields and bounded excerpts), not full unbounded catalogues/payloads. Keep enough provenance to distinguish failures per portal/job. A batch is not atomic. A fulfilled tool result may itself report an error: inspect the actual result contract as well as caught exceptions. Never use `Promise.all` for operations whose order or dependency matters.

## Writes, retries and authorization

- Exposed write schemas are not permission to mutate arbitrary resources. Obtain explicit current-user authorization for destructive, production, billing, credential and user-data actions, and keep scope to the approved target.
- The Worker refreshes credentials out of band. It does **not** replay MCP writes. A connection retry or refreshed token is not evidence the previous operation failed before taking effect.
- After any timeout, transport failure or partial batch failure involving a write, **read back the target state before deciding whether another write is safe**. If readback cannot establish the outcome, report uncertainty and stop; do not replay automatically.
- A downstream authorization URL comes from the same portal user/grant. Preserve it as returned, do not print secret-bearing URL values, and ask the owner to authorize the required browser flow. Do not create a different grant or copy browser cookies.
- Preserve meaningful upstream statuses/results and partial failures in the report. Do not claim hosted execution, downstream OAuth, refresh or revocation success from synthetic tests or local skill loading.
