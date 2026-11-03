# Changelog

## 0.13.0 — 2026-11-03

记忆图从一张平面图变成一团可以转动的东西：黑底上每一颗神经元有白热的核、同色的光晕和几根会弯的树突，同类的记忆聚成一片，拖一下整团云就转过来了。

**Changed**

- **记忆图是立体的了**。原来是一张平面 SVG：圆点、连线、标签，一眼能看懂也能一眼看完。现在换成一个自包含的 canvas 3D 场景——透视投影、辉光、景深雾都是手写的（不引入 three.js，`graph.html` 依然是零依赖单文件、双击就能开）。远近是真的：转的时候背后的记忆会转到前面来，前面的退到远处变小、变暗、变淡。
- **每个记忆是一颗神经元**：白热的核 + 一圈同色的光晕 + 3–7 根会弯的树突。颜色仍是 kind（决策紫 / 事实青 / 待解洋红 / 偏好橙 / 记录绿），但因为有了光晕，颜色在暗底上是"发光"而不是"填色"。
- **同类聚成一片**，每片外面浮着淡淡的名字（决策记忆 / 事实知识 / 偏好态度 / 记录 / 未决疑问）。区域名字会自己找空位：先按各片成员的最远处往外退，退到放得下再画，所以它不会压在神经元上。
- **实体枢纽是发白的**：颜色取自它周围那些记忆的多数 kind，大小按被提及次数。原来的实体是纯白大点，三分之二的库是实体时整张图会糊成一片白；现在枢纽会"落在"它所属的那片区域里，一眼能看出这个实体是被哪类记忆反复提到的。
- **可以转了**：拖动旋转、滚轮推进拉远、双击回到初始角度、静止不动时缓慢自转（`#still` 关掉自转）。悬停显示提示，点一颗神经元会亮起它和它的一跳邻居、其余淡下去（淡到 0.24 而不是消失，仍能看见云的形状）。
- 画面**填满窗口**而不是缩在中间：拟合半径用的是距离的 90 分位而不是最大半径，所以少数飞得远的点不会把整团挤小；这个半径与旋转无关，转起来也不会"呼吸"。同一个数在 380×520 的侧栏 iframe 里也成立——窄窗里云自动缩小到刚好放得下，标签减到六条以内。
- **位置可重放**：三维力导向的初值来自卡片 key 的哈希，同一个库画两遍每一颗神经元都在同一个位置；两次渲染的 HTML 仍然只差时间戳（`test/smoke.mjs` 与 `test/page.mjs` 一直盯着这件事）。`test/smoke.mjs` 的断言从「页面里有一个 `<svg>`」改成「页面里有一块 `<canvas>`」。

**Fixed**

- 浅色主题下白核会把每颗神经元读成甜甜圈：核的颜色改为按主题取，暗底提亮、纸面加深，所以同一颗神经元在两边都是实心的。
- 长程连线（横穿几片区域的那些）在平面图里被短边淹没了，现在单独画一遍：取最长的 26 条，浅色发丝、加色混合，云才像一张连着的网而不是五座岛。

**Docs**

- `docs/graph-light.png` / `docs/graph-dark.png` 按新渲染重拍（1400×900）；两版 README 的「看一眼你的记忆」/「Look at your memory」重写：立体、可以转、神经元怎么画、区域名、枢纽的颜色、`#still`。
- 检查数不变（277 项），`eval/run.mjs` 不变（recall@5 0.98、误报 0/5、历史 4/4）。

## 0.12.0 — 2026-11-03

装完之后就不用再管它了：插件自己去问有没有新版本，积压的记忆自己一批批追平，视图跟着库走。

**Added**

- **自我更新**。设置页最上面一行「版本与更新」：当前版本、检查更新、立即更新。启动时查一次，之后每 `update.checkEveryHours` 小时（默认 12）最多一次——一次 `GET <registry>/@ilaomianyang%2fdsh-memory-graph/latest`，不带查询串、不带记忆库路径、不带任何对话内容；结果缓存进库里的 `.update-state.json`，离线时保留上一次的答案，不会把"查不到"显示成"已是最新"。
- 安装走宿主自己的 `pluginManager.installBundle`（和 `dsh plugin` 同一条 pnpm 路径，尊重已配的 registry），装完照实说「需要重启 Harness 生效」还是「已生效」。**`link:` / `file:` 本地安装一律拒绝**，并说明会覆盖开发目录——这句是拒绝，不是报错。
- `update.autoInstall`（默认关）：启动时发现新版本就自己装。它在任何对话开始之前动手，是唯一"换掉插件不会打断你正在说的话"的时刻；`link:` 安装同样拒绝。`memory_stats` 也报一行版本。
- 新路由 `/api/memory-graph.update`：GET 读状态（`current/latest/behind/canInstall/installKind/busy/message`），POST 是唯一能装的方法，所以页面加载或预取永远不会误装。
- **追平模式**（`auto.catchUp`，默认关）。原来的两条规则一次只消化一批，两千条积压要等几十天；打开追平后，只要还攒着**一整批**（≥ `maxEpisodesPerRun`）就按自己的节奏（`catchUpEveryMinutes`，默认 10 分钟）一批批蒸下去，一天最多 `auto.maxBatchesPerDay` 批（默认 6，0 = 不限），追平就自己停。每日批次计数存进 `.auto-state.json` 的 `batchDay`/`batchesToday`，重启不重置；批次在调用**之前**就计数，失败也算用掉一个名额——上限才是真的上限。静默时段压过追平。
- `memory_backfill` 写完后顺手重画 `README.md` 和 `graph.html`（报告里 `refreshed`），导入两千条情节后打开视图看到的是当下的库，不是导入前的空图。
- `test/update.mjs` 27 项 + `test/auto.mjs` 加 6 项追平检查。检查数 244 → 277。

**Changed**

- 设置页多了 7 个旋钮：`auto.catchUp` / `auto.catchUpEveryMinutes` / `auto.maxBatchesPerDay`，以及新的「版本与更新」分区（`update.enabled` / `checkEveryHours` / `autoInstall` / `registry`）。版本那一行不是 config 字段，是这一块自己 GET/POST 出来的 UI，刻意不占 `mg-card` / `mg-row` 这些类名。
- `README.md` / `README.en.md`：「自动蒸馏」从两条规则写成三条，新增「它自己更新」一节，配置表 34 → 41 行，YAML 例子带上 `auto.catchUp` 与 `update`。

## 0.11.0 — 2026-11-03

历史会话也能进库了，宿主侧的文案统一成中文。

**Added**

- `memory_backfill`：把**插件装上之前**的会话历史一次性导入记忆库。采集只看得见宿主运行时发生的对话，所以新库一开始是空的；这个工具回放磁盘上的 `~/.dsh/sessions/<项目>/<会话>/session.v4.jsonl.zstd`，走**与实时采集完全相同**的过滤与脱敏（`src/turns.js` 是唯一实现），因此回填出来的情节和实时采集的是同一种记录。时间戳取自会话文件里那一轮，情节落进**它当天**的 `episodes/YYYY-MM-DD.jsonl`，不是全堆在今天。默认 `dryRun`，只统计不写库。
- 幂等：一轮对话的身份是 `(会话, 轮次)`，库里已有就跳过，所以还在长的会话下次再跑只补新的部分；删档重装、换机器、装晚了都是同一条命令。
- 实测（本机）：133 个会话 → 2078 条情节，85 条已有跳过，0 坏行、0 读不了，17 秒。
- `test/history.mjs` 12 项 + `test/fixtures/session.v4.jsonl.zstd`（真的 zstd 帧、真的 v4 事件形状）。检查数 232 → 244。

**Fixed**

- 会话文件是**拼接的 zstd 容器**（每次追加写一帧），而 `zstdDecompressSync` 和 fzstd 都只解第一帧——按流读只会拿到第一行会话头。`src/history.js` 现在带一个帧扫描器（和 harness 自己用的算法同构：帧头 → 3 字节块头 → 可选校验和），逐帧解码；Node ≥ 22.15 用原生 zstd（全保真），更老的 Node 退回 fzstd，报告里会写明用的是哪个解码器。单帧坏掉只丢那一批，不丢整个会话。
- `vault.appendEpisode` 的日期改为取记录自己的 `t`，不再一律写今天——否则回填三个月历史会让 `episodes/` 看起来全发生在今天（实测 27 个日期文件）。

**Changed**

- 宿主侧的用户可见文本统一成中文（英文保留在后，形如「中文 · English」）：抽取器/蒸馏的失败说明、路由错误体、失败页兜底、审计行、自动蒸馏的日志、图谱页的按钮与 tooltip、`confidence` 徽章的三种取值。共 45 条 / 10 个文件。`autoDecision` 的 reason 码、枚举码、发给模型的 `SYSTEM_PROMPT` 保持英文。
- `src/graphdata.js` 的 400 响应补了 `message`，页签不再把机器码 `missing-session` 直接印出来（`reason` 未动）。

## 0.10.4 — 2026-11-03

**Changed**

- Release 正文改成 `CHANGELOG.md` 里对应版本的段落。`--generate-notes` 在这个仓库里只会吐出一句 `Full Changelog: …`——它是靠合并的 PR 生成的，而这里全是直接提交，所以 Release 页面等于空的。现在发布流程从 `CHANGELOG.md` 里切出 `## <version>` 那一段当正文，切不到才退回 `--generate-notes`。也就是说：想写什么 Release 说明，就往 CHANGELOG 里写。

## 0.10.3 — 2026-11-03

发布流水线的两件收尾。插件功能没有变化——这一版自己就是流水线的验收样本。

**Added**

- 发布成功后自动在本仓库建 GitHub Release：`gh release create --generate-notes`，并把 `npm pack` 出来的 tarball 附上去。建 Release 的前提是 npm 已经接受这个版本（`steps.publish.outcome == 'success'`），所以不会出现「有 Release、npm 上没有」的错位；同名 Release 已存在就跳过，重跑同一条流水线是安全的。`gh` 是 runner 自带的，没有引入第三方 action。
- 给 `v0.10.0`、`v0.10.1`、`v0.10.2` 补建了 Release。

**Changed**

- `actions/checkout@v4`、`actions/setup-node@v4` → `v5`。GitHub 通报 Node 20 运行时弃用：v4 会被强行拉到 Node 24 上跑，功能不变但每次 run 都挂一条警告。
- 发布流水线需要 `contents: write`（建 Release 用），原来只有 `contents: read`。

## 0.10.2 — 2026-11-03

补一个从第一天就存在的渲染缺陷，并让发布流水线第一次真正跑完。

**Fixed**

- 图里每个节点的光晕（halo）一直是 `r="NaN"`。`haloScale` 在模型里算好了（实体 2.5、卡片 2.7），序列化给页面的 payload 时漏了这个字段，浏览器做 `node.r * undefined` 得到 NaN，柔光画不出来，控制台上每个节点报一条 `<circle> attribute r: Expected length, "NaN"`。截图上完全看不出来——缺的是柔光，不是骨架——只有打开控制台才发现。现在 payload 带上 `haloScale`。
- `test/page.mjs` 加一条检查兜住这一类问题：解析页面里的 `DATA`，断言每个节点的 `r` 与 `haloScale` 都是有限数，并且整页不出现字面量 `NaN`。

**Changed**

- 检查数 231 → 232（README 两版、`test.yml` 的注释同步）。

**已发布到 npm：`@ilaomianyang/dsh-memory-graph@0.10.2`，由 GitHub Actions 用 trusted publishing（OIDC，仓库里不存任何 token）发布，带 SLSA provenance。**

## 0.10.1 — 2026-11-03

**Added**

- `.github/workflows/publish.yml`：推 `v*` tag 就发布，不再靠本机 `npm publish`。核对 tag 与 `package.json`、跳过已发布的版本（重推 tag 是空操作）、`npm publish --provenance`，npm 页面上因此有「Built and signed on GitHub Actions」。
- `npm run release`：跑测试 → bump → 提交 → 打 tag → 推 tag 的一条命令。
- 首版流水线踩了两个坑，都只影响 CI，与插件本身无关：`npm view` 在「版本尚未发布」时退出码为 1，而 runner 打开了 `PSNativeCommandUseErrorActionPreference`，这个预期内的非零退出直接把守门步骤干掉了；改成直接读 registry 文档判断。另外 trusted publishing 需要 npm ≥ 11.5.1，Node 22 自带 10.x，所以先 `npm install -g npm@latest`。

## 0.10.0 — 2026-11-03

**已发布到 npm：`npm i @ilaomianyang/dsh-memory-graph`（0.10.0，2026-11-03）。** npmmirror 已同步，国内直接装。`dsh-memory-graph` 这个名字在 npm 上已经被别人占了（maintainer `lilai123`，2026-11-01 发的 0.1.2，是个同名但不同的插件），所以换名发布。

**Changed**

- 包名 `dsh-memory-graph` → `@ilaomianyang/dsh-memory-graph`。跟着改的：`client.js` 的 `PACKAGE_NAME`（宿主按包名核对 client 是否注册，对不上就是 "loaded without registering"）、仓库里 `cordis.patch.yml` 的 `name:`、README 两版的安装与卸载命令。
- `publishConfig.registry` 显式指向 `https://registry.npmjs.org/`。本机 npm 默认源是 npmmirror，镜像**只读**、不接受发布；不写死这一行，`npm publish` 会打到镜像上然后失败。
- `scripts.prepublishOnly: npm test`：发布前跑那 231 项，免得发上去一个红的版本。

**Fixed**

- `test/page.mjs` 里那个「磁盘上的图和服务出来的图是同一份渲染」的检查是**会闪的**：页面里的 `generatedAt` 带的是本机时区偏移（`…T13:21:53+08:00`），而规范化用的正则只认结尾的 `Z`，所以两次渲染只要跨了一秒就报差异。第一次 `npm publish` 就是被它拦下来的（发布前跑测试是对的，错的是那条检查）。现在两种写法都认。

**Added**

- README 两版新增「从 npm 装」：`plugin_manager action=install_bundle target="@ilaomianyang/dsh-memory-graph"`，并给出国内走 `registry="https://registry.npmmirror.com/"` 的写法（镜像自动同步 npm，滞后几分钟到几小时）。

**Added（发布流水线）**

- `.github/workflows/publish.yml`：推 `v*` tag 就发布，不再靠本机 `npm publish`。它会核对 tag 与 `package.json`、跳过已发布的版本（重推 tag 是空操作）、`npm publish --provenance`，并在 npm 页面上留一条「Built and signed on GitHub Actions」。凭据是仓库 secret `NPM_TOKEN`（必须是 Automation token，账号开着 2FA 时普通 Publish token 会被 403 挡掉）。
- `npm run release`：先跑测试、再 bump、提交、打 tag、推 tag 的一条命令；README 两版都加了「发布」一节。

**Removed**

- `package-lock.json`：里面还写着 `@local/dsh-memory-graph`（第一次本地装时的残留），且只有一个依赖，留着只会误导。

**Note**

- 换名后要重启一次应用：Web 侧的插件清单是启动时扫出来的，进程里缓存，改名跟新装一样得让进程重来。
## 0.9.1 — 2026-11-03

0.9.0 的面板能用了，但设置页的保存栏位置是错的：它浮在页面中间，压着「默认返回」那一行，下面还露着别的行。第一眼像"样式不对"，其实是布局方式选错了。

**Fixed**

- 保存栏原来在滚动区里面、用 `position: sticky; bottom: 0` + `margin-bottom: -92px` 去抵消内边距。sticky 钉的是**外边距盒**，那个 -92px 就把整个栏往上提了 92px，于是它悬在离底边 92px 的地方，后面的内容从它下面滚过去。现在改成两行布局：`.mg-page` 是撑满高度的 flex 列，`.mg-root` 在里面滚，`.mg-bar` 是它的**兄弟**、静态定位，永远贴着底边，谁也不压谁。顺带没有魔法数字了（那 92px 是照着旧内边距手算的）。
- `test/client.mjs` 32 → 35：新增一项结构断言——动作栏必须在滚动区**外面**，滚动区必须在页面里。以后谁再把它挪回去，测试先红。

**Added**

- `docs/vault-panel.png`：侧栏面板的真机截图（裁掉了左侧边栏），补进两版 README 那一节。
## 0.9.0 — 2026-11-03

整库那张图以前只有一个入口：知道记忆库在哪，进去双击 `graph.html`。库的位置本身不是秘密，但"想看自己记得什么"不该先要求你记住一个路径。现在应用左侧栏多了一个 **记忆图谱**，点开就是它。

**Added**

- 侧栏入口 + 主面板：`sidebar.panellist` 注册一条（order 30，排在 上下文洞察 之后），`main` 用同一个 id 注册页面，外壳按这个字符串把两者连起来。
- `src/pageapi.js` + `/api/memory-graph.page`（GET）：把 `graph.html` 当页面发出去。面板嵌的是**同一份渲染器**，不是第二套 React 重画——两份实现迟早会对不上，而"图里有的东西库里没有"这种错最难发现。只读：读卡片和实体页，不写文件、不调模型。
- `x-frame-options: SAMEORIGIN`：只有应用自己能把它嵌进去，顺手也挡住别的站点拿它做 frame。
- 面板顶栏两个按钮：**刷新**（重画，读到刚写进去的卡片）、**新窗口打开**（同一个页面开成真正的浏览器窗口，图能占满屏）。
- `src/vault.js`：`graphPage()` 返回渲染结果，`regenerateGraph()` 改成写它——磁盘和路由两个出口，一次渲染。

**Changed**

- 测试：`test/client.mjs` 32 → 34、新增 `test/page.mjs` 7 项，合计 **230** 项。
- 两版 README 都加了「不用找文件：侧栏里的记忆图谱」一节，「已知边界」里那条"整库图只能在 `graph.html` 里看"随之改写。

**Note**

- 面板是 iframe，所以搜索、缩放、过滤、深浅色仍然是页面自己那套，跟双击文件打开时一模一样——包括它的缺点（它不会跟着应用的主题切换，除非页面自己跟随系统）。
- 空库也给一页，只是写着"还没有卡片"。库读坏了就把原因印在页面上（转义后），不是白框。
## 0.8.0 — 2026-11-03

上一版给了个按钮，但按钮要人按。现在可以自己定义它什么时候跑：**攒够多少条**，或者**每隔多久**。两条规则互相独立，都可以单独开、单独关。

**Added**

- `src/auto.js`：一个每分钟的节拍 + 一个纯函数决定"这一拍该不该跑"。节拍只做算术（未蒸馏条数、距上次多久、是不是静默时段），**不调模型**；命中规则才跑一次。决定逻辑是纯函数，所以 19 项测试一秒跑完，不用等一分钟也不用花一个 token。
- 两条规则：`auto.minEpisodes`（未蒸馏情节攒够 N 条）与 `auto.everyMinutes`（距上次 N 分钟，1440 = 每天）。
- 三个共用的闸门：`auto.minGapMinutes`（最短间隔，默认 30）、`auto.quietHours`（静默时段，可跨午夜）、`auto.project`（自动卡片记到哪个项目）。
- 间隔**在调用之前**就落盘到 `.auto-state.json`（`lastAttemptAt`）：跑空了也算数，重启也不重置，否则一个安静的库会被每分钟问一遍。
- `src/distillrun.js`：把「一次蒸馏」抽成共享 runner（单飞锁 + 报告 + 视图重建 + 卡片上限）。按钮、`memory_distill`、自动蒸馏三条路走同一把锁——正在跑时第二条路拿到"已经有一次在跑"，不排队。
- `src/vault.js`：`readAutoState` / `writeAutoState`。和 `.distill-state.json`（游标）分开：游标回答"哪些行读过了"，它回答"上次尝试是什么时候"，混在一起就表达不了"读了但没产出"。
- 定时蒸的时钟从**打开那一刻**算起（`startedAt`），单独存：刚打开不会立刻花一次调用，也不会因为"时钟刚起"把「攒够就蒸」推迟一个最短间隔。两条规则因此各有各的触发条件，互不牵连。
- 设置页多了「自动蒸馏」一节（6 个字段，全部 volatile，改完立刻生效）。

**Changed**

- `src/distillapi.js` 只负责把报告翻成 HTTP 状态；锁和报告挪进 `src/distillrun.js`。
- `memory_distill` 的 `execute` 优先走 runner（`registerTools` 新增可选 `runner`），所以模型要的那次蒸馏不会和一次自动蒸馏撞在一起；`dryRun` 与取消信号照样透传。
- 测试：`test/client.mjs` 31 → 32、`test/tools.mjs` 21 → 22、`test/distillapi.mjs` 9 → 11、新增 `test/auto.mjs` 19 项、`test/capture.mjs` 11 → 12 项，合计 **221** 项。`test/schema.mjs` 的 volatile 叶子数改成"等于页面字段表"，多一格少一格都失败。

**Fixed**

- 采集会把宿主的 runtime 快照当成你说的话记下来——实测库里就躺着一条 1501 字的图像工具说明，被 1500 字上限截断后当成一轮对话。原因是"这是不是人说的"只看 `source.kind`，而这条快照带的正是 `user`。现在来源只能**增加**跳过，不能否决文本规则，两条都过；判断之前先剥掉 `<system-reminder>…</system-reminder>` 这种有边界的块，所以一条真消息里带了提醒时，剥完留下你的原话，而不是整条丢掉。
- README 记下两个已知限制：采集不回溯（老会话没有情节，因为它只从插件在场那一刻开始），以及子智能体的开场提示词也会被当成一条情节（还没过滤）。

**发布**

- 包名从占位的 `@local/dsh-memory-graph` 改成 `dsh-memory-graph`（`package.json` / `client.js` 的 bundle id / `cordis.patch.yml` / 库里的 `vault.json` 标记四处一起改，它们必须一致）。补上 `repository` / `homepage` / `bugs` / `author`。
- README 补上 `git clone` 安装路径；截图裁掉左侧边栏（工作区名、会话标题、账号）。
- `.github/workflows/test.yml`：push / PR 时在 windows-latest 上跑 Node 20 与 22 的 `npm test`（221 项 + 离线评测，不联网、不碰记忆库）。
- `projectOf` 不再用 `path.basename`：它只认当前平台的斜杠，而会话头里的 cwd 可能是另一个系统写下的。两个斜杠都切。

**Note**

- 默认仍然是**关**。这不是保守，是定价：一次蒸馏是一次真模型调用，什么时候花这笔钱应该是用户的决定，不是插件的。

## 0.7.0 — 2026-11-03

蒸馏以前只有一条路：模型自己想起来调 `memory_distill`。采集是自动的、蒸馏不是，而界面上没有任何地方能按一下。现在会话页签的页头有 **蒸馏一次**。

**Added**

- `src/distillapi.js` + `/api/memory-graph.distill`（POST）：跑的是 `memory_distill` 背后**同一个** `distill()`，用设置里选中的模型和当前生效的隐私规则，不另写一套。POST only——刷新页面、预取、GET 探路都不可能顺手花掉一次模型调用。
- 页头的「蒸馏一次」按钮：跑完在页头下面写一行「读出 12 条情节 → 3 张卡片 · 2 批」，随即重画图；失败写原因（"抽取器已关闭"、"已经有一次在跑"、"没有新情节"），不是转圈。
- 一次只跑一个：同一进程内并发按下时，第二个拿到 `busy` 而不是排队——蒸馏花的是真钱，两开两花没有道理。
- 跑完顺手重建 `graph.html` 和库里的 README（`vault.regenerate*`），失败只 warn，不影响已经落盘的卡片。
- 卡片列表在响应里截到 40 条（`written` 仍是真数），免得一次大蒸馏把面板撑爆。

**Changed**

- `extractorServices(ctx)` 从 `tools.js` 挪进 `src/extract.js` 并导出：工具与路由必须借同一套 `llm` / 模型选择，否则两条路的模型会分叉。
- `json()` 抽到 `src/http.js`，两条路由共用一个响应助手。
- `src/tools.js` 少了 9 行（助手搬家），行为不变。
- 测试：`test/client.mjs` 29 → 31（按钮只 POST 一次、跑完重读、失败写原因）、新增 `test/distillapi.mjs` 9 项（同一函数、单飞锁、拒绝、抛错后解锁、视图刷新、卡片上限）。合计 197 项。

**Note**

- 为什么仍然不自动：一次蒸馏是一次真模型调用。没打招呼的后台调用等于替用户花钱，而且卡片会在他没看的时候进库。想要自动，正确的做法是一条定时提醒去调工具，而不是让插件自己决定什么时候花钱。

## 0.6.0 — 2026-11-02

记忆以前只能通过 `memory_search` 被模型看见。现在它也在**会话页签**里：对话 / 上下文 / 编队之后多一个「记忆」，点开就是这个会话留下的东西，以及它连着谁。

**Added**

- 会话视图：`client.js` 往 `conversation.view` 槽注册一格（id `memory-graph`、order 30、标签「记忆 / Memory」，排在「上下文」order 10 之后）。**用自家 id**，因为复用 `chat` / `trajectory` 会替换那一格而不是新增一格。
- 图的结构全部可证：会话 —`said`→ 本会话的每条情节；会话 —`recall`→ 本会话自己的话真的能唤回的卡片（复用 `searchCards`，和模型查的是同一个函数）；卡片 —`mentions`→ 它提到的实体；情节 —`named`→ 它正文里点名的实体；被推翻的卡片 —`supersedes`→ 它的继任者。跨项目的卡片通过共享实体挂进来，虚线边框、暗一档。
- 点节点在右侧展开：卡片是标题 / 类型 / 状态 / 项目 / 日期 / 正文 / 实体 / 标签，情节是那一轮的用户原文，实体是"被多少段记忆提到过"。
- 数据通路：宿主 `ctx.connection.fetch.register` 注册 `/api/memory-graph.graph`（exact Fetch route）。Connection 先验浏览器签名、只把 `owner` Peer 放进来，所以插件里**没有第二套鉴权**；浏览器侧用同源 cookie 请求，`cache-control: no-store`。
- 布局在宿主算：确定性力导向（220 次迭代、种子位置按节点顺序、归一化到 1080×640），浏览器只把坐标画出来——没有每帧模拟，重开页签是同一张图。
- `src/graphdata.js`：`buildSessionGraph`（按 `session` 字段过滤情节、项目多数决、召回、实体桥、上限）、`layoutNodes`、`createGraphHandler`、`GRAPH_PATH`。
- `src/vault.js` 新增 `readEpisodes({ session, limit })`：游标式的 `readUndistilled` 回答不了"这个会话说过什么"（游标可能已经越过那些行），所以单独读全量再过滤。
- 三种空状态都说人话：没选会话、本会话还没留下情节（提示"聊一轮再刷新"）、读不到记忆库（把宿主回的原因原样打出来，而不是空白面板）。
- 上限与截断：情节 40 / 卡片 60 / 实体 40 / 跨项目 12 / 边 420，超了写进 `truncated`，页头的计数照实报总数。
- 隐私：payload 只带用户侧原文（截断 180 字），assistant 一个字都不带——测试里塞了一句哨兵文本，断言它不出现在 JSON 里。
- 半空的图会说明自己：库里有情节但还没有卡片时，页头下面多一行提示，指向"蒸馏一次"；没有这一行，第一眼看上去像是坏了。
- 布局按画布的**长宽分别归一化**（单轴扭曲上限 2.6:1）：八个情节的会话以前缩在 1080×640 中间一个小圆里、三分之二画布是空的，现在铺满整条画布。

**Changed**

- 页签打开时每 20 秒静默轮询一次（`document.visibilityState === 'hidden'` 时不发），所以蒸馏完或改了卡片不用手点刷新。
- `client.js` 的 `apply` 拆成 `registerSlots(ctx, React)`，测试可以拿假 `ctx` 断言两个槽的**确切注册**（哪个槽、哪个 id、哪个 order、id 不是已发布的那几个）。
- 测试口径：`npm test` 197 项：`test/graphdata.mjs` 15 项、`test/client.mjs` 21 → 31 项、新增 `test/distillapi.mjs` 9 项。

**Note**

- 改完怎么生效（实测）：`client.js` 刷新页面就够——客户端 bundle 是**每次请求现读文件**的，宿主只在启动时扫一次「有哪些包」。真正要重新 `apply` 的是宿主侧（`index.js` / `src/*.js`）：在插件管理器里把「记忆图谱」关掉再打开，路由当场就注册上了，不用重启整个应用。设置页的即时生效本来就与这两者无关（volatile 字段）。

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
