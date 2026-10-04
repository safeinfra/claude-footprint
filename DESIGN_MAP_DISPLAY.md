# Map display redesign (design note)

Status: brainstorm outcome, 2026-10-04. The **Presentation** rows of the table below are implemented (see IMPLEMENTATION_NOTES.md, v3); the **Capture** rows are not. Mockups marked **needs capture** cannot be drawn from today's events.

## Goal

- A reader catches up on what the AI touched or checked, fast.
- When they read an AI claim, they can compare it against the target, scope and conditions that were really checked.
- The map does not match claims to calls by itself. Hooks see tool calls only; whether a claim holds also depends on results. The `turn` filter is the reader's tool for that.
- A fresher engineer must be able to read it without learning a legend.

## Problems in the current pane (checked against code)

| Problem | Cause |
|---|---|
| A failed read looks destructive | `failed` and `destructive` are both red (`hooks/register.tsx:30-34`); failure overrides the class colour (`register.tsx:336,357,384`) |
| Operation name repeats on service row and child row | Service row note is `latestNotable` (`hooks/view.ts:229-231`), then the same event is drawn again as a `res` line |
| Group label and detail label differ | Groups merge by account and keep the first profile seen (`view.ts:113-115`); detail uses the event's own profile (`view.ts:337`). The merge hides which role ran the call |
| Region falls off screen | Title is `tool › profile › region`, truncated at the end (`view.ts:213`, `register.tsx:321`) |
| `r4 ✗2` is ambiguous | Means 4 reads of which 2 failed (`view.ts:51-54`), reads as 4 + 2 |
| Row and detail can disagree | A `res` row draws the worst event but selects the newest (`view.ts:163-164`) |

## Decisions

### 1. Layout: sections by outcome, plain words

```
CHANGED (1)
  Kubernetes prod-eks · namespace web
    deployment api       rollout restart, worked

MAY HAVE CHANGED (1)
  argocd
    argocd app sync payments-api          worked

FAILED, NEVER SUCCEEDED (1)
  AWS account 437984728688 · ap-northeast-1
    rds describe-db-clusters      tried 2 times, all failed

LOOKED AT (3)
  AWS account 437984728688 · ap-northeast-1
    rds describe-db-instances     same call 2 times, last one worked
    ec2 describe-instances        same call 2 times, last one worked
  Kubernetes prod-eks · namespace web
    pods                 get, 3 different calls
  ran without error; results are not recorded

NOT TRACKED
  pup (5 calls), terraform (1 call)
  add them in config to see what they did
```

- Sections, top to bottom: `CHANGED`, `MAY HAVE CHANGED`, `FAILED, NEVER SUCCEEDED`, `LOOKED AT`, then a `NOT TRACKED` line.
- `CHANGED` always shows, even empty (`nothing changed`).
- Failure versus impact is told by position, not colour. Colour stays for class only.
- A failed changing call says so: `rollback (change), failed`. A failed change may have changed something partway.
- No symbols or abbreviations: no `r4 ✗2`, no shortened account ids, full region names.
- Filters `all` / `write` / `turn` and `collapse` stay. They filter events before sectioning. `write` already keeps everything that is not `read` (`view.ts:94`), so it covers `MAY HAVE CHANGED`.
- `LOOKED AT` collapses to one line by default: `LOOKED AT (14) · rds, ec2, pods`.
- Rejected: one row per call in time order. Too fragmented to read.

### 2. Where it ran: 0 to 2 levels, per domain

- System, then whatever scope the call really carried, then object, then the real operation name.
- AWS: account · region. Kubernetes: cluster · namespace (`all namespaces`, `cluster-wide` written out). Generic MCP or CLI: system name only unless `where` fields are configured.
- No level is invented. Missing data prints as `region unknown`, the same idea as today's `?` (`view.ts:120`).
- Profile leaves the header and moves to the detail area. The header shows account and region, so long profile names stop truncating it. Detail lists the profile of each call.

### 3. Rows: object first, real operation after

- `deployment api   describe, 1 time`. Several operations on one object stay together.
- AWS calls with no named resource use the service (`rds`) as the object.

### 4. Counting and retries

- Merge key becomes the stored command string (`cmd`), not verb + resource (`view.ts:153`).
- Identical commands: `same call N times`. Different commands on the same object: `N different calls`.
- Outcome in words: `last one worked`, `tried N times, all failed`, `failed, then worked`.
- Known cost: cosmetic differences (flag order, `--output json`) split rows. Showing too much is safer than merging two different checks.
- When the 500-event cap (`hooks/record.ts:7`) has dropped history, print `older calls dropped`.

### 5. Detail area (bottom of the pane only, no inline expand)

```
pods · get · 3 calls
  14:02  worked   get pods -l app=api
  14:02  failed   get pods -l app=worker
  14:03  worked   get pods -l app=worker
where     Kubernetes prod-eks · namespace web
result    exit status only; output is not recorded
```

- Lists every call behind the selected row: time, outcome, profile where it applies, full command.
- The raw command string is the detail. No extra parsing needed.
- For an MCP server with no config, also print `other fields not shown: query, from, to, limit` (names only). **Needs capture**: store the arg key names per call.

### 6. CLI tools beyond aws and kubectl: user-declared

- Nothing is tracked by default except aws and kubectl. The plugin ships copyable sample tables (argocd, helm, terraform).
- Wrappers: strip a `safe-` prefix before lookup.
- Untracked commands are counted per tool in `NOT TRACKED`, so silence is never read as "the AI did nothing".
- A config `ignore` list keeps local noise (`ls`, `cat`, `git`) out of `NOT TRACKED`.

Matching is verb-anchored, not position-anchored, so flags before the subcommand do not matter:

```
argocd --server cd.example.com --grpc-web app sync payments-api
```

1. Drop every token that starts with `-`.
2. A call is `read` only if the **first token that matches any list** is a read verb.
3. Any verb not in the `read` list lands in `MAY HAVE CHANGED`. Users declare read verbs only; there is no `change` list.
4. Object = the non-flag token right after the matched verb.
5. Anything the table cannot handle (`bash -c`, `xargs`, shell variables) falls back to the raw command in `MAY HAVE CHANGED`. No guessing.

Consequence: a user-declared CLI never appears under `CHANGED`. `CHANGED` comes only from aws, kubectl and MCP.

Residual risk: a `--flag value` whose value equals a read verb, when the real verb is unlisted. Rule 2 covers the common case; declaring value-taking flags in `where` covers more.

### 7. Config shape (same three keys for CLI and MCP)

```
argocd:                       # CLI name
  read:  [get, list, diff, manifests, history, logs]
  where: [--project]
  show:  [--revision]

datadog:                      # MCP server name
  where: [env, service]
  show:  [query, from, to]

ignore: [ls, cat, git]
```

- `where`: fields that go on the scope line.
- `show`: fields drawn next to the operation; they take part in the same-call comparison.
- `read`: CLI only. MCP class comes from the server's read-only flag and the tool name (`hooks/mcp.ts:62-70`).
- Naming an MCP server in config is also the switch that keeps its reads. Today generic MCP reads are dropped at capture (`mcp.ts:97-98`).
- The hard-coded identifier allowlist (`mcp.ts:21-26`) stays as the default; `where` and `show` add to it.
- `show` values need a longer limit than today's 60 characters (`mcp.ts:28`): truncate to pane width in the list, full value in detail.

Datadog with config (**needs capture**: reads kept, `query`/`from` stored):

```
LOOKED AT (2)
  Datadog · env prod · service payments-api
    logs       search_logs, 2 different calls
                 query "status:error" · from now-15m
                 query "status:error @http.status:5xx" · from now-7d
    monitor 48213   get_monitor, 1 time
```

### 8. Redaction

- No extra masking for user-declared tools. The existing `redact` pass already runs on every stored command.
- `show` can pull message bodies or payloads into the map if a user lists such a field. That is the user's call; the README should say so in one line.

## Presentation only versus needs capture

| Change | Kind |
|---|---|
| Sections, plain wording, scope line, object-first rows | Presentation |
| Same call / different calls, retry wording | Presentation |
| Detail lists every call behind a row | Presentation |
| `older calls dropped` | Presentation (needs a dropped flag or counter) |
| User-declared CLI tools, `NOT TRACKED` per tool, `ignore` | Capture |
| Keep MCP reads for configured servers | Capture |
| `where` / `show` fields for MCP and CLI | Capture |
| Arg key names for `other fields not shown` | Capture |
| Resource counts, error reasons, empty results, turn titles | Not planned. Tool output and prompts are not stored |

`ok` is exit status only. `LOOKED AT` means the command ran without error, not that it found or confirmed anything.

## Open points against the existing plan (IMPLEMENTATION_NOTES.md, MCP section)

- **Config sources.** The plan takes `mcp.read` only from `user`/`flag`/`policy`, so a cloned repo cannot hide writes. The CLI `read` list carries the same risk and should follow the same rule. Not yet decided for `show`, `where`, `ignore`.
- **Config key shape.** The plan uses flat dotted keys read through `$.settings.read`. The nested per-tool shape above has to be mapped onto that, or the plan changed.
- **Keyed by server name.** The plan avoids matching adapters on server name because users name servers freely. User config keyed by their own server name is fine, but it will not travel between machines.
- **History cap.** Reads were dropped at capture so MCP reads could not evict CLI writes from the 500-event cap. Keeping reads for configured servers reopens that. Option: evict reads before anything else.
- **Lexer reuse.** `lex` and `analyze` are exported from `hooks/parse.ts`. Whether their tokenising serves the verb-anchored matcher was not checked.
- **Order across groups** is lost with outcome sections (staging checked before prod, or interleaved). Accepted for now; the detail area shows times.
