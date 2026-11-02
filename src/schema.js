/**
 * The plugin's `Config` schema.
 *
 * The harness renders the Settings form for a plugin from the schema it exports,
 * and it builds that schema with schemastery — the same library every bundled
 * plugin uses. This file is the plugin's only runtime dependency; `index.js`
 * loads it opportunistically, so a bare checkout that has not run `npm install`
 * still works (with these defaults) and simply shows no Settings form.
 *
 * Every field here has a default, so an empty `config:` block in the profile
 * patch is valid. `src/config.js` still normalises whatever arrives: the form is
 * a convenience, not the contract.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SKIP_PATTERNS } from './config.js'

const capture = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('记录原始对话片段 · record raw episodes (off = nothing new is stored)'),
  userChars: z
    .number()
    .min(200)
    .max(20000)
    .step(100)
    .default(1500)
    .description('每条用户消息最多保留多少字符 · characters kept per user message'),
  assistantChars: z
    .number()
    .min(200)
    .max(20000)
    .step(100)
    .default(1500)
    .description('每条助手回复最多保留多少字符 · characters kept per assistant reply'),
  includeToolOutput: z
    .boolean()
    .default(false)
    .description('是否连工具输出一起记 · also store tool output (usually noise)'),
  minChars: z
    .number()
    .min(0)
    .max(500)
    .step(1)
    .default(12)
    .description('短于这个长度的消息不记 · ignore messages shorter than this'),
  skipPatterns: z
    .array(z.string())
    .default([...DEFAULT_SKIP_PATTERNS])
    .description('不记录的文本正则（整段替换默认值）· regexes whose matching messages are skipped; replaces the defaults'),
})

const privacy = z.object({
  useDefaultPatterns: z
    .boolean()
    .default(true)
    .description('启用内置密钥/令牌规则 · enable the built-in secret patterns'),
  denyPatterns: z
    .array(z.string())
    .default([])
    .description('额外强制打码的正则 · extra regexes redacted before anything is written'),
  redactEmails: z
    .boolean()
    .default(true)
    .description('邮箱打码 · redact email addresses'),
  redactPaths: z
    .boolean()
    .default(true)
    .description('本地路径打码 · redact local absolute paths'),
})

const extractor = z.object({
  enabled: z
    .boolean()
    .default(false)
    .description('用模型把片段蒸馏成记忆卡 · distil episodes into cards with a model'),
  transport: z
    .union([z.const('harness'), z.const('http')])
    .default('harness')
    .description(
      '从哪里取模型：harness = 复用设置里已经配好的模型和密钥；http = 自己填地址和密钥 · where the model comes from: harness borrows a route configured in Settings, http posts to your own endpoint',
    ),
  useCurrentModel: z
    .boolean()
    .default(true)
    .description(
      'harness 模式下跟随「设置 → 模型」当前选中的模型 · harness: use the model currently selected in Settings → Models',
    ),
  provider: z
    .string()
    .default('')
    .description(
      'harness 模式下的 provider（如 deepseek、wb、agy-local）；只有关掉 useCurrentModel 才需要 · harness provider id, only when useCurrentModel is off',
    ),
  reasoningEffort: z
    .string()
    .default('')
    .description(
      '思考强度（如 low/medium/high，取决于模型）；留空跟随该模型的默认 · thinking level for distillation; empty keeps the route default',
    ),
  baseUrl: z
    .string()
    .default('https://api.deepseek.com/v1')
    .description('仅 http 模式：OpenAI 兼容接口地址 · http transport only: OpenAI-compatible base URL'),
  path: z.string().default('/chat/completions').description('仅 http 模式：补全路径 · http transport only: completion path'),
  model: z
    .string()
    .default('')
    .description(
      '模型名；http 模式留空即 deepseek-chat，harness 模式下只有关掉 useCurrentModel 才用到 · model name; http mode falls back to deepseek-chat',
    ),
  apiKeyEnv: z
    .string()
    .default('MEMORY_LLM_API_KEY')
    .description(
      '仅 http 模式：放密钥的环境变量或 ~/.dsh/.credentials.yaml 里的 ref 名 · http transport only: env var or credentials ref holding the key',
    ),
  apiKey: z
    .string()
    .role('secret')
    .default('')
    .description(
      '仅 http 模式：直接写密钥（不建议，会存进 profile 配置）· http transport only: inline key (not recommended)',
    ),
  maxOutputTokens: z
    .number()
    .min(256)
    .max(32000)
    .step(1)
    .default(3000)
    .description('单次蒸馏输出上限 · output token cap per run'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .step(0.05)
    .default(0.1)
    .description('仅 http 模式：采样温度（harness 模式沿用模型设置）· http transport only: sampling temperature'),
  timeoutMs: z
    .number()
    .min(5000)
    .max(600000)
    .step(1000)
    .default(90000)
    .description('请求超时（毫秒）· request timeout in ms'),
  maxEpisodesPerRun: z
    .number()
    .min(1)
    .max(400)
    .step(1)
    .default(40)
    .description('一次最多蒸馏多少片段 · episodes handled per run'),
})

const retrieval = z.object({
  limit: z.number().min(1).max(40).step(1).default(8).description('默认返回几条 · default result count'),
  hops: z.number().min(0).max(2).step(1).default(1).description('沿实体扩展几跳 · co-mention expansion hops'),
  snippetChars: z
    .number()
    .min(60)
    .max(2000)
    .step(20)
    .default(220)
    .description('每条摘要截多长 · snippet length'),
  timelineLimit: z
    .number()
    .min(1)
    .max(200)
    .step(1)
    .default(30)
    .description('时间线默认条数 · timeline default size'),
})

export const Config = z.object({
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
  retrieval,
})

export default Config
