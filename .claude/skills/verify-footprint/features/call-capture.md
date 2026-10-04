# Call capture

When Claude runs an `aws` or `kubectl` command through Bash, footprint adds a row to the `/map` pane: the object and operation, under where it ran (AWS profile/account and region, or Kubernetes context and namespace), in a section chosen by outcome. It never blocks or changes the call.

## Sub-features

- `capture-aws` an `aws <service> <verb>` call becomes a row `<service>  <verb>, <outcome>` under `AWS profile <p> · <account state> · <region>`.
- `capture-kubectl` a `kubectl <verb> <kind>` call becomes a row `<kind>  <verb>, <outcome>` under `Kubernetes <context> · namespace <ns>`.
- `capture-failed` a call that never worked lands in `FAILED, NEVER SUCCEEDED (n)`.
- `capture-looked` a read that worked folds into one `LOOKED AT (n) · <topics>` line.
- `capture-account-unknown` an unresolvable profile reads `account unknown` (or `account not looked up yet` while pending), never a guessed id.
- `capture-repeat` repeated calls merge into one row: `2 calls, all failed`.
- `capture-current-turn` rows touched in the current turn start with `•`.

## How to get to it (user POV)

- Ask Claude to do something that makes it run `aws ...` or `kubectl ...` (or `safe-aws` / `safe-kubectl`) in Bash, then open `/map`.

## Driving it with drive.sh

Preconditions:

- Baseline from the [index](./README.md); pane open, showing `No aws, kubectl or MCP calls yet.`

- **Failed reads.** Send the prompt from SKILL.md Drive (`safe-aws --profile fpv-none ec2 describe-instances --region ap-northeast-1` and `safe-kubectl --context fpv-none -n web get pods`, nothing appended), then `wait`. `drive.sh pane` shows (proven 2026-10-04, run3):
  ```
  FAILED, NEVER SUCCEEDED (2)
    AWS profile fpv-none · account unknown · ap-northeast-1
  •    ec2  describe-instances, failed
    Kubernetes fpv-none · namespace web
  •    pods  get, failed
  ```
  `CHANGED (0)` / `nothing changed` sits above it. If the nested Claude ran a command twice (e.g. raw and `safe-*`), the row reads `2 calls, all failed`.
- **Appended echo flips the outcome.** Same commands with `; echo "Exit code: $?"` appended exit 0, so the rows go to `l: LOOKED AT (2) · ec2, pods`. footprint is correct there: `worked` is the Bash call's result.
- **Worked read.** Ask it to run `kubectl version --client` and `kubectl config get-contexts` (both exit 0 offline). Expect a `LOOKED AT (n) · ...` line naming `cluster` / `config`. Not yet driven live: record what the pane actually says.
- **Proof.** `drive.sh capture <name> capture-after`, then `drive.sh export <name>`. `trace.jsonl` holds one line per call with `"outcome":"failed","class":"read"` and the same `where` text as the pane.

## Gotchas

- The account lookup runs in the background. A capture taken right after the call can show `account not looked up yet`; it settles to `account unknown` with the empty config.
- Unless told "do not retry", the nested Claude often reruns raw commands through `safe-aws` / `safe-kubectl`. That doubles call counts. Both commands appear in the row detail.
- Raw `aws` raises a permission prompt and the user's hook blocks raw `kubectl` reads. A **hook-blocked** `kubectl` still showed up as a `failed` row (2026-10-04), even though it never ran. A permission-dialog "No" or a classifier denial should leave no row; not driven yet.
- `drive.sh wait` returning `idle` too early means the busy spinner changed its look; check the screen for `… (Ns ·` and fix `busy()` in `drive.sh`.
