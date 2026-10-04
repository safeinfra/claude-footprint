# Pane and filters

`/map` opens and closes the footprint pane beside the conversation. The pane can show everything, only risky actions, or only the current turn, and the LOOKED AT line can be opened and folded.

## Sub-features

- `pane-toggle` `/map` opens the pane (`Footprint pane opened.`) and closes it (`Footprint pane closed.`).
- `pane-empty` a new session shows `No aws, kubectl or MCP calls yet.`
- `filter-all` `/map all` or hotkey `a` shows everything.
- `filter-write` `/map write` or hotkey `w` hides reads; with only reads recorded it shows `Nothing matches this filter.`
- `filter-turn` `/map turn` or hotkey `t` shows only the current turn; a new turn with no calls shows `Nothing in this turn yet.`
- `looked-fold` hotkey `l` opens or folds LOOKED AT; `/map collapse` or hotkey `c` folds it (`Footprint: LOOKED AT folded.`).
- `pane-narrow` on a too-narrow terminal `/map` replies `Footprint: the terminal is too narrow for the pane; widen it or use /map export.`

## How to get to it (user POV)

- Type `/map`, `/map all`, `/map write`, `/map turn`, `/map collapse` at the prompt.
- Focus the pane with ctrl+x tab and press `a`, `w`, `t`, `l`, `c`, or Tab to a button and press Enter.

## Driving it with drive.sh

Preconditions:

- Baseline from the [index](./README.md). For filters, run the Call capture drive first so there are rows.

- **Open.** `drive.sh send <name> "/map"`. The screen shows `footprint: Footprint pane opened.` and `drive.sh pane` starts with `[ all ] [ write ] [ turn ] [ collapse ] [ export ]` then `No aws, kubectl or MCP calls yet.`
- **Close.** `drive.sh send <name> "/map"` again. Screen shows `Footprint pane closed.`; `drive.sh pane` prints nothing pane-like.
- **Write filter, hotkey.** `drive.sh keys <name> focus w`. With only failed reads recorded, the pane shows `Nothing matches this filter.` (proven 2026-10-04). `drive.sh keys <name> a` brings the rows back.
- **Write filter, command.** `drive.sh send <name> "/map write"`. Screen shows `Footprint: showing write.` and the same pane state.
- **Turn filter.** After the capture turn, send any prompt that runs no aws/kubectl (e.g. `say hi`), `wait`, then `drive.sh send <name> "/map turn"`. Expect `Nothing in this turn yet.`
- **Narrow.** Not driven: would need `tmux resize-window -t fpv-<name> -x 60` before `/map`. Record what you see if you try it.
- **Proof.** `drive.sh capture <name> pane-<step>` after each step.

## Gotchas

- Pane hotkeys only work while the pane has focus. Without `focus`, `w` is typed into the prompt instead.
- `/map write` also opens the pane if it was closed; a bare `/map` toggles, so sending it twice closes it.
- The `[ write ]` button's highlight is a colour, which plain `capture-pane` drops. Prove the active filter by the rows shown, not by the button.
