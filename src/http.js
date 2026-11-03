/**
 * The one response helper both route handlers use.
 *
 * Not `Response.json`: the harness may run on a Node build that predates the
 * static helper, and this is a host-side route, not a browser call — a plain
 * `new Response` with an explicit content type is the least surprising thing to
 * return to Connection.
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * A page, for the one route that serves the whole-vault graph.
 *
 * `x-frame-options: SAMEORIGIN` because that page is embedded in the app's own
 * panel: same origin only, which also means a page on another origin cannot frame
 * it. No CSP of its own — the page is self-contained and ships its own script.
 */
export function html(body, status = 200) {
  return new Response(String(body ?? ''), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'SAMEORIGIN',
    },
  })
}
