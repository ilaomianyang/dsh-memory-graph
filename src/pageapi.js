/**
 * The whole-vault graph, served as a page.
 *
 * Why a route and not the file: `graph.html` sits in the vault directory, which
 * is a path on disk the browser has no business reading (and a `file://` URL the
 * app's panel will not frame). This route hands back the same bytes over the
 * authenticated `/api` connection, so the panel can embed it and so a link to it
 * keeps working from another window.
 *
 * Read-only and cheap: it renders from the cards and entity pages already in the
 * vault, writes nothing, and spends nothing.
 */
import { html } from './http.js'

/** The exact path the host serves and the panel embeds. Authenticated by Connection. */
export const PAGE_PATH = '/api/memory-graph.page'

function failure(error) {
  const detail = error instanceof Error ? error.message : String(error)
  const escaped = detail.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>记忆图谱</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#333}
main{max-width:34rem;padding:2rem}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}</style>
<main><h1>记忆图没能画出来</h1><p><code>${escaped}</code></p>
<p>图谱渲染失败了，但记忆库还在磁盘上，什么都没写 · The graph could not be rendered. The vault is still on disk; nothing was written.</p></main></html>`
}

export function createPageHandler({ getVault }) {
  return async function fetch() {
    const vault = getVault()
    if (!vault || typeof vault.graphPage !== 'function') {
      return html(failure(new Error('记忆库不可用 · vault unavailable')), 500)
    }
    try {
      return html(await vault.graphPage())
    } catch (error) {
      return html(failure(error), 500)
    }
  }
}
