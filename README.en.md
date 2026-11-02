# dsh-memory-graph

English · [中文](README.md)

Long-term **associative memory** for [DeepSeek Harness](https://getartcraft.com) (DSH).

Context compaction quietly deletes things. This plugin keeps a second layer — outside the context window, on your own disk, readable by you — so that a decision you made three months ago can still be found.

Plain Node ESM, no build step. The only third-party dependency is the harness's own `@deepseek-ai/schemastery`, which renders the Settings form; without it the plugin runs on defaults and simply has no form.

---

## How this differs from "compressing the context"

| | Context compaction | This plugin |
| --- | --- | --- |
| Goal | make the current conversation fit | make last quarter's decision findable |
| Loss | compressed away = gone | raw events are append-only, never rewritten |
| Structure | one paragraph of summary | typed cards with time, provenance and entity links |
| Change | invisible | conflicts become a supersede chain you can read |
| Location | inside the session log | a folder of plain files you own |

Compaction is a **working-memory** strategy. This is **long-term memory**. They coexist; neither replaces the other.

## Three layers

```
episodes/   raw      one JSON line per turn, never distilled, never deleted
cards/      semantic typed memory cards distilled from the raw layer (markdown)
entities/   index    one page per thing, with a timeline of mentions
```

Retrieval reads `cards + entities`. `episodes` is the raw material for distillation, and the audit trail when something looks wrong.

### A card

```markdown
---
id: "c-20261102-7f3a"
kind: "decision"
title: "Store memories as plain text instead of SQLite"
project: "memory-graph"
entities: ["vault-format", "sqlite"]
created: "2026-11-02T15:40:12+08:00"
valid_from: "2026-11-02"
valid_to: null
status: "active"
confidence: "user_stated"
source: {"kind":"agent","project":"memory-graph"}
supersedes: []
tags: []
---
SQLite would need locking and binary merges. Plain text can be read, grepped and
backed up directly.
```

`status` is only ever `active`, `superseded` or `retracted`. **A belief that was overturned is never deleted** — it becomes `superseded` and points at the card that replaced it. That is what makes "how did this come to be" readable.

## Install

```
plugin_manager action=install_bundle target="<absolute path to this repo>"
```

`install_bundle` links a local directory with `link:`, which does **not** install the package's dependencies, so run `npm install` once in this repo (it is a single package). Without it the plugin still runs — there is simply no Settings form.

The vault defaults to `~/dsh-memory` and is created on activation.

Installation is hot, but **changing this plugin's source requires restarting Harness** to load a fresh module generation — including the `Config` schema added for the Settings form.

Uninstall with `plugin_manager action=remove_bundle target="@local/dsh-memory-graph"`. The vault is not touched — it lives in `~/dsh-memory`, independent of the plugin.

## What you get on disk

```
~/dsh-memory/
├── vault.json                   schema version, creation time
├── projects.json                project slugs seen so far
├── README.md                    generated index linking every card
├── graph.html                   generated memory graph, open it in a browser
├── episodes/2026-11-02.jsonl    raw layer: one line per turn, append-only
├── cards/2026-11/               semantic layer: one file per card
│   └── c-20261102-7f3a.md
├── entities/                    index layer: one page per thing
│   └── vault-format.md
└── audit/2026-11.log            redaction audit (which rule fired, never the text)
```

One file is one memory. Append-only. No binaries, no lockfiles. Run `git init` inside it if you want version history, or `grep -r` the whole vault.

**This is your private local data.** What gets shared on GitHub is the plugin, not the vault.

## Configuration

Two ways, same result — use either:

1. **The Settings UI**: Settings → Plugins → memory-graph. Every field carries a bilingual description and applies immediately.
2. **Your profile's `cordis.patch.yml`**: better when the config belongs in version control or is built from variables.

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
      denyPatterns: ['my-internal-domain\\.corp']
    extractor:
      enabled: true
      transport: 'harness'      # default: reuse the model selected in Settings, no key of its own
      maxEpisodesPerRun: 40
    retrieval:
      limit: 8
      hops: 1
```

| Key | Default | Meaning |
| --- | --- | --- |
| `vaultDir` | `~/dsh-memory` | where the vault lives, `~` supported |
| `capture.enabled` | `true` | append raw events automatically |
| `capture.includeToolOutput` | `false` | record tool call counts (never their contents) |
| `capture.skipPatterns` | 3 built-in | fallback regexes for old logs that carry no provenance |
| `privacy.useDefaultPatterns` | `true` | built-in key / private-key / token rules |
| `privacy.denyPatterns` | `[]` | your own regexes, `(?i)` prefix supported |
| `extractor.enabled` | `false` | when off, nothing is captured *and* no model is ever called |
| `extractor.transport` | `harness` | `harness` = borrow the model from Settings; `http` = fill in your own endpoint |
| `extractor.useCurrentModel` | `true` | harness mode: follow the model currently selected |
| `extractor.provider` | `''` | harness mode: provider id, used when "follow" is off |
| `extractor.reasoningEffort` | `''` | harness mode: thinking level, empty = whatever Settings has |
| `extractor.baseUrl` | `https://api.deepseek.com/v1` | http mode: any OpenAI-compatible endpoint |
| `extractor.path` | `/chat/completions` | http mode: the path |
| `extractor.model` | `deepseek-chat` | http mode: the model id |
| `extractor.apiKeyEnv` | `MEMORY_LLM_API_KEY` | http mode: the key is looked up under this name |
| `extractor.temperature` | `0.1` | http mode only: in harness mode sampling belongs to the borrowed route |
| `extractor.maxEpisodesPerRun` | `40` | how many episodes one distillation may feed in |
| `retrieval.hops` | `1` | entity expansion depth, `0` = keyword only |

### Two ways to hook up the extractor

**A. Borrow the model from Settings (the default)**

With `transport: 'harness'` the plugin touches no key and no endpoint: it asks the harness `llm` service for one call and gets exactly what you selected in **Settings → Models** — provider, model, and thinking level. The key is already configured there, so the plugin never needs a second one.

- Want a different extraction model? Change it in Settings; the next distillation follows.
- Want to pin a cheap small model to extraction? Turn `useCurrentModel` off and fill in `provider` + `model` (e.g. `deepseek` / `deepseek-chat`); the key still comes from Settings.
- Want a cheaper or stronger thinking level? Set `reasoningEffort` to one of the ids that model offers in Settings (e.g. `high`); leave it empty to reuse your selection.
- No secret can leak on this route: the plugin reports only the provider / model / effort it used, never a credential value.

**B. Your own endpoint (`http`)**

The extractor is fully independent: its own endpoint, model, and budget. Use it when extraction should run on a model configured elsewhere, behind your own gateway, or when this harness build exposes no `llm` service.

The Settings form also has an `extractor.apiKey` field, but **do not use it**: whatever you type there is written in plaintext into the profile config. Pointing `apiKeyEnv` at a name and keeping the value in the environment or `~/.dsh/.credentials.yaml` is the intended route.

### Where the key comes from (http mode)

Tried in this order; whichever answers is used, and the value is never logged, never audited, never written into the vault:

1. `extractor.apiKey` in the config (not recommended — it ends up in YAML)
2. the process environment variable named by `extractor.apiKeyEnv`
3. **the harness's own credential store**: `refs.<apiKeyEnv>` in `~/.dsh/.credentials.yaml`

Point 3 means that if the key is already configured for the harness (`DEEPSEEK_API_KEY`, say), you just set `apiKeyEnv` to the same name instead of exporting anything. Reading the store parses the `refs:` block only and touches nothing else. `memory_stats` prints an `extractor:` line naming the route and model it would use — never the value.

## Tools

| Tool | What it does |
| --- | --- |
| `memory_search` | cross-project retrieval: id, snippet, and why it matched |
| `memory_get` | one card in full, plus its entities |
| `memory_timeline` | chronological view that keeps the supersede chain visible |
| `memory_graph` | walk from an entity or a card to connected memories and neighbouring entities |
| `memory_remember` | write a card explicitly |
| `memory_forget` | `retract` (keeps the trace) or `purge` (deletes the file) |
| `memory_distill` | turn raw episodes into cards with the extractor model |
| `memory_stats` | vault location, counts, last distillation |

`memory_graph` is the "neuron" part made concrete: an edge is not invented, it is **two cards mentioning the same entity**. It claims co-mention, never causation — the model decides what that means.

**Nothing is injected automatically.** Memory only enters the context when the model asks for it. Most turns do not need long-term memory, and injecting it would be pure cost.

## Look at your memory

`memory_stats` tells you where the vault is; in its root there is also **`graph.html`** — double-click it, nothing to install, no server:

![The memory graph: entities are hubs, cards are neurons](docs/graph-light.png)

- **Entities are the large dark hubs** (`infra`, `deepseek`, `blog-engine`, `memory-graph`…), sized by how often they are mentioned — the cross-project ones stand out immediately.
- **Cards are the small coloured dots**, coloured by kind: decision / fact / open question / preference / note.
- **Dashed edges are replaced memories** (`superseded`), so you can see where the record changed its mind; retracted cards stay visible, greyed out.
- Search by title / entity / id, filter by project, click a card for its detail, hover to highlight one-hop neighbours, scroll to zoom, drag the background to pan, `Esc` to clear.
- Follows the system light/dark setting; you can also open `#dark`, `#light`, or `#dark&<card id|entity slug>` to pin the theme and jump to one card.
- Redrawn after every `memory_remember` / `memory_forget` / `memory_distill`. An empty vault and a one-card vault both render something readable instead of a blank page.

It is **one self-contained HTML file**: no CDN, no framework, no build step, no network requests — the data is inlined at render time. 38 cards → 101 KB. Delete it if you like; the next write regenerates it.

Dark:

![The memory graph in dark mode](docs/graph-dark.png)

One honest limit: this is a **static file**, not a panel inside the DSH Web GUI. A panel would mean a client plugin (bundling, slot injection), which is not something zero dependencies buy you — so "you can look at it" came first.

## Cross-project means one person's projects, not shared memory

You set "every script must be zero-dependency" in project A. Three months later, in project B, you ask whether a build step can be dropped — `memory_search` surfaces the card from A, because both mention the entity `zero-dependency`.

That is the only reason the entity layer exists.

## Privacy

Enforced **before** the write, not cleaned up afterwards:

- built-in rules: API keys, private-key blocks, `password=` forms, Bearer tokens
- `redactEmails`: addresses become `[email]`
- `redactPaths`: your home directory becomes `~`
- `denyPatterns`: your own regexes

Matches become `[REDACTED]`. The audit log records **which rule fired, never the matched text**. If something slips in anyway, `memory_forget mode=purge` deletes the file.

### Only what you actually said

The harness delivers runtime snapshots, skill catalogs, sampled timestamps, approval notices and compaction checkpoints **disguised as user messages**. Those are not your words, and distilling them would manufacture memories out of nothing.

So capture looks at `source.kind`: only `kind === 'user'` — the message you typed — opens an episode. Everything else is ignored, not even buffered. Logs from older harness versions carry no provenance, and there `capture.skipPatterns` is the text fallback.

Side benefit: an injected message no longer cuts a turn in half, so an episode's boundary is the real turn boundary.

## Design decisions worth knowing

1. **The entity layer is what makes cross-project work.** Two projects sharing "the same Postgres instance" or "the same tool" connect through an entity page, instead of hoping a vector similarity finds it.
2. **Temporal validity `[valid_from, valid_to]`.** Without it the graph lays this quarter's plan next to last quarter's and lies to you quietly.
3. **The write unit is an episode, not a fact.** `episodes` records when, why and who decided; `cards` are conclusions derived from episodes.
4. **Forgetting is a feature.** `retract` keeps the trace, which is more honest than pretending it never happened; `purge` is the real delete.
5. **The graph is a derived cache.** The session log is the source of truth; every card can be re-distilled from episodes.

## Testing

No network, no real vault:

```bash
npm test        # 30 + 11 + 21 + 34 = 96 checks, plus the 25-question retrieval eval
npm run eval    # retrieval eval only (offline, deterministic)
```

- `test/smoke.mjs` — storage, redaction, BM25 retrieval, entity expansion, supersede chain, extractor parsing
- `test/capture.mjs` — drives the capture listener with real `session/event` shapes, including injected context
- `test/tools.mjs` — runs `execute` + `render` for all eight tools
- `test/extract.mjs` — the extractor: `fetch` stubbed for the http route (prompt construction, key resolution order, tolerant JSON parsing, per-card project attribution, cursor advance, dry run writing nothing, secrets stopped before the write), then a fake `llm` service for the harness route (borrows the Settings model and thinking level, honours an explicit override, explains a missing selection, handles every terminal `finish`, rejects an empty completion, and never touches `fetch`)

Two suites do touch the network (and cost money), so they are not in `npm test`:

```bash
npm run live             # real model, end to end: 3 episodes → distill → search them back
npm run live:supersede   # real model: record a decision, then correct it, check the supersede chain
```

They read the key from `~/.dsh/.credentials.yaml` or the environment (see above); nothing is hard-coded or persisted.

## Distillation, measured (real runs, not estimates)

With `deepseek-chat` via `npm run live`:

| Input | Output | Time | Tokens |
| --- | --- | --- | --- |
| 3 synthetic episodes (mixed zh/en, 2 projects) | 5 cards, project attribution 5/5 correct | 2.9 s / 3.6 s (two runs) | ≈1,590 |
| a real 266-event session log → 2 captured episodes (1,501 + 278 chars) | 9 cards (8 decision + 1 preference), Chinese in, Chinese out | 5.9 s | 2,816 (prompt 1,795 / completion 1,021) |

`npm run live:supersede` checks that temporal validity actually moves: round one records "share it on GitHub", round two the user corrects "the *plugin* is shared, not the memories"; the extractor fills `supersedes` itself, the old card flips to `superseded` with a `valid_to`, and the two link to each other. Offline tests can prove the mechanism, not that a model will use it.

One honest lesson from doing this: replaying an **older snapshot** produced a card stating "memories are meant to be shared on GitHub" as the current truth. The model was not at fault — the snapshot predated the correction. **A memory is only as good as what it read.** So episodes are kept forever, cards can be overturned (`supersedes`), and the overturning stays visible (`memory_timeline`).

## How good is retrieval, really?

`eval/` is an offline benchmark: 38 cards / 3 projects / 5 kinds / 7 cross-project entities / 4 supersede chains / 1 retracted card, 25 retrieval questions (9 keyword, 6 entity-bridge, 5 temporal, 5 negative) plus 4 paired "ask about the past vs ask about now" questions. It runs the real `searchCards` from this repo rather than a second scoring implementation. The questions were written before any number was seen and not edited afterwards.

```bash
npm run eval
```

Current result (limit 5, hops 1):

| Type | n | recall@1 | recall@5 | MRR |
| --- | --- | --- | --- | --- |
| keyword | 9 | 1.00 | 1.00 | 1.00 |
| entity-bridge | 6 | 0.67 | 0.94 | 0.83 |
| temporal | 5 | 0.60 | 1.00 | 0.80 |
| history pairs (retired vs successor) | 4 | — | — | 4/4 |
| negative (not in the vault) | 5 | — | — | 0/5 false positives |
| all | 25 | 0.80 | **0.98** | 0.90 |

**[`eval/REPORT.md`](eval/REPORT.md) records what this benchmark does not cover** and lists eight known weaknesses — including that history-vs-current intent is detected by one regex (also an enumeration; it still misses some phrasings), that "is that old Kuma setup still around?" is a present-tense question the reader may treat as history, and that ordinary topic words like "deployment" keep the false-positive line fuzzy. Read that report before trusting the number: 0/5 means "these five passed", not "negatives are solved", and 4 pairs is coin-flip-grade evidence.

One deliberate asymmetry: **asking about the past gets its own path**. "Is the extractor on by default now?" demotes the retired card and promotes the current answer; "what was the first version of the extraction design?" restores the retired card to full weight. Same words, different tense, different right answer — demotion must not mean unreachable.

## Known limits

- Retrieval is BM25 plus entity expansion — **no vector recall**. Chinese uses bigram tokenization, which works but trails embeddings; swap it out once you pass a few thousand cards.
- Distillation quality depends on the extractor model and **only happens when you call it**. Pair it with a scheduled task.
- Harness mode borrows "whatever model is currently selected in Settings", so switching models mid-conversation also switches the extractor; turn `useCurrentModel` off to pin one. It spends that provider's quota — being a plugin does not make the calls free.
- The graph view is a **static HTML file** (`graph.html`), not a panel inside the DSH Web GUI; a panel would be a separate client plugin.
- Deduplication only matches "same project + same normalized title". Paraphrases become two cards.
- The Settings form is the generic schemastery form: fields have bilingual descriptions, but there are **no section headings and no custom widgets**, and array-valued keys such as `skipPatterns` / `denyPatterns` are edited one line at a time. A nicer configuration UI would be a client-side panel of its own.
- Capture granularity is one turn (flushed on `turn/end`), not one message; tool calls inside a turn are counted, not recorded. A long multi-step turn keeps the first six visible text blocks.
- The vault writes its own `.gitignore` (ignoring `*.tmp`, OS junk and `.distill-state.json`); the last one is a per-machine distillation cursor, so a synced vault re-distills once on the other machine and relies on title dedup.

## License

MIT
