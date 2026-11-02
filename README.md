# dsh-memory-graph

[English](README.en.md) · 中文

给 DeepSeek Harness 的**长期联想记忆**插件。上下文压缩会把东西真的抹掉；这个插件在上下文之外留一层持久的、可读的、属于你自己的记忆。

零依赖，纯 Node ESM，不需要构建。

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

装完默认 `vaultDir` 是 `~/dsh-memory`，插件激活时会自动建目录和空文件。安装结果是热生效的，但**改完插件源码后需要重启 Harness** 才会加载新的 JavaScript 模块代。

卸载：`plugin_manager action=remove_bundle target="@local/dsh-memory-graph"`。**记忆库不会被删**，它在 `~/dsh-memory`，独立于插件。

## 你的记忆库长什么样

```
~/dsh-memory/
├── vault.json                     库的元信息（schema 版本、创建时间）
├── projects.json                  见到过的项目 slug
├── README.md                      自动生成的目录页，链接到每张卡片
├── episodes/2026-11-02.jsonl      原始层：一轮一行，只追加
├── cards/2026-11/                语义层：一个文件一张卡片
│   └── c-20261102-7f3a.md
├── entities/                     索引层：一个东西一页
│   └── vault格式.md
└── audit/2026-11.log             隐私拦截的审计（只记规则，不记内容）
```

纯文本、一文件一记忆、只追加不重写——可以 `git init` 自己版本化，或者直接 `grep -r` 全库搜索。这是本地私有数据，只属于你一个人；共享出去的是这个插件项目，不是记忆库。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

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
      baseUrl: 'https://api.deepseek.com/v1'
      model: 'deepseek-chat'
      apiKeyEnv: 'MEMORY_LLM_API_KEY'   # 从环境变量读，不写进配置文件
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
| `privacy.useDefaultPatterns` | `true` | 内置密钥/私钥/token 规则 |
| `privacy.denyPatterns` | `[]` | 追加你自己的正则，支持 `(?i)` 前缀 |
| `extractor.enabled` | `false` | 关闭时只采集不蒸馏，不产生任何模型调用 |
| `extractor.apiKeyEnv` | `MEMORY_LLM_API_KEY` | API key 从环境变量读 |
| `retrieval.hops` | `1` | 联想扩散跳数，0 = 只做关键词 |

**抽取器是独立的**，用自己的 endpoint 和模型，不占用对话模型的额度。

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

## 设计取舍（重要的几条）

1. **实体层是跨项目的关键**。两个项目共享"同一个 Postgres 实例""同一个工具"，通过 entity 页连起来，而不是靠向量相似度碰运气。
2. **时间有效性 `[valid_from, valid_to]`**。没有它，记忆图会把三个月前的方案和昨天的方案平铺在一起，安静地撒谎。
3. **写入是情节，不是事实**。`episodes` 记"什么时候、因为什么、谁决定"；`cards` 是从情节派生的结论。
4. **遗忘是功能**。`retract` 保留痕迹，比假装没发生诚实；`purge` 才是真删。
5. **图是派生缓存**。会话日志是唯一真相源，卡片全部可以从 episodes 重新蒸馏出来。

## 测试

零依赖，不联网，不碰真实记忆库：

```bash
npm test     # 27 + 8 + 21 = 56 项检查
```

- `test/smoke.mjs` — 存储、隐私过滤、BM25 检索、实体扩散、supersede 链、蒸馏结果解析
- `test/capture.mjs` — 用真实的 `session/event` 形状驱动采集，验证一轮一情节、密钥被拦、短轮不入库
- `test/tools.mjs` — 逐个跑 8 个工具的 `execute` + `render`

## 已知边界

- 检索是关键词 BM25 + 实体扩散，**没有向量召回**。中英文混合场景下中文靠 bigram 分词，可用但不如嵌入模型；卡片量到几千张时应该换。
- 蒸馏质量取决于抽取模型，且**只在你显式调用时发生**，不会自己跑。建议配合定时任务。
- 没有 Web UI 图视图，当前靠 `README.md`（自动生成）和文件系统阅读。
- 卡片去重只按"同项目 + 标题归一化相同"，措辞不同的近义卡片会被存成两张。
- 没有导出 `Config` schema，所以 Settings 里没有可视化表单；配置走 `cordis.patch.yml`。这是为了让插件保持真正的零依赖（不引用 `@deepseek-ai/schemastery`），代价是配置得写 YAML。
- 采集粒度是一轮（`turn/end` 触发落盘），不是一条一条消息；一轮里的多次工具调用只记次数不记内容。

## License

MIT
