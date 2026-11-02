# Changelog

## 0.5.0 — 2026-11-02

蒸馏在真实记忆库上第一次跑就失败，暴露了两件事：一次调用喂不完一整个后台，以及同一件事会在图上长成两张卡。

**Added**

- `extract.js` 分批蒸馏：`maxEpisodesPerRun` 依旧是一次蒸馏读多少条，但每批条数按 `maxOutputTokens` 折算（约 320 输出 token 一条情节），一批一次调用、批批独立落盘。某一批失败（限流 / 超时 / 断网）时，前面几批的卡片和蒸馏游标都留着，`memory_distill` 会照实报"已经写下 N 张"。
- 截断自愈：某一批撞上输出上限就把这批对半拆开重试（递归到单条为止），单条还超才是真失败。两条路线都认这件事——harness 侧看 `finish.kind === 'max-tokens'`，http 侧看 `finish_reason === 'length'`（后者以前会当成 JSON 解析失败报错，误导方向）。
- 近义标题去重（`src/vault.js` 的 `titleSimilarity` / `NEAR_DUPLICATE`）：同一项目里标题词面重合度 ≥ 0.55 视为同一张卡，归一化到老卡（id 不变、正文取更全的那份、实体取并集）。写进审计日志时会注明是哪个标题以多少分被并进来的。
- 带 `supersedes` 的卡片跳过近义判断：推翻是有意的写入，"监控换成 Prometheus"和"监控换到 Uptime Kuma"词面再像也是新决定。
- `test/live.mjs --backlog N` / `--tokens N`：把真实联网测试扩成"能看到分批"——12 条情节、3 000 输出上限时，日志里会写 `2/2 batch(es) of 9`。

**Changed**

- `memory_distill` 的文案分开报新卡与重新确认（`4 card(s) · 4 re-confirmed`），并写明分了几批、每批几条；`dryRun` 明确只预览第一批、还剩多少条。
- 设置页的「已自定义」标只在**真的和继承值不同**时出现：一次保存会钉住整行配置，值恰好等于默认的那些以前也被标成改过，看着像人改了三个设置。密钥例外（它的值不回传，只能看路径在不在）。`test/client.mjs` 21 项，其中一项就是拿"等值钉住"当输入。
- README / README.en：新增「一次蒸馏会分几批」一节、"已知边界"里把去重从"标题完全相同"改成"词面重合 ≥ 0.55（含 `supersedes` 例外）"，实测表补上 12 条情节分两批那一行，并写下这次踩坑的原话：第一版一次调用喂完后台，被 3 000 token 截断，整批白跑。
- 测试口径：`npm test` 163 项检查（43 + 13 + 21 + 11 + 21 + 54）。

**Fixed**

- 23 条积压情节在有 3 000 输出上限时必定失败（`Extractor output reached maxOutputTokens`）——默认配置下第一次蒸馏就是不可用的。现在同一份后台分几次小调用，实测 12 条 → 2 批 → 4 张卡、5.9 s。
- 同一段对话分两批蒸馏时，模型给同一件事换了措辞（「长期记忆采用…纯文本库」/「长期记忆库采用…纯文本结构」），以前会写成两张卡、两个节点互相稀释检索分数。

## 0.4.0 — 2026-11-02

真正的设置页：插件在 **设置 → 记忆图谱** 里有自己的一页，四组、28 个字段，保存即生效。

**Added**

- `client.js`：手写 `window.__ModuleLoader__.load` factory 的浏览器侧 bundle，零构建、零 JSX、只 `require('react')`。往 `settings.section` 槽注册一页（id `memory-graph`，order 25，在「模型」和「内置插件」之间），四张分组卡片：采集 / 隐私 / 抽取器 / 检索。
- 每个字段都带中英文说明、单位、占位符和边界；改过的字段打「已改」标，旁边的「恢复默认」发的是 `unset`（退回继承层），不是把值写成空串。
- 底部粘着一条保存栏：未保存改动数、保存中、成功/失败提示；宿主只读时保存按钮直接禁用。保存被拒（`mutate` 返回 `false`）会清空草稿并提示"配置刚被别处改过"，而不是假装成功。
- 抽取器那一组跟着路线走：`transport: 'harness'` 只显示模型相关的几项，选 `http` 才出现 endpoint / 路径 / key / temperature，`useCurrentModel` 与 `provider` 反过来隐藏。切换在下一次保存前就能看到效果（可见性用草稿值算，不是等回读）。
- 页面底部写明哪四项不在这页上（总开关 / 记忆库目录 / 默认项目 / 跨项目连接）、为什么、以及去 `cordis.patch.yml` 的哪一行改。
- `test/client.mjs`（20 项）：用一个最小 React 替身把页面真挂起来跑——控件与字段表一致、`transport` 切换后 http 项才出现、空的内联 key 不会被当成"删除"发出去、越界数字到不了线上、宿主拒绝后清空草稿并报错、`unset` 与 `set` 不混用、样式表只有一个带包名标记的 `<style>`、`client.js` 里不许有 `export`/`import`（loader 按脚本求值）；最后把 `client.js` 放进一个带 `window.__ModuleLoader__` 的假页面里求值，走一遍 factory → `apply` → `settings.section` 的**真实浏览器路径**（只 require `react`、注册 id 是包名、order 25、侧栏标签跟随语言）。
- `package.json`：新增 `exports["./client"]`、`dsh.client = { platform: 'web', inject: [] }`，`files` 带上 `client.js`。

**Fixed**

- **设置里一直没有这个插件的根因**：`@deepseek-ai/dsh-settings` 的 `describe()` 只投影声明为 `.volatile()` 的字段（`volatileForm(schema)` 拿不到 volatile 叶子就返回 `undefined`，整个条目被跳过）。0.3.0 导出的 `Config` 是对的，但 32 个叶子全是普通字段，所以永远不显示。现在 28 个"调用时才读"的字段标了 `.volatile()`，`enabled` / `vaultDir` / `defaultProject` / `crossProject` 保持普通（它们在激活期被消费，改了本来就是重载）。
- volatile 写入只走 `loader/volatile-update`、**不会重跑 `apply`**，所以三处快照都得跟着改，否则"即时生效"只是页面上的假象：`capture.enabled` 从注册期提前返回改成每条事件判断；`createRedactor` 在 volatile 更新时重建；`skipRules` 惰性重编译。
- `src/config.js` 新增 `unwrapConfig`：volatile 字段到达 `apply` 时是引用对象（`{[Symbol.for('cosmokit.volatile.write')]: fn, get: fn}`），直接 `{...DEFAULTS, ...config}` 会静默得到默认值加一个 `get` 函数。

**Changed**

- 配置入口从「schemastery 的通用表单」换成自己的页面；README / README.en 的「配置」一节重写（四组、默认值表、哪些键不在这页上、为什么）。
- **装完、或改过 `client.js` / `package.json` 之后必须重启一次 Harness**：Web 侧的插件清单是启动时扫一遍 loader 条目、读各自 `package.json` 的 `dsh.client` 定的，这份扫描结果在进程里缓存、不再重读。README 里写清了，免得装完以为插件坏了。
- 测试口径：`npm test` 151 项检查（38 + 13 + 20 + 11 + 21 + 48）。

## 0.3.0 — 2026-11-02

设置界面 + 直接复用设置里已经配好的模型。

**Added**

- `Config` schema（`src/schema.js`）：DSH 的 Settings 表单是照着插件导出的 schema 画的，之前没导出，所以设置里根本没有这一行。现在 32 个设置项全部带中英文说明，包括 `vaultDir`、`capture.*`、`privacy.*`、`extractor.*`、`retrieval.*`；每一格都有默认值，空的 `config:` 依然合法。
- `test/schema.mjs`（9 项）：表单和运行时两条默认值**双向**比对，多一格没用的、少一格看不见的都算失败（只放过 `vaultDir`——表单存原始文本、运行时存绝对路径）；顺带锁住 `transport` 的取值、数值边界、`apiKey` 的 `secret` 角色、以及所有设置项都真的出现在投影出来的 schema 里。
- `extractor.transport: 'harness'`（默认）：蒸馏不再要求另配 endpoint 和 key，而是向 Harness 的 `llm` 服务借一次调用，提供商 / 模型 / **思考强度**全部照搬 **Settings → 模型**里的当前选择（`agentDefaultModel.currentSelection()`）。设置里配过的 key 直接生效，插件不碰凭据。
- `extractor.useCurrentModel` / `provider` / `reasoningEffort`：想钉死一个抽取专用模型就关掉跟随、填 provider + model；想换思考档就填 `reasoningEffort`（留空沿用设置里的那一档）。
- `extractor.transport: 'http'`：原来的直连路线保留，一个字段切回去。`baseUrl` / `path` / `model` / `apiKeyEnv` / `apiKey` / `temperature` 现在都标注为 http 专用。
- `extractor.apiKey` 标了 `role('secret')`，同时在 README 里明说**不要用它**——表单里填的密钥会明文落进 profile 配置，`apiKeyEnv` 指向凭据库才是设计上的路线。
- `memory_stats` 新增一行 `extractor:`，说明当前走哪条路、用哪个模型、思考档是什么；`memory_distill` 的报告里也带上了 `model` 和来源。只报来源，不报值。
- `test/extract.mjs` 从 34 项扩到 48 项：新增 harness 路线的假 `llm` 服务（借用设置模型、显式覆盖、没选模型时的报错、`finish` 的 error / max-tokens / aborted、取消时说明是谁取消的、空回复、全程不碰 `fetch`）。

**Changed**

- harness 路线**不传 `temperature`**：采样交给被借用的那一路模型，避免和某些提供商的思考模式打架；`extractor.temperature` 因此只在 http 模式下生效。
- 报告与审计行改为 `model=<provider>/<model> via=harness route=<来源 · effort <档>>`。
- `test/live.mjs` / `test/live-supersede.mjs` 显式写 `transport: 'http'`：这两个脚本跑在普通 `node` 进程里，没有 Harness 的 `llm` 服务可借，改成默认 harness 后它们会连不上。
- `extractor.model` 的空值处理按路线分开：默认值改成空，http 模式在归一化时回退到 `deepseek-chat`；harness 模式下被清空就是空，由路由检查报「缺 provider/model」，而不是悄悄用一个别的模型顶上去。
- 插件不再是"零依赖"：`index.js` 会试着加载 `@deepseek-ai/schemastery`（Harness 自带的那个，也是所有官方插件用的那个），加载不到就退化成"没有表单、跑默认值"，插件本身照样起来。所以**裸仓库 + `link:` 安装需要先 `npm install` 一次**，README 的安装步骤已加这一句。
- `package.json` 的 `description` 同步改口径（原文写着 "Zero dependencies"）。

## 0.2.0 — 2026-11-02

记忆图视图、离线评测，以及「问的是过去还是现在」这条通路。

**Added**

- `graph.html`：每次写入后重新生成的**单文件**记忆图。力导向布局，实体是枢纽节点，卡片按 kind 着色，虚边是「已被替换」，支持搜索、按项目过滤、点击卡片看详情、悬停高亮邻居、缩放平移。零依赖、无 CDN、无构建步骤，直接双击打开；跟随系统深浅色。入口是 `vault.regenerateGraph()`，`memory_stats` 会告诉你文件在哪。
- `eval/`：38 张卡片 / 4 条 supersede 链 / 33 道题的离线评测，跑的是仓库里真实的 `searchCards`。`npm run eval` 给出分组 recall@1 / recall@5 / MRR、逐题名次、negative 明细和 PASS/FAIL 判定；`eval/REPORT.md` 记录八个已知弱点和「这份评测容易高估你的地方」。
- `test/extract.mjs`（34 项）：`fetch` 打桩测蒸馏器——prompt 构造、key 解析顺序、容错 JSON 解析、逐卡 project 归属、游标推进、dry run 不落盘、密文不落地。
- `test/live.mjs` / `test/live-supersede.mjs`：真模型端到端。前者 3 段 episode → 蒸馏 → 搜回来；后者记录一个决定、再改口，检查 `supersedes` 链和 `valid_to` 是不是真的动了。
- `extractor.baseUrl` / `extractor.model` / `extractor.maxEpisodesPerRun` 配置项；key 可以只写在 `~/.dsh/.credentials.yaml` 的 `refs:` 下，报告来源而不打印值。

**Changed**

- 检索：`superseded` 卡片基础权重 0.4 → **0.15**，并新增「命中作废卡则把它当前有效的继任卡拉进来」（权重 0.9）——措辞停留在旧词时，答案应该是最新状态。
- 检索：问句意图分流。命中历史意图（最早 / 当初 / 上一版 / 原来那 / used to …）时，作废卡恢复全权重、**且不再触发继任卡拉取**；否则维持降权 + 拉取。同一句话换个时态就该给另一个答案。
- 中文分词：多字虚词表扩充（`什么 怎么 如何 哪些 这个 那个 …`），并新增一条**字规则**——bigram 两端只要碰到纯语法字就丢弃，取代「枚举虚词 + 削尾字」。`有`、`不`、`得` 刻意不在字表里：它们在 `所有`、`不同`、`得到` 里是实词的一部分，第一版把它们也算进去，把「所有项目都要零依赖吗」这个问题在问的东西一起丢掉了。
- `postToolUse` 之后重新生成 README 与 graph.html 的调用合并成 `refreshViews()`，任一步失败只记 warn，不影响写入。

**Fixed**

- 作废卡在前面挡路：措辞没跟上改口时，正确的新卡片排不到前面。
- `原来 Kuma 只做外部拨测啊` 这类「原来 = 原来如此」被当成历史意图，把作废卡放大 6.7 倍。`原来` 已从意图正则里拿掉（保留 `原来那`）。

## 0.1.0 — 2026-11-01

第一个可用版本。

**Added**

- 三层存储，纯文本、每张卡片一个文件、append-only：`episodes/`（原话，永不改写）→ `cards/`（结论型记忆，带 kind / project / entities / valid_from / valid_to）→ `entities/`（跨项目枢纽）。
- 八个工具：`memory_search`、`memory_timeline`、`memory_get`、`memory_remember`、`memory_forget`、`memory_distill`、`memory_graph`、`memory_stats`。**只在模型主动查的时候给**，不做自动注入。
- 采集：`session/event` 钩子把用户原话和助手回复写进当天的 episode 文件，注入的上下文（`runtime-context`、`skill-catalog`、`time-context`、`compact-checkpoint`）跳过。
- 隐私：写入前过一遍 deny 正则（API key、token、私钥、身份证、手机号…），命中整段打码，`memory_forget` 保留审计痕迹（retract 而不是删除）。
- 蒸馏：走自己配置的 OpenAI 兼容接口（`/chat/completions`），输出逐卡带 project 的 JSON；游标 `maxDistillState` 保证不重复蒸馏。
- 时间有效性：`supersedes` / `supersededBy` / `valid_to`，改口不是覆盖而是接龙，历史可以回头查。
