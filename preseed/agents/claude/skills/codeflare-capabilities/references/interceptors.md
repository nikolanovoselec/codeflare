# Credential interception and secret boundaries

## What I can do

I can use ordinary command-line clients while selected credentials stay outside the container. Worker-side interceptors recognize exact owned destinations, validate the bound session identity, remove non-secret placeholders, and add the real authorization only at the egress boundary.

I use the signed-in user's encrypted token for GitHub traffic to allowlisted GitHub hosts. I route supported model traffic through the configured Cloudflare AI Gateway. I use Browser Rendering calls whose account authorization is added at the boundary without placing the long-lived token in the shell environment.

For strict web egress, I send storage requests through the catch-all controller. It checks the bound storage identity and re-signs S3-compatible requests for the user's exact bucket, so I can work with the storage service without gaining a reusable credential for somebody else's bucket.

## Where the boundary sits

A hostname that looks similar is not an approved destination. A user ID supplied by the container is not session identity. A proxy variable is not a security boundary. The Worker owns all three decisions.

Named interceptors cover named services; they are not a universal secret manager. A secret placed in an environment variable is exposed to processes allowed to read it inside the container, but container visibility is not the same as unrestricted escape. With Enterprise Strict Gateway Egress enabled, direct-internet HTTP, HTTPS, and WebSocket traffic must pass through Cloudflare Gateway, raw TCP and UDP internet egress is denied, and configured DLP policies can detect or block exfiltration. I still inspect the actual path before claiming a secret cannot leave: own-account control-plane exceptions use separate scoped authorization and audit boundaries, and DLP protection is only as strong as the customer's active Cloudflare Gateway policy.

## Try it

In an Enterprise deployment, connect your GitHub identity, open a new Bash terminal tab, and run:

```bash
if [ "${GH_TOKEN-}" = "codeflare-enterprise" ]; then
  printf 'GH_TOKEN=%s\n' "$GH_TOKEN"
else
  printf '%s\n' 'Enterprise GitHub placeholder is unavailable. No value printed.'
fi
```

A connected Enterprise session prints `GH_TOKEN=codeflare-enterprise`. That value is a non-secret placeholder, not your GitHub token. Only after you see that placeholder, test Worker-side authorization:

```bash
gh api user --jq '{login, id}'
```

If GitHub returns your identity, the request authenticated after leaving the container while the reusable token stayed outside it.

Other useful requests:

- “Check whether this GitHub request uses a placeholder without exposing a reusable token.”
- “Use my S3-compatible storage and confirm the request can reach only my assigned bucket.”
- “Tell me whether credentials for this outbound call enter the shell before I run it.”
