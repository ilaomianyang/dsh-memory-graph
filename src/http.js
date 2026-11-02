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
