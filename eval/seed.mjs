/**
 * Eval fixture: a throwaway vault built with the real vault writer.
 *
 *   node eval/seed.mjs      build it, print a summary, keep the directory
 *
 * Shape of the fixture (this is the ground truth the questions are written
 * against, not the other way round):
 *   - 3 projects: memory-graph, blog-engine, infra
 *   - 38 cards over all 5 kinds
 *   - 7 entities shared by two or more projects (the cross-project bridges)
 *   - 4 supersede chains, 1 retracted card
 *
 * The first two chains (抽取, 监控) existed from the start. The other two
 * (告警渠道, 证书) were added when the paired history/current test was written:
 * a pair needs an old card and a new card on the same topic, and two chains do
 * not make four pairs. Both new chains sit on themes no earlier question asks
 * about, so the original 25 questions are re-measured on the larger corpus but
 * their answers did not move.
 *   - mixed Chinese/English titles, real-looking bodies of one to three lines
 *
 * Card ids are fixed instead of generated so questions.json can name them; the
 * date inside an id is decorative. Ages are kept in `ageDays` and turned into
 * `created` timestamps at seed time, so recency weighting stays identical
 * however long after this file was written the eval runs.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../src/config.js'
import { createRedactor } from '../src/privacy.js'
import { createVault } from '../src/vault.js'

const DAY = 24 * 60 * 60 * 1000

/** Cards as they are handed to vault.saveCard, oldest first. */
export const FIXTURE_CARDS = [
  /* ------------------------------------------------------------ memory-graph */
  {
    id: 'c-20260305-0001',
    project: 'memory-graph',
    kind: 'decision',
    ageDays: 242,
    title: '记忆存储用纯文本而不是 SQLite',
    body: 'SQLite 要处理锁、迁移和二进制合并，出了事只能写脚本去挖。纯文本可以直接 grep、直接读、直接进 git，坏了也能手工修。',
    entities: ['memory-graph', 'vault格式', 'sqlite'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260412-0002',
    project: 'memory-graph',
    kind: 'decision',
    ageDays: 204,
    title: '卡片层和情节层分开：episodes 只追加，cards 蒸馏',
    body: '原始情节一行一轮，谁都不许改；从情节里抽出来的记忆单独存成带 kind 和日期的卡片。分开之后可以重新蒸馏，也不会因为一次抽取失误毁掉原始记录。',
    entities: ['memory-graph', 'vault格式', '蒸馏'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260520-0003',
    project: 'memory-graph',
    kind: 'preference',
    ageDays: 166,
    title: '所有 DSH 插件零依赖、不要构建步骤',
    body: '装到哪个 profile 都能直接 node 跑起来，不想要 bundler，也不想要 node_modules。宁可多写两百行，也不引一个包。',
    entities: ['dsh插件', '零依赖', 'esm'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260618-0004',
    project: 'memory-graph',
    kind: 'fact',
    ageDays: 137,
    title: '中文按二元组切词，英文按空白切词',
    body: 'tokenize 里中文没有词典，直接滑窗取 bigram；英文和数字按非字母数字切分。这样“记忆图谱”会出“记忆”“忆图”“图谱”三个 token。',
    entities: ['memory-graph', 'tokenize', '中文分词'],
    confidence: 'verified',
  },
  {
    id: 'c-20260701-0005',
    project: 'memory-graph',
    kind: 'open_question',
    ageDays: 124,
    title: '实体页要不要做别名合并？',
    body: '现在 slugify 之后“vault 格式”和“vault格式”是两页。合并本身不难，但规则写歪了会把两个不相干的东西并到一起，暂时没定。',
    entities: ['entities索引', 'memory-graph'],
    confidence: 'inferred',
  },
  {
    id: 'c-20260715-0006',
    project: 'memory-graph',
    kind: 'decision',
    ageDays: 110,
    title: '抽取模型默认关闭',
    body: '第一版打算默认开启自动蒸馏，每轮对话结束就跑一次抽取。',
    entities: ['抽取器', 'deepseek'],
    confidence: 'inferred',
  },
  {
    id: 'c-20260802-0007',
    project: 'memory-graph',
    kind: 'decision',
    ageDays: 92,
    title: '抽取改成显式调用 memory_distill，不再自动蒸馏',
    body: '自动蒸馏会在用户不知情的时候烧 API 费用，而且大部分轮次根本没有值得记的东西。改成只有用户显式调用 memory_distill 才跑抽取。',
    entities: ['抽取器', 'deepseek', 'dsh插件'],
    confidence: 'user_stated',
    supersedes: ['c-20260715-0006'],
  },
  {
    id: 'c-20260820-0008',
    project: 'memory-graph',
    kind: 'fact',
    ageDays: 74,
    title: '写入前必须过 redactor，凭证一律替换',
    body: 'sk- / ghp_ / 私钥块这些形状在落盘之前就替换成 [REDACTED]，不许写进 vault。',
    entities: ['隐私边界', 'vault格式'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260901-0009',
    project: 'memory-graph',
    kind: 'note',
    ageDays: 62,
    title: 'vault 目录结构笔记',
    body: 'episodes/ 放原始 jsonl，cards/YYYY-MM/ 放卡片，entities/ 一实体一页，audit/ 是写入流水。没有数据库文件，全部是能 diff 的文本。',
    entities: ['vault格式', 'memory-graph'],
    confidence: 'verified',
  },
  {
    id: 'c-20260918-0010',
    project: 'memory-graph',
    kind: 'decision',
    ageDays: 45,
    title: '检索用 BM25 加实体单跳扩展',
    body: '关键词走 BM25，实体命中给一个固定加分，然后沿共现实体做一跳扩展。不用向量检索，因为漂移了没法解释为什么召回这张卡。',
    entities: ['检索', 'memory-graph', 'vault格式'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20261005-0011',
    project: 'memory-graph',
    kind: 'fact',
    ageDays: 28,
    title: 'retracted 和 superseded 是降权不是删除',
    body: 'retracted 权重归零但文件还在磁盘上；superseded 打 0.4 的折扣，旧方案还能查到，只是压在新方案下面。',
    entities: ['检索', 'vault格式', '隐私边界'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20261020-0012',
    project: 'memory-graph',
    kind: 'open_question',
    ageDays: 13,
    title: '跨项目 recall 的评测集怎么造',
    body: '要有一批只有靠共享实体才能带出来的问题，否则测的都是关键词匹配。人工标 25 条左右，按题型分组看分数。',
    entities: ['评测', 'memory-graph', '检索'],
    confidence: 'inferred',
  },
  {
    id: 'c-20261029-0013',
    project: 'memory-graph',
    kind: 'preference',
    ageDays: 4,
    title: '报告里不要用 emoji，表格用 markdown',
    body: '汇报和文档一律纯文本，表格用 markdown 管道，重点用粗体而不是表情符号。',
    entities: ['写作偏好', '文档'],
    confidence: 'user_stated',
  },

  /* ------------------------------------------------------------- blog-engine */
  {
    id: 'c-20260310-0014',
    project: 'blog-engine',
    kind: 'decision',
    ageDays: 237,
    title: '静态站点生成器自己写，零依赖',
    body: 'Hugo 和 Eleventy 都试过，为了两个自定义行为要改主题源码，还不如自己写一个两百行的 generator。只用 node 内置模块。',
    entities: ['零依赖', 'blog-engine', 'node-esm'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260408-0015',
    project: 'blog-engine',
    kind: 'fact',
    ageDays: 208,
    title: '文章用 Markdown + frontmatter，日期写 YYYY-MM-DD',
    body: '每篇一个 .md，头部 frontmatter 放 title/date/tags/draft。日期格式统一 YYYY-MM-DD，不做本地化。',
    entities: ['markdown', 'blog-engine'],
    confidence: 'verified',
  },
  {
    id: 'c-20260512-0016',
    project: 'blog-engine',
    kind: 'decision',
    ageDays: 174,
    title: '评论系统从 Disqus 换成自建 sqlite',
    body: 'Disqus 加载慢还带追踪。改成一个小服务，评论存 sqlite，和站点部署在同一台机器上。',
    entities: ['sqlite', 'blog-engine', '评论'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260602-0017',
    project: 'blog-engine',
    kind: 'open_question',
    ageDays: 153,
    title: '旧文章要不要加 canonical 指向掘金',
    body: '同一篇在掘金也发，重复内容怕被降权。加 canonical 会不会把本站的权重也让出去，还没想清楚。',
    entities: ['seo', 'blog-engine'],
    confidence: 'inferred',
  },
  {
    id: 'c-20260708-0018',
    project: 'blog-engine',
    kind: 'fact',
    ageDays: 117,
    title: '部署靠 GitHub Actions，push 到 main 就 build',
    body: 'workflow 里 npm ci、build、rsync 到 VPS。没有别的部署方式，也不打算上 Vercel。',
    entities: ['github-actions', 'blog-engine', '部署'],
    confidence: 'verified',
  },
  {
    id: 'c-20260811-0019',
    project: 'blog-engine',
    kind: 'preference',
    ageDays: 83,
    title: '博客写作偏好：先结论后论证，少用形容词',
    body: '开头两句把结论说完，后面再展开。形容词和副词能删就删，宁可干一点。',
    entities: ['写作偏好', 'blog-engine'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260905-0020',
    project: 'blog-engine',
    kind: 'decision',
    ageDays: 58,
    title: '封面图用 Cloudflare Images，不做本地压缩',
    body: '本地 sharp 压缩要维护依赖，不同尺寸还得自己写。Cloudflare Images 一个 URL 参数搞定，按量付费也不贵。',
    entities: ['cloudflare', 'blog-engine'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260922-0021',
    project: 'blog-engine',
    kind: 'note',
    ageDays: 41,
    title: '英文站放在 /en 子路径，不搞子域名',
    body: '子域名要单独配证书和 DNS，子路径直接复用现有部署。hreflang 里两个都指回主域。',
    entities: ['i18n', 'blog-engine', 'seo'],
    confidence: 'inferred',
  },
  {
    id: 'c-20261011-0022',
    project: 'blog-engine',
    kind: 'fact',
    ageDays: 22,
    title: '每篇文章目标 1200 字，超了就拆成两篇',
    body: '超过 1200 字阅读完成率明显掉。宁可拆成两篇互相链接。',
    entities: ['写作偏好', 'blog-engine'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20261024-0023',
    project: 'blog-engine',
    kind: 'decision',
    ageDays: 9,
    title: 'RSS 输出全文，不做摘要',
    body: '全文 RSS 对读者更友好，也省得维护摘要逻辑。带着 canonical 一起输出。',
    entities: ['rss', 'blog-engine'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20261101-0024',
    project: 'blog-engine',
    kind: 'open_question',
    ageDays: 1,
    title: '要不要把 blog engine 抽成 DSH 插件',
    body: '现在 generator 是个独立脚本，抽成插件就能在会话里直接发文。但插件要零依赖，可能会把 generator 写胖。',
    entities: ['dsh插件', 'blog-engine', 'esm'],
    confidence: 'inferred',
  },

  /* ------------------------------------------------------------------- infra */
  {
    id: 'c-20260320-0025',
    project: 'infra',
    kind: 'decision',
    ageDays: 227,
    title: '备份用 restic 到 B2，每天凌晨跑',
    body: 'restic 增量加密，仓库放 Backblaze B2。保留策略 7 天 / 4 周 / 12 月。',
    entities: ['备份', 'infra', 'restic'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260425-0026',
    project: 'infra',
    kind: 'fact',
    ageDays: 191,
    title: '主 VPS 是 Hetzner 2C4G，跑 docker compose',
    body: 'CPX11，两个 vCPU 四个 G。所有服务一个 compose 文件起，不搞 swarm 也不搞 k8s。',
    entities: ['infra', 'hetzner', 'docker'],
    confidence: 'verified',
  },
  {
    id: 'c-20260530-0027',
    project: 'infra',
    kind: 'decision',
    ageDays: 156,
    title: '监控从 Zabbix 换到 Uptime Kuma',
    body: 'Zabbix 太重，模板和维护成本都高。先用 Uptime Kuma 做外部拨测。',
    entities: ['监控', 'infra'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260706-0028',
    project: 'infra',
    kind: 'decision',
    ageDays: 119,
    title: '监控换成 Prometheus + Grafana，Uptime Kuma 只留外部拨测',
    body: 'Uptime Kuma 只有 up/down，看不出趋势。指标全量进 Prometheus，面板用 Grafana，Kuma 只负责从外网拨。',
    entities: ['监控', 'infra', 'prometheus'],
    confidence: 'user_stated',
    supersedes: ['c-20260530-0027'],
  },
  {
    id: 'c-20260809-0029',
    project: 'infra',
    kind: 'preference',
    ageDays: 85,
    title: '每个服务都要能单机 docker compose up 起来',
    body: '不允许出现只在一个环境能跑的服务。本地 compose 和线上是同一份文件，差异只在 .env。',
    entities: ['docker', 'infra', '零依赖'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20260912-0030',
    project: 'infra',
    kind: 'open_question',
    ageDays: 51,
    title: '要不要给 infra 抽一个统一 CLI',
    body: '现在每件事都是散着的 shell 脚本。想收成一个 node 写的 esm CLI，零依赖直接跑，但还没到非做不可的程度。',
    entities: ['infra', '零依赖', 'esm'],
    confidence: 'inferred',
  },
  {
    id: 'c-20261002-0031',
    project: 'infra',
    kind: 'fact',
    ageDays: 31,
    title: 'deepseek API 账单告警设在 50 美元',
    body: '月度用量超 50 美元就发通知。主要消耗是记忆图谱的抽取和几个自动化脚本。',
    entities: ['deepseek', 'infra', '成本'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20261016-0032',
    project: 'infra',
    kind: 'note',
    ageDays: 17,
    title: 'GitHub Actions nightly 备份 workflow 在 03:00 UTC 跑',
    body: '备份任务本身也在 Actions 里，跑 restic backup 然后 check。失败会开一个 issue。',
    entities: ['github-actions', 'infra', '备份'],
    confidence: 'verified',
  },
  {
    id: 'c-20261027-0033',
    project: 'infra',
    kind: 'fact',
    ageDays: 6,
    title: '内网走 tailscale，不暴露公网端口',
    body: '除了 80/443 之外没有对公网开的端口。ssh 和数据库都只在 tailnet 里。',
    entities: ['tailscale', 'infra', '安全'],
    confidence: 'verified',
  },
  {
    id: 'c-20261030-0034',
    project: 'infra',
    kind: 'decision',
    ageDays: 3,
    title: '日志集中到 Loki，保留 14 天',
    body: '从 docker logs 改成 promtail 推到 Loki。14 天够排障了，再长就用冷备。',
    entities: ['loki', 'infra', '日志'],
    confidence: 'user_stated',
  },
  {
    id: 'c-20261102-0035',
    project: 'infra',
    kind: 'preference',
    ageDays: 0,
    title: '告警只发手机，不进邮箱',
    body: '邮箱里的告警等于没告警。全部走手机推送，非工作时间的低优先级告警静音。',
    entities: ['告警', 'infra'],
    confidence: 'user_stated',
    supersedes: ['c-20260110-0036'],
  },
  {
    id: 'c-20260110-0036',
    project: 'infra',
    kind: 'decision',
    ageDays: 296,
    title: '告警先发邮件，Slack 只做抄送',
    body: '早期所有告警都往邮箱里塞，重要的再手动抄一份到 Slack 频道。一天几十封，最后全都不看了。',
    entities: ['告警', 'infra', '邮箱'],
    confidence: 'inferred',
  },
  {
    id: 'c-20260105-0037',
    project: 'infra',
    kind: 'note',
    ageDays: 301,
    title: '证书手动 renew，到期前手工跑一次',
    body: '用 certbot 手动签，日历里记着到期提醒，忘了就过期，浏览器直接报红。',
    entities: ['证书', 'infra', 'https'],
    confidence: 'inferred',
  },
  {
    id: 'c-20260128-0038',
    project: 'infra',
    kind: 'decision',
    ageDays: 278,
    title: '证书交给 caddy 自动续期',
    body: 'caddy 自己管签发和续期，不再手动跑 certbot，也不用再记日历。',
    entities: ['证书', 'infra', 'caddy'],
    confidence: 'user_stated',
    supersedes: ['c-20260105-0037'],
  },
]

/** The one card whose advice was wrong and was taken back. */
export const RETRACTED = { id: 'c-20260820-0008', reason: '规则写歪了，误伤正常文本，先撤回' }

/**
 * Build the fixture vault.
 * @param {string} [dir] target directory; a fresh temp dir when omitted
 * @returns {Promise<{ dir: string, vault: object, cards: object[], stats: object }>}
 */
export async function seed(dir) {
  const target = dir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-eval-')))
  await fsp.mkdir(target, { recursive: true })

  const cfg = resolveConfig({ vaultDir: target })
  const redactor = createRedactor(cfg.privacy)
  const vault = createVault(cfg, redactor)

  const now = Date.now()
  // Oldest first, so every supersede chain is written after the card it retires.
  const ordered = [...FIXTURE_CARDS].sort((a, b) => b.ageDays - a.ageDays)
  for (const { ageDays, ...card } of ordered) {
    await vault.saveCard({ ...card, created: new Date(now - ageDays * DAY).toISOString() })
  }
  await vault.retractCard(RETRACTED.id, RETRACTED.reason)
  await vault.regenerateReadme()

  const cards = await vault.listCards({ includeRetracted: true })
  const stats = await vault.stats()
  return { dir: target, vault, cards, stats }
}

/** Shared entities that appear in cards from two or more projects. */
export function bridgeEntities(cards) {
  const projectsByEntity = new Map()
  for (const card of cards) {
    for (const slug of card.entities ?? []) {
      if (!projectsByEntity.has(slug)) projectsByEntity.set(slug, new Set())
      projectsByEntity.get(slug).add(card.project)
    }
  }
  return [...projectsByEntity.entries()]
    .filter(([, projects]) => projects.size >= 2)
    .map(([slug, projects]) => ({ slug, projects: [...projects].sort() }))
    .sort((a, b) => (a.slug > b.slug ? 1 : -1))
}

/* Allow `node eval/seed.mjs` as a standalone command. */
const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (invokedDirectly) {
  const { dir, cards, stats } = await seed()
  const bridges = bridgeEntities(cards)
  const ages = FIXTURE_CARDS.map((card) => card.ageDays)
  console.log(`vault:     ${dir}`)
  console.log(`cards:     ${stats.cards.total} (${Object.entries(stats.cards.byKind).map(([k, n]) => `${k} ${n}`).join(', ')})`)
  console.log(`status:    active ${stats.cards.active}, superseded ${stats.cards.superseded}, retracted ${stats.cards.retracted}`)
  console.log(`projects:  ${stats.projects.join(', ')}`)
  console.log(`entities:  ${stats.entities}`)
  console.log(`ages:      ${Math.min(...ages)}..${Math.max(...ages)} days before the run`)
  console.log(`bridges:   ${bridges.length} shared by 2+ projects`)
  for (const bridge of bridges) console.log(`           ${bridge.slug} -> ${bridge.projects.join(', ')}`)
}
