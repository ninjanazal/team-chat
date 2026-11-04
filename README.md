# team-chat

A Claude Code plugin for running fixed teams of subagents from a mission-control pane beside the chat. Each member (lead, backend, frontend, qa, …) is a real agent type with its own role, model and effort. The pane shows one card per member with a live, animated status (spinner while working, pulsing ◆ when it needs help, a sparkle then ✓ when done), its current activity, steps and elapsed time, plus a `#team` feed of every task and message.

## Install

At the prompt of a terminal session:

```
/plugin install team-chat --marketplace ninjanazal/team-chat
```

From a shell:

```
claude plugin install team-chat --marketplace ninjanazal/team-chat
```

Answer `y` to add the marketplace, then pick a scope. In the desktop app: + next to the prompt box → Plugins → Add marketplace `ninjanazal/team-chat` → Add plugin.

Or run the script in this repo and answer its questions:

```
./plugin.sh
```

It asks whether to install, update or remove the plugin. Then it asks where: **system** for every project on this machine, or **local** for one project (it asks which folder, the current one by default), just for you. Restart Claude Code after installing or updating.

## Using it

- **`/team-chat:create [what it's for]`**: Claude looks at your project, interviews you briefly, proposes a team (roles, models, effort and a brief per member), and saves it once you approve.
- **`/team-chat:start [team]`**: makes a team active and opens the pane; without a name it asks which one.
- **`/team-chat:janitor [operation]`**: maintains teams: list, inspect, rename, delete or clear, duplicate, edit or add/remove members, prune shared files, fix a broken team file, switch the active team. Asks before anything destructive.
- **`/team-chat:help`**, `/team help`, or **? help** in the pane: the full guide.

- **Pick a team.** `/team` opens the pane; with several teams it asks which one you want to work with. `/team <name>` goes straight to one, **⇄ switch** changes it. The last team is remembered per project, and a project with only one team loads it automatically. **⇄ switch** works only while no member is working; otherwise the button reads "⇄ switch (busy)".
- **Flags.** **⚑ needs you** appears when a member asks for permission (its tool check returns `ask`) and the same call is still pending after about 1.5 seconds (a call that runs at once never flashes the flag) or sends `NEEDS-HUMAN: <question>`, and also when its `BLOCKED:` line mentions permission or approval. **◆ needs help** appears when a member sends a `BLOCKED:` message mid-run. A member that has finished (done or idle) never shows a flag: a `BLOCKED:` line in its final answer stays in the chat and the log only. Both blink and show the reason. A flag clears when the permission is answered or its tool runs, when the member's next step starts, when you message it, or when a newer message from it replaces the blocked one. A flag can be false when the permission mode settles an ask automatically, since the member then goes on without you. A member that is only waiting on its own background work or on messages shows as working, not "needs you"; only a tool check `ask` raises the permission flag. After a denied ask, the flag stays until the member's next tool call or the end of its turn. The flag is matched on the tool call id, falling back to the tool name.
- **Members never spawn agents.** Only the lead starts members, and a member talks to a teammate by name with SendMessage. The Agent tool is removed from a member only when its entry has an explicit `tools` list. Members without one keep the tool, and for them the rule is in the brief only, because the plugin cannot exclude a single tool.
- **`/new` and `/clear`** keep the active team, and the lead is told about it again.
- **Give the lead a task** in the main chat. Your main session is the lead: it splits the work and starts members in the background. Untargeted prompts go to the team's **main** member instead, when the team sets one (see below).
- **Talk to a member** with `@backend …` in the main chat (or **✉ message** on its card). It goes straight to that member, resumed or started. `@lead …` reaches your main session.
- **Stats:** each card shows `model · effort · ctx · out · steps`. `ctx` is the latest request's input tokens, `out` the output tokens; a `max_tokens` stop shows in red.
- **Receipt:** a line under the header summarises the running or last lead turn: duration, agents used, edits, errors.
- **On/off:** the team view is off by default: a session is a plain Claude Code chat (no team prompt, no `@member` routing, no queue, no pane), even in a project that already has teams. `/team on` reloads the last team, opens the pane and remembers the choice per project, so `/new` and `/clear` stay on; `/team <name>`, `/team-chat:start` and `/team-chat:create` also turn it on. `/team off` turns it off again and closes the pane. `TEAM_CHAT=on claude` launches with it on (not stored). `/team`, `/team list` and `/team help` work while it is off.
- **Usage row:** the context fill and the 5h/wk limits sit centered at the bottom of the pane from the moment it opens.
- **Views:** `/team close` shows one line per member, `/team open` the full cards. `/team layout auto|compact|wide|mini` sets how cards are drawn; `/team palette pastel|default` sets the colours.
- **Keys:** with the pane focused, On Overview, `1`–`9` expands that member's card (full task, last tool calls, start of its answer). Click a member to expand it too.
- **Tabs:** **Overview** (cards and receipt, with a ⚑N badge for members needing help or you), **Chain**, **Files**. The pane remembers the tab. Switch by clicking, or `/team tab overview|chain|files`.
- **Scrolling:** the mouse wheel scrolls the pane; with it focused, the arrow and page keys do too. On Chat, a **↓ latest** button jumps to the newest message.
- **Queue** (read-only): the tab shows all member work in three groups: **Active** (running now, flagged ones included), **Queued**, and **Done**. Each group shows only what fits on the screen, with a `+N more` line when rows are cut and an `N hidden` line when a group does not fit. Tasks are not added in the pane: use `/team queue <member|any> <task>`. `/team queue` lists the queue, and `/team queue rm #<id>` removes a queued task. A task is sent when its member is idle or done, never to one that needs help or you. The lead cannot be queued: give it work in the chat.

## Member briefs and summaries

Each member has a brief: its **purpose**, its **responsibilities**, **how it works**, its **boundaries** (what it must never do) and when it is **done**. The brief becomes the member's instructions, so a member knows what it is for and where its job ends. Each card shows the member's **task** and a live **now** line: a one-sentence summary of what it is doing, written by Haiku from its latest actions at most every 20 seconds while it works (billed to your account like any model call), and the first line of its report once it is done.

## Shared team files

Members and the lead keep plans, specs, decisions, API contracts and handoff notes as **team files** in `.claude/teams/<team>/files/`. They work through three tools: `write_file` (replace or append, with a one-line note), `read_file` and `list_files`. Every member's brief tells it to check the files before starting and to save anything a teammate or a later session will need. Members whose tools are restricted still get these three.

- Each write records its author in `files/.index.json` and posts `📄 wrote <file>` in `#team`.
- **📁 files** in the pane header (or `/team files`) lists them, newest first; click one to read it.
- They are ordinary files in your project. They persist across sessions, and you share them by committing them. Hand edits and `git pull`s show up within a second.

## Teams and members

Teams live in `.claude/teams/<team>/team.json` in your project (an older `.claude/team.json` is picked up too). With no team, the plugin asks whether to create one.

- `/team new <team> [from]` creates a team, empty (lead only) or copied from an existing team; or use **+ new team** in the picker.
- **+ member** / `/team add <name>` opens a form: name, role, emoji, model, effort, when to use, instructions, tools.
- **✎ edit** / `/team edit <name>`, `/team remove <name>`.
- **⇅ move** (or **⇅** on rows and the mini line): click it, then click **↳ place here** at the new spot. **Cancel** drops the pick. The lead is always first and cannot be moved; the edit form keeps its Position and up/down buttons.
- Hand edits of the team file are picked up within a second; `/team reload` forces it. `/team list` lists the teams.

### Who answers to whom

Each member can set two optional fields in the team file:

- **`reportsTo`**: the member it answers to. Missing means the lead. Chains must end at the lead, with no loops.
- **`handsTo`**: the members that receive its finished work, in order. It may name the lead, and loops are allowed (for example builder → tester → builder).

The chain has its own **Chain** tab: a tree from you (the lead) drawn with `├─` / `└─` connectors for who reports to whom, each member with its live status, role and model, and `⇢` arrows for who it hands work to. The lead is told about it too, and the lead is told about it, so it knows where a member's result should go next. It sets the order, not a wall: any member can still message any other member directly.

The team can also name one member as **`main`** (a team-level field, not a member's). Prompts you type without an `@` target go to it. `@member …` still goes to any member. Leave it out and your main session handles untargeted prompts, as before.

Set these with `/team-chat:create` or `/team-chat:janitor`, or by hand in the team file. Invalid values are rejected when saving, and when a hand edit loads they are dropped with a warning in `#team`.

Every change is posted in `#team` and told to the lead.

## Developing

`claude --plugin-dir .` runs it from this folder; `claude plugin test .` runs the tests, `claude plugin validate .` checks it.
