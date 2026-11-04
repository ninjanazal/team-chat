---
name: help
description: Show the team-chat guide, how to create and start a team, read the pane, talk to members, and every command. Use when the person asks how team-chat works or for its help.
---

Show the person the guide below as it is, then offer to answer any question about it. Do not call tools.

# team-chat

Run a fixed team of subagents. Your session is the **lead**: it splits your tasks, hands them to members, and reports back.

## Get started
1. **Create a team**: `/team-chat:create <what it is for>`. Claude reads your project, proposes members with roles, models, effort and a brief, and saves it once you approve. With no team yet, the plugin asks if you want one.
2. **Start it**: `/team-chat:start [team]`. The pane opens with one box per member. The project remembers the last team; with only one team, it loads automatically.
3. **Give it work**: type a task in the chat. The lead assigns it and gives you one summary.
4. **Talk to one member**: `@qa run the e2e suite` in the chat, or ✉ message on its box.

## Reading the pane
- **⠋ working**: busy. **◆ needs help**: blocked, read its message. **⚑ needs you**: a permission prompt or a question for you; the reason shows. **✦ ✓ done**: finished. **○ idle**.
- Flags blink. **⚑ needs you** is raised promptly on a permission prompt or `NEEDS-HUMAN:`; it can be false when the permission mode settles an ask automatically. A member waiting on its own background work or messages shows as working, not "needs you". Flags clear when you message the member, it resumes, or the permission is answered.
- Members never start agents of their own: only the lead does. A member messages a teammate by name.
- **task** is what it was asked; **now** is a live one-line summary of what it is doing; **▸** is its latest action.
- **Stats line**: `model · effort · ctx · out · steps` for each member. A `max_tokens` stop shows in red.
- **Receipt line**: duration, agents used, edits and errors for the running or last lead turn.
- **Event log**: press `l` in the pane to show or hide it.
- **Tabs**: Overview (cards and receipt, with a ⚑N badge for members needing help or you), Chat (the #team feed), Files and Queue (with its count). The pane remembers the tab. Click a tab, or press `o` `c` `f` `q` while the pane is focused.
- **Scrolling**: the mouse wheel scrolls the pane; with it focused, the arrow and page keys do too. On Chat, **↓ latest** jumps to the newest message.
- **Queue** is read-only: it lists all member work as Active, Queued and Done, showing what fits with `+N more` and `N hidden` lines. Add tasks with `/team queue <member|any> <task>`. A task is sent when its member is idle or done, never to one that needs help or you. The lead cannot be queued: give it work in the chat.
- Hotkeys: `o` `c` `f` `q` switch tabs everywhere except the Queue tab. On the Queue tab all pane hotkeys are off; leave it by clicking a tab or with `/team tab`.
- **#team** shows every assignment, message and report, including messages between members and their reports. Each is cut to two lines; click one to expand or collapse it. ✉ shows one conversation; × back returns.
- Click a member's name to expand it: its purpose, last actions and report.

## Shared files
- Members and the lead save plans, specs, decisions and handoff notes as **team files** in `.claude/teams/<team>/files/`. Each records who wrote it last.
- They persist across sessions and live in your project, so commit them to share with people.
- **📁 files** in the pane (or `/team files`) lists them; click one to read it.

## Changing the team
- **+ member** or **✎ edit** opens the form: **Job** (handle, role, model, effort, when to use), **Brief** (purpose, responsibilities, how it works, boundaries, done when), **Tools**.
- **⇄ switch** changes team, only while no member is working; otherwise the button reads "⇄ switch (busy)". Teams live in `.claude/teams/<team>/team.json`; hand edits apply within a second.

## Commands
- `/team-chat:create [goal]`: design and save a new team with Claude
- `/team-chat:start [team]`: make a team active and open the pane
- `/team-chat:janitor [operation]`: list, inspect, rename, delete, duplicate teams, edit members, prune shared files, fix a broken team file
- `/team-chat:help`: this guide
- `/team`: open the pane
- `/new`, `/clear`: keep the active team
- `/team list`: list the project's teams
- `/team new <name> [from]`: new team: lead only, or copied from an existing team
- `/team add | edit | remove <member>`: manage members
- `/team close | open`: one-line view or full boxes
- `/team layout auto|compact|wide|mini`: how the pane draws members
- `/team palette pastel|default`: pane colours
- `/team tab overview|chat|files|queue`: pick a tab
- `/team queue <member|any> <task>`: queue a task, sent when that member is idle or done (`any` takes whichever is idle; flagged members are skipped; the lead cannot be queued)
- `/team queue`: list the queue (Active, Queued, Done; read-only in the pane); `/team queue rm #<id>`: remove a queued task
- Pane keys (pane focused, not on the Queue tab): `o` `c` `f` `q` switch tabs; on Overview, `1`–`9` expand a member and `l` toggles the event log
- `/team reload`: re-read the team file
- `/team files`: the team's shared files
- `/team help`: this guide
