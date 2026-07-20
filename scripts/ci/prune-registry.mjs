// Prune old container images from the Cloudflare registry, scoped to one
// image repo. Extracted verbatim from the former inline `node -e` block in
// deploy.yml so the logic is reviewable and diffable.
//
// Registry size is capped by the instance type's available disk; without
// pruning, every deploy leaves a tag in registry.cloudflare.com forever and
// eventually `wrangler containers push` starts dropping connections mid-upload
// ("use of closed network connection"). Keeps the last KEEP_N tags by image
// creation time PLUS the currently-deployed tag as rollback floor; deletes the
// rest. Wrangler exposes `containers images delete` but only under its
// OAuth-login flow — the API token in CI cannot use that path, so this script
// talks to the Docker Registry v2 API directly via short-lived credentials
// minted from the CF API. Non-fatal by contract: the caller runs it with
// continue-on-error; every internal error degrades to a ::warning + skip.
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, REGISTRY_URI, KEEP_N
(async () => {
  const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
  const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  const URI = process.env.REGISTRY_URI || "";
  const KEEP_N = parseInt(process.env.KEEP_N || "10", 10);
  // URI shape: registry.cloudflare.com/<acct>/<repo>:<tag>
  const m = URI.match(/^registry\.cloudflare\.com\/([^/]+)\/([^:]+):(.+)$/);
  if (!m) { console.log("::warning::could not parse REGISTRY_URI=" + URI + "; skipping prune"); return; }
  const [, uriAcct, repo, deployedTag] = m;
  if (uriAcct !== ACCT) { console.log("::warning::URI account does not match CLOUDFLARE_ACCOUNT_ID; skipping prune"); return; }
  console.log("Pruning " + repo + " (keep " + KEEP_N + " newest + deployed " + deployedTag + ")");

  const credR = await fetch("https://api.cloudflare.com/client/v4/accounts/" + ACCT + "/containers/registries/registry.cloudflare.com/credentials",
    { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ expiration_minutes: 30, permissions: ["pull","push"] }) });
  const credJ = await credR.json();
  if (!credJ.success) { console.log("::warning::mint creds failed: " + JSON.stringify(credJ.errors)); return; }
  const auth = "Basic " + Buffer.from(credJ.result.username + ":" + credJ.result.password).toString("base64");
  const accept = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json"
  ].join(",");
  const base = "https://registry.cloudflare.com/v2/" + ACCT + "/" + repo;

  // Enumerate every tag (paginated). Docker Registry v2 paginates
  // lexicographically, not by recency. If any page errors, we MUST
  // fail closed - a partial enumeration biases the "newest by
  // creation time" selection toward whichever lexical slice we did
  // see, and the digest-protection invariant below cannot protect
  // tags we never knew existed.
  const tags = [];
  let last = "";
  let complete = true;
  for (let p = 0; p < 200; p++) {
    const url = base + "/tags/list?n=500" + (last ? "&last=" + encodeURIComponent(last) : "");
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) { console.log("::warning::tags/list HTTP " + r.status); complete = false; break; }
    const j = await r.json();
    const page = j.tags || [];
    if (!page.length) break;
    tags.push(...page);
    if (page.length < 500) break;
    last = page[page.length - 1];
  }
  if (!complete) { console.log("::warning::incomplete tag listing; skipping prune to avoid deleting a kept manifest"); return; }
  console.log("Found " + tags.length + " tags");
  if (tags.length <= KEEP_N + 1) { console.log("Below threshold; nothing to prune."); return; }

  // Fetch manifest digest + creation time per tag, concurrency-bounded
  async function info(tag) {
    const r = await fetch(base + "/manifests/" + tag, { headers: { Authorization: auth, Accept: accept } });
    if (!r.ok) return null;
    const digest = r.headers.get("docker-content-digest");
    const body = await r.json();
    let cfg = body.config?.digest;
    if (!cfg && body.manifests?.length) {
      const r2 = await fetch(base + "/manifests/" + body.manifests[0].digest, { headers: { Authorization: auth, Accept: accept } });
      if (r2.ok) { const b2 = await r2.json(); cfg = b2.config?.digest; }
    }
    let created = null;
    if (cfg) {
      const r3 = await fetch(base + "/blobs/" + cfg, { headers: { Authorization: auth } });
      if (r3.ok) { const c = await r3.json(); created = c.created || null; }
    }
    return { tag, digest, created };
  }
  const results = new Array(tags.length);
  let idx = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (true) { const i = idx++; if (i >= tags.length) return; results[i] = await info(tags[i]); }
  }));

  const ok = results.filter(Boolean);
  // Fail closed if we could not resolve a digest for the just-deployed
  // tag. Without its digest in keepDigests, the alias-protection
  // below cannot defend it from a sibling tag that happens to share
  // the same manifest. Treat this exactly like pagination failure:
  // skip the prune entirely rather than risk destroying the rollback
  // floor we promised to protect.
  if (!ok.some(x => x.tag === deployedTag && x.digest)) {
    console.log("::warning::could not resolve digest for deployed tag " + deployedTag + "; skipping prune");
    return;
  }
  const dated = ok.filter(x => x.created).sort((a,b) => b.created.localeCompare(a.created));
  const top = dated.slice(0, KEEP_N).map(x => x.tag);
  // Fail closed on unresolved creation times: a tag whose config-blob fetch
  // flaked might be one of the newest, so keep it — that also protects any
  // digest it aliases. It becomes prunable again once a later run resolves it.
  const undated = ok.filter(x => !x.created);
  if (undated.length) console.log("::warning::" + undated.length + " tag(s) lack a resolved creation time; protecting them this run");
  const keepTags = new Set([...top, deployedTag, ...undated.map(x => x.tag)]);
  // DELETE on a registry v2 manifest removes the manifest globally -
  // every tag that aliases that digest 404s afterward. If two tags
  // share a digest (identical Dockerfile + identical context across
  // deploys produces identical layers; the manual sweep found ~40%
  // of tags shared a manifest), deleting the "other" tag's digest
  // would destroy a kept tag's image too. Protect every digest that
  // ANY kept tag references, then dedupe the delete list separately.
  const keepDigests = new Set(ok.filter(x => keepTags.has(x.tag) && x.digest).map(x => x.digest));
  const seen = new Set();
  const toDel = ok.filter(x =>
    !keepTags.has(x.tag) &&
    x.digest &&
    !keepDigests.has(x.digest) &&
    !seen.has(x.digest) &&
    seen.add(x.digest));
  console.log("Keeping " + keepTags.size + " tags (" + keepDigests.size + " unique digests), deleting " + toDel.length + " manifests");
  let okN = 0, failN = 0;
  let di = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (true) {
      const i = di++; if (i >= toDel.length) return;
      const r = await fetch(base + "/manifests/" + toDel[i].digest, { method: "DELETE", headers: { Authorization: auth } });
      if (r.ok || r.status === 202) okN++; else failN++;
    }
  }));
  console.log("Pruned: ok=" + okN + " fail=" + failN);
})().catch(e => console.log("::warning::prune crashed: " + (e?.stack || e)));
