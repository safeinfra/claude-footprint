# footprint

A Claude Code mod that keeps a live map of the `aws` and `kubectl` commands Claude runs: which account and region, which cluster and namespace, and whether each action **read**, **wrote**, **destroyed** or **exposed credentials**.

```
1: ▾ aws › acct-a (1234…9012)  w1 d1 cred2 ✗1
  ap-ne-1 ec2  r4 d1 · terminate-instances i-0abc
          ecr  cred1 · get-login-password
          lambda  r1 w1 ✗1 · ✗ update-function-configuration api
          logs, rds, eks · read-only (3)
  global  sts  r1 cred1 · assume-role Deploy
          iam, s3 · read-only (2)
  → link: aws acct-b (2109…4321) (role Deploy) · k8s prod-eks
2: ▸ aws › acct-b (2109…4321) › us-e-1  r4 · ec2, s3, cloudwatch
3: ▾ k8s › prod-eks › web  w1
  deployments  r2 w1 · rollout restart api
  pods, services, events, horizontalpodautoscalers · read-only (8)
```

Above the prompt, one line sums it up:

```
aws acct-a w1 d1 cred2 ✗1 │ k8s prod-eks w1 │ acct-b r4
```

> **Display only.** The parser reads the command text. Commands hidden in scripts, Terraform, Helm or SDKs do not show. **A missing row does not mean nothing happened.** It never blocks or rewrites a tool call.

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
| `/map collapse` | Fold every group back to its default |
| `/map clear` | Empty the map and forget account lookups |

In the pane (focus it with ctrl+x tab): `1`–`9` toggle a group, `a` / `w` / `t` pick a filter, `c` folds all. Select a row to see its full command, redacted, at the bottom.

On a terminal too narrow for the pane, `/map` says so and the band stays the view.

## How to read it

- `r12 w1 d1 cred1 i2 ✗1`: reads, writes, destructive, credential, interactive, failed.
- Colors: write yellow, destructive red, cred magenta, interactive cyan, read dim.
- `•` marks rows touched in the current turn; older rows are dim.
- Groups with only reads fold to one line. Groups with any write, destructive or cred action stay open, so those actions are always visible.
- `acct-a (…)` is still looking up the account; `acct-a (?)` could not (expired SSO, no credentials). Region `?` means none was given or configured.

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
- `hooks/view.ts`: events to groups, rows and the band. Pure.
- `hooks/register.tsx`: hooks, state, lookups, drawing.
- `types/index.d.ts`: the `$.state` contract.

See [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md) for where this differs from the original spec.
