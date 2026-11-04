---
name: create
description: Design and create a team-chat agent team with the person, a fixed team of subagents with roles, models, effort and a brief per member, saved to .claude/teams/ and opened in the team pane. Use when the person asks to create, set up, design or build a team.
argument-hint: "[what the team is for]"
---

# Create a team-chat team

Help the person design a team of subagents, then save it with the `mcp__team-chat__save_team` tool. The person's main session is always the team's lead; never add a lead member yourself.

## 1. Understand the job

If `$ARGUMENTS` already says what the team is for, start from it. Ask only what you cannot see for yourself, in one short message:

- What the team will work on (a kind of task, a product area, a repo).
- Any roles they already have in mind, and any they do not want.
- Cost preference: lean (more haiku/sonnet, lower effort) or strong (opus/high where it matters).

Look at the project yourself before asking about it: the languages, frameworks, test setup and folder layout (README, package files, top-level folders). Use what you find to make the briefs concrete: real test commands, real folder names.

## 2. Propose the team

Propose 2–6 members. Fewer, sharper roles beat many overlapping ones. For each member give:

| field | what to write |
| --- | --- |
| `name` | handle, lowercase: `backend`, `reviewer`, `docs` |
| `role` | job title |
| `emoji` | one emoji avatar |
| `color` | one of cyan, magenta, green, yellow, blue, red, claude; different per member |
| `model` / `effort` | haiku for mechanical work (running tests, searching), sonnet for most building, opus for hard reasoning or review; effort low…max to match |
| `description` | one sentence: when the lead should hand it work |
| `purpose` | one line: what it is for |
| `responsibilities` | 2–4 lines: what it does |
| `approach` | 2–4 lines: how it works, its process, with this project's real commands and paths |
| `boundaries` | 1–3 lines: what it must never do, and who to ask instead |
| `doneWhen` | one line: its definition of done |
| `tools` | only to restrict it, e.g. a reviewer with `["Read", "Grep", "Glob", "Bash", "SendMessage"]`; otherwise leave out. An explicit list drops `Agent` (members never spawn agents); without a list the member keeps `Agent` and is only told in its brief not to use it |
| `reportsTo` | optional: the handle it answers to. Leave out for the lead (the default). Must be a member of this team, and the chain must end at the lead with no loops |
| `handsTo` | optional: handles that receive its finished work, in order. May include `lead`. Loops are allowed (builder → tester → builder) |

Give the team a short name (`dev-team`, `docs-squad`). Show the proposal as a compact table (name, role, model/effort, purpose), then each member's responsibilities and boundaries in a line or two. Make sure the boundaries fit together: every kind of work has exactly one owner.

Also propose the chain, as an indented list under the table, with `→` for each handoff:

```
- lead
  - techlead → builder, tester
    - builder → tester
    - tester → reviewer
    - reviewer → techlead
```

Check it before showing it: every `reportsTo` reaches the lead, and every `handsTo` names a member who exists (a handoff with no receiver is a mistake). Members may still message each other directly, so the chain sets the order, not a wall.

Optionally ask whether one member should be the **main** member. Untargeted prompts the person types then go to that member, and `@<member>` still goes to any member. The main member must be a member, not the lead. Leave it out to keep the main session handling untargeted prompts.

Ask the person to approve or change it. Apply their changes and show only what changed.

## 3. Save it

Once they approve, call `mcp__team-chat__save_team` with `name`, `members` and, if chosen, `main` (a member's handle). If it answers with an `Error:` (an unknown handle in a relation, a self-reference, a `reportsTo` loop, a relation on the lead, or a `main` that is not a member), fix the proposal and call again. If it answers that the team exists, ask whether to replace it, then call again with `overwrite: true`, or pick another name.

Then tell the person in two or three lines: the team is saved and open in the pane, they give it work by typing a task in the chat, and `@<member> …` talks to one member directly.
