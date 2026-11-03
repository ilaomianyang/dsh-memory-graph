/**
 * dsh-memory-graph — browser half: the 设置 → 记忆图谱 page.
 *
 * The host half exports a `Config` schema whose live-safe fields are marked
 * `.volatile()`. `@deepseek-ai/dsh-settings` projects exactly those fields into a
 * form and serves them under this plugin's profile entry id. This file is the
 * page that renders that form: it registers a `settings.section`, reads the form
 * through the client service `configForms`, and writes edits back as path ops.
 *
 * Why hand-drawn inputs instead of the `ui-primitives` settings widgets: the page
 * groups 28 knobs, hides the ones that cannot apply (http-only fields while the
 * transport is `harness`), shows which values are user overrides and can restore
 * one, and none of that is a primitive's job. The write path is the one the
 * official settings pages use — `configForms.get(ns).mutate(ops)` — so the
 * revision fence, the write queue and the silent recovery on conflict all still
 * apply.
 *
 * No build step and no JSX: the module loader runs this file as a plain script
 * and calls the factory below with the frozen require table. Outside the browser
 * it is an ordinary ES module whose only side effect is publishing `FORM_SPEC`,
 * so `test/schema.mjs` can hold the page and the schema to each other.
 */

const PACKAGE_NAME = 'dsh-memory-graph'
const HOST_ENTRY_ID = 'memory-graph'
const STYLE_ID = 'dsh-memory-graph-settings-css'
/** The Conversation view cell this plugin adds, and the host routes it reads. */
const GRAPH_VIEW_ID = 'memory-graph'
const GRAPH_API = '/api/memory-graph.graph'
const DISTILL_API = '/api/memory-graph.distill'

const ZH = (() => {
  try {
    return String((typeof navigator === 'object' && navigator && navigator.language) || '')
      .toLowerCase()
      .startsWith('zh')
  } catch {
    return false
  }
})()

/** Pick a string by UI language. Both halves of the plugin are bilingual; the nav label follows suit. */
const t = (zh, en) => (ZH ? zh : en)

// ---------------------------------------------------------------------------
// The form description
//
// `path` is the config path exactly as `src/schema.js` declares it: the test
// asserts that every path here is a volatile leaf in the schema, and that every
// volatile leaf appears here. A knob added to one side only fails the suite.
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    id: 'capture',
    title: t('记录', 'Capture'),
    hint: t(
      '每一轮对话落成一条原始片段。片段不会被压缩，蒸馏成卡片之后仍然保留。',
      'Every turn becomes a raw episode. Episodes are never compacted, and they stay after distillation.',
    ),
    fields: [
      {
        path: ['capture', 'enabled'],
        type: 'boolean',
        label: t('记录对话', 'Record conversations'),
        hint: t('关掉后不再写入新片段；已有记忆不受影响。', 'Off stops new episodes; existing memories stay.'),
      },
      {
        path: ['capture', 'userChars'],
        type: 'number',
        min: 200,
        max: 20000,
        step: 100,
        unit: t('字符', 'chars'),
        label: t('用户消息保留', 'User message kept'),
        hint: t('每条用户消息最多留多少字。', 'Characters kept per user message.'),
      },
      {
        path: ['capture', 'assistantChars'],
        type: 'number',
        min: 200,
        max: 20000,
        step: 100,
        unit: t('字符', 'chars'),
        label: t('助手回复保留', 'Assistant reply kept'),
        hint: t('每条回复最多留多少字。', 'Characters kept per reply.'),
      },
      {
        path: ['capture', 'minChars'],
        type: 'number',
        min: 0,
        max: 500,
        step: 1,
        unit: t('字符', 'chars'),
        label: t('最短长度', 'Shortest kept'),
        hint: t('短于这个长度的往返不记（"好的"这种）。', 'Shorter exchanges are dropped (a bare "ok").'),
      },
      {
        path: ['capture', 'includeToolOutput'],
        type: 'boolean',
        label: t('连工具输出一起记', 'Also record tool output'),
        hint: t('默认关：工具输出多而杂，会挤占蒸馏预算。', 'Off by default: tool output is bulk and usually noise.'),
      },
      {
        path: ['capture', 'skipPatterns'],
        type: 'list',
        wide: true,
        label: t('跳过这些消息（正则）', 'Skip matching messages (regex)'),
        hint: t(
          '一行一条；整段替换内置的三条（压缩摘要、运行时上下文、system-reminder）。',
          'One per line; replaces the three built-ins (checkpoints, runtime context, system-reminder).',
        ),
      },
    ],
  },
  {
    id: 'privacy',
    title: t('隐私打码', 'Privacy'),
    hint: t(
      '在写入之前打码：匹配到的东西根本不会落盘，事后再清理是不做的。',
      'Redaction happens before anything is written: a match never reaches the file.',
    ),
    fields: [
      {
        path: ['privacy', 'useDefaultPatterns'],
        type: 'boolean',
        label: t('内置密钥规则', 'Built-in secret patterns'),
        hint: t('sk- 开头的 key、GitHub/Google/AWS 令牌、私钥块等 11 条。', '11 rules: sk- keys, GitHub/Google/AWS tokens, private key blocks, bearer headers, password assignments.'),
      },
      {
        path: ['privacy', 'redactEmails'],
        type: 'boolean',
        label: t('邮箱打码', 'Redact emails'),
        hint: t('替换成 [email]。', 'Replaced with [email].'),
      },
      {
        path: ['privacy', 'redactPaths'],
        type: 'boolean',
        label: t('本地路径打码', 'Redact home paths'),
        hint: t('把家目录替换成 ~。', 'Replaces your home directory with ~.'),
      },
      {
        path: ['privacy', 'denyPatterns'],
        type: 'list',
        wide: true,
        label: t('额外强制打码（正则）', 'Extra redaction patterns (regex)'),
        hint: t(
          '一行一条，例如客户名、内部主机名；不合法的正则会被忽略而不是让记录停摆。',
          'One per line, e.g. client names or internal hostnames; a malformed rule is ignored rather than breaking capture.',
        ),
      },
    ],
  },
  {
    id: 'extractor',
    title: t('模型蒸馏', 'Distillation'),
    hint: t(
      '用一个模型把片段整理成带类型的记忆卡。默认走 harness：直接复用「设置 → 模型」里已经配好的 provider、密钥和思考强度，本插件不需要另存密钥。',
      'A model turns episodes into typed cards. The default route reuses the provider, key and thinking level already configured in Settings → Models, so this plugin stores no credentials of its own.',
    ),
    fields: [
      {
        path: ['extractor', 'enabled'],
        type: 'boolean',
        label: t('启用蒸馏', 'Enable distillation'),
        hint: t('关着时 memory_distill 会直接拒绝，不会偷偷调模型。', 'Off makes memory_distill refuse instead of calling a model.'),
      },
      {
        path: ['extractor', 'transport'],
        type: 'enum',
        options: [
          { value: 'harness', label: t('harness（复用设置里的模型）', 'harness (reuse the model in Settings)') },
          { value: 'http', label: t('http（自填地址和密钥）', 'http (own endpoint and key)') },
        ],
        label: t('模型来源', 'Model route'),
        hint: t('harness 用宿主已配置的路由；http 自己填 OpenAI 兼容接口。', 'harness borrows a route the harness already configured; http posts to your own endpoint.'),
      },
      {
        path: ['extractor', 'useCurrentModel'],
        type: 'boolean',
        label: t('跟随当前模型', 'Follow the current model'),
        hint: t(
          '开着就跟着「设置 → 模型」里选中的那个；关掉才用下面的 provider / 模型名。',
          'On follows whatever Settings → Models has selected; off uses the provider and model below.',
        ),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'harness',
      },
      {
        path: ['extractor', 'provider'],
        type: 'text',
        placeholder: 'deepseek / wb / agy-local',
        label: t('provider', 'provider'),
        hint: t('只有关掉"跟随当前模型"才需要。', 'Only needed when "follow the current model" is off.'),
        visible: (value) =>
          getPath(value, ['extractor', 'transport']) === 'harness' && getPath(value, ['extractor', 'useCurrentModel']) === false,
      },
      {
        path: ['extractor', 'reasoningEffort'],
        type: 'text',
        placeholder: t('留空跟随模型默认', 'empty keeps the model default'),
        label: t('思考强度', 'Thinking level'),
        hint: t(
          '例如 low / medium / high / max，取决于模型支持哪些；留空就是该模型的默认。',
          'e.g. low / medium / high / max, depending on the model; empty keeps the route default.',
        ),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'harness',
      },
      {
        path: ['extractor', 'maxEpisodesPerRun'],
        type: 'number',
        min: 1,
        max: 400,
        step: 1,
        unit: t('条', 'episodes'),
        label: t('每次最多蒸馏', 'Episodes per run'),
        hint: t('一次 memory_distill 处理多少片段。', 'How many episodes one memory_distill call handles.'),
      },
      {
        path: ['extractor', 'maxOutputTokens'],
        type: 'number',
        min: 256,
        max: 32000,
        step: 1,
        unit: 'tokens',
        label: t('输出上限', 'Output cap'),
        hint: t('单次蒸馏的 token 上限。', 'Token cap per distillation.'),
      },
      {
        path: ['extractor', 'timeoutMs'],
        type: 'number',
        min: 5000,
        max: 600000,
        step: 1000,
        unit: 'ms',
        label: t('请求超时', 'Request timeout'),
        hint: t('慢模型就调大。', 'Raise it for slow models.'),
      },
      {
        path: ['extractor', 'model'],
        type: 'text',
        placeholder: t('留空 = deepseek-chat', 'empty = deepseek-chat'),
        label: t('模型名', 'Model'),
        hint: t(
          'http 模式是接口里的模型名；harness 模式下关掉"跟随当前模型"才用到。',
          'In http mode the API model name; in harness mode only used when "follow the current model" is off.',
        ),
        visible: (value) =>
          getPath(value, ['extractor', 'transport']) === 'http' || getPath(value, ['extractor', 'useCurrentModel']) === false,
      },
      {
        path: ['extractor', 'baseUrl'],
        type: 'text',
        placeholder: 'https://api.deepseek.com/v1',
        label: t('接口地址', 'Base URL'),
        hint: t('OpenAI 兼容的 /v1 地址。', 'An OpenAI-compatible /v1 base URL.'),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'http',
      },
      {
        path: ['extractor', 'path'],
        type: 'text',
        placeholder: '/chat/completions',
        label: t('补全路径', 'Completion path'),
        hint: t('拼在接口地址后面。', 'Appended to the base URL.'),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'http',
      },
      {
        path: ['extractor', 'apiKeyEnv'],
        type: 'text',
        placeholder: 'MEMORY_LLM_API_KEY',
        label: t('密钥来源', 'Key source'),
        hint: t(
          '一个环境变量名，或 ~/.dsh/.credentials.yaml 的 refs 里的一项。',
          'An environment variable, or a name under refs: in ~/.dsh/.credentials.yaml.',
        ),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'http',
      },
      {
        path: ['extractor', 'apiKey'],
        type: 'secret',
        label: t('密钥（直接填）', 'Key (inline)'),
        hint: t(
          '不建议：会明文存进 profile 配置。优先用上面的密钥来源。留空表示不改动。',
          'Not recommended: stored in the profile config. Prefer the key source above. Empty leaves it untouched.',
        ),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'http',
      },
      {
        path: ['extractor', 'temperature'],
        type: 'number',
        min: 0,
        max: 2,
        step: 0.05,
        unit: '',
        label: t('采样温度', 'Temperature'),
        hint: t('只对 http 生效；harness 沿用模型设置。', 'http only; harness keeps the model settings.'),
        visible: (value) => getPath(value, ['extractor', 'transport']) === 'http',
      },
    ],
  },
  {
    id: 'auto',
    title: t('自动蒸馏', 'Automatic distillation'),
    hint: t(
      '关着的时候只有你按「蒸馏一次」或模型调 memory_distill 才会跑。打开后插件每分钟看一次有没有该蒸的（只看计数，不调模型、不花钱），命中下面任一规则才真的跑一次。',
      'While off, only the Distill now button or a memory_distill call runs a distillation. Turned on, the plugin looks once a minute (counting only — no model call, no cost) and runs only when one of the rules below matches.',
    ),
    fields: [
      {
        path: ['auto', 'enabled'],
        type: 'boolean',
        label: t('启用自动蒸馏', 'Enable automatic distillation'),
        hint: t(
          '自动跑的是同一个 distill()，用同一个模型、同一套打码规则。它花的是你的额度。',
          'It runs the same distill() with the same model and the same redaction rules — and spends your model budget.',
        ),
      },
      {
        path: ['auto', 'minEpisodes'],
        type: 'number',
        min: 0,
        max: 400,
        step: 1,
        unit: t('条', 'episodes'),
        label: t('攒够就蒸', 'Distill once this many pile up'),
        hint: t('未蒸馏的情节攒到这个数就跑一次；0 = 关掉这条规则。', 'Runs when this many undistilled episodes are waiting; 0 turns the rule off.'),
      },
      {
        path: ['auto', 'everyMinutes'],
        type: 'number',
        min: 0,
        max: 10080,
        step: 5,
        unit: t('分钟', 'min'),
        label: t('定时蒸', 'Distill on a schedule'),
        hint: t(
          '距上次自动蒸馏过了这么多分钟就跑一次；0 = 关掉这条规则。1440 是每天。',
          'Runs once this many minutes have passed since the last automatic run; 0 turns the rule off. 1440 is once a day.',
        ),
      },
      {
        path: ['auto', 'minGapMinutes'],
        type: 'number',
        min: 0,
        max: 1440,
        step: 5,
        unit: t('分钟', 'min'),
        label: t('最短间隔', 'Minimum gap'),
        hint: t(
          '两条规则共用：两次自动蒸馏至少隔这么久，免得刚攒够就被反复问。',
          'Shared by both rules: never two automatic runs closer than this, so a busy vault does not keep re-asking.',
        ),
      },
      {
        path: ['auto', 'quietHours'],
        type: 'text',
        placeholder: '23:00-08:00',
        label: t('静默时段', 'Quiet hours'),
        hint: t(
          '这段时间里不跑（可以跨午夜）；留空 = 全天都能跑。写不对就当没写，不会因此永远不跑。',
          'Nothing runs inside this window (it may cross midnight); empty means always. Unreadable text is ignored rather than silencing the feature forever.',
        ),
      },
      {
        path: ['auto', 'project'],
        type: 'text',
        placeholder: t('留空 = 最近情节的项目', "empty = the newest episode's project"),
        label: t('记到哪个项目', 'Project'),
        hint: t('自动蒸馏出的卡片归属哪个项目。', 'Which project automatic cards are filed under.'),
      },
    ],
  },
  {
    id: 'retrieval',
    title: t('召回', 'Recall'),
    hint: t(
      '模型主动调用 memory_search / memory_timeline 时才召回，绝不自动塞进上下文。',
      'Recall runs only when the agent calls memory_search / memory_timeline; nothing is injected automatically.',
    ),
    fields: [
      {
        path: ['retrieval', 'limit'],
        type: 'number',
        min: 1,
        max: 40,
        step: 1,
        unit: t('条', 'cards'),
        label: t('默认返回', 'Default results'),
        hint: t('memory_search 不指定 limit 时的条数。', 'Used when memory_search gets no limit.'),
      },
      {
        path: ['retrieval', 'hops'],
        type: 'number',
        min: 0,
        max: 2,
        step: 1,
        unit: t('跳', 'hops'),
        label: t('实体扩展', 'Entity expansion'),
        hint: t('沿共享实体再拉一层相邻卡片；0 只返回命中的卡片。', 'Pulls one more ring of cards through shared entities; 0 returns exact hits only.'),
      },
      {
        path: ['retrieval', 'snippetChars'],
        type: 'number',
        min: 60,
        max: 2000,
        step: 20,
        unit: t('字符', 'chars'),
        label: t('摘要长度', 'Snippet length'),
        hint: t('每条结果摘要截多长。', 'How much of each hit is shown.'),
      },
      {
        path: ['retrieval', 'timelineLimit'],
        type: 'number',
        min: 1,
        max: 200,
        step: 1,
        unit: t('条', 'cards'),
        label: t('时间线默认条数', 'Timeline size'),
        hint: t('memory_timeline 不指定条数时返回多少。', 'Used when memory_timeline gets no limit.'),
      },
    ],
  },
]

const ALL_FIELDS = SECTIONS.flatMap((section) => section.fields)

/** Public for `test/schema.mjs`: the page and the schema must describe the same fields. */
const FORM_SPEC = {
  entryId: HOST_ENTRY_ID,
  packageName: PACKAGE_NAME,
  sections: SECTIONS,
  /** Config paths the page can edit, dotted. */
  paths: ALL_FIELDS.map((field) => field.path.join('.')),
  /** Knobs that are deliberately *not* on this page. */
  structural: ['enabled', 'vaultDir', 'defaultProject', 'crossProject'],
}

// ---------------------------------------------------------------------------
// Value helpers (pure, shared by rendering and by the save path)
// ---------------------------------------------------------------------------

function getPath(value, path) {
  let node = value
  for (const key of path) {
    if (node === null || node === undefined) return undefined
    node = node[key]
  }
  return node
}

/** Copy `value` with one dotted path replaced; the source object is left alone. */
function setPath(value, path, next) {
  const [head, ...rest] = path
  const source = value !== null && typeof value === 'object' ? value : {}
  const copy = Array.isArray(source) ? source.slice() : { ...source }
  copy[head] = rest.length === 0 ? next : setPath(copy[head], rest, next)
  return copy
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** What the control shows for a raw config value. */
function displayValue(field, raw) {
  switch (field.type) {
    case 'boolean':
      return raw === true
    case 'list':
      return Array.isArray(raw) ? raw.join('\n') : raw === undefined || raw === null ? '' : String(raw)
    case 'enum':
      return raw === undefined || raw === null ? '' : String(raw)
    default:
      return raw === undefined || raw === null ? '' : String(raw)
  }
}

/** What a shown value means in config: the inverse of `displayValue`, plus whitespace trimming. */
function configValue(field, shown) {
  switch (field.type) {
    case 'boolean':
      return shown === true
    case 'number':
      return typeof shown === 'number' ? shown : Number(String(shown).trim())
    case 'list':
      return String(shown)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    case 'text':
    case 'secret':
      return String(shown)
    default:
      return shown
  }
}

function validateValue(field, value) {
  if (field.type !== 'number') return null
  if (!Number.isFinite(value)) return t('要填一个数字', 'a number is required')
  if (value < field.min) return t(`不能小于 ${field.min}`, `must be at least ${field.min}`)
  if (value > field.max) return t(`不能大于 ${field.max}`, `must be at most ${field.max}`)
  return null
}

// ---------------------------------------------------------------------------
// Reading the served form
// ---------------------------------------------------------------------------

function resolveForm(ctx) {
  try {
    const forms = ctx.get('configForms')
    if (!forms || typeof forms.get !== 'function') return null
    const form = forms.get(servedNamespace(ctx, forms))
    return form && typeof form.getSnapshot === 'function' ? form : null
  } catch {
    return null
  }
}

/**
 * Which settings namespace is ours.
 *
 * The browser boot gives every client plugin entry a generated id, so the entry
 * id is only a candidate: the namespace the settings service actually serves is
 * the one to use, and the host-side entry id from `cordis.patch.yml` is the
 * fallback that also works when the describe mirror is not readable yet.
 */
function servedNamespace(ctx, forms) {
  const candidates = []
  try {
    const entry = ctx && ctx.fiber ? ctx.fiber.entry : null
    const id = entry ? entry.id : null
    if (typeof id === 'string' && id !== '') {
      const colon = id.lastIndexOf(':')
      candidates.push(colon === -1 ? id : id.slice(colon + 1))
    }
  } catch {
    // No entry behind the façade (dynamic module): the static candidates stand.
  }
  candidates.push(PACKAGE_NAME, HOST_ENTRY_ID)
  try {
    const describe = forms && typeof forms.describe === 'function' ? forms.describe() : null
    const snapshot = describe && typeof describe.getSnapshot === 'function' ? describe.getSnapshot() : null
    const view = snapshot && snapshot.view
    const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : null
    if (namespaces) {
      for (const ns of candidates) {
        if (namespaces.some((row) => row && row.ns === ns)) return ns
      }
    }
  } catch {
    // Fall through to the static id.
  }
  return HOST_ENTRY_ID
}

// ---------------------------------------------------------------------------
// Styles — one labelled <style> element, owned by this package so the host's
// per-package stylesheet housekeeping removes it with the plugin.
// ---------------------------------------------------------------------------

const CSS = `
.mg-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 20px 26px 92px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 1.55;
}
.mg-head { display: flex; flex-direction: column; gap: 3px; }
.mg-title { font-size: 16px; font-weight: 600; }
.mg-sub { color: var(--dsw-alias-label-tertiary, #808080); font-size: 12px; }
.mg-card {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.mg-card-h { padding: 12px 14px 2px; }
.mg-card-t { font-weight: 600; font-size: 13px; }
.mg-card-d { color: var(--dsw-alias-label-tertiary, #808080); font-size: 11.5px; margin-top: 3px; }
.mg-rows { padding: 4px 14px 8px; }
.mg-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 0;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.07));
}
.mg-row:first-child { border-top: none; }
.mg-row-wide { display: block; }
.mg-row-wide .mg-ctl { margin-top: 7px; }
.mg-main { flex: 1 1 auto; min-width: 0; }
.mg-label { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.mg-hint { color: var(--dsw-alias-label-tertiary, #808080); font-size: 11.5px; margin-top: 2px; }
.mg-ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.mg-input {
  height: 28px;
  box-sizing: border-box;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  background: var(--dsw-alias-bg-layer-3, transparent);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.mg-input:focus { border-color: var(--dsw-alias-brand-primary, #3b6ef0); }
.mg-input:disabled { opacity: 0.55; }
.mg-num { width: 96px; text-align: right; }
.mg-text { width: 210px; }
.mg-select { width: 240px; cursor: pointer; }
.mg-area {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  background: var(--dsw-alias-bg-layer-3, transparent);
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.mg-area:focus { border-color: var(--dsw-alias-brand-primary, #3b6ef0); }
.mg-unit { color: var(--dsw-alias-label-tertiary, #808080); font-size: 11.5px; min-width: 16px; }
.mg-sw {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.22));
  cursor: pointer;
  transition: background 0.15s ease;
}
.mg-sw[data-on="true"] { background: var(--dsw-alias-brand-primary, #3b6ef0); }
.mg-sw > i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s ease;
}
.mg-sw[data-on="true"] > i { left: 18px; }
.mg-sw:disabled { opacity: 0.5; cursor: default; }
.mg-badge {
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(59, 110, 240, 0.14));
  color: var(--dsw-alias-brand-primary, #3b6ef0);
}
.mg-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-brand-primary, #3b6ef0);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.mg-link:disabled { opacity: 0.5; cursor: default; }
.mg-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 14px;
  border-radius: 10px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font-size: 11.5px;
}
.mg-state { display: flex; flex-direction: column; gap: 8px; padding: 26px 4px; max-width: 520px; }
.mg-state-t { font-weight: 600; }
.mg-state-d { color: var(--dsw-alias-label-secondary, #5a5a5a); font-size: 12px; }
.mg-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.mg-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px -26px -92px;
  padding: 10px 26px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-elevation-prominent, 0 -6px 18px rgba(0, 0, 0, 0.06));
}
.mg-msg { flex: 1 1 auto; min-width: 0; font-size: 11.5px; }
.mg-msg[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.mg-msg[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #c62828); }
.mg-btn {
  height: 28px;
  padding: 0 14px;
  border: none;
  border-radius: 7px;
  background: var(--dsw-alias-brand-primary, #3b6ef0);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.mg-btn:disabled { opacity: 0.55; cursor: default; }
.mg-btn-ghost {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.mg-btn-ghost:disabled { opacity: 0.55; cursor: default; }
.mgv-root { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 0; }
.mgv-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  flex: 0 0 auto;
}
.mgv-title { font-size: 12.5px; font-weight: 600; }
.mgv-counts { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 11.5px; }
.mgv-chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font-size: 11px;
}
.mgv-spacer { flex: 1 1 auto; }
.mgv-note {
  flex: 0 0 auto;
  padding: 6px 16px 7px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
}
.mgv-note-ok {
  color: var(--dsw-alias-state-success-primary, #1a7f37);
  background: rgba(26, 127, 55, 0.07);
}
.mgv-note-err {
  color: var(--dsw-alias-state-error-primary, #c62828);
  background: rgba(198, 40, 40, 0.06);
}
.mgv-body { display: flex; flex: 1 1 auto; min-height: 0; }
.mgv-canvas { flex: 1 1 auto; min-width: 0; display: block; touch-action: none; }
.mgv-link { stroke: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.16)); stroke-width: 1; }
.mgv-link[data-k="recall"] { stroke: var(--dsw-alias-state-success-primary, #1a7f37); stroke-dasharray: 3 3; }
.mgv-link[data-k="supersedes"] { stroke: var(--dsw-alias-state-warning-primary, #b26a00); }
.mgv-node { cursor: pointer; }
.mgv-node text {
  font-size: 10px;
  fill: var(--dsw-alias-label-secondary, #5a5a5a);
  pointer-events: none;
}
.mgv-node[data-k="session"] text { font-size: 11.5px; font-weight: 600; fill: var(--dsw-alias-label-primary, #1c1c1c); }
.mgv-node[data-k="card"] text { fill: var(--dsw-alias-label-primary, #1c1c1c); }
.mgv-node[data-k="episode"] text { font-size: 11px; }
.mgv-node[data-dim="true"] { opacity: 0.34; }
.mgv-node[data-selected="true"] circle { stroke: var(--dsw-alias-label-primary, #1c1c1c); stroke-width: 2; }
.mgv-aside {
  flex: 0 0 286px;
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  padding: 12px 14px;
  overflow: auto;
  font-size: 12px;
}
.mgv-aside-h { font-weight: 600; font-size: 12.5px; line-height: 1.45; }
.mgv-aside-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.mgv-aside-b { margin-top: 10px; color: var(--dsw-alias-label-secondary, #5a5a5a); line-height: 1.6; white-space: pre-wrap; }
.mgv-aside-tags { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 5px; }
.mgv-empty { padding: 40px 24px; max-width: 560px; }
.mgv-empty-t { font-weight: 600; margin-bottom: 8px; }
.mgv-empty-d { color: var(--dsw-alias-label-secondary, #5a5a5a); font-size: 12px; line-height: 1.7; }
.mgv-legend { display: flex; gap: 12px; align-items: center; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 11px; }
.mgv-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
`

function ensureStyle() {
  if (typeof document === 'undefined') return
  const host = document.head || document.documentElement
  if (!host) return
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    // Tag it as ours: the host collects unlabelled <style> elements into whichever
    // package materialises next and deletes them on reload, which would strip this
    // page without a refresh.
    style.dataset.plugin = PACKAGE_NAME
    style.dataset.pluginCss = STYLE_ID
    style.textContent = CSS
    host.appendChild(style)
  } else if (style.textContent !== CSS) {
    style.textContent = CSS
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function createPage(ctx, React) {
  const h = React.createElement
  const { useEffect, useRef, useState } = React

  function Page() {
    const [, bump] = useState(0)
    const [form, setForm] = useState(null)
    const [drafts, setDrafts] = useState({})
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState(null)
    const [hostReady, setHostReady] = useState(true)
    const [slowRead, setSlowRead] = useState(false)
    const attempts = useRef(0)

    useEffect(() => {
      ensureStyle()
      let disposed = false
      let stop = null
      let timer = null
      const attach = () => {
        if (disposed) return
        const found = resolveForm(ctx)
        if (!found) {
          // The client service arrives with whichever plugin provides it, so the
          // page can be mounted before `configForms` is reachable.
          attempts.current += 1
          if (attempts.current < 40) timer = setTimeout(attach, 250)
          else setHostReady(false)
          return
        }
        setForm(found)
        try {
          stop = found.subscribe(() => bump((n) => n + 1))
        } catch {
          // A form without subscribe still shows the first read.
        }
        bump((n) => n + 1)
      }
      attach()
      return () => {
        disposed = true
        if (timer) clearTimeout(timer)
        try {
          if (typeof stop === 'function') stop()
        } catch {
          // ignore
        }
      }
      // The form is resolved once per mount; the snapshot subscription drives redraws.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const snapshot = form && typeof form.getSnapshot === 'function' ? safeSnapshot(form) : null
    const value = snapshot && snapshot.status === 'ready' ? snapshot.value : null
    const user = (snapshot && snapshot.user) || {}
    const base = (snapshot && snapshot.base) || {}
    const writable = !snapshot || snapshot.writable !== false
    const status = snapshot ? snapshot.status : 'loading'

    // `value` is decoded by the settings service, so a form that never leaves
    // "loading" means the served value failed validation — worth saying out loud
    // rather than spinning forever.
    useEffect(() => {
      if (!form || status !== 'loading') {
        setSlowRead(false)
        return undefined
      }
      const timer = setTimeout(() => setSlowRead(true), 3000)
      return () => clearTimeout(timer)
    }, [form, status])

    const setDraft = (key, next) => {
      setNotice(null)
      setDrafts((prev) => ({ ...prev, [key]: next }))
    }
    const clearDraft = (key) => {
      setDrafts((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    }

    /** The value a control shows: the draft if the user touched it, else the served value. */
    const shownOf = (field) => {
      const key = field.path.join('.')
      if (Object.prototype.hasOwnProperty.call(drafts, key)) return drafts[key]
      return displayValue(field, getPath(value, field.path))
    }

    // Conditional knobs follow what the user is looking at, not the value the host
    // last sent: picking `http` has to reveal the endpoint fields before the save,
    // or the route reads as if it had no settings at all.
    const shownValue =
      Object.keys(drafts).length === 0
        ? value
        : ALL_FIELDS.reduce((acc, field) => {
            const key = field.path.join('.')
            if (!Object.prototype.hasOwnProperty.call(drafts, key)) return acc
            return setPath(acc, field.path, configValue(field, drafts[key]))
          }, value)

    const isDirty = (field) => {
      const key = field.path.join('.')
      if (!Object.prototype.hasOwnProperty.call(drafts, key)) return false
      const current = configValue(field, displayValue(field, getPath(value, field.path)))
      const next = configValue(field, drafts[key])
      if (field.type === 'number' && (!Number.isFinite(current) || !Number.isFinite(next))) return true
      return !sameValue(current, next)
    }

    const overridden = (field) => {
      const own = getPath(user, field.path)
      if (own === undefined) return false
      // A secret never rides back as a value, so the path being present is the
      // only signal there is. Everything else has to actually differ: one save
      // pins the whole served row, and badging values that merely repeat the
      // inherited default would claim edits nobody made.
      if (field.type === 'secret') return true
      const mine = configValue(field, displayValue(field, own))
      const inherited = configValue(field, displayValue(field, getPath(base, field.path)))
      return !sameValue(mine, inherited)
    }

    const collect = () => {
      const ops = []
      const errors = []
      for (const field of ALL_FIELDS) {
        if (!isDirty(field)) continue
        const key = field.path.join('.')
        const next = configValue(field, drafts[key])
        if (field.type === 'secret' && String(next).trim() === '') continue
        const problem = validateValue(field, next)
        if (problem) {
          errors.push(`${field.label}: ${problem}`)
          continue
        }
        ops.push({ op: 'set', path: field.path.slice(), value: next })
      }
      return { ops, errors }
    }

    const write = (ops, done) => {
      const run = () => {
        let pending
        try {
          pending = form.mutate(ops)
        } catch (error) {
          setBusy(false)
          setNotice({ kind: 'error', text: String((error && error.message) || error) })
          return
        }
        Promise.resolve(pending).then(
          (accepted) => {
            setBusy(false)
            if (accepted === false) {
              // The controller already re-read the host state on refusal, so the
              // page is consistent again; say so instead of silently reverting.
              setDrafts({})
              setNotice({
                kind: 'error',
                text: t(
                  '宿主拒绝了这次保存（配置刚被别处改过？），已重新读取。',
                  'The host refused the write (edited elsewhere?). Reloaded.',
                ),
              })
              return
            }
            setDrafts({})
            setNotice({ kind: 'ok', text: t('已保存，立即生效', 'Saved, live now') })
            if (done) done()
          },
          (error) => {
            setBusy(false)
            setNotice({ kind: 'error', text: String((error && error.message) || error) })
          },
        )
      }
      setBusy(true)
      setNotice(null)
      run()
    }

    const save = () => {
      if (!form) return
      const { ops, errors } = collect()
      if (errors.length > 0) {
        setNotice({ kind: 'error', text: errors.join(t('；', '; ')) })
        return
      }
      if (ops.length === 0) {
        setDrafts({})
        setNotice(null)
        return
      }
      write(ops)
    }

    const restore = (field) => {
      if (!form) return
      clearDraft(field.path.join('.'))
      write([{ op: 'unset', path: field.path.slice() }])
    }

    const dirtyCount = ALL_FIELDS.filter((field) => isDirty(field)).length

    // ---- states that are not the form ------------------------------------

    const statePanel = (title, lines) =>
      h(
        'div',
        { className: 'mg-root' },
        h(
          'div',
          { className: 'mg-state' },
          h('div', { className: 'mg-state-t' }, title),
          ...lines.map((line, index) =>
            h('div', { key: index, className: 'mg-state-d' }, ...(Array.isArray(line) ? line : [line])),
          ),
        ),
      )

    if (!hostReady) {
      return statePanel(t('这一页需要设置服务', 'This page needs the settings service'), [
        t(
          '浏览器端没有找到 settings 的配置表单服务（configForms），通常是「设置」这一域没有被装配。重启 DeepSeek Harness 之后再来一次。',
          'The browser half could not reach the settings form service (configForms), which usually means the settings domain was never composed. Restart DeepSeek Harness and come back.',
        ),
      ])
    }

    if (!form) {
      return statePanel(t('正在读取配置…', 'Reading configuration…'), [])
    }

    if (status === 'loading') {
      return statePanel(t('正在读取配置…', 'Reading configuration…'), slowRead
        ? [
            t(
              '读到了这一节，但值一直没通过校验，所以停在这里。多数情况是进程里跑的还是更新前的模块：重启 DeepSeek Harness 即可。',
              'The section was found but its value never validated, so the page waits. Usually the process still runs the pre-update module: restart DeepSeek Harness.',
            ),
          ]
        : [])
    }

    if (status !== 'ready' || !value) {
      return statePanel(t('这一页暂时读不到配置', 'Configuration is not served right now'), [
        t(
          '设置服务没有提供 memory-graph 这一节的字段。先确认该插件条目已启用；如果是刚更新的插件，重启 DeepSeek Harness 之后这一页就会出现。',
          'The settings service does not serve the memory-graph section. Check that the plugin entry is enabled; after a plugin update the page appears once DeepSeek Harness restarts.',
        ),
        [h('span', null, t('条目 id：', 'entry id: ')), h('span', { className: 'mg-code' }, HOST_ENTRY_ID), h('span', null, t('　状态：', '  status: ')), h('span', { className: 'mg-code' }, status)],
      ])
    }

    // ---- the form --------------------------------------------------------

    const control = (field) => {
      const key = field.path.join('.')
      const shown = shownOf(field)
      const disabled = !writable || busy
      const set = (next) => setDraft(key, next)

      if (field.type === 'boolean') {
        const on = shown === true
        return h(
          'button',
          {
            type: 'button',
            className: 'mg-sw',
            'data-field': key,
            'data-on': on ? 'true' : 'false',
            'aria-pressed': on,
            disabled,
            onClick: () => set(!on),
          },
          h('i', null),
        )
      }

      if (field.type === 'enum') {
        return h(
          'select',
          {
            className: 'mg-input mg-select',
            'data-field': key,
            value: shown,
            disabled,
            onChange: (event) => set(event.target.value),
          },
          (field.options || []).map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        )
      }

      if (field.type === 'list') {
        const lines = String(shown === '' ? '' : shown).split('\n').length
        return h('textarea', {
          className: 'mg-area',
          'data-field': key,
          rows: Math.min(9, Math.max(3, lines + 1)),
          spellCheck: false,
          value: String(shown),
          disabled,
          onChange: (event) => set(event.target.value),
        })
      }

      const inputType = field.type === 'secret' ? 'password' : 'text'
      return h('input', {
        className: field.type === 'number' ? 'mg-input mg-num' : 'mg-input mg-text',
        'data-field': key,
        type: inputType,
        value: String(shown),
        placeholder: field.placeholder || '',
        spellCheck: false,
        inputMode: field.type === 'number' ? 'decimal' : undefined,
        autoComplete: field.type === 'secret' ? 'new-password' : undefined,
        disabled,
        onChange: (event) => set(event.target.value),
      })
    }

    const row = (field) => {
      const key = field.path.join('.')
      const dirty = isDirty(field)
      const own = overridden(field)
      return h(
        'div',
        { key, className: field.wide ? 'mg-row mg-row-wide' : 'mg-row', 'data-path': key },
        h(
          'div',
          { className: 'mg-main' },
          h(
            'div',
            { className: 'mg-label' },
            h('span', null, field.label),
            own ? h('span', { className: 'mg-badge' }, t('已自定义', 'custom')) : null,
            dirty ? h('span', { className: 'mg-badge' }, t('未保存', 'unsaved')) : null,
          ),
          field.hint ? h('div', { className: 'mg-hint' }, field.hint) : null,
        ),
        h(
          'div',
          { className: 'mg-ctl' },
          control(field),
          field.type === 'number' && field.unit ? h('span', { className: 'mg-unit' }, field.unit) : null,
          own && dirty
            ? h(
                'button',
                { type: 'button', className: 'mg-link', disabled: busy || !writable, onClick: () => restore(field) },
                t('恢复默认', 'reset'),
              )
            : null,
        ),
      )
    }

    const visibleFields = (section) => section.fields.filter((field) => !field.visible || field.visible(shownValue))

    return h(
      'div',
      { className: 'mg-root' },
      h(
        'div',
        { className: 'mg-head' },
        h('div', { className: 'mg-title' }, t('记忆图谱', 'Memory graph')),
        h(
          'div',
          { className: 'mg-sub' },
          t(
            '长期联想记忆：原始片段 → 带类型的记忆卡 → 实体页。下面的每一项都立即生效，不需要重启。',
            'Long-term associative memory: raw episodes → typed cards → entity pages. Every knob below applies immediately, no restart.',
          ),
        ),
      ),

      ...SECTIONS.map((section) =>
        h(
          'section',
          { key: section.id, className: 'mg-card' },
          h(
            'div',
            { className: 'mg-card-h' },
            h('div', { className: 'mg-card-t' }, section.title),
            section.hint ? h('div', { className: 'mg-card-d' }, section.hint) : null,
          ),
          h('div', { className: 'mg-rows' }, visibleFields(section).map(row)),
        ),
      ),

      h(
        'div',
        { className: 'mg-note' },
        h(
          'div',
          null,
          t(
            '下面几项只在插件启动时读一次，因此不在这一页：总开关、记忆库目录、默认项目名、跨项目连接。改它们需要重载插件。',
            'Not on this page, because the plugin reads them once while activating: the master switch, the vault directory, the default project tag and cross-project linking. Changing one reloads the plugin.',
          ),
        ),
        h(
          'div',
          null,
          t('改它们：profile 的 ', 'To change one, edit '),
          h('span', { className: 'mg-code' }, 'cordis.patch.yml'),
          t(' 里 ', ' in the profile and look for the '),
          h('span', { className: 'mg-code' }, '- id: memory-graph'),
          t(' 那一行的 config。', ' row, under config.'),
        ),
        h(
          'div',
          null,
          t('当前记忆库：', 'Vault: '),
          h('span', { className: 'mg-code' }, String(getPath(value, ['vaultDir']) || '')),
        ),
      ),

      h(
        'div',
        { className: 'mg-bar' },
        h(
          'div',
          { className: 'mg-msg', 'data-kind': (notice && notice.kind) || '' },
          notice ? notice.text : dirtyCount > 0 ? t(`${dirtyCount} 项改动未保存`, `${dirtyCount} unsaved`) : '',
        ),
        h(
          'button',
          { type: 'button', className: 'mg-btn-ghost', disabled: busy || dirtyCount === 0, onClick: () => { setDrafts({}); setNotice(null) } },
          t('撤销改动', 'Discard'),
        ),
        h(
          'button',
          { type: 'button', className: 'mg-btn', disabled: busy || dirtyCount === 0 || !writable, onClick: save },
          busy ? t('保存中…', 'Saving…') : t('保存', 'Save'),
        ),
      ),
    )
  }

  return Page
}

function safeSnapshot(form) {
  try {
    return form.getSnapshot() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 对话页签：这个会话的记忆
//
// The tab sits in the Conversation view row beside 对话 and 上下文, so it is
// reached from the conversation it describes. The host answers on one exact
// Fetch route (`/api/memory-graph.graph`); Connection admits the browser's own
// cookie first and hands back only an owner Peer, so the panel never invents an
// auth scheme of its own.
//
// The layout is computed on the host. The browser therefore only maps points
// onto the viewBox and draws them: no simulation per render, no second layout
// when the tab is reopened, and the same picture for the same vault.
// ---------------------------------------------------------------------------

const KIND_FILL = {
  decision: '#3b6ef0',
  preference: '#7a4fd0',
  fact: '#1a7f37',
  plan: '#b26a00',
  constraint: '#c62828',
  note: '#5a6470',
}

// The two structural layers are not card kinds, so they get their own colours:
// an episode is this conversation's own words, an entity is what links it to
// everything else.
const EPISODE_FILL = '#9fb4d3'
const ENTITY_FILL = '#9aa4b2'

/**
 * The registered route is an absolute `/api/...` path, but the page that runs
 * this bundle is not always at the origin root: a mounted deployment serves the
 * GUI under a prefix, and a custom-scheme page has no usable origin at all. So
 * resolve explicit origin + path when the page has a real http(s) origin, and
 * fall back to letting the page resolve the path itself otherwise.
 */
function apiUrl(path) {
  try {
    const location = globalThis.location
    const origin = String((location && location.origin) || '')
    if (/^https?:\/\//.test(origin)) return `${origin}${path}`
  } catch {
    // No usable location: fall through to the bare path.
  }
  return path
}

function fillOf(node) {
  if (node.k === 'session') return '#111318'
  if (node.k === 'episode') return EPISODE_FILL
  if (node.k === 'entity') return ENTITY_FILL
  if (node.foreign) return '#e2e6ee'
  return KIND_FILL[node.kind] ?? KIND_FILL.note
}

function createGraphView(ctx, React) {
  const h = React.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  function kindText(node) {
    if (node.k === 'session') return t('本次会话', 'this session')
    if (node.k === 'episode') return t('情节', 'episode')
    if (node.k === 'entity') return t('实体', 'entity')
    const map = {
      decision: t('决定', 'decision'),
      preference: t('偏好', 'preference'),
      fact: t('事实', 'fact'),
      plan: t('计划', 'plan'),
      constraint: t('限制', 'constraint'),
      note: t('笔记', 'note'),
    }
    return map[node.kind] ?? node.kind
  }

  function statusText(status) {
    if (status === 'superseded') return t('已被推翻', 'superseded')
    if (status === 'retracted') return t('已撤回', 'retracted')
    return t('有效', 'active')
  }

  return function SessionMemoryView(props) {
    const sessionId = props && props.sessionId ? String(props.sessionId) : ''
    const [data, setData] = useState(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [distilling, setDistilling] = useState(false)
    const [distillNote, setDistillNote] = useState(null)
    const [selectedKey, setSelectedKey] = useState('')
    const [hoverKey, setHoverKey] = useState('')
    const ticket = useRef(0)
    const mounted = useRef(true)

    const load = useCallback(
      (quiet) => {
        if (sessionId === '') return undefined
        if (quiet !== true) setBusy(true)
        const mine = ++ticket.current
        return fetch(apiUrl(`${GRAPH_API}?session=${encodeURIComponent(sessionId)}`), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
          .then((response) =>
            response
              .json()
              .catch(() => null)
              .then((body) => ({ response, body })),
          )
          .then(({ response, body }) => {
            if (!mounted.current || mine !== ticket.current) return
            if (!response.ok || !body || body.ok !== true) {
              const why = (body && (body.message || body.reason)) || `HTTP ${response.status}`
              setError(String(why))
              setBusy(false)
              return
            }
            setData(body)
            setError('')
            setBusy(false)
          })
          .catch((failure) => {
            if (!mounted.current || mine !== ticket.current) return
            setError(String((failure && failure.message) || failure))
            setBusy(false)
          })
      },
      [sessionId],
    )

    useEffect(() => {
      mounted.current = true
      setData(null)
      setError('')
      setSelectedKey('')
      setHoverKey('')
      setDistillNote(null)
      if (sessionId === '') return undefined
      load(false)
      // The graph changes when you talk, distill, or edit a card elsewhere. A
      // quiet poll keeps the open tab honest without a spinner every 20 seconds.
      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        load(true)
      }, 20000)
      return () => {
        mounted.current = false
        clearInterval(timer)
        ticket.current += 1
      }
    }, [sessionId, load])

    const nodes = (data && data.nodes) || []
    const links = (data && data.links) || []
    const byKey = useMemo(() => {
      const map = new Map()
      for (const node of nodes) map.set(node.key, node)
      return map
    }, [nodes])
    const neighbours = useMemo(() => {
      const map = new Map()
      for (const node of nodes) map.set(node.key, new Set())
      for (const link of links) {
        map.get(link.s)?.add(link.t)
        map.get(link.t)?.add(link.s)
      }
      return map
    }, [nodes, links])

    const focus = hoverKey !== '' ? hoverKey : selectedKey
    const near = neighbours.get(focus)
    const selected = (selectedKey !== '' && byKey.get(selectedKey)) || null

    /**
     * Run one distillation and then re-read the graph.
     *
     * This is the only place in the panel that spends anything: the button posts
     * to the host, the host runs the same `distill()` the `memory_distill` tool
     * runs. Nothing is distilled unless somebody presses it — capture is passive,
     * and a background model call the user did not ask for would be a surprise
     * bill.
     */
    const distillNow = useCallback(() => {
      if (distilling) return
      setDistilling(true)
      setDistillNote(null)
      return fetch(apiUrl(DISTILL_API), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
        .then((response) =>
          response
            .json()
            .catch(() => null)
            .then((body) => ({ response, body })),
        )
        .then(({ response, body }) => {
          if (!mounted.current) return
          if (body && body.busy === true) {
            setDistillNote({ kind: 'err', text: t('已经有一次蒸馏在跑，等它结束。', 'A distillation is already running; let it finish.') })
          } else if (!body || body.ok !== true) {
            const why = (body && (body.message || body.reason)) || `HTTP ${response.status}`
            setDistillNote({ kind: 'err', text: String(why) })
          } else if ((body.episodes ?? 0) === 0) {
            setDistillNote({ kind: 'ok', text: String(body.reason || t('没有新情节要蒸馏。', 'Nothing new to distill.')) })
          } else {
            const batches = body.batches && body.batches.done > 1 ? t(` · ${body.batches.done} 批`, ` · ${body.batches.done} batches`) : ''
            setDistillNote({
              kind: 'ok',
              text: t(`读出 ${body.episodes} 条情节 → ${body.written} 张卡片${batches}`, `read ${body.episodes} episodes → ${body.written} cards${batches}`),
            })
          }
          setDistilling(false)
          load(true)
        })
        .catch((failure) => {
          if (!mounted.current) return
          setDistillNote({ kind: 'err', text: String((failure && failure.message) || failure) })
          setDistilling(false)
        })
    }, [distilling, load])

    const head = h(
      'div',
      { className: 'mgv-head' },
      h('span', { className: 'mgv-title' }, t('这个会话的记忆', 'Memory for this session')),
      data
        ? h(
            'span',
            { className: 'mgv-counts' },
            t(
              `${data.counts.episodes} 条情节 · ${data.counts.cards} 张卡片 · ${data.counts.entities} 个实体`,
              `${data.counts.episodes} episodes · ${data.counts.cards} cards · ${data.counts.entities} entities`,
            ),
          )
        : null,
      data && data.project ? h('span', { className: 'mgv-chip' }, data.project) : null,
      data && data.counts.foreign > 0
        ? h('span', { className: 'mgv-chip' }, t(`跨项目 ${data.counts.foreign}`, `${data.counts.foreign} cross-project`))
        : null,
      h('span', { className: 'mgv-spacer' }),
      h(
        'div',
        { className: 'mgv-legend' },
        h('span', null, h('i', { className: 'mgv-dot', style: { background: EPISODE_FILL } }), t('情节', 'episode')),
        h('span', null, h('i', { className: 'mgv-dot', style: { background: KIND_FILL.decision } }), t('卡片', 'card')),
        h('span', null, h('i', { className: 'mgv-dot', style: { background: ENTITY_FILL } }), t('实体', 'entity')),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mg-btn-ghost mgv-distill',
          disabled: distilling || sessionId === '',
          title: t(
            '把还没蒸馏的情节变成卡片（借设置里选中的模型，会花它的额度）',
            'Turn undistilled episodes into cards, borrowing the model selected in Settings (it spends that model budget)',
          ),
          onClick: distillNow,
        },
        distilling ? t('蒸馏中…', 'Distilling…') : t('蒸馏一次', 'Distill now'),
      ),
      h(
        'button',
        { type: 'button', className: 'mg-btn-ghost', disabled: busy || sessionId === '', onClick: () => load(false) },
        busy ? t('读取中…', 'Reading…') : t('刷新', 'Refresh'),
      ),
    )

    if (sessionId === '') {
      return h(
        'div',
        { className: 'mgv-root' },
        head,
        h(
          'div',
          { className: 'mgv-empty' },
          h('div', { className: 'mgv-empty-t' }, t('还没有选中的会话', 'No session selected')),
          h('div', { className: 'mgv-empty-d' }, t('打开一个会话再回来。', 'Open a conversation and come back.')),
        ),
      )
    }

    if (error !== '') {
      return h(
        'div',
        { className: 'mgv-root' },
        head,
        h(
          'div',
          { className: 'mgv-empty' },
          h('div', { className: 'mgv-empty-t' }, t('读不到记忆', 'Cannot read the memory vault')),
          h('div', { className: 'mgv-empty-d' }, error),
        ),
      )
    }

    if (!data) {
      return h(
        'div',
        { className: 'mgv-root' },
        head,
        h('div', { className: 'mgv-empty' }, h('div', { className: 'mgv-empty-d' }, t('读取中…', 'Reading…'))),
      )
    }

    if (data.empty) {
      return h(
        'div',
        { className: 'mgv-root' },
        head,
        h(
          'div',
          { className: 'mgv-empty' },
          h('div', { className: 'mgv-empty-t' }, t('这个会话还没有留下情节', 'This session has not left an episode yet')),
          h(
            'div',
            { className: 'mgv-empty-d' },
            t(
              '每聊完一轮就落一条原始片段。聊一轮再刷新，或者确认 设置 → 记忆图谱 里「记录对话」是开着的。',
              'One episode is written per finished turn. Talk a turn and refresh, or check that 记录对话 is on in Settings → Memory graph.',
            ),
          ),
        ),
      )
    }

    return h(
      'div',
      { className: 'mgv-root' },
      head,
      // What the last press of 蒸馏一次 did: a count, "nothing new", or why it
      // could not run. Printed as a line rather than a toast because the numbers
      // are worth reading twice.
      distillNote
        ? h('div', { className: `mgv-note mgv-note-${distillNote.kind} mgv-distill-note` }, distillNote.text)
        : null,
      // An empty half of the picture should say which half is missing: with no
      // cards in the vault the graph can only ever show episodes, and that reads
      // as "broken" unless it is spelled out.
      data && data.counts.cards === 0 && data.counts.episodes > 0
        ? h(
            'div',
            { className: 'mgv-note' },
            t(
              '记忆库里还没有卡片：蒸馏一次之后，这里会从这些情节长出卡片，以及把它们连起来的实体。',
              'No cards in the vault yet: one distillation grows cards — and the entities that link them — out of these episodes.',
            ),
          )
        : null,
      h(
        'div',
        { className: 'mgv-body' },
        h(
          'svg',
          {
            className: 'mgv-canvas',
            viewBox: '0 0 1080 640',
            preserveAspectRatio: 'xMidYMid meet',
            onClick: () => setSelectedKey(''),
          },
          links.map((link, i) => {
            const a = byKey.get(link.s)
            const b = byKey.get(link.t)
            if (!a || !b) return null
            const dim = focus !== '' && !(link.s === focus || link.t === focus)
            return h('line', {
              key: `l${i}`,
              className: 'mgv-link',
              'data-k': link.k,
              x1: a.x,
              y1: a.y,
              x2: b.x,
              y2: b.y,
              opacity: dim ? 0.35 : 0.9,
            })
          }),
          nodes.map((node) => {
            const dim = near !== undefined && !near.has(node.key) && node.key !== focus
            return h(
              'g',
              {
                key: node.key,
                className: 'mgv-node',
                'data-k': node.k,
                'data-dim': dim ? 'true' : 'false',
                'data-selected': node.key === selectedKey ? 'true' : 'false',
                onClick: (event) => {
                  event.stopPropagation()
                  setSelectedKey(node.key === selectedKey ? '' : node.key)
                },
                onMouseEnter: () => setHoverKey(node.key),
                onMouseLeave: () => setHoverKey(''),
              },
              h('circle', {
                cx: node.x,
                cy: node.y,
                r: node.r,
                fill: fillOf(node),
                stroke: node.k === 'session' ? 'none' : 'rgba(0,0,0,0.10)',
                strokeWidth: 1,
                strokeDasharray: node.foreign ? '2 2' : undefined,
              }),
              h(
                'text',
                {
                  x: node.x + node.r + 5,
                  y: node.y + 3.5,
                  textAnchor: node.k === 'session' ? 'middle' : 'start',
                  ...(node.k === 'session' ? { x: node.x, y: node.y - node.r - 8 } : {}),
                },
                node.k === 'session' ? t('本次会话', 'this session') : node.label,
              ),
            )
          }),
        ),
        selected
          ? h(
              'aside',
              { className: 'mgv-aside' },
              h('div', { className: 'mgv-aside-h' }, selected.k === 'session' ? t('本次会话', 'This session') : selected.k === 'entity' ? selected.label : selected.label),
              h(
                'div',
                { className: 'mgv-aside-meta' },
                h('span', { className: 'mgv-chip' }, kindText(selected)),
                selected.project ? h('span', { className: 'mgv-chip' }, selected.project) : null,
                selected.status ? h('span', { className: 'mgv-chip' }, statusText(selected.status)) : null,
                selected.created ? h('span', { className: 'mgv-chip' }, selected.created) : null,
              ),
              h(
                'div',
                { className: 'mgv-aside-b' },
                selected.k === 'session'
                  ? t(
                      `这个会话写下了 ${data.counts.episodes} 条情节，其中 ${data.recall.length} 张卡片会被它自己的话唤回（虚线的边）。`,
                      `${data.counts.episodes} episodes from this session; ${data.recall.length} cards would be recalled by its own words (dashed edges).`,
                    )
                  : selected.k === 'episode'
                    ? selected.text || t('（这一轮没有留下用户原文）', '(no user text in this turn)')
                    : selected.k === 'card'
                      ? selected.body || ''
                      : selected.k === 'entity'
                        ? t(
                            `被 ${selected.mentions ?? 0} 段记忆提到过。图上连着的卡片就是它串起来的记忆。`,
                            `Mentioned by ${selected.mentions ?? 0} memories. The cards joined to it are the memories it links.`,
                          )
                        : '',
              ),
              selected.entityNames && selected.entityNames.length > 0
                ? h(
                    'div',
                    { className: 'mgv-aside-tags' },
                    selected.entityNames.map((name, i) => h('span', { key: `e${i}`, className: 'mgv-chip' }, name)),
                  )
                : null,
              selected.status === 'superseded' && selected.supersededBy
                ? h('div', { className: 'mgv-aside-tags' }, h('span', { className: 'mgv-chip' }, t(`被 ${selected.supersededBy} 取代`, `replaced by ${selected.supersededBy}`)))
                : null,
              selected.tags && selected.tags.length > 0
                ? h(
                    'div',
                    { className: 'mgv-aside-tags' },
                    selected.tags.map((tag, i) => h('span', { key: `t${i}`, className: 'mgv-chip' }, `#${tag}`)),
                  )
                : null,
            )
          : null,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The two slots this bundle fills. Split out of `apply` so the suite can drive
 * it with a stub `ctx` and assert the exact registrations: which slot, which id,
 * which order, and that a fresh id is used rather than a shipped one (reusing
 * `chat` or `trajectory` would replace that cell instead of adding one).
 */
function registerSlots(ctx, React) {
  ensureStyle()
  const Page = createPage(ctx, React)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: HOST_ENTRY_ID,
        // 15 is 插件, 20 预设, 21 导入, 40 桌宠: sit between presets and the pet page.
        order: 25,
        label: () => t('记忆图谱', 'Memory Graph'),
      },
      Page,
    ),
  )

  // A view of its own in the Conversation row: after the chat (0) and the
  // context it burned (10), what survived it. Registering the entry is enough —
  // the row shows a tab once the session has more than one view.
  const SessionMemoryView = createGraphView(ctx, React)
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: GRAPH_VIEW_ID,
        order: 30,
        label: () => t('记忆', 'Memory'),
      },
      SessionMemoryView,
    ),
  )
}

if (typeof window === 'undefined' || !window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') {
  // Plain Node import (tests, schema tooling): publish what the suite needs and
  // touch nothing else. Headless by design — no document, no styles.
  globalThis.__memoryGraphFormSpec = FORM_SPEC
  globalThis.__memoryGraphClient = { FORM_SPEC, createPage, createGraphView, registerSlots, ensureStyle, PACKAGE_NAME, HOST_ENTRY_ID, STYLE_ID, GRAPH_API, DISTILL_API, GRAPH_VIEW_ID }
} else {
  window.__ModuleLoader__.load({
    id: PACKAGE_NAME,
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports
      const React = require('react')
      const h = React.createElement

      const name = PACKAGE_NAME
      const inject = ['slots']

      function apply(ctx) {
        registerSlots(ctx, React)
      }

      exports.name = name
      exports.inject = inject
      exports.apply = apply
      // Exposed for the host-side schema test and for debugging in devtools.
      exports.formSpec = FORM_SPEC
      exports.createGraphView = createGraphView
      exports.GRAPH_API = GRAPH_API
      exports.DISTILL_API = DISTILL_API
      exports.GRAPH_VIEW_ID = GRAPH_VIEW_ID
      return module.exports
    },
  })
}
