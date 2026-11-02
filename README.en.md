# dsh-memory-graph

English · [中文](README.md)

Long-term **associative memory** for [DeepSeek Harness](https://getartcraft.com) (DSH).

Context compaction quietly deletes things. This plugin keeps a second layer — outside the context window, on your own disk, readable by you — so that a decision you made three months ago can still be found.

Zero dependencies. Plain Node ESM. No build step.

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

The vault defaults to `~/dsh-memory` and is created on activation.

Installation is hot, but **changing this plugin's source requires restarting Harness** to load a fresh module generation.

Uninstall with `plugin_manager action=remove_bundle target="@local/dsh-memory-graph"`. The vault is not touched — it lives in `~/dsh-memory`, independent of the plugin.

## What you get on disk

```
~/dsh-memory/
├── vault.json                   schema version, creation time
├── projects.json                project slugs seen so far
├── README.md                    generated index linking every card
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

Override the row in your profile's `cordis.patch.yml`:

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
      baseUrl: 'https://api.deepseek.com/v1'
      model: 'deepseek-chat'
      apiKeyEnv: 'MEMORY_LLM_API_KEY'   # read from the environment, never stored
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
| `privacy.useDefaultPatterns` | `true` | built-in key / private-key / token rules |
| `privacy.denyPatterns` | `[]` | your own regexes, `(?i)` prefix supported |
| `extractor.enabled` | `false` | when off, nothing is captured *and* no model is ever called |
| `extractor.apiKeyEnv` | `MEMORY_LLM_API_KEY` | the key comes from the environment |
| `retrieval.hops` | `1` | entity expansion depth, `0` = keyword only |

The extractor is **separate from your chat model**: its own endpoint, its own model, its own budget.

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

## Design decisions worth knowing

1. **The entity layer is what makes cross-project work.** Two projects sharing "the same Postgres instance" or "the same tool" connect through an entity page, instead of hoping a vector similarity finds it.
2. **Temporal validity `[valid_from, valid_to]`.** Without it the graph lays this quarter's plan next to last quarter's and lies to you quietly.
3. **The write unit is an episode, not a fact.** `episodes` records when, why and who decided; `cards` are conclusions derived from episodes.
4. **Forgetting is a feature.** `retract` keeps the trace, which is more honest than pretending it never happened; `purge` is the real delete.
5. **The graph is a derived cache.** The session log is the source of truth; every card can be re-distilled from episodes.

## Testing

No network, no real vault:

```bash
npm test     # 56 checks across three suites
```

- `test/smoke.mjs` — storage, redaction, BM25 retrieval, entity expansion, supersede chain, extractor parsing
- `test/capture.mjs` — drives the capture listener with real `session/event` shapes
- `test/tools.mjs` — runs `execute` + `render` for all eight tools

## Known limits

- Retrieval is BM25 plus entity expansion — **no vector recall**. Chinese uses bigram tokenization, which works but trails embeddings; swap it out once you pass a few thousand cards.
- Distillation quality depends on the extractor model and **only happens when you call it**. Pair it with a scheduled task.
- No graph view in the Web UI yet; the generated `README.md` and the filesystem are the current browser.
- Deduplication only matches "same project + same normalized title". Paraphrases become two cards.
- No `Config` schema is exported, so there is no Settings form; configure via `cordis.patch.yml`. That keeps the plugin truly dependency-free at the cost of writing YAML.
- Capture granularity is one turn (flushed on `turn/end`), not one message; tool calls inside a turn are counted, not recorded.

## License

MIT
