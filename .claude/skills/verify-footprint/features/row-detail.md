# Row detail

Selecting a row in the pane lists, below a rule, every call behind it: time, worked or failed, the Bash tool's description, then the full redacted command. Selecting it again hides the detail.

## Sub-features

- `detail-open` pressing a row shows `<object> · <operation> · <n> calls, <same command | n different commands>` and the `where` line.
- `detail-calls` one block per call: `HH:MM  failed|worked  <description>` then the command.
- `detail-close` pressing the same row again restores `Select a row to see every call behind it.`

## How to get to it (user POV)

- Focus the pane (ctrl+x tab), Tab to a row, press Enter. Or click the row in the desktop app.

## Driving it with drive.sh

Preconditions:

- Call capture drive done; pane shows the `ec2` and `pods` rows under `FAILED, NEVER SUCCEEDED`.

- **Select.** `drive.sh keys <name> focus`, then `drive.sh keys <name> Tab` one at a time, checking `drive.sh pane` each time, until the wanted row has focus, then `drive.sh keys <name> Enter`. Focus order is the five buttons, then rows top to bottom.
- **Expected (proven 2026-10-04, pods row).**
  ```
  pods · get · 2 calls, 2 different commands
  Kubernetes fpv-none · namespace web
    ┄┄┄┄
    09:48  failed  Test kubectl with non-existent context
      kubectl --context fpv-none -n web get pods
    ┄┄┄┄
    09:49  failed  Read-only kubectl query with non-existent context
      safe-kubectl --context fpv-none -n web get pods
  ```
  Descriptions are whatever the nested Claude wrote; times are local.
- **Close.** `drive.sh keys <name> Enter` on the same row. The detail is replaced by `Select a row to see every call behind it.`
- **Proof.** `drive.sh capture <name> row-detail`.

## Gotchas

- Focus is not visible in plain captures, so the Tab count is not fixed. Step one Tab at a time and check which row's detail opens.
- `Down` did not move focus to a row in the 2026-10-04 run; use Tab.
- Long commands wrap inside the pane column; the full command is in the export.
