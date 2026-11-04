---
name: janitor
description: Maintain team-chat teams: list, inspect, rename, delete or clear teams, duplicate a team, edit a member's model, effort, role, tools or brief, add, remove or reorder members, prune shared team files, fix a broken team file, or switch the active team. Use when the person asks to list, inspect, rename, delete, remove, clear, duplicate, edit, fix or switch any team, member or team file.
argument-hint: "[operation] [team]"
---

# Maintain team-chat teams

Operations: `list`, `inspect`, `rename`, `delete`, `clear`, `duplicate`, `edit`, `add`, `remove`, `reorder`, `prune`, `fix`, `switch`.

1. Parse `$ARGUMENTS` into an operation and a team name. If the operation is unclear, ask one short question. If the team is needed and missing, ask which one.
2. Find the teams. Each lives at `.claude/teams/<name>/team.json`. Legacy `.claude/teams/<name>.json` and `.claude/team.json` are still read, so include them when listing and when deleting or clearing. The active team is the plain-text name in `.claude/teams/.active`. Shared notes are in `.claude/teams/<name>/files/`.
3. For `list`, call `mcp__team-chat__start_team` with no name, which lists the project's teams. Do not start one. For `inspect`, read the team file and summarise its members (handle, role, model, effort, color), then print the chain: an indented list from the lead down through each member's `reportsTo`, with `→ handsTo` after each member that has one, and mark the team's `main` member.
4. Always read the target first. Use `mcp__team-chat__save_team` with `overwrite` true to rewrite a whole team, or `Edit` for a single field. Use `save_team` without `overwrite` for a duplicate under a new name. Do not put the lead entry (`isLead: true`) in the members list; `save_team` adds the lead itself.
5. Validate before writing:
   - Team and member names: letters, digits, `-` or `_`, 1 to 40 characters for teams.
   - Reserved member names: `you`, `team`, `all`.
   - Model: `haiku`, `sonnet`, `opus`, `inherit`, or a full model id.
   - Effort: `low`, `medium`, `high`, `xhigh` or `max`.
   - Color: `cyan`, `magenta`, `green`, `yellow`, `blue`, `red` or `claude`.
   - Never remove or rename the entry with `isLead: true`.
   - Relations (`reportsTo`, `handsTo`), checked across the whole member list:
     - The lead has neither `reportsTo` nor `handsTo`.
     - `reportsTo` names another existing member (not the member itself), or is left out, which means the lead. Following `reportsTo` from every member must reach the lead, with no loops.
     - `handsTo` is a list of existing members (the lead is allowed, not the member itself). Loops are fine.
     - `main` (team level) names an existing non-lead member, or is left out.
   - Set or clear a relation with `edit`: `reportsTo` (empty means the lead), `handsTo` (empty list clears it), and `main` (empty clears it). Write the canonical form: leave out `reportsTo` when it is the lead, and leave out an empty `handsTo`. Validate the whole list after the change, not just the edited member.
6. Before any destructive step, show the person exactly what will go, with paths, and wait for a yes. Destructive steps are `delete`, `clear` (all teams), `remove` a member, and `prune` or any deletion of files. Warn that `files/` holds shared notes that may be the only copy of a plan or decision, so they should commit or back them up first.
7. Keep `.active` in step. On a member `rename`, rewrite every `reportsTo`, `handsTo` and `main` that names the old handle. On a member `remove`, give its members the removed member's `reportsTo` (or leave it out, for the lead), drop it from every `handsTo`, and clear `main` if it named it. Show these changes in the confirmation. On `rename`, update `.active` if it named the old team. On `delete` or `clear`, remove `.active` if it named a deleted team, then ask which team to switch to, or leave it unset.
8. For `prune`, list the files in `files/` with their notes and `.index.json` entries, and ask which to delete. Update `files/.index.json` to match.
9. For `fix`, read the broken file, say what is wrong (for example the JSON parse error or a bad field value), propose the smallest fix, and write it only after the person agrees. Relation problems are the common case: a `reportsTo` loop, a handle that no longer exists, a relation on the lead, or a `main` that is not a member. The fix is usually to point the reference at the lead (leave `reportsTo` out), drop the bad `handsTo` entry, or clear `main`. Those warnings come from the plugin when it loads the team, so `fix` clears them.
10. For `reorder`, read the team, show the current member order (numbered, without the lead) and the proposed new order, and wait for the person to confirm. Then rewrite the `members` array in the new order with `mcp__team-chat__save_team` and `overwrite` true. The lead is not in the list. Keep every member's other fields unchanged, including `reportsTo` and `handsTo`, and keep the team's `main`. The new order must contain exactly the same handles as before.
11. Finish by calling `mcp__team-chat__start_team` with the active team's name, or with no name if none is active, to refresh the pane. Then summarise the result in one or two lines: what changed, and which team is active now.
