# 💬 team-chat

> Mission control for a fixed team of Claude Code subagents, in a pane beside your chat.

Each member (lead, backend, frontend, qa, …) is a real agent type with its own role, model and effort. The pane shows one card per member with a live, animated status: a spinner while working, a pulsing ◆ when it needs help, a sparkle then ✓ when done. Cards also show current activity, steps and elapsed time, and a `#team` feed records every task and message.

## 📦 Install

At the prompt of a terminal session:

```
/plugin install team-chat --marketplace ninjanazal/team-chat
```

From a shell:

```
claude plugin install team-chat --marketplace ninjanazal/team-chat
```

Answer `y` to add the marketplace, then pick a scope. In the desktop app: + next to the prompt box → Plugins → Add marketplace `ninjanazal/team-chat` → Add plugin.

Or run the script in this repo:

```
./plugin.sh
```

It asks whether to install, update or remove, then where: **system** (every project on this machine) or **local** (one project, just for you). Restart Claude Code after installing or updating.

## 🚀 Quick start

1. `/team-chat:create what it's for`: Claude looks at your project, interviews you briefly, proposes a team and saves it once you approve.
2. `/team on` (or `/team-chat:start`): opens the pane.
3. Give the lead a task in the main chat. It splits the work and starts members in the background.
4. Talk to anyone with `@backend …`.

## 🧭 Commands

| Command | What it does |
| --- | --- |
| `/team-chat:create [purpose]` | Design and save a new team |
| `/team-chat:start [team]` | Make a team active and open the pane |
| `/team-chat:janitor [operation]` | List, inspect, rename, delete, duplicate, edit teams and members, prune files, fix a broken team file. Asks before anything destructive |
| `/team-chat:help`, `/team help`, **? help** | The full guide |
| `/team on` / `/team off` | Turn the team view on or off |
| `/team <name>` / `/team list` | Open a team / list teams |
| `/team new <team> [from]` | Create a team, empty or copied |
| `/team add\|edit\|remove <name>` | Manage members |
| `/team reload` | Force a reload of the team file |
| `/team open` / `/team close` | Full cards / one line per member |
| `/team layout auto\|compact\|wide\|mini` | How cards are drawn |
| `/team palette pastel\|default` | Colours |
| `/team tab overview\|chain\|files` | Switch tab |
| `/team files` | Open the shared files |
| `/team queue <member\|any> <task>` | Queue a task; `/team queue` lists, `/team queue rm #<id>` removes |

## 🔌 On/off

The team view is **off by default**. A session is a plain Claude Code chat (no team prompt, no `@member` routing, no queue, no pane), even in a project that already has teams.

- `/team on` reloads the last team, opens the pane and remembers the choice per project, so `/new` and `/clear` stay on.
- `/team <name>`, `/team-chat:start` and `/team-chat:create` also turn it on.
- `/team off` turns it off and closes the pane.
- `TEAM_CHAT=on claude` launches with it on (not stored).
- `/team`, `/team list` and `/team help` work while it is off.

## 🖥️ The pane

- 🗂️ **Tabs:** **Overview** (cards and receipt, with a ⚑N badge for members needing help or you), **Chain**, **Files**. The pane remembers the tab.
- 🃏 **Cards:** each shows `model · effort · ctx · out · steps`. `ctx` is the latest request's input tokens, `out` the output tokens; a `max_tokens` stop shows in red.
- 🧾 **Receipt:** a line under the header summarises the running or last lead turn: duration, agents used, edits, errors.
- 📊 **Usage row:** context fill and 5h/wk limits sit centered at the bottom of the pane from the moment it opens.
- ⌨️ **Keys:** on Overview, `1`–`9` expands that member's card (full task, last tool calls, start of its answer). Clicking a member does the same.
- 📜 **Scrolling:** the mouse wheel scrolls; with the pane focused, so do the arrow and page keys. On Chat, **↓ latest** jumps to the newest message.
- 🔀 **Pick a team:** `/team` asks which one when there are several. The last team is remembered per project, and a lone team loads automatically. **⇄ switch** works only while no member is working (otherwise it reads "⇄ switch (busy)").

## 🚩 Flags

- **⚑ needs you** appears when:
  - a member asks for permission (its tool check returns `ask`) and the same call is still pending after about 1.5 seconds, so a call that runs at once never flashes it;
  - a member sends `NEEDS-HUMAN: <question>`;
  - its `BLOCKED:` line mentions permission or approval.
- **◆ needs help** appears when a member sends a `BLOCKED:` message mid-run.

Both blink and show the reason. A flag clears when the permission is answered or its tool runs, when the member's next step starts, when you message it, or when a newer message replaces the blocked one.

Good to know:
- A member that has finished (done or idle) never shows a flag: a `BLOCKED:` line in its final answer stays in the chat and the log only.
- A member only waiting on its own background work or on messages shows as working. Only a tool check `ask` raises the permission flag.
- A flag can be false when the permission mode settles an ask automatically.
- After a denied ask, the flag stays until the member's next tool call or the end of its turn. It is matched on the tool call id, falling back to the tool name.

## 🗣️ Talking to the team

- **Give the lead a task** in the main chat. Your main session is the lead. If the team sets a **main** member, untargeted prompts go to it instead.
- **Talk to a member** with `@backend …` (or **✉ message** on its card). It is resumed or started. `@lead …` reaches your main session.
- **Members never spawn agents.** Only the lead starts members; a member reaches a teammate by name with SendMessage. The Agent tool is removed only when a member's entry has an explicit `tools` list. Otherwise the rule lives in its brief only, because the plugin cannot exclude a single tool.
- **`/new` and `/clear`** keep the active team, and the lead is told about it again.

## 📋 Queue

Read-only tab showing all member work in three groups: **Active** (running now, flagged ones included), **Queued** and **Done**. Each group shows what fits, with `+N more` when rows are cut and `N hidden` when a group does not fit.

Add tasks with `/team queue <member|any> <task>`. A task is sent when its member is idle or done, never to one that needs help or you. The lead cannot be queued: give it work in the chat.

## 📝 Member briefs and summaries

Each member has a brief: its **purpose**, **responsibilities**, **how it works**, **boundaries** (what it must never do) and when it is **done**. The brief becomes its instructions.

Each card shows the member's **task** and a live **now** line: a one-sentence summary written by Haiku from its latest actions at most every 20 seconds while it works (billed to your account like any model call), and the first line of its report once done.

## 📁 Shared team files

Members and the lead keep plans, specs, decisions, API contracts and handoff notes as **team files** in `.claude/teams/<team>/files/`, through three tools: `write_file` (replace or append, with a one-line note), `read_file` and `list_files`. Every brief tells the member to check them before starting and to save anything a teammate or a later session will need. Members with restricted tools still get these three.

- Each write records its author in `files/.index.json` and posts `📄 wrote <file>` in `#team`.
- **📁 files** in the header (or `/team files`) lists them, newest first; click one to read it.
- They are ordinary files in your project: they persist across sessions and you share them by committing. Hand edits and `git pull`s show up within a second.

## 👥 Teams and members

Teams live in `.claude/teams/<team>/team.json` (an older `.claude/team.json` is picked up too). With no team, the plugin asks whether to create one.

- `/team new <team> [from]`, or **+ new team** in the picker.
- **+ member** / `/team add <name>` opens a form: name, role, emoji, model, effort, when to use, instructions, tools.
- **✎ edit** / `/team edit <name>`, `/team remove <name>`.
- **⇅ move** (or **⇅** on rows and the mini line): click it, then **↳ place here** at the new spot; **Cancel** drops the pick. The lead is always first and cannot be moved; the edit form keeps its Position and up/down buttons.
- Hand edits are picked up within a second; `/team reload` forces it.

### 🔗 Who answers to whom

Each member can set two optional fields in the team file:

- **`reportsTo`**: the member it answers to. Missing means the lead. Chains must end at the lead, with no loops.
- **`handsTo`**: the members that receive its finished work, in order. It may name the lead, and loops are allowed (for example builder → tester → builder).

The **Chain** tab draws a tree from you (the lead) with `├─` / `└─` connectors for who reports to whom, each member with its live status, role and model, and `⇢` arrows for who it hands work to. The lead is told about the chain too, so it knows where a member's result should go next. It sets the order, not a wall: any member can still message any other directly.

A team can also name one member as **`main`** (a team-level field). Prompts without an `@` target go to it; `@member …` still goes to any member. Leave it out and your main session handles them.

Set these with `/team-chat:create` or `/team-chat:janitor`, or by hand. Invalid values are rejected when saving; on a hand edit they are dropped with a warning in `#team`. Every change is posted in `#team` and told to the lead.

## 🛠️ Developing

```
claude --plugin-dir .       # run it from this folder
claude plugin test .        # run the tests
claude plugin validate .    # check it
```
