# dsh-memory-graph

[English](README.en.md) · 中文

给 DeepSeek Harness 的**长期联想记忆**插件。上下文压缩会把东西真的抹掉；这个插件在上下文之外留一层持久的、可读的、属于你自己的记忆。

纯 Node ESM，不需要构建。唯一的运行依赖是 Harness 自带的 `@deepseek-ai/schemastery`——设置表单就是它渲染出来的；没装这个依赖时插件照常跑，只是没有表单。

---

## 它和"压缩上下文"有什么不同

| | 上下文压缩 | 本插件 |
| --- | --- | --- |
| 目的 | 让当前对话塞得进窗口 | 让三个月前的决定还能被找回 |
| 丢失 | 压掉就是没了 | 原始事件永不被改写，只追加 |
| 结构 | 一段摘要 | 带类型、带时间、带来源的卡片 + 实体连接 |
| 变化 | 不可见 | 冲突变成 supersede 链，"怎么变成现在这样"可读 |
| 位置 | 会话日志内部 | 独立文件夹，可移植、可直接读 |

一句话：**压缩是工作记忆策略，这个插件是长期记忆。两者不是替代关系，是并存的。**

## 三层结构

```
episodes/   原始层  每轮追加一行 JSON，不蒸馏、不删除           ← 保证"不会消失"
cards/      语义层  从原始层蒸馏出的带类型记忆卡片（markdown）  ← 真正的检索对象
entities/   索引层  每个东西一页，带提及时间线                  ← 跨项目联想的桥
```

模型检索的时候，走的是 `cards + entities`；`episodes` 是蒸馏的原料，也是出事时的对账依据。

### 卡片长这样

```markdown
---
id: "c-20261102-7f3a"
kind: "decision"
title: "记忆存储用纯文本文件而不是 SQLite"
project: "memory-graph"
entities: ["vault格式", "sqlite"]
created: "2026-11-02T15:40:12+08:00"
valid_from: "2026-11-02"
valid_to: null
status: "active"
confidence: "user_stated"
source: {"kind":"agent","project":"memory-graph"}
supersedes: []
tags: []
---
SQLite 需要处理锁和二进制合并，纯文本可以直接读、直接 grep、直接备份。
用户要求插件可以放到 GitHub 上让别人安装，纯文本降低理解成本。
```

`status` 只会是 `active` / `superseded` / `retracted`。**被推翻的记忆不会被删掉**，它变成 `superseded` 并指向新卡片——这正是"事物的发展"能被读出来的原因。

## 安装

在 Harness 里让模型执行，或者自己在插件管理里填绝对路径：

```
plugin_manager action=install_bundle target="<本仓库绝对路径>"
```

`install_bundle` 用 `link:` 方式装本地目录，**不会**替你装依赖，所以先在这个仓库里跑一次 `npm install`（只有一个包）。不装也能用，只是设置里看不到表单。

装完默认 `vaultDir` 是 `~/dsh-memory`，插件激活时会自动建目录和空文件。安装结果是热生效的，但**改完插件源码后需要重启 Harness** 才会加载新的 JavaScript 模块代——包括这次新增的 `Config` schema。

卸载：`plugin_manager action=remove_bundle target="@local/dsh-memory-graph"`。**记忆库不会被删**，它在 `~/dsh-memory`，独立于插件。

## 你的记忆库长什么样

```
~/dsh-memory/
├── vault.json                     库的元信息（schema 版本、创建时间）
├── projects.json                  见到过的项目 slug
├── README.md                      自动生成的目录页，链接到每张卡片
├── graph.html                     自动生成的记忆图，双击打开
├── episodes/2026-11-02.jsonl      原始层：一轮一行，只追加
├── cards/2026-11/                语义层：一个文件一张卡片
│   └── c-20261102-7f3a.md
├── entities/                     索引层：一个东西一页
│   └── vault格式.md
└── audit/2026-11.log             隐私拦截的审计（只记规则，不记内容）
```

纯文本、一文件一记忆、只追加不重写——可以 `git init` 自己版本化，或者直接 `grep -r` 全库搜索。这是本地私有数据，只属于你一个人；共享出去的是这个插件项目，不是记忆库。

## 配置

两种写法，效果完全一样，改哪一个都行：

1. **设置界面**：DSH 的 Settings → 插件 → memory-graph。表单里的每一项都带中英文说明，改了即时生效。
2. **profile 的 `cordis.patch.yml`**：适合写进版本库、或者用变量拼出配置。

```yaml
- id: memory-graph
  config:
    vaultDir: '~/dsh-memory'
    capture:
      enabled: true
      userChars: 1500
      assistantChars: 1500
    privacy:
      redactEmails: true
      redactPaths: true
      denyPatterns: ['我的内部域名\\.corp']
    extractor:
      enabled: true
      transport: 'harness'      # 默认：跟随设置里选中的模型，不用自己配 key
      maxEpisodesPerRun: 40
    retrieval:
      limit: 8
      hops: 1
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `vaultDir` | `~/dsh-memory` | 记忆库位置，支持 `~` |
| `capture.enabled` | `true` | 是否自动追加原始事件 |
| `capture.includeToolOutput` | `false` | 是否记录工具调用计数（不记录内容） |
| `capture.skipPatterns` | 3 条内置 | 老版本日志没有来源标记时的兜底正则 |
| `privacy.useDefaultPatterns` | `true` | 内置密钥/私钥/token 规则 |
| `privacy.denyPatterns` | `[]` | 追加你自己的正则，支持 `(?i)` 前缀 |
| `extractor.enabled` | `false` | 关闭时只采集不蒸馏，不产生任何模型调用 |
| `extractor.transport` | `harness` | `harness` = 借用设置里的模型；`http` = 自己填 endpoint 直连 |
| `extractor.useCurrentModel` | `true` | harness 模式下是否跟随当前选中的模型 |
| `extractor.provider` | `''` | harness 模式：关掉「跟随」后指定提供商 id |
| `extractor.reasoningEffort` | `''` | harness 模式：思考强度，留空则沿用设置里的那一档 |
| `extractor.baseUrl` | `https://api.deepseek.com/v1` | http 模式：任何 OpenAI 兼容端点 |
| `extractor.path` | `/chat/completions` | http 模式：路径 |
| `extractor.model` | `deepseek-chat` | http 模式：模型 id |
| `extractor.apiKeyEnv` | `MEMORY_LLM_API_KEY` | http 模式：key 从这个环境变量名的来源里找 |
| `extractor.temperature` | `0.1` | 仅 http 模式：harness 模式下采样由被借用的模型设置决定 |
| `extractor.maxEpisodesPerRun` | `40` | 一次蒸馏最多喂多少条情节 |
| `retrieval.hops` | `1` | 联想扩散跳数，0 = 只做关键词 |

### 抽取器接在哪：两条路

**A. 跟随设置里的模型（默认）**

`transport: 'harness'` 时，插件不碰 key、不碰 endpoint，直接向 Harness 的 `llm` 服务要一次调用，用的是你在 **Settings → 模型** 里选中的那一路：提供商、模型、思考强度（thinking）全部照搬。你在设置里给模型配过 key 了，插件就不用再要第二个。

- 想换抽取用的模型？在设置里换，插件下一次蒸馏就跟上。
- 想固定一个便宜的小模型专门做抽取？把 `useCurrentModel` 关掉，填 `provider` + `model`（例如 `deepseek` / `deepseek-chat`），key 仍然是设置里那套。
- 想跑更省或更强的思考档？填 `reasoningEffort`，取值是那个模型在设置里给出的档位 id（如 `high`）；留空就沿用设置里的选择。
- 这条路上没有密钥可泄露：插件全程只报"用了哪个提供商/模型/档位"，不接触凭据值。

**B. 自己填 endpoint 直连（`http`）**

抽取器完全独立，用自己的端点、模型和额度。适合：抽取想用一个别处的小模型、想接到自建网关、或者这个 Harness 构建里没有暴露 `llm` 服务。

设置表单里也有 `extractor.apiKey` 一栏，但你**最好别用它**：表单里填的值会明文落进 profile 的配置里。用 `apiKeyEnv` 指个名字、把值放进环境变量或 `~/.dsh/.credentials.yaml`，是这个插件设计上的默认路线。

### http 模式的 key 从哪来

按这个顺序找，找到就用，一路都不写进日志、不写进审计、不写进记忆库：

1. 配置里的 `extractor.apiKey`（不推荐，会落到 YAML 里）
2. 进程环境变量 `extractor.apiKeyEnv` 指定的那个名字
3. **Harness 自己的凭据库** `~/.dsh/.credentials.yaml` 里 `refs.<apiKeyEnv>` 指向的条目

第 3 条的意思是：如果你已经把 key 配给 Harness 用（比如 `DEEPSEEK_API_KEY`），把 `apiKeyEnv` 改成同名就行，不用再导出环境变量。读凭据库时只解析 `refs:` 那一段，别的内容不碰。`memory_stats` 会告诉你这次蒸馏走的是哪条路、用的哪个模型（`extractor:` 那一行），但永远只报来源、不报值。

## 工具

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 跨项目检索，返回 id + 摘要 + 命中原因 |
| `memory_get` | 读一张卡片的全文和关联实体 |
| `memory_timeline` | 按时间看，保留 supersede 链 |
| `memory_graph` | 从一个实体或卡片出发，看它连着哪些记忆和邻近实体 |
| `memory_remember` | 显式写一张卡片 |
| `memory_forget` | `retract` 撤回（留痕）或 `purge` 删除 |
| `memory_distill` | 用抽取模型把原始事件蒸馏成卡片 |
| `memory_stats` | 库位置、数量、上次蒸馏时间 |

`memory_graph` 是"神经元"那部分的具体形态：边不是凭空生成的，而是**两张卡片提到同一个实体**。它不声称因果，只声称"这两个东西在同一段记忆里出现过"，模型看到之后自己判断。

**没有自动注入。** 记忆只在模型主动调用工具时才进入上下文——这是刻意的：大多数轮次根本不需要长期记忆，注入了就是纯成本。

## 看一眼你的记忆

`memory_stats` 会告诉你库在哪；库里根目录还有一个 **`graph.html`**，双击就能开，不用装东西、不用起服务：

![记忆图：实体是枢纽，卡片是神经元](docs/graph-light.png)

- **实体是深色大枢纽**（`infra`、`deepseek`、`blog-engine`、`memory-graph`……），大小按被提及次数长，跨项目共享的实体一眼就能认出来。
- **卡片是彩色小点**，颜色是 kind：决策 / 事实 / 待解 / 偏好 / 记录。
- **虚线 = 已被替换**（`superseded`），能看见「改口」发生过的位置；撤回的卡片仍在，只是灰掉。
- 搜标题 / 实体 / id、按项目过滤、点卡片看详情、悬停高亮一跳邻居、滚轮缩放、拖背景平移、`Esc` 清除。
- 跟随系统深浅色；也可以直接跳到 `#dark`、`#light`，或者 `#dark&<卡片id|实体slug>` 一次把主题和某张卡片都定好。
- 每次 `memory_remember` / `memory_forget` / `memory_distill` 之后自动重画；空库和只有一张卡的库都有能读的提示，不会白屏。

它是**一个自包含的 HTML 文件**：没有 CDN、没有框架、没有构建步骤、没有网络请求，数据是渲染时内联进去的。38 张卡片 → 101 KB。丢掉它也无所谓，下次写入会重新生成。

深色：

![记忆图深色模式](docs/graph-dark.png)

一个明确的边界：这是一个**静态文件**，不是 DSH Web GUI 里的面板。做面板要写 client 插件（打包、注入 slot），那不是零依赖能换来的东西，所以先把「能看」做出来。

## 跨项目是什么意思

同一个人的多个项目之间互相联想，不是多人共享记忆。

你在 A 项目里定过"所有脚本必须零依赖"，三个月后在 B 项目里问"这个库能不能省掉构建步骤"，`memory_search` 会把 A 项目那张卡片带出来——因为它们共享实体 `零依赖`。这就是实体层存在的唯一原因。

## 隐私

写入前拦截，不是写完再清：

- 内置规则：各类 API key、私钥块、`password=` 形态、Bearer token
- `redactEmails`：邮箱 → `[email]`
- `redactPaths`：家目录 → `~`
- `denyPatterns`：你自己的正则

命中即替换为 `[REDACTED]`，审计日志只记录"哪条规则触发"，**不记录命中内容**。万一有东西漏进来，`memory_forget mode=purge` 直接删文件。

### 只记你说的话

Harness 会把运行时快照、技能目录、时间戳、审批通知、压缩摘要**伪装成 user 消息**投递进来。这些不是你的话，蒸馏它们只会凭空造出记忆。

所以采集按 `source.kind` 判断：只有 `kind === 'user'`（你真敲进去的那条）才开一个情节。其余的一律忽略，连 buffer 都不建。老版本日志没有来源标记时，退回 `capture.skipPatterns` 的文本正则兜底。

顺带的好处：一轮里不再被中途插入的注入消息切断，情节的边界就是真正的轮次边界。

## 设计取舍（重要的几条）

1. **实体层是跨项目的关键**。两个项目共享"同一个 Postgres 实例""同一个工具"，通过 entity 页连起来，而不是靠向量相似度碰运气。
2. **时间有效性 `[valid_from, valid_to]`**。没有它，记忆图会把三个月前的方案和昨天的方案平铺在一起，安静地撒谎。
3. **写入是情节，不是事实**。`episodes` 记"什么时候、因为什么、谁决定"；`cards` 是从情节派生的结论。
4. **遗忘是功能**。`retract` 保留痕迹，比假装没发生诚实；`purge` 才是真删。
5. **图是派生缓存**。会话日志是唯一真相源，卡片全部可以从 episodes 重新蒸馏出来。

## 测试

零依赖，不联网，不碰真实记忆库：

```bash
npm test        # 38 + 9 + 11 + 21 + 48 = 127 项检查，另加 25 题检索评测
npm run eval    # 只跑检索评测（离线，确定性的）
```

- `test/smoke.mjs` — 存储、隐私过滤、BM25 检索、实体扩散、supersede 链、蒸馏结果解析
- `test/schema.mjs` — 设置表单的 schema 和运行时默认值不许漂移：双向比对 `Config({})` 和 `resolveConfig({})` 的每个叶子（只有 `vaultDir` 例外，表单存原始文本、运行时存绝对路径）——表单多一格没用的、少一格看不见的都算失败；另外验证 `transport` 只认那两个值、数值边界、`apiKey` 被标成 secret、所有设置项都出现在投影出来的 schema 里
- `test/capture.mjs` — 用真实的 `session/event` 形状驱动采集，验证一轮一情节、密钥被拦、短轮不入库、注入消息不入库
- `test/tools.mjs` — 逐个跑 8 个工具的 `execute` + `render`
- `test/extract.mjs` — 抽取器：`fetch` 打桩验证 http 路线（提示词构造、key 解析顺序、JSON 解析容错、每张卡片归到自己的项目、游标前进、dry run 不落盘、密钥在写入前被拦住），再用一个假的 `llm` 服务验证 harness 路线（借用设置里的模型与思考档、显式覆盖、没有选中模型时的报错、`finish` 各种终态、取消、空回复、以及全程不碰 `fetch`）

下面两个测试会真的联网/花钱，所以不在 `npm test` 里，要自己跑：

```bash
npm run live             # 真模型端到端：3 条情节 → 蒸馏 → 再检索回来
npm run live:supersede   # 真模型：先记一条，再让它被"更正"推翻，验证作废链
```

它们从 `~/.dsh/.credentials.yaml` 或环境变量取 key（见下文），不写死、不落盘。这两个脚本跑在普通 `node` 进程里，没有 Harness 的 `llm` 服务可借，所以它们显式用 `transport: 'http'`；插件自己在界面里默认走 harness。

## 蒸馏实测（真模型跑过，不是估计）

用 `deepseek-chat`，`npm run live`：

| 输入 | 产出 | 耗时 | token |
| --- | --- | --- | --- |
| 3 条合成情节（中英混排，2 个项目） | 5 张卡片，项目归属 5/5 正确 | 2.9 s / 3.6 s（两次） | ≈1 590 |
| 真实会话日志 266 个事件 → 采出 2 条情节（1 501 + 278 字） | 9 张卡片（8 decision + 1 preference），中文进中文出 | 5.9 s | 2 816（prompt 1 795 / completion 1 021） |

`npm run live:supersede` 验证的是**时间有效性真的会动**：第一轮记下「上传到 GitHub 共享」，第二轮用户更正「共享的是插件，不是记忆」，抽取模型自己填 `supersedes`，旧卡转 `superseded` 并写 `valid_to`，两边链接互指。这条链在离线测试里只能验证机制，验证不了模型会不会填。

顺带一个真实的教训：我第一次拿**旧快照**回放时，蒸馏出的卡片把"记忆要上传 GitHub 共享"当成了现行结论。查下来的原因不是模型错，是那份快照早于用户的更正——**记忆只能和它读到的东西一样好**。所以插件做的是：情节永远留着，卡片可被推翻（`supersedes`），推翻也可被查（`memory_timeline`）。

## 检索到底准不准

`eval/` 是一套离线评测：38 张卡片 / 3 个项目 / 5 种 kind / 7 个跨项目共享实体 / 4 条 supersede 链 / 1 张 retracted，25 道检索题（keyword 9、entity-bridge 6、temporal 5、negative 5）外加 4 对（8 条）「问历史 vs 问现状」成对题，跑仓库里真实的 `searchCards`，不自己写一套评分。题目是先写好的，跑完没有改过一个字。

```bash
npm run eval
```

当前结果（limit 5、hops 1）：

| 题型 | n | recall@1 | recall@5 | MRR |
| --- | --- | --- | --- | --- |
| keyword | 9 | 1.00 | 1.00 | 1.00 |
| entity-bridge | 6 | 0.67 | 0.94 | 0.83 |
| temporal | 5 | 0.60 | 1.00 | 0.80 |
| 历史成对（老卡 vs 继任卡） | 4 对 | — | — | 4/4 |
| negative（库里没有） | 5 | — | — | 误报 0/5 |
| 全部 | 25 | 0.80 | **0.98** | 0.90 |

**[`eval/REPORT.md`](eval/REPORT.md) 里写着这份评测没覆盖什么，以及八个已知弱点**——包括「问历史」「问现状」这类意图靠一条正则判断，同样是穷举（实测 10 条变体里仍会漏）；包括「监控之前那套还留着吗」这种问现状却把老卡排第一；包括 `部署`、`流程` 这种有主题义的常见词会让 negative 的判据停在灰区。0/5 只该读作"这 5 条过了"，不该读作"负面问题修好了"；4 对成对题只有 4 对，是抛硬币级别的证据。想信这个分数之前先读那份报告。

一处刻意的设计：**问历史有单独的通路**。「抽取模型现在默认开着吗」会压制作废的旧卡、把现行结论顶上来；「最早那版抽取方案是什么」则反过来，把作废卡还原到满权重。同一批词、不同的时态，答案不是一个——降权不该等于捞不出来。

## 已知边界

- 检索是关键词 BM25 + 实体扩散，**没有向量召回**。中英文混合场景下中文靠 bigram 分词，可用但不如嵌入模型；卡片量到几千张时应该换。
- 蒸馏质量取决于抽取模型，且**只在你显式调用时发生**，不会自己跑。建议配合定时任务。
- harness 模式借的是「设置里当前选中的那个模型」，所以你在对话里换模型，抽取也跟着换；想钉死一个抽取专用模型就把 `useCurrentModel` 关掉。另外它花的是同一个模型提供商的额度，不会因为"插件"就变免费。
- 图视图是**静态 HTML**（`graph.html`），不是 DSH Web GUI 里的面板；要面板得单独写 client 插件。
- 卡片去重只按"同项目 + 标题归一化相同"，措辞不同的近义卡片会被存成两张。
- 设置表单是 schemastery 生成的通用表单：字段有中英文说明，但**没有分组标题、没有自定义控件**，`skipPatterns` / `denyPatterns` 这种数组只能一行一条地编辑。要更好看的配置界面得自己写 client 侧的面板。
- 采集粒度是一轮（`turn/end` 触发落盘），不是一条一条消息；一轮里的多次工具调用只记次数不记内容。连续多步的长轮次只留前 6 段可见文本。
- 记忆库自带 `.gitignore`（忽略 `*.tmp`、系统垃圾文件和 `.distill-state.json`）；后者是每台机器各自的蒸馏游标，同步到另一台机器会重新蒸馏一遍，靠标题去重兜底。

## License

MIT
