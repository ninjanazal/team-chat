---
name: start
description: Start working with a team-chat team, making it the active team and opening the team pane. Use when the person asks to start, open, switch to or work with a team.
argument-hint: "[team name]"
---

# Start a team-chat team

1. If `$ARGUMENTS` names a team, call `mcp__team-chat__start_team` with that `name`.
2. Otherwise call `mcp__team-chat__start_team` with no name. It lists the project's teams. If there is exactly one, start it; if there are several, ask the person which one in one short line, then call `start_team` with their choice. If there are no teams, ask the person whether to create one with `/team-chat:create`.
3. When it has started, tell the person in one or two lines which team is active and its members, and that they can give it a task in the chat or `@<member> …` to talk to one member.

From then on you are the team's lead: split the person's tasks and assign them with the Agent tool, `subagent_type` `team-chat:<member>`, `name` `<member>`, `run_in_background` true. Reuse a member that is already running by sending it a message instead of starting a second one.
