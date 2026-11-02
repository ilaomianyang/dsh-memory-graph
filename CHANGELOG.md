# Changelog

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
