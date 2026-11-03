/**
 * The plugin's `Config` schema.
 *
 * The harness draws this plugin's page in 设置 (Settings) from the schema
 * exported here: `@deepseek-ai/dsh-settings` reads the `Config` of an active
 * profile entry, keeps only the fields marked `.volatile()`, and serves them to
 * the page as one editable form. A field that is *not* volatile never appears in
 * Settings — it is ordinary Cordis configuration, editable only by hand in
 * `cordis.patch.yml`, and changing it remounts the plugin.
 *
 * So the split below is a contract, not a style choice:
 *
 *   * `live(...)` leaves — knobs read at call time. A write reaches the running
 *     plugin through `loader/volatile-update` with no restart, which is what you
 *     want for thresholds, weights and patterns.
 *   * plain leaves — `enabled`, `vaultDir`, `defaultProject`, `crossProject`.
 *     They are consumed once while the plugin activates (register the tools,
 *     `mkdir` the vault, tag the session), so a live write could not take effect
 *     and would silently do nothing. Editing them is a re-activation, and the
 *     Loader performs one when an ordinary field changes.
 *
 * Every field here has a default, so an empty `config:` block in the profile
 * patch is valid. `src/config.js` still normalises whatever arrives: the form is
 * a convenience, not the contract.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SKIP_PATTERNS } from './config.js'

/**
 * Mark a leaf editable in Settings without remounting the plugin.
 *
 * A volatile leaf validates to a frozen `{ get() }` reference rather than a
 * value, so anything reading it must go through `resolveConfig` (which unwraps
 * refs — see `src/config.js`). Volatile is only allowed on a fixed object path,
 * which is why whole arrays (`skipPatterns`, `denyPatterns`) are marked instead
 * of their items.
 */
const live = (schema) => schema.volatile()

const capture = z.object({
  enabled: live(
    z
      .boolean()
      .default(true)
      .description('记录原始对话片段 · record raw episodes (off = nothing new is stored)'),
  ),
  userChars: live(
    z
      .number()
      .min(200)
      .max(20000)
      .step(100)
      .default(1500)
      .description('每条用户消息最多保留多少字符 · characters kept per user message'),
  ),
  assistantChars: live(
    z
      .number()
      .min(200)
      .max(20000)
      .step(100)
      .default(1500)
      .description('每条助手回复最多保留多少字符 · characters kept per assistant reply'),
  ),
  includeToolOutput: live(
    z
      .boolean()
      .default(false)
      .description('是否连工具输出一起记 · also store tool output (usually noise)'),
  ),
  minChars: live(
    z
      .number()
      .min(0)
      .max(500)
      .step(1)
      .default(12)
      .description('短于这个长度的消息不记 · ignore messages shorter than this'),
  ),
  skipPatterns: live(
    z
      .array(z.string())
      .default([...DEFAULT_SKIP_PATTERNS])
      .description('不记录的文本正则（整段替换默认值）· regexes whose matching messages are skipped; replaces the defaults'),
  ),
})

const privacy = z.object({
  useDefaultPatterns: live(
    z
      .boolean()
      .default(true)
      .description('启用内置密钥/令牌规则 · enable the built-in secret patterns'),
  ),
  denyPatterns: live(
    z
      .array(z.string())
      .default([])
      .description('额外强制打码的正则 · extra regexes redacted before anything is written'),
  ),
  redactEmails: live(
    z.boolean().default(true).description('邮箱打码 · redact email addresses'),
  ),
  redactPaths: live(
    z.boolean().default(true).description('本地路径打码 · redact local absolute paths'),
  ),
})

const extractor = z.object({
  enabled: live(
    z
      .boolean()
      .default(false)
      .description('用模型把片段蒸馏成记忆卡 · distil episodes into cards with a model'),
  ),
  transport: live(
    z
      .union([z.const('harness'), z.const('http')])
      .default('harness')
      .description(
        '从哪里取模型：harness = 复用设置里已经配好的模型和密钥；http = 自己填地址和密钥 · where the model comes from: harness borrows a route configured in Settings, http posts to your own endpoint',
      ),
  ),
  useCurrentModel: live(
    z
      .boolean()
      .default(true)
      .description(
        'harness 模式下跟随「设置 → 模型」当前选中的模型 · harness: use the model currently selected in Settings → Models',
      ),
  ),
  provider: live(
    z
      .string()
      .default('')
      .description(
        'harness 模式下的 provider（如 deepseek、wb、agy-local）；只有关掉 useCurrentModel 才需要 · harness provider id, only when useCurrentModel is off',
      ),
  ),
  reasoningEffort: live(
    z
      .string()
      .default('')
      .description(
        '思考强度（如 low/medium/high，取决于模型）；留空跟随该模型的默认 · thinking level for distillation; empty keeps the route default',
      ),
  ),
  baseUrl: live(
    z
      .string()
      .default('https://api.deepseek.com/v1')
      .description('仅 http 模式：OpenAI 兼容接口地址 · http transport only: OpenAI-compatible base URL'),
  ),
  path: live(
    z.string().default('/chat/completions').description('仅 http 模式：补全路径 · http transport only: completion path'),
  ),
  model: live(
    z
      .string()
      .default('')
      .description(
        '模型名；http 模式留空即 deepseek-chat，harness 模式下只有关掉 useCurrentModel 才用到 · model name; http mode falls back to deepseek-chat',
      ),
  ),
  apiKeyEnv: live(
    z
      .string()
      .default('MEMORY_LLM_API_KEY')
      .description(
        '仅 http 模式：放密钥的环境变量或 ~/.dsh/.credentials.yaml 里的 ref 名 · http transport only: env var or credentials ref holding the key',
      ),
  ),
  apiKey: live(
    z
      .string()
      .role('secret')
      .default('')
      .description(
        '仅 http 模式：直接写密钥（不建议，会存进 profile 配置）· http transport only: inline key (not recommended)',
      ),
  ),
  maxOutputTokens: live(
    z
      .number()
      .min(256)
      .max(32000)
      .step(1)
      .default(3000)
      .description('单次蒸馏输出上限 · output token cap per run'),
  ),
  temperature: live(
    z
      .number()
      .min(0)
      .max(2)
      .step(0.05)
      .default(0.1)
      .description('仅 http 模式：采样温度（harness 模式沿用模型设置）· http transport only: sampling temperature'),
  ),
  timeoutMs: live(
    z
      .number()
      .min(5000)
      .max(600000)
      .step(1000)
      .default(90000)
      .description('请求超时（毫秒）· request timeout in ms'),
  ),
  maxEpisodesPerRun: live(
    z
      .number()
      .min(1)
      .max(400)
      .step(1)
      .default(40)
      .description('一次最多蒸馏多少片段 · episodes handled per run'),
  ),
})

const retrieval = z.object({
  limit: live(z.number().min(1).max(40).step(1).default(8).description('默认返回几条 · default result count')),
  hops: live(z.number().min(0).max(2).step(1).default(1).description('沿实体扩展几跳 · co-mention expansion hops')),
  snippetChars: live(
    z
      .number()
      .min(60)
      .max(2000)
      .step(20)
      .default(220)
      .description('每条摘要截多长 · snippet length'),
  ),
  timelineLimit: live(
    z
      .number()
      .min(1)
      .max(200)
      .step(1)
      .default(30)
      .description('时间线默认条数 · timeline default size'),
  ),
})

/**
 * The automatic distiller. Two independent rules over one minute-long tick:
 * "this many episodes are waiting" and "this many minutes have passed". Both are
 * live, so switching one on takes effect without remounting the plugin — and both
 * default to zero/off, because a background run spends the user's model budget.
 */
const auto = z.object({
  enabled: live(
    z
      .boolean()
      .default(false)
      .description('自动蒸馏总开关 · run distillations without being asked (spends model budget)'),
  ),
  minEpisodes: live(
    z
      .number()
      .min(0)
      .max(400)
      .step(1)
      .default(0)
      .description('攒够多少条未蒸馏情节就蒸一次；0 = 关闭这条规则 · distill once this many episodes are waiting; 0 turns the rule off'),
  ),
  everyMinutes: live(
    z
      .number()
      .min(0)
      .max(10080)
      .step(5)
      .default(0)
      .description('每隔多少分钟蒸一次；0 = 关闭这条规则 · distill at most every N minutes; 0 turns the rule off'),
  ),
  minGapMinutes: live(
    z
      .number()
      .min(0)
      .max(1440)
      .step(5)
      .default(30)
      .description('两次自动蒸馏之间至少隔多久 · minimum gap between two automatic runs'),
  ),
  quietHours: live(
    z
      .string()
      .default('')
      .description('不跑的时间段，如 23:00-08:00；空 = 全天 · quiet window like 23:00-08:00; empty = always on'),
  ),
  project: live(
    z
      .string()
      .default('')
      .description('自动蒸馏记到哪个项目；空 = 最近情节的项目 · project for automatic cards; empty = the newest episode\'s project'),
  ),
})

export const Config = z.object({
  // Structural: read once while activating. Editing one remounts the plugin,
  // which is exactly the semantics it needs, so they stay ordinary.
  enabled: z
    .boolean()
    .default(true)
    .description('总开关；关掉后工具和记录都不注册 · master switch; off registers neither tools nor capture'),
  vaultDir: z
    .string()
    .default('')
    .description('记忆库目录，留空是 ~/dsh-memory · vault directory; empty means ~/dsh-memory'),
  defaultProject: z
    .string()
    .default('shared')
    .description('会话没有可用目录时用的项目名 · project tag when a session has no usable cwd'),
  crossProject: z
    .boolean()
    .default(true)
    .description('把新卡片连到项目实体上，跨项目可召回 · link cards into project hubs so recall crosses projects'),
  capture,
  privacy,
  extractor,
  auto,
  retrieval,
})

export default Config
