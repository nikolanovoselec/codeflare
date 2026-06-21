/**
 * Vault proxy path helpers.
 *
 * The in-container terminal server proxies `/vault*` requests to the
 * localhost SilverBullet editor. Before forwarding it must strip the `/vault`
 * prefix so the editor sees its own native paths (the Worker has already
 * stripped its `/api/vault/:sid` prefix upstream). The same strip is needed
 * for both the HTTP branch and the WebSocket upgrade passthrough, so it lives
 * here as one pure function rather than being duplicated in server.ts.
 */

/**
 * Strip the leading `/vault` prefix from an incoming pathname, returning the
 * upstream path SilverBullet should see. An exactly-`/vault` request (or a
 * missing pathname) maps to `/`.
 *
 *   /vault            -> /
 *   /vault/           -> /
 *   /vault/index/foo  -> /index/foo
 *   /vault/.client/x  -> /.client/x
 */
export function stripVaultPrefix(pathname: string | null | undefined): string {
  return (pathname ?? '/vault').slice('/vault'.length) || '/';
}
