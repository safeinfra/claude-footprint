# footprint

A Claude Code mod that keeps a live map of the `aws` and `kubectl` commands Claude runs: which account and region, which cluster and namespace, and whether each action **read**, **wrote**, **destroyed** or **exposed credentials**.

```
CHANGED (2)
  AWS account 123456789012 · ap-northeast-1
    ec2 i-0abc  terminate-instances, worked
  Kubernetes prod-eks · namespace web
    deployment api  rollout restart, worked
MAY HAVE CHANGED (2)
  AWS account 123456789012 · ap-northeast-1
    ecr  get-login-password, worked
  AWS account 123456789012 · global
    sts Deploy  assume-role, worked
      opens AWS account 210987654321, role Deploy
FAILED, NEVER SUCCEEDED (1)
  AWS account 123456789012 · ap-northeast-1
    lambda api  update-function-configuration (change), failed
LOOKED AT (24) · ec2, lambda, logs, rds, eks, iam, sts, s3, cloudwatch, pods, deployments, services, events, horizontalpodautoscalers
```

It draws nothing in the main window: the map lives only in the `/map` pane.

> **Display only.** The parser reads the command text, or an MCP tool's name and arguments. MCP reads are not drawn yet, and a tool its server marks read-only is not drawn even if it writes. Commands hidden in scripts, Terraform, Helm or SDKs do not show. **A missing row does not mean nothing happened.** It never blocks or rewrites a tool call.

## Install

In Claude Code:

```
/plugin marketplace add aqaurius6666/claude-footprint
/plugin install footprint@footprint
```

footprint uses function hooks, so start Claude Code with them turned on:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

**Claude Desktop (and other GUI launches):** the app does not read your shell's environment. Put `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` in the `env` block of `~/.claude/settings.json` and restart the app.

Or load a checkout for one session:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/claude-footprint
```

The mod runs `aws sts get-caller-identity --profile <p>` and `aws configure get region --profile <p>` once per profile your commands name, and `kubectl config current-context` / `kubectl config view` once, as child processes. All read-only; only the account id is kept.

Mods draw in the terminal and the desktop Code tab. `claude -p` and VS Code run the hooks but draw nothing.

## Use

| Command | Does |
|---|---|
| `/map` | Toggle the pane |
| `/map write` | Only write, destructive, cred and interactive actions |
| `/map turn` | Only the current turn |
| `/map all` | Everything |
| `/map collapse` | Fold LOOKED AT back to one line |
| `/map export` | Write every recorded call to `~/.claude/footprint/trace-<session>.jsonl` |
| `/map clear` | Empty the map and forget account lookups |

In the pane (focus it with ctrl+x tab): `l` opens or folds LOOKED AT, `a` / `w` / `t` pick a filter, `c` folds, `e` exports. Select a row to see every call behind it at the bottom: time, worked or failed, the AWS profile when the command does not name it, the Bash tool's own description, then the full command, redacted.

The export is one JSON object per call (time, turn, outcome, class, where, profile, object, operation, description, command), unfiltered, the same redacted text the pane shows. Each export of a session overwrites its file, and its path goes on the clipboard. Calls past the 500-call history cap are gone and not in it.

On a terminal too narrow for the pane, `/map` says so; calls are still recorded and `/map export` still works.

## How to read it



- Sections by outcome: `CHANGED` (a write or delete that worked; always shown), `MAY HAVE CHANGED` (credentials, interactive shells, MCP tools not known to be read-only), `FAILED, NEVER SUCCEEDED` (every try failed; `(change)` marks a change, which may have done something partway), `LOOKED AT` (reads, folded to one line).
- Under each: where it ran (`AWS account … · region`, `Kubernetes cluster · namespace`, or the MCP server), then one row per object and operation.
- `3 calls, last worked` counts tries. The detail says whether they were the `same command` or `N different commands` (flag order or `--output json` counts as different).
- `worked` is exit status only. The output is never recorded, so `LOOKED AT` does not mean anything was found.
- `account not looked up yet` / `account unknown` (expired SSO, no credentials) and `region unknown` are said, never guessed.
- Colour is the action class only (write yellow, destructive red, cred magenta, interactive cyan); a failure is told by its section, not by colour.
- `•` marks rows touched in the current turn. `older calls dropped` means the 500-call history cap pushed some out.


## Scope

| | Taken from, first wins |
|---|---|
| AWS profile | `--profile`, inline `AWS_PROFILE=`, `export AWS_PROFILE=` earlier in the command, `aws-vault exec p --`, Claude Code's `AWS_PROFILE`, `default` |
| AWS region | `--region`, `AWS_REGION` / `AWS_DEFAULT_REGION` (inline, then Claude Code's), `aws configure get region` |
| AWS account | `aws sts get-caller-identity --profile p`, once per profile, off the tool call's path. Only `Account` is kept |
| Global services | iam, sts, organizations, cloudfront, route53, `s3 ls` without a bucket, and similar, sit under `global` |
| kube context | `--context`, then `kubectl config current-context`. `config use-context X` switches later rows; earlier ones keep theirs |
| Namespace | `-n` / `--namespace`, `-A` (`all-ns`), cluster-scoped kinds (`cluster`), the context's default namespace |
| `-f file` | Kind, name and namespace read from the manifest (YAML or JSON, multi-document); `-f -` reads a heredoc |

`safe-aws` and `safe-kubectl` count as `aws` and `kubectl`.

## Security

- Secret values are masked before anything is stored: `--secret-string`, `--password`, `--token`, `--from-literal=k=v` (keeps `k`), `--parameter-overrides`, `--cli-input-json`, env prefixes like `*KEY*=`/`*SECRET*=`/`*TOKEN*=`/`*PASSWORD*=`, URL credentials, `curl -u`, `docker login -p`, AWS access key ids and common token shapes.
- Heredoc bodies are never stored.
- Command output is never stored, for any command.
- Masking is best effort: a secret passed in an unusual way can slip through. The map lives in the session's memory only.

## Develop

```bash
bun test spec
```

```bash
claude plugin test .
```

```bash
claude plugin validate .claude-plugin/plugin.json
```

Typecheck after `/plugin-types` has written `.claude/types/`:

```bash
bun x -p typescript tsc --noEmit -p .
```

- `hooks/parse.ts`: shell lexer, `aws` / `kubectl` argv parsing, classification, redaction. Pure.
- `hooks/record.ts`: parsed actions to stored events. Pure.
- `hooks/view.ts`: events to sections, rows, detail and the export. Pure.
- `hooks/register.tsx`: hooks, state, lookups, drawing.
- `types/index.d.ts`: the `$.state` contract.

See [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md) for where this differs from the original spec.
