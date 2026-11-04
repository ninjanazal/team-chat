import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChainRow, Draft, Layout, Live, LogEntry, Member, MemberStatus, Msg, QueueItem, Receipt, Tab, Team, TeamEntry, TeamFile } from '../types'

const P = 'team-chat'
const PANE = 'team-chat'
const TYPE_PREFIX = `${P}:`

const team = atom({ plugin: 'team-chat', key: 'team' } as const, null, { shape: 'team-1' })
const live = atom({ plugin: 'team-chat', key: 'live' } as const, {}, { shape: 'live-1' })
const channel = atom({ plugin: 'team-chat', key: 'channel' } as const, [], { shape: 'msg-1' })
const view = atom({ plugin: 'team-chat', key: 'view' } as const, '#team')
/** Channel messages pressed open, by index in the channel. */
const openMsgs = atom({ plugin: 'team-chat', key: 'openMsgs' } as const, [] as number[])  // Msg ids
const expanded = atom({ plugin: 'team-chat', key: 'expanded' } as const, null)
const now = atom({ plugin: 'team-chat', key: 'now' } as const, 0)
const isPanePlaced = atom({ plugin: 'team-chat', key: 'isPanePlaced' } as const, false)
const draft = atom({ plugin: 'team-chat', key: 'draft' } as const, null, { shape: 'draft-1' })
const teamMtime = atom({ plugin: 'team-chat', key: 'teamMtime' } as const, 0)
const isCompact = atom({ plugin: 'team-chat', key: 'isCompact' } as const, false)
const teamList = atom({ plugin: 'team-chat', key: 'teamList' } as const, [], { shape: 'entries-1' })
const moving = atom({ plugin: 'team-chat', key: 'moving' } as const, null as string | null)  // name of the member picked up to be moved
const isPicking = atom({ plugin: 'team-chat', key: 'isPicking' } as const, false)
const isHelpOpen = atom({ plugin: 'team-chat', key: 'isHelpOpen' } as const, false)
const files = atom({ plugin: 'team-chat', key: 'files' } as const, [], { shape: 'files-1' })
const filesView = atom({ plugin: 'team-chat', key: 'filesView' } as const, null)
const fileText = atom({ plugin: 'team-chat', key: 'fileText' } as const, '')

const log = atom({ plugin: 'team-chat', key: 'log' } as const, [], { shape: 'log-1' })
const receipt = atom({ plugin: 'team-chat', key: 'receipt' } as const, null, { shape: 'receipt-1' })
const layout = atom({ plugin: 'team-chat', key: 'layout' } as const, 'auto')
const isLogOpen = atom({ plugin: 'team-chat', key: 'isLogOpen' } as const, false)
const isPastel = atom({ plugin: 'team-chat', key: 'isPastel' } as const, false)

const activeTab = atom({ plugin: 'team-chat', key: 'tab' } as const, 'overview')
const queue = atom({ plugin: 'team-chat', key: 'queue' } as const, [], { shape: 'queue-1' })
const queueNext = atom({ plugin: 'team-chat', key: 'queueNext' } as const, 1)
/** How far the pane body is scrolled below the fixed header: blocks hidden at the start (Chat: hidden at the end, 0 = newest). */
const isChainOpen = atom({ plugin: 'team-chat', key: 'isChainOpen' } as const, false)
const bodyOffset = atom({ plugin: 'team-chat', key: 'bodyOffset' } as const, 0)
/** Chat: the id of the newest message in view, so new messages never shift it; 0 follows the newest. */
const chatAnchor = atom({ plugin: 'team-chat', key: 'chatAnchor' } as const, 0)

const TABS: { id: Tab; label: string; hot: string }[] = [
  { id: 'overview', label: 'Overview', hot: 'o' },
  { id: 'files', label: 'Files', hot: 'f' },
]

/** Back to the natural end of the body: the top of the lists, the newest chat message. */
async function resetScroll($: EngineInterface) {
  await update($, bodyOffset, () => 0)
  await update($, chatAnchor, () => 0)
}

/** Terminal columns a text takes: wide characters and emoji count two, joiners and marks none. */
function textWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x300 && c <= 0x36f)) continue
    const isWide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
    w += isWide ? 2 : 1
  }
  return w
}

/** Shows a tab and remembers it. Every tab opens at its natural end: top for the lists, newest for Chat. */
async function selectTab($: EngineInterface, id: Tab) {
  await update($, activeTab, () => id)
  await resetScroll($)
  await quietly(() => $.store.set('tab', id))
  if (id === 'files') await update($, filesView, cur => cur ?? '')
}

async function queueKey($: EngineInterface, t: Team): Promise<string> {
  return `queue:${await $.session.cwd()}:${t.name}`
}

/** True while a team switch swaps the queue: nothing is saved or sent until the new team's queue is in. */
let isSwitching = false

const KEEP_FINISHED = 50
/** Keeps every open task and only the newest finished ones, so the saved queue cannot grow without limit. */
function capFinished(items: QueueItem[]): QueueItem[] {
  const fin = items.filter(i => i.status === 'done' || i.status === 'failed')
  if (fin.length <= KEEP_FINISHED) return items
  const drop = new Set(fin.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id).slice(KEEP_FINISHED).map(i => i.id))
  return items.filter(i => !drop.has(i.id))
}

/**
 * Records member work that did not come from the queue (an Agent spawn or a routed chat message) as a running item,
 * so the Queue tab shows it. Work still open for that member is closed as done first.
 */
async function trackWork($: EngineInterface, name: string, w: { source: 'spawn' | 'route'; text: string; from: string; agentId?: string }) {
  const t = await read($, team)
  if (t === null || isSwitching) return
  const old = (await read($, live))[name]?.queueId
  const tNow = await $.clock.now()
  let id = 0
  await update($, queueNext, cur => {
    id = cur
    return cur + 1
  })
  await setQueue($, cur => [
    ...cur.map(i => (i.id === old && i.status === 'running' ? { ...i, status: 'done' as const, endedAt: tNow } : i)),
    { id, to: name, member: name, text: w.text.slice(0, 400), status: 'running', addedAt: tNow, startedAt: tNow, source: w.source, from: w.from, agentId: w.agentId },
  ], t.name)
  await setLive($, name, one => ({ ...one, queueId: id }))
}

/** With forTeam, the write is dropped unless that team is still the loaded one and no switch is under way. */
async function setQueue($: EngineInterface, fn: (cur: QueueItem[]) => QueueItem[], forTeam?: string) {
  if (forTeam !== undefined && (isSwitching || (await read($, team))?.name !== forTeam)) return
  await update($, queue, cur => capFinished(fn(cur)))
  if (isSwitching) return
  const t = await read($, team)
  if (t !== null) {
    await quietly(async () => $.store.set(await queueKey($, t), { items: await read($, queue), nextId: await read($, queueNext) }))
  }
}

/** The team's saved queue. A task left running is failed unless its member is still working on it; a failed load shows an empty queue. */
async function loadQueue($: EngineInterface, t: Team) {
  await update($, queue, () => [])
  await update($, queueNext, () => 1)
  await quietly(async () => {
    const saved = (await $.store.get(await queueKey($, t))) as { items?: QueueItem[]; nextId?: number } | QueueItem[] | undefined
    const items = (Array.isArray(saved) ? saved : saved?.items) ?? []
    if (!Array.isArray(items)) return
    const l = await read($, live)
    const tNow = await $.clock.now()
    let isChanged = false
    const q = items.map(i => {
      if (i.status !== 'running') return i
      const mine = i.member !== undefined ? l[i.member] : undefined
      if (mine?.status === 'working' && mine.queueId === i.id) return i
      isChanged = true
      return { ...i, status: 'failed' as const, endedAt: tNow }
    })
    const nextId = Math.max(Array.isArray(saved) ? 1 : (saved?.nextId ?? 1), ...q.map(i => i.id + 1))
    await update($, queue, () => q)
    await update($, queueNext, () => nextId)
    if (isChanged) await $.store.set(await queueKey($, t), { items: q, nextId })
  })
}

async function enqueue($: EngineInterface, to: string, text: string): Promise<string | undefined> {
  const t = await read($, team)
  if (t === null) return 'No team yet.'
  const body = text.trim()
  if (!body) return 'Give the task some text.'
  if (isSwitching) return 'Switching teams, try again in a moment.'
  const workers = t.members.filter(m => !m.isLead)
  if (to === 'any') {
    if (workers.length === 0) return 'The team has no members besides the lead; add one first.'
  } else if (t.members.find(m => m.name === to)?.isLead) {
    return 'The lead is your main session: give it work in the chat, not the queue.'
  } else if (!workers.some(m => m.name === to)) {
    return `No member "${to}". Members: any, ${workers.map(m => m.name).join(', ')}`
  }
  const addedAt = await $.clock.now()
  let id = 0
  await update($, queueNext, cur => {
    id = cur
    return cur + 1
  })
  await setQueue($, cur => [...cur, { id, to, text: body.slice(0, 400), status: 'queued', addedAt }], t.name)
  await logEvent($, 'you', 'handoff', `queued for ${to}: ${body.split('\n')[0].slice(0, 80)}`)
  await dispatchQueue($)
  return undefined
}

async function removeQueued($: EngineInterface, id: number): Promise<string | undefined> {
  const item = (await read($, queue)).find(i => i.id === id)
  if (!item) return `No task #${id}.`
  if (item.status === 'running') return `Task #${id} is running and cannot be removed.`
  await setQueue($, cur => cur.filter(i => i.id !== id))
  return undefined
}

/** A member's run of its queued task ended: only the task it was sent (its queueId) finishes. */
async function finishQueued($: EngineInterface, name: string, status: 'done' | 'failed', taskId?: number, forTeam?: string) {
  if (forTeam !== undefined && (isSwitching || (await read($, team))?.name !== forTeam)) return
  const id = taskId ?? (await read($, live))[name]?.queueId
  if (id === undefined) return
  const tEnd = await $.clock.now()
  await setQueue($, cur => (cur.some(i => i.id === id && i.status === 'running') ? cur.map(i => (i.id === id ? { ...i, status, endedAt: tEnd } : i)) : cur), forTeam)
  await update($, live, all => (all[name]?.queueId === id ? { ...all, [name]: { ...all[name], queueId: undefined } } : all))
}

/** Members left the team: their running and waiting tasks fail rather than hang. */
async function failTasksOf($: EngineInterface, names: string[]) {
  if (names.length === 0) return
  const tEnd = await $.clock.now()
  await setQueue($, cur => (
    cur.some(i => (i.status === 'running' || i.status === 'queued') && names.includes(i.member ?? i.to))
      ? cur.map(i => ((i.status === 'running' || i.status === 'queued') && names.includes(i.member ?? i.to) ? { ...i, status: 'failed' as const, endedAt: tEnd } : i))
      : cur
  ))
}

let isDispatching = false
let isDispatchAsked = false
/** Sends each queued task to its member, through the usual routing, once that member is idle or done and not flagged. */
async function dispatchQueue($: EngineInterface) {
  if (isDispatching || isSwitching) {
    // A trigger that arrives mid-loop is not lost: the loop runs once more.
    isDispatchAsked = true
    return
  }
  isDispatching = true
  try {
    do {
      isDispatchAsked = false
      await dispatchPass($)
    } while (isDispatchAsked && !isSwitching)
  } finally {
    isDispatching = false
  }
}

async function dispatchPass($: EngineInterface) {
  const first = await read($, team)
  if (first === null) return
  const teamName = first.name
  for (let guard = 0; guard < 50; guard++) {
    // The team can change under a running pass: read it afresh and stop if it did.
    const t = await read($, team)
    if (isSwitching || t === null || t.name !== teamName) return
    const q = await read($, queue)
    const l = await read($, live)
    const taken = new Set(q.filter(i => i.status === 'running').map(i => i.member))
    const isFree = (m: Member) => {
      const st = (l[m.name] ?? blank()).status
      return !m.isLead && (st === 'idle' || st === 'done') && !taken.has(m.name)
    }
    let item: QueueItem | undefined
    let to: Member | undefined
    for (const i of q) {
      if (i.status !== 'queued') continue
      const m = i.to === 'any' ? t.members.find(isFree) : t.members.find(x => x.name === i.to && isFree(x))
      if (m) { item = i; to = m; break }
    }
    if (!item || !to) return
    const id = item.id
    const member = to.name
    const tNow = await $.clock.now()
    await setQueue($, cur => cur.map(i => (i.id === id ? { ...i, status: 'running', member, startedAt: tNow } : i)), teamName)
    if (isSwitching || (await read($, team))?.name !== teamName) return
    await setLive($, member, one => ({ ...one, queueId: id }))
    await logEvent($, 'you', 'handoff', `queue #${id} to ${member}: ${item.text.split('\n')[0].slice(0, 80)}`)
    let isStarted = false
    try {
      isStarted = await route($, '#team', `@${member} ${item.text}`, id)
    } catch {
      isStarted = false
    }
    if (!isStarted) {
      await finishQueued($, member, 'failed', id, teamName)
      continue
    }
    // A fresh spawn replaces the member's record: keep the tag (only if still this team).
    if (isSwitching || (await read($, team))?.name !== teamName) return
    await setLive($, member, one => (one.queueId === id ? one : { ...one, queueId: id }))
  }
}

const LAYOUTS: Layout[] = ['auto', 'compact', 'wide', 'mini']
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const PASTEL: Record<string, string> = {
  suggestion: '#8ec5ff', warning: '#ffd8a8', error: '#ff9aa2', success: '#a8e6cf', claude: '#d4a5ff', subtle: '#9aa0a6', inactive: '#9aa0a6',
}

/** 4100 -> 4.1k, 38000 -> 38k. */
function tokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

async function logEvent($: EngineInterface, who: string, kind: LogEntry['kind'], text: string) {
  const ts = await $.clock.now()
  await update($, log, cur => [...cur, { ts, who, kind, text: text.slice(0, 120) }].slice(-80))
}

async function touchReceipt($: EngineInterface, fn: (r: Receipt) => Receipt) {
  await update($, receipt, cur => (cur === null ? cur : fn(cur)))
}

async function noteAgent($: EngineInterface, name: string) {
  await touchReceipt($, r => (r.agents.includes(name) ? r : { ...r, agents: [...r.agents, name] }))
}

const HELP = `# team-chat

Run a fixed team of subagents. Your session is the **lead**: it splits your tasks, hands them to members, and reports back.

## Get started
1. **Create a team**: \`/team-chat:create <what it is for>\`. Claude reads your project, proposes members with roles, models, effort and a brief, and saves it once you approve.
2. **Start it**: \`/team-chat:start [team]\`. The pane opens with one box per member. The project remembers the last team; with only one team, it loads automatically.
3. **Give it work**: type a task in the chat. The lead assigns it and gives you one summary.
4. **Talk to one member**: \`@qa run the e2e suite\` in the chat, or ✉ message on its box.

## Reading the pane
- **⠋ working**: busy. **◆ needs help**: blocked on a teammate. **⚑ needs you**: waiting on you (a permission prompt, or a NEEDS-HUMAN: question). Both show the reason and blink. The flag clears when the permission is answered, you message the member, or it resumes. Caveat: if the permission mode settles an ask by itself, or the ask is denied, the flag can flash or stay until the member's next call, a poll that sees it running, or the end of its turn. **✦ ✓ done**: finished. **○ idle**.
- **task** is what it was asked; **now** is a live one-line summary of what it is doing; **▸** is its latest action.
- **#team** shows every assignment, message and report, including messages between members and their reports. Each is cut to two lines; click one to expand or collapse it. ✉ shows one conversation; × back returns.
- Click a member's name to expand it: its purpose, last actions and report.

## Tabs and scrolling
- **Overview** (member cards and receipt, with the latest team message pinned at the bottom), **Files**, **Queue**. The pane remembers the tab. When another tab is open, Overview shows **⚑N** for members that need help or need you, and Queue shows how many tasks are queued.
- The top two lines never scroll: the team name with **⇄ switch** and **? help**, then the tabs with **+** (add a member). Below them the body shows what fits; **↑ N more** / **↓ N more** buttons scroll it. Chat shows only the newest messages that fit; **↑ N older** goes back and **↓ latest** returns.
- **Queue** (read only): shows all member work (spawned, routed or queued) as active, queued and done tasks that fit the pane (a dim \"N hidden\" line names the groups left out when the pane is too small for all of them); add tasks with \`/team queue <member|any> <task>\`. A task is sent to its member when that member is idle or done, never to one that needs help or you. The lead is not queueable: give it work in the chat.

## Shared files
- Members and the lead save plans, specs, decisions and handoff notes as **team files** in \`.claude/teams/<team>/files/\`. Each records who wrote it last.
- They persist across sessions and live in your project, so commit them to share with people.
- The **Files** tab (or \`/team files\`) lists them; click one to read it.

## Changing the team
- **+** (top right) or **✎ edit** opens the form: **Job** (handle, role, model, effort, when to use), **Brief** (purpose, responsibilities, how it works, boundaries, done when), **Tools**.
- **⇄ switch** changes team, only while no member is working; while a member is working the button reads "⇄ switch (busy)" and does nothing. Teams live in \`.claude/teams/<team>/team.json\`; hand edits apply within a second.

## Commands
- \`/team-chat:create [goal]\`: design and save a new team with Claude
- \`/team-chat:start [team]\`: make a team active and open the pane
- \`/team-chat:help\`: this guide
- \`/team\`: open the pane
- \`/new\`, \`/clear\`: keep the active team
- \`/team list\`: list the project's teams
- \`/team new <name> [from]\`: new team: lead only, or copied from an existing team
- \`/team add | edit | remove <member>\`: manage members; reorder them with the ↑/↓ buttons in the pane or \`/team-chat:janitor reorder\`
- \`/team close | open\`: one-line view or full boxes
- \`/team layout auto|compact|wide|mini\`: how the pane draws members; \`/team palette pastel|default\`
- Pane keys (pane focused): on Overview, \`l\` toggles the event log. Click a member to expand it.
- \`/team reload\`: re-read the team file
- \`/team tab overview|files\`: pick a tab; \`/team queue <member|any> <task>\` queues a task that is sent when that member is free
- \`/team files\`: the team's shared files
- \`/team help\`: this guide
`
const newTeamName = atom({ plugin: 'team-chat', key: 'newTeamName' } as const, '')

const TEAMS_DIR = '.claude/teams'
const LEGACY_FILE = '.claude/team.json'
/** The project's active team, so a new session (/clear, /new) picks it back up. */
const ACTIVE_FILE = `${TEAMS_DIR}/.active`
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/
const MODELS = ['haiku', 'sonnet', 'opus', 'inherit']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const RESERVED = ['you', 'team', 'all']
const COLORS = ['cyan', 'magenta', 'green', 'yellow', 'blue', 'red', 'claude']

const GLYPH: Record<MemberStatus, string> = {
  idle: '○',
  working: '◎',
  waiting: '◆',
  human: '⚑',
  done: '✓',
  failed: '✗',
}
const COLOR: Record<MemberStatus, 'inactive' | 'suggestion' | 'warning' | 'success' | 'error'> = {
  idle: 'inactive',
  working: 'suggestion',
  waiting: 'warning',
  human: 'error',
  done: 'success',
  failed: 'error',
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPARK = ['✦', '✧', '✶', '✷', '✸', '✦']
const FRAME_MS = 160
const CELEBRATE_MS = 3000

type Look = { glyph: string; label: string; color: string; border: string; isLive: boolean }

/** How a member's state is drawn at this moment: the frame comes from the clock. */
function look(one: Live, tNow: number): Look {
  const f = Math.floor(tNow / FRAME_MS)
  switch (one.status) {
    case 'working':
      return { glyph: SPIN[f % SPIN.length] ?? '◎', label: 'working', color: 'suggestion', border: 'suggestion', isLive: true }
    case 'waiting': {
      const on = Math.floor(tNow / 600) % 2 === 0
      return { glyph: on ? '◆' : '◇', label: 'needs help', color: on ? 'warning' : 'subtle', border: on ? 'warning' : 'subtle', isLive: true }
    }
    case 'human': {
      const on = Math.floor(tNow / 400) % 2 === 0
      return { glyph: on ? '⚑' : '⚐', label: 'needs human', color: on ? 'error' : 'subtle', border: on ? 'error' : 'subtle', isLive: true }
    }
    case 'done': {
      const since = one.endedAt ? tNow - one.endedAt : CELEBRATE_MS
      if (since < CELEBRATE_MS) {
        return { glyph: SPARK[f % SPARK.length] ?? '✓', label: 'done!', color: f % 2 ? 'success' : 'claude', border: 'success', isLive: true }
      }
      return { glyph: '✓', label: 'done', color: 'success', border: 'success', isLive: false }
    }
    case 'failed':
      return { glyph: '✗', label: 'failed', color: 'error', border: 'error', isLive: false }
    default:
      return { glyph: '○', label: 'idle', color: 'inactive', border: 'subtle', isLive: false }
  }
}



/** Reads a finished answer: the last BLOCKED: or NEEDS-HUMAN: line outside code fences. Permission or approval asks the person. */
function needsInput(text: string): { status: MemberStatus; reason: string } | undefined {
  let isFenced = false
  let found: { status: MemberStatus; reason: string } | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      isFenced = !isFenced
      continue
    }
    if (isFenced) continue
    const m = /^[*_>\-\s]*(BLOCKED|NEEDS-HUMAN):\s*(.*?)[*_\s]*$/i.exec(line)
    if (!m) continue
    const isHuman = m[1].toUpperCase() === 'NEEDS-HUMAN' || /permission|approv/i.test(m[2])
    found = { status: isHuman ? 'human' : 'waiting', reason: m[2].slice(0, 160) }
  }
  return found
}

/** Token stats of a subagent's requests that arrived before agent.spawn registered it. */
const pendingStats = new Map<string, Partial<Live>>()
function takeStats(agentId: string | undefined): Partial<Live> {
  if (agentId === undefined) return {}
  const got = pendingStats.get(agentId) ?? {}
  pendingStats.delete(agentId)
  return got
}

const blank = (): Live => ({ status: 'idle', steps: 0, recent: [] })

function lead(t: Team | null): Member | undefined {
  return t?.members.find(m => m.isLead)
}

function memberOfAgent(t: Team | null, l: Record<string, Live>, agentId?: string): string {
  if (agentId === undefined) return lead(t)?.name ?? 'lead'
  for (const [name, one] of Object.entries(l)) if (one.agentId === agentId) return name

  return agentId.slice(0, 8)
}

function brief(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const arg = e.file_path ?? e.command ?? e.pattern ?? e.url ?? e.description ?? e.to ?? ''
  const text = String(arg).split('\n')[0]
  const short = text.includes('/') && !text.includes(' ') ? text.split('/').slice(-2).join('/') : text

  return `${tool} ${short}`.trim().slice(0, 60)
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function hhmm(ts: number): string {
  const d = new Date(ts)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A message routed to a member that needs help or the person: it is working on it again. */
async function resume($: EngineInterface, to: string) {
  const one = (await read($, live))[to]
  if (one && (one.status === 'waiting' || one.status === 'human')) {
    await setLive($, to, cur => ({ ...cur, status: 'working', reason: undefined, flagSource: undefined, flagCall: undefined, flagTool: undefined }))
  }
}

/** A tool.check verdict of 'ask' on a member's call is a prompt waiting for the person: the flag to set, tied to that call (id when the engine gave one, and tool name). */
export function permissionFlag(e: { tool?: unknown; tool_use_id?: string; agentId?: string }, res: unknown): Partial<Live> | undefined {
  if ((res as { decision?: string } | undefined)?.decision !== 'ask' || e.agentId === undefined) return undefined

  return { status: 'human', reason: `permission: ${String(e.tool)}`, flagSource: 'permission', flagCall: e.tool_use_id, flagTool: String(e.tool) }
}

/** A call starting: does the member keep its flag? A permission flag tied to a pending call stays (a poll-set one, with no call, does not); a message flag stays for the member's own SendMessage. */
export function keepsFlag(one: Live, isOwnMessage: boolean): boolean {
  if (one.status !== 'waiting' && one.status !== 'human') return false
  if (one.flagSource === 'permission') return one.flagCall !== undefined || one.flagTool !== undefined

  return one.flagSource === 'message' && isOwnMessage
}

/** Applies a call's end to a member: the permission flag of that call ends. The ids may differ or be missing between tool.check and tool.call, so the tool name matches too. A different tool's flag stays. */
export function afterCall(one: Live, e: { tool?: unknown; tool_use_id?: string }): Live {
  // Two different ids never clear each other (parallel calls); the tool name decides only when an id is missing.
  const isSame = one.flagCall !== undefined && e.tool_use_id !== undefined ? one.flagCall === e.tool_use_id : one.flagTool === String(e.tool)
  return one.flagSource === 'permission' && isSame
    ? { ...one, status: 'working', reason: undefined, flagSource: undefined, flagCall: undefined, flagTool: undefined }
    : one
}

async function flagPermission($: EngineInterface, e: { tool?: unknown; tool_use_id?: string; agentId?: string }, res: unknown) {
  const flag = permissionFlag(e, res)
  if (!flag) return
  const t = await read($, team)
  const who = memberOfAgent(t, await read($, live), e.agentId)
  if (!t?.members.some(m => m.name === who)) return
  await setLive($, who, one => ({ ...one, ...flag }))
}

async function setLive($: EngineInterface, name: string, fn: (one: Live) => Live) {
  await update($, live, all => ({ ...all, [name]: fn(all[name] ?? blank()) }))
}

let msgSeq = 0

/** Every message gets a unique numeric id: entries saved without one (or twice) are numbered after the highest. */
function withIds(list: Msg[]): Msg[] {
  const seen = new Set<number>()
  let seq = Math.max(msgSeq, 0, ...list.map(m => (typeof m.id === 'number' ? m.id : 0)))
  const out = list.map(m => {
    if (typeof m.id === 'number' && m.id > 0 && !seen.has(m.id)) {
      seen.add(m.id)
      return m
    }
    seq += 1
    seen.add(seq)
    return { ...m, id: seq }
  })
  msgSeq = Math.max(msgSeq, seq)
  return out
}

async function post($: EngineInterface, msg: Omit<Msg, 'ts' | 'id'>) {
  const ts = await $.clock.now()
  let kept: Msg[] = []
  // Append inside the update so concurrent posts never lose each other.
  await update($, channel, cur => {
    const base = withIds(cur)
    const id = msgSeq + 1
    msgSeq = id
    kept = [...base, { ...msg, ts, id }].slice(-300)
    return kept
  })
  // Saved per project, so /clear and /new bring the conversation back.
  await quietly(async () => $.store.set(await channelKey($), kept))
  const ids = new Set(kept.map(m => m.id))
  await update($, openMsgs, cur => cur.filter(x => ids.has(x)))
}

function teamFile(t: Team): string {
  return t.file ?? `${TEAMS_DIR}/${t.name}/team.json`
}

// ── Shared team files: .claude/teams/<team>/files/, an index records who wrote each ──
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
const INDEX = '.index.json'
const MAX_FILE = 256 * 1024
/** Members never start agents: the lead does. Stripped from an explicit tools list (no list means all tools; the prompt rule covers that case). */
const SPAWN_TOOLS = ['Agent', 'Task']
const FILE_TOOLS = ['list_files', 'read_file', 'write_file'].map(n => `mcp__${P}__${n}`)

type FileMeta = { author?: string; note?: string; updatedAt?: number }

function filesDir(t: Team): string {
  return `${TEAMS_DIR}/${t.name}/files`
}

/** "plan" → "plan.md"; undefined for anything that is not a plain file name. */
function fileName(raw: unknown): string | undefined {
  let name = String(raw ?? '').trim()
  if (!name.includes('.')) name = `${name}.md`
  return FILE_RE.test(name) && !name.includes('..') && name !== INDEX ? name : undefined
}

async function readIndex($: EngineInterface, t: Team): Promise<Record<string, FileMeta>> {
  try {
    const v = JSON.parse(await $.fs.read(`${filesDir(t)}/${INDEX}`)) as unknown
    return v && typeof v === 'object' ? (v as Record<string, FileMeta>) : {}
  } catch {
    return {}
  }
}

async function listFiles($: EngineInterface, t: Team): Promise<TeamFile[]> {
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  try {
    entries = await $.fs.list(filesDir(t))
  } catch {
    return []
  }
  const index = await readIndex($, t)
  return entries
    .filter(f => f.kind === 'file' && f.name !== INDEX && !f.name.startsWith('.'))
    .map(f => ({ name: f.name, size: f.size, updatedAt: f.mtimeMs, author: index[f.name]?.author, note: index[f.name]?.note }))
    .sort((x, y) => y.updatedAt - x.updatedAt)
}

let filesSig = ''
/** Re-reads the folder when something in it changed (also hand edits and git pulls). */
async function refreshFiles($: EngineInterface, isForced = false) {
  const t = await read($, team)
  if (t === null) return
  let sig = `${t.name}:`
  try {
    sig += (await $.fs.list(filesDir(t))).map(f => `${f.name}@${f.mtimeMs}`).join('|')
  } catch {
    // no folder yet
  }
  if (!isForced && sig === filesSig) return
  filesSig = sig
  const list = await listFiles($, t)
  await update($, files, () => list)
}

async function writeFileTool($: EngineInterface, input: Record<string, unknown>, agentId?: string): Promise<string> {
  const t = await read($, team)
  if (t === null) return 'Error: no team is active. Start one with start_team.'
  const name = fileName(input.name)
  if (!name) return 'Error: name must be a plain file name: letters, digits, ".", "-" and "_" (e.g. "api-plan.md"), no folders.'
  if (typeof input.content !== 'string') return 'Error: content must be text.'
  const path = `${filesDir(t)}/${name}`
  const isAppend = input.mode === 'append'
  let text = input.content
  if (isAppend) {
    const before = await $.fs.read(path).catch(() => '')
    text = before ? `${before.replace(/\n*$/, '')}\n\n${text}` : text
  }
  if (text.length > MAX_FILE) return `Error: ${name} would be over ${MAX_FILE / 1024} KiB; split it into several files.`
  const author = memberOfAgent(t, await read($, live), agentId)
  await $.fs.write(path, text.endsWith('\n') ? text : `${text}\n`)
  const index = await readIndex($, t)
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 120) : index[name]?.note
  index[name] = { author, ...(note ? { note } : {}), updatedAt: await $.clock.now() }
  await $.fs.write(`${filesDir(t)}/${INDEX}`, `${JSON.stringify(index, null, 2)}\n`)
  await refreshFiles($, true)
  await post($, { from: author, to: 'all', text: `📄 ${isAppend ? 'added to' : 'wrote'} ${name}${note ? `: ${note}` : ''}` })
  return `${isAppend ? 'Appended to' : 'Saved'} ${path}. The whole team can read it with read_file "${name}".`
}

async function readFileTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const t = await read($, team)
  if (t === null) return 'Error: no team is active.'
  const name = fileName(input.name)
  if (!name) return 'Error: give the file name, as list_files shows it.'
  const meta = (await readIndex($, t))[name]
  try {
    const text = await $.fs.read(`${filesDir(t)}/${name}`)
    return `# ${name}${meta?.author ? ` (last written by ${meta.author})` : ''}\n\n${text}`
  } catch {
    const list = await listFiles($, t)
    return `Error: no team file "${name}". Files: ${list.map(f => f.name).join(', ') || 'none yet'}.`
  }
}

async function listFilesTool($: EngineInterface): Promise<string> {
  const t = await read($, team)
  if (t === null) return 'Error: no team is active.'
  const list = await listFiles($, t)
  if (list.length === 0) return `No team files yet in ${filesDir(t)}/. Save one with write_file.`
  return `Team files in ${filesDir(t)}/, newest first:\n${list
    .map(f => `- ${f.name} (${f.author ? `by ${f.author}, ` : ''}${Math.max(1, Math.round(f.size / 1024))} KiB)${f.note ? `: ${f.note}` : ''}`)
    .join('\n')}`
}

function filesSection(t: Team): string {
  return `Shared team files: ${filesDir(t)}/ in the project. They persist across sessions and the whole team (and the people, through git) can read them.
- list_files, read_file "<name>" and write_file "<name>" (mode "append" adds to the end; note is a one-line summary) are the tools for them.
- Keep plans, specs, decisions, API contracts, findings and handoff notes there: anything a teammate or a later session needs. Check list_files before you start, and read the files that touch your task.
- They are not for product code: that goes in the repo as usual.`
}

const NO_TEAM_TEXT = 'No team in this project yet. Create one with /team-chat:create <what it is for> (Claude proposes members and saves the team once you approve), or use the + new team button in the picker for a lead-only team.'
/** The /team listing: the verbs only. The pane's ? help shows the full guide (HELP). */
const SHORT_HELP = `/team                         open the pane
/team <team>                  work with that team
/team list                    list teams
/team queue [<member|any> <task> | rm #<id>]   queue work
/team view full|compact|wide|mini|pastel|default
/team help                    this list
Create a team: /team-chat:create   Edit/rename/delete: /team-chat:janitor   Full guide: /team-chat:help`

/** Verbs that are gone: each answers with where to go instead. They stay reserved words, so a team named like one
 * (say "files") is reachable only as /team switch files. */
const REMOVED: Record<string, string> = {
  new: 'Use /team-chat:create (designed team) or the + new team button in the picker; /team-chat:janitor duplicates a team.',
  add: 'Use + member / ✎ edit in the pane, or /team-chat:janitor.',
  edit: 'Use + member / ✎ edit in the pane, or /team-chat:janitor.',
  remove: 'Use + member / ✎ edit in the pane, or /team-chat:janitor.',
  tab: 'Click a tab, or use /team tab overview|files.',
  files: 'Open 📁 Files in the pane.',
  reload: 'Team files reload automatically.',
}
/** Kept for muscle memory, not in the help. */
const ALIASES = ['switch', 'open', 'close', 'layout', 'palette']
const VERBS = ['list', 'queue', 'view', 'help']
const VIEWS = ['full', 'compact', 'wide', 'mini', 'pastel', 'default']

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestD = 3
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase())
    if (d < bestD) { best = c; bestD = d }
  }
  return best
}

const NO_TEAM_TOOL_TEXT = 'This project has no team yet. Ask the person whether to create one; if yes, run /team-chat:create (the team-chat:create skill).'

async function readTeam($: EngineInterface, entry: TeamEntry): Promise<Team> {
  const path = entry.file
  const t = JSON.parse(await $.fs.read(path)) as Team
  if (!Array.isArray(t.members)) throw new Error(`${path}: no members list`)
  if (!t.members.some(m => m.isLead)) {
    t.members.unshift({ name: 'lead', role: 'Team lead', emoji: '🧭', model: 'inherit', effort: 'high', isLead: true, description: 'Your main session.', prompt: '' })
  }
  const leadAt = t.members.findIndex(m => m.isLead)
  if (leadAt > 0) t.members.unshift(...t.members.splice(leadAt, 1))
  const rel = relate(t.members, false)
  const warnings = [...rel.warnings]
  const rawMain = (t as { main?: unknown }).main
  const { main: _main, ...rest } = t
  let main: string | undefined
  if (rawMain !== undefined && rawMain !== null && typeof rawMain !== 'string') warnings.push('main: must be a member handle')
  else if (typeof rawMain === 'string' && rawMain.trim()) {
    const hit = rel.members.find(m => m.name.toLowerCase() === rawMain.trim().toLowerCase())
    if (hit && !hit.isLead) main = hit.name
    else warnings.push(`main "${rawMain.trim()}": ${hit ? 'the lead cannot be main' : 'no such member'}`)
  }
  // A warning is posted once; one that no longer applies is forgotten, so it shows again if it comes back.
  for (const k of [...warned]) if (k.startsWith(`${path}|`) && !warnings.some(w => `${path}|${w}` === k)) warned.delete(k)
  for (const w of warnings) {
    const key = `${path}|${w}`
    if (warned.has(key)) continue
    warned.add(key)
    await quietly(() => post($, { from: 'team', to: 'all', text: `${t.name || path}: ${w}` }))
  }
  return { ...rest, members: rel.members, ...(main ? { main } : {}), file: entry.file }
}

/** Relation warnings already posted to #team, so a reload does not repeat them. */
const warned = new Set<string>()

/** Every team of the project: .claude/teams/<team>/team.json (or the older .claude/teams/<team>.json), the older .claude/team.json. Empty when the project has none. */
async function listTeams($: EngineInterface): Promise<TeamEntry[]> {
  const out: TeamEntry[] = []
  try {
    for (const f of await $.fs.list(TEAMS_DIR)) {
      // .claude/teams/<team>/team.json; the older .claude/teams/<team>.json is still read.
      const isDir = f.kind !== 'file'
      if (!isDir && !f.name.endsWith('.json')) continue
      const file = isDir ? `${TEAMS_DIR}/${f.name}/team.json` : `${TEAMS_DIR}/${f.name}`
      if (isDir && !(await $.fs.exists(file).catch(() => false))) continue
      try {
        const t = JSON.parse(await $.fs.read(file)) as Team
        const name = t.name || (isDir ? f.name : f.name.slice(0, -5))
        if (out.some(o => o.name === name)) continue
        out.push({ name, file, members: t.members?.length ?? 0 })
      } catch {
        // a broken file is left out of the picker
      }
    }
  } catch {
    // no teams folder yet
  }
  if (await $.fs.exists(LEGACY_FILE).catch(() => false)) {
    try {
      const t = JSON.parse(await $.fs.read(LEGACY_FILE)) as Team
      if (!out.some(o => o.name === t.name)) out.push({ name: t.name, file: LEGACY_FILE, members: t.members?.length ?? 0 })
    } catch {
      // ignore
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name))
}

async function channelKey($: EngineInterface): Promise<string> {
  return `channel:${await $.session.cwd()}`
}

async function lastTeamKey($: EngineInterface): Promise<string> {
  return `lastTeam:${await $.session.cwd()}`
}

/** Makes `name` the team you work with: registers its members and tells the lead. */
async function switchTeam($: EngineInterface, name: string, isQuiet = false, isRestart = false): Promise<string | undefined> {
  const entries = await listTeams($)
  await update($, teamList, () => entries)
  const entry = entries.find(o => o.name === name)
  if (!entry) return `No team "${name}". Teams: ${entries.map(o => o.name).join(', ')}`
  const t = await readTeam($, entry)
  const before = await read($, team)
  // Same team again (/clear, /new): keep the view, the open conversation and member state.
  if (before?.name !== t.name) isSwitching = true
  try {
  if (before?.name !== t.name) {
    await update($, live, () => ({}))
    await update($, draft, () => null)
    await update($, view, () => '#team')
    await update($, openMsgs, () => [])
    await update($, receipt, () => null)
    await update($, log, () => [])
    await update($, isLogOpen, () => false)
    await update($, expanded, () => null)
    // The old team's queue must never be saved under the new team's key.
    await update($, queue, () => [])
    await update($, queueNext, () => 1)
    await resetScroll($)
  }
  await applyTeam($, t)
  if (before?.name !== t.name || (await read($, queue)).length === 0) await loadQueue($, t)
  } finally {
    isSwitching = false
  }
  if (before?.name !== t.name) void quietly(() => dispatchQueue($))
  await quietly(() => readLeadModel($))
  await update($, isPicking, () => false)
  await update($, filesView, () => null)
  await quietly(() => refreshFiles($, true))
  await quietly(async () => {
    const st = await $.fs.stat(teamFile(t))
    await update($, teamMtime, () => st.mtimeMs)
  })
  await quietly(async () => $.store.set(await lastTeamKey($), t.name))
  await quietly(() => $.fs.write(ACTIVE_FILE, `${t.name}\n`))
  if (!isQuiet && (isRestart || before?.name !== t.name)) {
    await quietly(async () => {
      await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text: `[team-chat] You now lead the team "${t.name}". Use only its members from now on.\n${leadSection(t)}` }] },
      })
    })
    await post($, { from: 'team', to: 'all', text: `now working with ${t.name}` })
  }
  return undefined
}

/** Creates a team file: a copy of an existing team, or a lead alone. */
async function createTeam($: EngineInterface, name: string, from?: string): Promise<string | undefined> {
  if (!NAME_RE.test(name)) return 'Team name: letters, digits, - and _ only.'
  const entries = await listTeams($)
  if (entries.some(o => o.name === name)) return `A team "${name}" already exists.`
  let members: Member[] = [{ name: 'lead', role: 'Team lead', emoji: '🧭', model: 'inherit', effort: 'high', isLead: true, description: 'Your main session. Plans, splits and assigns work.', prompt: '' }]
  let main: string | undefined
  if (from) {
    const src = entries.find(o => o.name === from)
    if (!src) return `No team "${from}".`
    try {
      const copy = await readTeam($, src)
      members = copy.members
      main = copy.main
    } catch {
      return `No team "${from}".`
    }
  }
  const t: Team = { name, members, ...(main ? { main } : {}), file: `${TEAMS_DIR}/${name}/team.json` }
  await $.fs.write(teamFile(t), `${JSON.stringify({ name, members, ...(main ? { main } : {}) }, null, 2)}\n`)
  return switchTeam($, name)
}

/** Checks and normalizes reportsTo/handsTo across a whole member list (lead included).
 *  strict: the first problem is returned as an error.
 *  lenient: bad values are dropped and each drop is listed in warnings. */
function relate(members: Member[], isStrict: boolean): { members: Member[]; error?: string; warnings: string[] } {
  const warnings: string[] = []
  const out = members.map(m => ({ ...m }))
  // References match handles case-insensitively and are stored as the member's real handle.
  const real = new Map(out.map(m => [m.name.toLowerCase(), m.name]))
  const leadName = out.find(m => m.isLead)?.name
  const problem = (text: string) => {
    if (isStrict) return text
    warnings.push(text)
    return undefined
  }
  for (const m of out) {
    const rawTo = m.reportsTo as unknown
    const rawHands = m.handsTo as unknown
    delete m.reportsTo
    delete m.handsTo
    if (rawTo !== undefined && rawTo !== null && typeof rawTo !== 'string') {
      const error = problem(`reportsTo on ${m.name}: must be a handle`)
      if (error) return { members, error, warnings }
    }
    const rawKey = typeof rawTo === 'string' ? rawTo.trim() : ''
    const to = real.get(rawKey.toLowerCase()) ?? rawKey
    const list: unknown[] = Array.isArray(rawHands)
      ? rawHands
      : typeof rawHands === 'string' && !isStrict ? rawHands.split(',') : []
    if (rawHands !== undefined && rawHands !== null && !Array.isArray(rawHands) && !(typeof rawHands === 'string' && !isStrict)) {
      const error = problem(`handsTo on ${m.name}: must be a list of handles`)
      if (error) return { members, error, warnings }
    }
    if (m.isLead) {
      if (to || list.length > 0) {
        const error = problem(`${m.name} is the lead and cannot have reportsTo or handsTo`)
        if (error) return { members, error, warnings }
      }
      continue
    }
    if (to && to !== leadName) {
      if (to === m.name) {
        const error = problem(`reportsTo "${to}" on ${m.name}: a member cannot report to itself`)
        if (error) return { members, error, warnings }
      } else if (!real.has(to.toLowerCase())) {
        const error = problem(`reportsTo "${to}" on ${m.name}: no such member`)
        if (error) return { members, error, warnings }
      } else m.reportsTo = to
    }
    const hands: string[] = []
    for (const h of list) {
      const key = String(h).trim()
      const x = real.get(key.toLowerCase()) ?? key
      if (!x || hands.includes(x)) continue
      if (x === m.name) {
        const error = problem(`handsTo "${x}" on ${m.name}: a member cannot hand to itself`)
        if (error) return { members, error, warnings }
      } else if (!real.has(x.toLowerCase())) {
        const error = problem(`handsTo "${x}" on ${m.name}: no such member`)
        if (error) return { members, error, warnings }
      } else hands.push(x)
    }
    if (hands.length > 0) m.handsTo = hands
  }
  // reportsTo must reach the lead: a loop is an error (strict) or the member falls back to the lead (lenient).
  const by = new Map(out.map(m => [m.name, m]))
  for (const start of out) {
    const path: string[] = []
    let cur: Member | undefined = start
    while (cur?.reportsTo) {
      const at = path.indexOf(cur.name)
      if (at >= 0) {
        const loop = [...path.slice(at), cur.name]
        const error = problem(`reportsTo loops: ${loop.join(' → ')}`)
        if (error) return { members, error, warnings }
        delete by.get(path[path.length - 1])!.reportsTo
        break
      }
      path.push(cur.name)
      cur = by.get(cur.reportsTo)
    }
  }
  return { members: out, warnings }
}

/** The reportsTo tree, depth-first from the lead; siblings keep member order. */
function chainRows(t: Team): ChainRow[] {
  const root = lead(t)
  if (!root) return []
  const names = new Set(t.members.map(m => m.name))
  const rows: ChainRow[] = []
  const seen = new Set<string>()
  const walk = (m: Member, depth: number, guide: string, isLast: boolean) => {
    seen.add(m.name)
    rows.push({
      name: m.name,
      depth,
      prefix: depth === 0 ? '' : `${guide}${isLast ? '└─ ' : '├─ '}`,
      handsTo: (m.handsTo ?? []).filter(h => names.has(h) && h !== m.name),
    })
    const kids = t.members.filter(k => !k.isLead && !seen.has(k.name) && (k.reportsTo || root.name) === m.name)
    const next = depth === 0 ? '' : `${guide}${isLast ? '   ' : '│  '}`
    kids.forEach((k, i) => walk(k, depth + 1, next, i === kids.length - 1))
  }
  walk(root, 0, '', true)
  return rows
}

const hasRelations = (t: Team) => t.members.some(m => m.reportsTo || (m.handsTo?.length ?? 0) > 0)

/** The Chain block of the lead prompt: '' when no member has a relation. */
function chainLines(t: Team): string {
  if (!hasRelations(t)) return ''
  return chainRows(t).map(r => `${'  '.repeat(r.depth)}- ${r.name}${r.handsTo.length ? ` → ${r.handsTo.join(', ')}` : ''}`).join('\n')
}

function chainText(t: Team): string {
  const lines = chainLines(t)
  if (!lines) return ''
  return `

Chain (the order of the team: who answers to whom; → who gets their finished work):
${lines}
The order is fixed, but members may also message any teammate directly. When a member reports back, pass its result on to the members after its →, unless the person said otherwise. A blocked member's question goes first to the one it answers to; ask the person only if that one cannot answer.`
}

/** The lines of a member prompt about the order: '' when the team has no relations. */
function relationLines(t: Team, m: Member): string {
  if (!hasRelations(t)) return ''
  const boss = m.isLead ? undefined : (m.reportsTo ?? lead(t)?.name ?? 'lead')
  return [
    boss ? `\nYou answer to ${boss}; you may also message any teammate directly.` : '',
    m.handsTo?.length ? `When you finish, your work goes to: ${m.handsTo.join(', ')}. Name them in your summary so the lead routes it.` : '',
  ].filter(Boolean).join('\n') + '\n'
}

function memberPrompt(t: Team, m: Member): string {
  const others = t.members
    .filter(o => o.name !== m.name)
    .map(o => `- ${o.name} (${o.role})${o.isLead ? ' — the team lead, the main session' : ''}`)
    .join('\n')

  const bullets = (text?: string) =>
    (text ?? '').split('\n').map(x => x.trim().replace(/^[-*•]\s*/, '')).filter(Boolean).map(x => `- ${x}`).join('\n')
  const brief = [
    m.purpose ? `## Purpose\n${m.purpose.trim()}` : '',
    m.responsibilities ? `## Responsibilities\n${bullets(m.responsibilities)}` : '',
    m.approach ? `## How you work\n${bullets(m.approach)}` : '',
    m.boundaries ? `## Boundaries (never do these)\n${bullets(m.boundaries)}` : '',
    m.doneWhen ? `## Done when\n${bullets(m.doneWhen)}` : '',
  ].filter(Boolean)
  return `# Role: ${m.role}
${brief.length ? `\n${brief.join('\n\n')}\n` : ''}${m.prompt.trim() ? `\n## Extra instructions\n${m.prompt.trim()}\n` : ''}
You are "${m.name}", ${m.role}, on the team "${t.name}". Your teammates:
${others}
${relationLines(t, m)}
${filesSection(t)}

Teamwork rules:
- Never use the Agent tool: you do not start agents. The lead starts every member. Talk to teammates with the SendMessage tool, by name, when you need something from them or hand work over; if a teammate is not running, ask the lead (SendMessage to "main") to start it.
- When you finish, end with a short summary of what you did, the files you changed, the team files you wrote, and anything left open.
- If you are blocked, say "BLOCKED:" and why, then stop.
- If you need the person, end with "NEEDS-HUMAN: <question>" on its own line.`
}

function mainText(t: Team): string {
  return t.main ? `\n\nMain member: ${t.main}. The person's prompts that name nobody with @ go straight to ${t.main}, not to you; expect its results to reach you through the chain.` : ''
}

function leadSection(t: Team): string {
  const roster = t.members
    .filter(m => !m.isLead)
    .map(m => `- ${m.name}: ${m.role}, ${m.model}/${m.effort}. ${m.description}`)
    .join('\n')

  return `# Team "${t.name}"

You are the lead of a fixed agent team. When the person gives you a task, split it and assign the parts to members with the Agent tool (you are the only one who starts members; they never start agents): subagent_type "${TYPE_PREFIX}<member>", name "<member>", run_in_background true. Reuse a member that is already running by sending it a message (SendMessage to its name) instead of spawning a second one. If a member asks you to start or message a teammate, or its work should go to the next member in the chain, do it: you relay every handoff. Wait for their reports, check their work, and give the person one summary.

When a plan, decision or contract should outlive this conversation, write it to a team file and tell the members its name.
${filesSection(t)}

Members:
${roster}${mainText(t)}${chainText(t)}`
}

/** Which session.start registration owns the clock intervals. */
let tickGen = 0
/** Handles clock.every returned, cancelled when they are real disposers. */
const ticks: unknown[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A team already loaded means this is /new or /clear, not a fresh launch: the context is wiped, so re-tell the lead.
    // The engine types are not in the repo, so there is no known source/reason on session.start; a loaded team is the signal.
    // Module state survives /clear and /new; tickGen > 0 means session.start already ran in this process.
    const isRestart = (await read($, team)) !== null || tickGen > 0
    // A new session may come with empty atoms: bring back the saved #team channel.
    if ((await read($, channel)).length === 0) {
      await quietly(async () => {
        const saved = await $.store.get(await channelKey($))
        if (Array.isArray(saved) && saved.length > 0) {
          // Older saves have no ids: give them one so keys and open state work.
          const restored = withIds(saved as Msg[])
          await update($, channel, () => restored)
        }
      })
    }
    // Keep the loaded team until it is replaced, so /clear and /new never show an empty team.
    let entries = await listTeams($)
    // On /clear the project files can be briefly unreadable: keep what is loaded rather than show an empty picker.
    if (entries.length === 0) entries = await read($, teamList)
    await update($, teamList, () => entries)
    let last: unknown
    await quietly(async () => {
      last = (await $.fs.read(ACTIVE_FILE)).trim() || undefined
    })
    if (!last) {
      await quietly(async () => {
        last = await $.store.get(await lastTeamKey($))
      })
    }
    // A project with one team loads it without asking.
    const pick = entries.find(o => o.name === last) ?? (entries.length === 1 ? entries[0] : undefined)
    const loaded = await read($, team)
    if (pick) await switchTeam($, pick.name, !isRestart, isRestart)
    else if (loaded !== null && isRestart) {
      // Nothing readable yet but a team is loaded: keep it.
    } else {
      await update($, team, () => null)
      await update($, teamMtime, () => 0)
    }
    // A fresh session shows the project's teams to choose from; the last one stays loaded.
    if ((!pick && !(loaded !== null && isRestart)) || (entries.length > 1 && !isRestart)) await update($, isPicking, () => true)
    await quietly(async () => {
      const saved = await $.store.get('isCompact')
      await update($, isCompact, () => saved === true)
      const lay = await $.store.get('layout')
      if (typeof lay === 'string' && (LAYOUTS as string[]).includes(lay)) await update($, layout, () => lay as Layout)
      const tb = await $.store.get('tab')
      if (TABS.some(x => x.id === tb)) await update($, activeTab, () => tb as Tab)
      const pastel = await $.store.get('isPastel')
      await update($, isPastel, () => pastel === true)
    })
    await quietly(() => registerTools($))
    await $.command.register({
      name: 'team',
      description: 'Open the team pane, switch team, or queue work. /team help lists the verbs.',
      argumentHint: '[<team> | list | queue [<member|any> <task>] | view <mode> | help]',
    })
    // /new fires session.start again and intervals cannot be cancelled: only the newest registration's callbacks do work.
    const gen = ++tickGen
    for (const h of ticks.splice(0)) void Promise.resolve(h).then(d => (typeof d === 'function' ? d() : (d as { dispose?: () => void } | undefined)?.dispose?.()), () => {})
    ticks.push(
      $.clock.every(1000, () => void (gen === tickGen && quietly(() => poll($)))) as unknown,
      $.clock.every(FRAME_MS, () => void (gen === tickGen && quietly(() => animate($)))) as unknown,
    )
    const ready = await next(e)
    // Files unreadable before the session settled: try once more now.
    if (!pick) {
      await quietly(async () => {
        const again = await listTeams($)
        if (again.length === 0) return
        await update($, teamList, () => again)
        let name: unknown = (await $.fs.read(ACTIVE_FILE).catch(() => '')).trim() || undefined
        if (!name) name = await $.store.get(await lastTeamKey($))
        const p = again.find(o => o.name === name) ?? (again.length === 1 ? again[0] : undefined)
        if (p) await switchTeam($, p.name, !isRestart, isRestart)
      })
    }
    if (e.surface === 'terminal') {
      // Open unasked only where it docks as a sidebar.
      void $.ui.open({ id: PANE, title: 'Team' }).then(r =>
        update($, isPanePlaced, () => r.isPlaced),
      )
    }

    return ready
  })

  on('command.run', { command: 'team' }, async ($, e) => {
    const tokens = e.args.trim().split(/\s+/).filter(Boolean)
    const sub = tokens[0] ?? ''
    const name = tokens[1] ?? ''
    const openPane = async () => {
      const cur = await read($, team)
      const r = await $.ui.open({ id: PANE, title: cur ? `Team · ${cur.name}` : 'Team' })
      await update($, isPanePlaced, () => r.isPlaced)
    }
    const entries = await listTeams($)
    await update($, teamList, () => entries)

    // Order: reserved word, then team name, then unknown. These need no team.
    if (sub === 'help') return { text: SHORT_HELP }
    if (REMOVED[sub] !== undefined) return { text: REMOVED[sub] }
    // view <mode>; open / close / layout <m> / palette <p> are older spellings of it.
    if (sub === 'view' || sub === 'open' || sub === 'close' || sub === 'layout' || sub === 'palette') {
      const mode = sub === 'open' ? 'full' : sub === 'close' ? 'compact' : (sub === 'layout' && name === 'auto') ? 'full' : name
      if (!VIEWS.includes(mode)) return { text: 'Usage: /team view full|compact|wide|mini|pastel|default' }
      if (mode === 'pastel' || mode === 'default') {
        await update($, isPastel, () => mode === 'pastel')
        await quietly(() => $.store.set('isPastel', mode === 'pastel'))
        return { text: `Team pane palette: ${mode}.` }
      }
      const lay: Layout = mode === 'full' ? 'auto' : (mode as Layout)
      await update($, layout, () => lay)
      await update($, isCompact, () => lay === 'compact')
      await quietly(() => $.store.set('layout', lay))
      await quietly(() => $.store.set('isCompact', lay === 'compact'))
      await resetScroll($)
      await openPane()
      return { text: mode === 'full' ? 'Team pane: full view.' : mode === 'compact' ? 'Team pane: compact view.' : `Team pane layout: ${mode}.` }
    }
    if (entries.length === 0) {
      await update($, isPicking, () => true)
      await openPane()
      return { text: NO_TEAM_TEXT }
    }
    if (sub === 'list') {
      const cur = await read($, team)
      return { text: entries.map(o => `${o.name === cur?.name ? '▸' : ' '} ${o.name} (${o.members} members)`).join('\n') }
    }
    if (sub === 'switch' || (!VERBS.includes(sub) && entries.some(o => o.name === sub))) {
      const target = sub === 'switch' ? name : sub
      if (!target) {
        await update($, isPicking, () => true)
        await openPane()
        return { text: 'Pick a team in the pane.' }
      }
      const err = await switchTeam($, target)
      if (!err) await openPane()
      return { text: err ?? `Working with team ${target}.` }
    }
    const t = await read($, team)
    if (sub === '' || sub === 'queue') {
      if (t === null) {
        await update($, isPicking, () => true)
        await openPane()
        return { text: `Pick a team in the pane, or run /team <name>. Teams: ${entries.map(o => o.name).join(', ')}` }
      }
    }
    if (sub === '') {
      await openPane()
      return { text: 'Team pane opened.' }
    }
    if (sub === 'queue' && t !== null) {
      // Keep the task's text as typed, newlines included.
      const m = /^\s*queue(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(e.args)
      const who = m?.[1] ?? ''
      const rest = (m?.[2] ?? '').trim()
      await openPane()
      const q = await read($, queue)
      if (!who) return { text: q.length ? q.map(i => `#${i.id} ${i.status} ${i.to}${i.member ? ` -> ${i.member}` : ''}: ${i.text.split('\n')[0]}`).join('\n') : 'The queue is empty. /team queue <member|any> <task>' }
      if (who === 'rm' && !t.members.some(x => x.name === 'rm')) {
        const idm = /^#?(\d+)$/.exec(rest)
        if (!idm) return { text: 'Usage: /team queue rm #<id>' }
        const err = await removeQueued($, Number(idm[1]))
        return { text: err ?? `Removed queued task #${idm[1]}.` }
      }
      const err = await enqueue($, who, rest)
      return { text: err ?? `Queued for ${who}: ${rest.split('\n')[0]}` }
    }
    // Unknown input never opens the pane and never reaches the lead.
    if (tokens.length > 1) {
      return { text: '/team takes a verb, not a message. To give the team work, type it in the chat (the lead delegates), or /team queue <member|any> <task>. /team help lists the verbs.' }
    }
    const guess = closest(sub, [...VERBS, ...entries.map(o => o.name), ...Object.keys(REMOVED), ...ALIASES])
    return { text: guess ? `Unknown "${sub}". Did you mean /team ${guess}? /team help lists the verbs.` : `Unknown "${sub}".\n${SHORT_HELP}` }
  })

  // A removed member's type is still registered: hide it and refuse it.
  on('agent.offer', async ($, e, next) => {
    if (e.agent.startsWith(TYPE_PREFIX) && !(await isMember($, e.agent.slice(TYPE_PREFIX.length)))) {
      return { isOffered: false }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const t = await read($, team)
    if (t === null) return out

    return {
      sections: [...out.sections, { id: 'team-chat-lead', text: leadSection(t), scope: 'session' }],
    }
  })

  // The lead is the main loop.
  on('prompt.submit', async ($, e, next) => {
    const t = await read($, team)
    // Only the person's own typing is routed. Agent-finished notices, peer messages and plugin prompts go to the main session untouched.
    const isPerson = e.origin === undefined || e.origin.kind === 'human'
    // route() sent this text to the lead itself: it must not be routed again, but the bookkeeping below still applies.
    let isDirect = consumeSentToLead(e.text)
    // "@lead x" goes to the main session, with the prefix removed.
    const toLead = /^@(\S+)\s+([\s\S]+)$/.exec(e.text.trim())
    if (!isDirect && toLead && t && e.command === undefined && isPerson && t.members.some(m => m.isLead && m.name === toLead[1])) {
      e = { ...e, text: toLead[2] }
      isDirect = true
    }
    // "@backend fix the test" typed in the main chat goes to that member, not the lead.
    const at = /^@(\S+)\s+[\s\S]+$/.exec(e.text.trim())
    const target = !isDirect && at && t?.members.find(m => m.name === at[1] && !m.isLead)
    if (target && e.command === undefined && isPerson) {
      await route($, '#team', e.text)
      await update($, view, () => `dm:${target.name}`)
      await selectTab($, 'overview')
      return { drop: `✉ sent to ${target.name}. Its reply shows in the team pane.` }
    }
    // No @target: with a main member set, the person's prompt goes to it instead of the main session.
    if (!isDirect && t?.main && t.members.some(m => m.name === t.main && !m.isLead) && e.command === undefined && isPerson && e.text.trim() && !e.text.trim().startsWith('/')) {
      await route($, '#team', e.text)
      await update($, view, () => `dm:${t.main}`)
      await selectTab($, 'overview')
      return { drop: `✉ sent to ${t.main} (main). Its reply shows in the team pane.` }
    }
    const l = lead(t)
    await quietly(() => readLeadModel($))
    if (l) {
      const t0 = await $.clock.now()
      await setLive($, l.name, one => ({ ...one, status: 'working', startedAt: t0, steps: 0, activity: 'thinking', reason: undefined, out: 0, hitMax: false }))
      if (e.command === undefined) await update($, receipt, () => ({ startedAt: t0, agents: [], edits: 0, errors: 0 }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Every model request says what it runs on: keep it for the card.
  on('turn.step', async function* ($, e, next) {
    await quietly(async () => {
      const t = await read($, team)
      const name = memberOfAgent(t, await read($, live), e.agentId)
      if (!t?.members.some(m => m.name === name)) return
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const cur = (await read($, live))[name]
      if (cur?.model === e.model && cur?.effort === effort) return
      await setLive($, name, one => ({ ...one, model: e.model, ...(effort ? { effort, effortSeen: true } : {}) }))
    })
    const res = yield* next(e)
    // Observe only: tokens and why the request stopped.
    await quietly(async () => {
      const t = await read($, team)
      const l0 = await read($, live)
      const name = memberOfAgent(t, l0, e.agentId)
      const u = res?.usage
      const hitMax = res?.stopReason === 'max_tokens'
      const add = (one: Partial<Live>): Partial<Live> => ({
        hitMax,
        ...(u ? { ctx: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, out: (one.out ?? 0) + u.output_tokens } : { out: one.out }),
      })
      if (!t?.members.some(m => m.name === name)) {
        // A subagent not registered yet: keep its numbers for agent.spawn.
        if (e.agentId !== undefined) pendingStats.set(e.agentId, add(pendingStats.get(e.agentId) ?? {}))
        return
      }
      await setLive($, name, one => ({ ...one, ...add(one) }))
      if (hitMax) {
        await touchReceipt($, r => ({ ...r, errors: r.errors + 1 }))
        await logEvent($, name, 'error', 'stopped on max_tokens')
      }
    })
    return res
  })

  on('agent.spawn', async ($, e, next) => {
    const type = spawnType(e)
    if (type.startsWith(TYPE_PREFIX) && !(await isMember($, type.slice(TYPE_PREFIX.length)))) {
      return { deny: `${type.slice(TYPE_PREFIX.length)} is no longer on the team` }
    }
    const res = await next(e)
    if (!type.startsWith(TYPE_PREFIX) || res.agentId === undefined) return res
    await quietly(async () => {
    const name = type.slice(TYPE_PREFIX.length)
    const t = await read($, team)
    const t0 = await $.clock.now()
    await setLive($, name, () => ({
      agentId: res.agentId,
      status: 'working',
      startedAt: t0,
      steps: 0,
      recent: [],
      activity: e.description,
      task: taskLine(e.description, e.prompt),
      ...takeStats(res.agentId),
    }))
    const from = memberOfAgent(t, await read($, live), e.parentAgentId)
    await post($, { from, to: name, text: `[task] ${e.description}: ${e.prompt.split('\n')[0].slice(0, 200)}` })
    await noteAgent($, name)
    await logEvent($, from, 'spawn', `${name}: ${e.description}`)
    await trackWork($, name, { source: 'spawn', text: taskLine(e.description, e.prompt), from, agentId: res.agentId })
    })

    return res
  })

  on('tool.call', { tool: 'mcp__team-chat__save_team' }, async ($, e) => {
    return toolText(await saveTeamTool($, toolArgs(e)))
  })

  on('tool.call', { tool: 'mcp__team-chat__start_team' }, async ($, e) => {
    const name = toolArgs(e).name
    return toolText(await startTeamTool($, typeof name === 'string' ? name : undefined))
  })

  on('tool.call', { tool: 'mcp__team-chat__write_file' }, async ($, e) => {
    return fileToolText(await writeFileTool($, toolArgs(e), e.agentId))
  })

  on('tool.call', { tool: 'mcp__team-chat__add_task' }, async ($, e) => {
    const { member, task } = toolArgs(e)
    if (typeof member !== 'string' || typeof task !== 'string') return toolText('Error: member and task must be strings.', true)
    const err = await enqueue($, member.trim().replace(/^@/, '') || 'any', task)
    return toolText(err ? `Error: ${err}` : `Task queued for ${member.trim() || 'any'}.`, !!err)
  })

  on('tool.call', { tool: 'mcp__team-chat__read_file' }, async ($, e) => {
    return fileToolText(await readFileTool($, toolArgs(e)))
  })

  on('tool.call', { tool: 'mcp__team-chat__list_files' }, async $ => {
    return fileToolText(await listFilesTool($))
  })

  on('tool.call', async ($, e, next) => {
    const t = await read($, team)
    let name: string | undefined
    if (t !== null) {
      const who = memberOfAgent(t, await read($, live), e.agentId)
      if (t.members.some(m => m.name === who)) {
        name = who
        const what = brief(e as unknown as Record<string, unknown>)
        const isOwnMessage = String(e.tool) === 'SendMessage'
        await setLive($, who, one => ({
          ...one,
          // A SendMessage carrying BLOCKED:/NEEDS-HUMAN: keeps its own flag; any other call means the member moved on.
          // A permission flag belongs to its pending call (flagCall): only that call going ahead, a poll or turn.complete clears it.
          ...(keepsFlag(one, isOwnMessage)
            ? {}
            : { status: 'working' as MemberStatus, reason: undefined, flagSource: undefined, flagCall: undefined, flagTool: undefined }),
          activity: what,
          steps: one.steps + 1,
          recent: [...one.recent, what].slice(-5),
        }))
      }
    }
    const res = await next(e)
    // This call went ahead (or was denied): a permission prompt for it is over. Another pending call keeps its own flag.
    if (name !== undefined) {
      const who = name
      await quietly(() => setLive($, who, one => afterCall(one, e)))
    }
    // Observe only: count edits and failed calls for the receipt and log.
    if (name !== undefined) {
      const who = name
      await quietly(async () => {
        const what = brief(e as unknown as Record<string, unknown>)
        if ((res as { isError?: boolean } | undefined)?.isError === true) {
          await touchReceipt($, r => ({ ...r, errors: r.errors + 1 }))
          await logEvent($, who, 'error', what)
        } else if (EDIT_TOOLS.includes(String(e.tool))) {
          await touchReceipt($, r => ({ ...r, edits: r.edits + 1 }))
          await logEvent($, who, 'edit', what)
        }
      })
    }

    return res
  }).catch(($, e, next) => next(e))

  // The engine's permission verdict: an 'ask' on a member's call is a prompt waiting for the person, flagged at once (poll stays the fallback).
  on('tool.check', async ($, e, next) => {
    const res = await next(e)
    await quietly(() => flagPermission($, e, res))
    return res
  }).catch(($, e, next) => next(e))

  on('session.send', async ($, e, next) => {
    const res = await next(e)
    // Only a delivered message counts as the member being answered.
    if ((res as { isDelivered?: boolean } | undefined)?.isDelivered !== false) await quietly(async () => {
      const to = e.to as unknown
      const name = typeof to === 'string' ? to : memberOfAgent(await read($, team), await read($, live), (to as { agentId?: string } | undefined)?.agentId)
      await resume($, name)
    })
    if (e.origin.kind === 'model') {
      await quietly(async () => {
        const t = await read($, team)
        const from = memberOfAgent(t, await read($, live), e.agentId)
        await post($, { from, to: e.to, text: e.text })
        // BLOCKED:/NEEDS-HUMAN: in a member's own message flags it while it keeps running.
        const ask = t?.members.some(m => m.name === from && !m.isLead) ? needsInput(e.text) : undefined
        if (ask) await setLive($, from, one => ({ ...one, status: ask.status, reason: ask.reason, flagSource: 'message', flagCall: undefined, flagTool: undefined }))
        await logEvent($, from, 'handoff', `to ${typeof e.to === 'string' ? e.to : memberOfAgent(t, await read($, live), (e.to as { agentId?: string }).agentId)}: ${e.text.split('\n')[0]}`)
      })
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    await quietly(async () => {
    const t = await read($, team)
    const agentId = (e as { agentId?: string }).agentId
    const name = memberOfAgent(t, await read($, live), agentId)
    if (t?.members.some(m => m.name === name)) {
      const text = (e as { answer?: string }).answer || (e as { text?: string }).text || ''
      const ask = needsInput(text)
      const status: MemberStatus = ask?.status ?? (agentId ? 'done' : 'idle')
      const tEnd = await $.clock.now()
      const first = text.split('\n').map(x => x.replace(/^[#*>\-\s]+/, '').trim()).find(Boolean)
      await setLive($, name, one => ({ ...one, status, activity: undefined, answer: text.slice(0, 600), reason: ask?.reason, flagSource: ask ? 'answer' : undefined, flagCall: undefined, flagTool: undefined, endedAt: tEnd, summary: first?.slice(0, 160) ?? one.summary }))
      if (agentId && text) await post($, { from: name, to: lead(t)?.name ?? 'lead', text: text.slice(0, 400) })
      await logEvent($, name, 'done', ask ? `${ask.status === 'human' ? 'needs you' : 'needs help'}: ${ask.reason}` : (first ?? 'finished').slice(0, 100))
      if (status === 'done' || status === 'idle') {
        await finishQueued($, name, 'done')
        await dispatchQueue($)
      }
      // The lead ends the receipt; a member finishing after that extends it.
      if (!agentId || status === 'done') await touchReceipt($, r => (agentId && r.endedAt === undefined ? r : { ...r, endedAt: tEnd }))
    }
    })

    return res
  })

  // The wheel and scroll keys must never move the whole pane (that hides the tabs): they move the body's window instead.
  let scrollMax = 0
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.origin.kind !== 'person') return { deny: 'team pane scrolls its own body' }
    const dir = e.by < 0 ? -1 : e.by > 0 ? 1 : 0
    if (dir !== 0) await update($, bodyOffset, cur => Math.min(Math.max(0, cur + dir), Math.max(0, scrollMax)))
    return { deny: 'team pane scrolls its own body' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
    if (await read($, isHelpOpen)) {
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Box justifyContent="flex-end">
            <Button key="help:close" plain label="× close help" onPress={() => update($, isHelpOpen, () => false)} />
          </Box>
          <Markdown text={HELP} />
        </Box>
      )
    }
    const t = await read($, team)
    const l = await read($, live)
    const msgs = await read($, channel)
    const v = await read($, view)
    const open = await read($, expanded)
    const openMsg = await read($, openMsgs)
    const tNow = await read($, now)
    const d = await read($, draft)
    const mv = await read($, moving)
    const layoutPref = await read($, layout)
    const pastel = await read($, isPastel)
    const logOpen = await read($, isLogOpen)
    const logList = await read($, log)
    const rcpt = await read($, receipt)
    const fileList = await read($, files)
    const fv = await read($, filesView)
    const fvv = fv ?? ''
    const curTab = await read($, activeTab)
    const qList = await read($, queue)
    const cols = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const mode: 'wide' | 'compact' | 'mini' =
      (await read($, isCompact)) || layoutPref === 'compact' ? 'compact' : layoutPref === 'auto' ? (cols < 60 ? 'compact' : 'wide') : layoutPref
    const compact = mode !== 'wide'
    // No hotkeys while a form is open.
    // No hotkeys on the Queue tab: its Input types text, and tasks contain these letters. Leave it by click or /team tab.
    const hk = (k: string) => (d === null && curTab !== 'queue' ? { hotkey: k } : {})
    const flagText = (one: Live) => `${one.status === 'human' ? '⚑ needs you' : '◆ needs help'}${one.reason ? `: ${one.reason}` : ''}`
    const pc = (c: string) => (pastel ? (PASTEL[c] ?? c) : c)
    const rule = (w = cols) => <Text color="subtle">{'─'.repeat(Math.max(1, w))}</Text>
    const toggleOpen = async (name: string) => {
      await update($, expanded, cur => (cur === name ? null : name))
      await resetScroll($)
    }

    // ── Team picker ──────────────────────────────────────────────
    if (t === null || (await read($, isPicking))) {
      const entries = await read($, teamList)
      const isEmpty = entries.length === 0
      const typed = await read($, newTeamName)
      const err = typed && !NAME_RE.test(typed) ? 'letters, digits, - and _ only' : ''
      const make = async (from?: string) => {
        const name = (await read($, newTeamName)).trim()
        if (!NAME_RE.test(name)) return
        const res = await createTeam($, name, from)
        if (res) $.ui.toast(res)
        else await update($, newTeamName, () => '')
      }

      return (
        <Box flexDirection="column" width={cols}>
          <Box justifyContent="space-between">
            <Text weight="bold" color="claude">Which team do you want to work with?</Text>
            {t !== null && <Button key="pick:cancel" plain label={`× stay on ${t.name}`} onPress={async () => {
                  const tNow2 = await $.clock.now()
                  await update($, now, () => tNow2)
                  await update($, isPicking, () => false)
                }} />}
          </Box>
          {rule()}
          {isEmpty && <Text>No team in this project yet. Create one?</Text>}
          {isEmpty && (
            <Box flexDirection="column">
              <Button
                key="newteam:claude"
                label="Create with Claude"
                variant="primary"
                onPress={() => $.ui.toast('Run /team-chat:create <what the team is for>')}
              />
              <Text dimColor>Run /team-chat:create {'<'}what it is for{'>'}: Claude proposes members and saves the team once you approve.</Text>
            </Box>
          )}
          {entries.map((o, i) => (
            <Box key={`pickbox:${o.name}`} borderStyle="quote" borderColor={o.name === t?.name ? 'claude' : 'subtle'} paddingLeft={1} width={cols}>
              <Button
                key={`pick:${o.name}`}
                plain
                onPress={async () => {
                  const res = await switchTeam($, o.name)
                  if (res) $.ui.toast(res)
                }}
              >
                <Text weight="bold">{o.name}</Text>
                <Text dimColor>
                  {'  '}{o.members} members
                </Text>
                {o.name === t?.name ? <Text color="claude"> · current</Text> : ''}
              </Button>
            </Box>
          ))}
          <Text> </Text>
          <Text weight="bold">+ new team</Text>
          <Input
            key="newteam"
            label="Name"
            placeholder="docs-team"
            value={typed}
            onInput={value => void update($, newTeamName, () => value.trim())}
            onSubmit={value => void update($, newTeamName, () => value.trim()).then(() => make())}
          />
          {err && <Text color="error">{err}</Text>}
          <Box gap={2}>
            <Button key="newteam:empty" label="Create (lead only)" variant="primary" onPress={() => make()} />
            {t !== null && <Button key="newteam:copy" label={`Copy ${t.name}`} onPress={() => make(t.name)} />}
          </Box>
        </Box>
      )
    }

    const accent = (m: Member) => pc(m.color || 'claude')
    // The lead is the person's own session, so the pane shows the crew only; the chain root reads "you".
    const crew = t.members.filter(m => !m.isLead)
    const star = (m: Member) => (t.main === m.name ? '★ ' : '')
    const who = (name: string) => t.members.find(m => m.name === name)
    const label = (name: string) => {
      const m = who(name)
      if (name === 'you') return { icon: '👤', text: 'you', color: 'text' }
      if (name === 'team') return { icon: '⚑', text: 'team', color: 'subtle' }
      if (!m) return { icon: '·', text: name, color: 'subtle' }
      return { icon: m.emoji, text: m.name, color: accent(m) }
    }

    // ── Header: team name, live counts as pills, actions ─────────
    const counts = (['working', 'waiting', 'human', 'done', 'failed'] as const)
      .map(s => ({ s, n: crew.filter(m => (l[m.name] ?? blank()).status === s).length }))
      .filter(c => c.n > 0)
    const pill = (s: MemberStatus, n: number) => {
      const lk = look({ ...blank(), status: s, endedAt: 0 }, tNow)
      const word = s === 'waiting' ? 'need help' : s === 'human' ? 'need you' : s
      return (
        <Text color={pc(lk.color)} inverse={s === 'waiting' || s === 'human'}>
          {' '}{lk.glyph} {n} {word}{' '}
        </Text>
      )
    }

    const isBusy = t.members.some(m => !m.isLead && (l[m.name] ?? blank()).status === 'working')

    // ── Member card: box, avatar, status, chips, task and summary ─
    const card = (m: Member, i: number, isPreview: boolean = false) => {
      const one = l[m.name] ?? blank()
      const isOpen = open === m.name
      const lk = look(one, tNow)
      const elapsed = one.status === 'working' && one.startedAt ? clock(tNow - one.startedAt) : ''
      const bar = pc(one.status === 'idle' ? 'subtle' : one.status === 'working' ? accent(m) : lk.border)

      return (
        <Box
          key={`box:${m.name}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={bar}
          paddingX={1}
          width={cols}
        >
          <Box justifyContent="space-between">
            {isPreview ? (
              <Text>
                {star(m)}{m.emoji} <Text weight="bold" color={accent(m)}>{m.name}</Text>
                <Text dimColor> · {m.role}</Text>
              </Text>
            ) : (
              <Button
                key={`card:${m.name}`}
                plain
                onPress={() => toggleOpen(m.name)}
              >
                <Text wrap="truncate-end" dimColor={one.status === 'idle'}>{mv === m.name ? '▶ ' : ''}{star(m)}{m.emoji} <Text weight="bold" color={accent(m)}>{m.name}</Text>
                <Text dimColor> · {m.role}</Text>{mv === m.name ? <Text weight="bold" color="claude">, moving</Text> : ''}</Text>
              </Button>
            )}
            <Text wrap="truncate-end" color={pc(lk.color)} inverse={one.status === 'waiting' || one.status === 'human'} weight={one.status === 'waiting' || one.status === 'human' ? 'bold' : undefined}>
              {' '}{lk.glyph} {lk.label}{elapsed ? ` · ${elapsed}` : ''}{' '}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'   '}{shortModel(one.model ?? m.model)} · {one.effort ?? (m.isLead ? '…' : m.effort)}
            {m.isLead ? ' · this session' : ''}
            {one.ctx ? ` · ctx ${tokens(one.ctx)}` : ''}
            {one.out ? <Text>{' · out '}<Text color={one.hitMax ? 'error' : undefined} weight={one.hitMax ? 'bold' : undefined}>{`${tokens(one.out)}${one.hitMax ? ' max_tokens' : ''}`}</Text></Text> : ''}
            {one.steps > 0 ? ` · ${one.steps} steps` : ''}
          </Text>
          {(one.status === 'human' || one.status === 'waiting') && (
            <Text wrap="truncate-end" color={one.status === 'human' ? 'error' : 'warning'} weight="bold">
              {`   ${flagText(one)}`}
            </Text>
          )}
          {one.task && (
            <Text wrap={isOpen ? 'wrap' : 'truncate-end'}>
              {'   '}<Text dimColor>task </Text>{one.task}
            </Text>
          )}
          {one.summary && (
            <Text wrap="truncate-end">
              {'   '}<Text dimColor>{one.status === 'working' ? 'now  ' : 'last '}</Text>
              <Text weight="medium">{one.summary}</Text>
            </Text>
          )}
          {one.activity && (
            <Text wrap="truncate-end" dimColor>
              {'   '}<Text color={accent(m)}>▸</Text> {one.activity}
            </Text>
          )}
          {isOpen && one.recent.slice(-3).map(r => <Text dimColor wrap="truncate-end">{'   '}· {r}</Text>)}
          {isOpen && one.answer && <Text dimColor>{'   '}{one.answer.slice(0, 300)}</Text>}
          {isOpen && m.purpose && <Text dimColor wrap="truncate-end">{'   '}purpose  {m.purpose}</Text>}
          {isPreview && m.purpose && <Text dimColor wrap="truncate-end">{'   '}{m.purpose}</Text>}
          {!m.isLead && !isPreview && (
            <Box gap={3} paddingLeft={3}>
              <Button
                key={`dm:${m.name}`}
                plain
                label="✉ message"
                onPress={async () => {
                  await update($, view, () => `dm:${m.name}`)
                  await selectTab($, 'overview')
                  await $.prompt.fill({ text: `@${m.name} `, mode: 'replace' })
                }}
              />
              <Button
                key={`edit:${m.name}`}
                plain
                label="✎ edit"
                onPress={() => update($, draft, () => ({ member: { ...m }, original: m.name, isMain: t.main === m.name }))}
              />
              <Button key={`move:${m.name}`} plain label="⇅ move" onPress={() => update($, moving, () => m.name)} />
            </Box>
          )}
        </Box>
      )
    }

    // ── Compact row ──────────────────────────────────────────────
    const row = (m: Member, i: number) => {
      const one = l[m.name] ?? blank()
      const lk = look(one, tNow)
      const elapsed = one.status === 'working' && one.startedAt ? clock(tNow - one.startedAt) : ''
      const isFlag = one.status === 'waiting' || one.status === 'human'

      return (
        <Box key={`rowbox:${m.name}`} gap={1}>
        <Button
          key={`row:${m.name}`}
          plain
          onPress={() => toggleOpen(m.name)}
        >
          <Text wrap="truncate-end">
            <Text color={pc(lk.color)}>{lk.glyph}</Text> {mv === m.name ? <Text weight="bold" color="claude">▶ moving </Text> : ''}{star(m)}{m.emoji} <Text weight="bold" color={accent(m)}>{m.name.padEnd(cols < 60 ? 0 : 10)}</Text>
            {cols >= 60 && <Text dimColor>{` ${`${shortModel(one.model ?? m.model)} · ${one.effort ?? (m.isLead ? '…' : m.effort)}`.slice(0, 20).padEnd(21)}`}</Text>}
            {isFlag ? (
              <Text color={one.status === 'human' ? 'error' : 'warning'} weight="bold">{` ${flagText(one)}`}</Text>
            ) : one.summary || one.activity ? <Text>{` ${one.summary ?? one.activity}`}</Text> : <Text dimColor>{` ${lk.label}`}</Text>}
            <Text dimColor>{elapsed ? `  ${elapsed}` : ''}</Text>
            {cols >= 70 && one.ctx ? <Text dimColor>{` ctx ${tokens(one.ctx)}`}</Text> : ''}
            {cols >= 70 && one.out ? <Text color={one.hitMax ? 'error' : undefined} dimColor={!one.hitMax}>{` out ${tokens(one.out)}`}</Text> : ''}
          </Text>
        </Button>
        <Button key={`move:${m.name}`} plain label="⇅" onPress={() => update($, moving, () => m.name)} />
        </Box>
      )
    }

    // ── Mini line, receipt and event log ─────────────────────────
    const pi = mv === null ? -1 : crew.findIndex(m => m.name === mv)
    // Gap k sits above crew[k]; the lead is always first and has no gap above it. Gaps next to the picked row change nothing.
    const slotOpen = (k: number) => pi >= 0 && k !== pi && k !== pi + 1
    const slotBtn = (k: number) => (
      <Button key={`slot:${k}`} plain label="↳ place here" onPress={async () => { await moveMemberTo($, mv as string, k <= pi ? k + 1 : k) }} />
    )
    const miniLine = pi >= 0 ? (
      <Box flexDirection="column">
        {crew.map((m, i) => (
          <Box key={`minimv:${m.name}`} flexDirection="column">
            {slotOpen(i) && slotBtn(i)}
            <Text wrap="truncate-end">{i === pi ? '▶ ' : '  '}{star(m)}{m.emoji} <Text color={accent(m)}>{m.name}</Text>{i === pi ? ', moving' : ''}</Text>
          </Box>
        ))}
        {slotOpen(crew.length) && slotBtn(crew.length)}
      </Box>
    ) : (
      <Box gap={2} flexWrap="wrap">
        {crew.map((m, i) => {
          const one = l[m.name] ?? blank()
          const lk = look(one, tNow)
          const isFlag = one.status === 'waiting' || one.status === 'human'
          return (
            <Box key={`minibox:${m.name}`} gap={1}>
            <Button key={`mini:${m.name}`} plain onPress={() => toggleOpen(m.name)}>
              <Text wrap="truncate-end">
                <Text color={pc(lk.color)}>{lk.glyph}</Text> {star(m)}{m.emoji} <Text color={accent(m)}>{m.name}</Text>
                {isFlag && <Text color={one.status === 'human' ? 'error' : 'warning'} weight="bold">{` ${flagText(one)}`}</Text>}
              </Text>
            </Button>
            <Button key={`move:${m.name}`} plain label="⇅" onPress={() => update($, moving, () => m.name)} />
            </Box>
          )
        })}
      </Box>
    )
    const receiptLine = rcpt !== null && (
      <Text wrap="truncate-end">
        <Text dimColor>receipt  </Text>
        {clock((isBusy || rcpt.endedAt === undefined ? tNow : rcpt.endedAt) - rcpt.startedAt)}
        <Text dimColor> · </Text>{rcpt.agents.length} {rcpt.agents.length === 1 ? 'agent' : 'agents'}
        <Text dimColor> · </Text>{rcpt.edits} {rcpt.edits === 1 ? 'edit' : 'edits'}
        <Text dimColor> · </Text><Text color={rcpt.errors > 0 ? 'error' : undefined}>{rcpt.errors} err</Text>
      </Text>
    )
    const openMember = open !== null && t.members.some(m => m.name === open)
    const logRows = logOpen ? logList.filter(x => !openMember || x.who === open).slice(-Math.max(3, Math.min(8, rows - 20))) : []
    const logPanel = logRows.length > 0 && (
      <Box flexDirection="column" width={cols}>
        <Text weight="bold" dimColor>log{openMember ? ` · ${open}` : ''}</Text>
        {logRows.map((x, i) => (
          <Text key={`log:${i}:${x.ts}`} wrap="truncate-end" dimColor={x.kind !== 'error'} color={x.kind === 'error' ? 'error' : undefined}>
            {hhmm(x.ts)} {label(x.who).icon} {x.who} {x.kind} · {x.text}
          </Text>
        ))}
      </Box>
    )

    // ── Member form (add / edit) ─────────────────────────────────
    const setField = (field: keyof Member, value: string) =>
      update($, draft, cur => (cur === null ? cur : { ...cur, error: undefined, member: { ...cur.member, [field]: value } }))
    const field = (key: keyof Member, name: string, placeholder: string, lines?: number) => (
      <Input
        key={`f:${key}`}
        label={name}
        placeholder={placeholder}
        value={d === null ? '' : String(d.member[key] ?? '')}
        rows={lines}
        onInput={value => void setField(key, value)}
        onSubmit={value => void setField(key, value)}
      />
    )
    const setTools = (value: string) =>
      update($, draft, cur => (cur === null ? cur : { ...cur, member: { ...cur.member, tools: splitTools(value) } }))
    const choice = (key: 'model' | 'effort' | 'color', name: string, list: readonly string[]) => (
      <Select
        key={`f:${key}`}
        label={name}
        value={d?.member[key] || list[0]}
        options={[...new Set([...list, d?.member[key] || list[0] || ''])].filter(Boolean).map(o => ({ value: o, label: o }))}
        onSelect={value => void setField(key, value)}
      />
    )
    const half = Math.max(16, Math.floor((cols - 6) / 2))
    const third = Math.max(12, Math.floor((cols - 8) / 3))
    const cell = (w: number, child: unknown) => <Box width={w} flexDirection="column">{child}</Box>
    const tab = d?.tab ?? 'job'
    const tabs = [
      { id: 'job', label: 'Job' },
      { id: 'brief', label: 'Brief' },
      { id: 'tools', label: 'Tools' },
    ] as const
    const section = (title: string, hint: string) => (
      <Text>
        <Text weight="bold" color="claude">{title}</Text>
        <Text dimColor>  {hint}</Text>
      </Text>
    )
    const formView = d !== null && (
      <Box flexDirection="column" width={cols}>
        <Box justifyContent="space-between">
          <Text weight="bold">{d.original ? `✎ Edit ${d.original}` : '✚ New member'}</Text>
          <Button key="f:close" plain label="× close" onPress={() => update($, draft, () => null)} />
        </Box>
        {card({ ...d.member, name: d.member.name || 'new-member', role: d.member.role || 'Role' }, 0, true)}
        <Box gap={1}>
          {tabs.map(x => (
            <Button
              key={`f:tab:${x.id}`}
              label={x.label}
              variant={tab === x.id ? 'primary' : 'secondary'}
              onPress={() => update($, draft, cur => (cur === null ? cur : { ...cur, tab: x.id }))}
            />
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={cols}>
          {tab === 'job' && (
            <Box flexDirection="column">
              {section('Who it is', 'how you @mention it and what it does')}
              <Box gap={2}>
                {cell(half, field('name', 'Handle', 'reviewer'))}
                {cell(half, field('role', 'Role', 'Code reviewer'))}
              </Box>
              <Box gap={2}>
                {cell(half, field('emoji', 'Avatar', '🔍'))}
                {cell(half, choice('color', 'Accent', COLORS))}
              </Box>
              {section('How it runs', 'cheaper for mechanical work, stronger for hard thinking')}
              <Box gap={2}>
                {cell(third, choice('model', 'Model', MODELS))}
                {cell(third, choice('effort', 'Effort', EFFORTS))}
              </Box>
              {d.original && !d.member.isLead && (
                <Button
                  key="f:main"
                  plain
                  label={d.isMain ? '★ main member (click to unset)' : '☆ make main member'}
                  onPress={() => update($, draft, cur => (cur === null ? cur : { ...cur, isMain: !cur.isMain }))}
                />
              )}
              {section('When to use it', 'the lead reads this to decide who gets which work')}
              {field('description', 'When to use', 'Before merging: reviews diffs for bugs and risky changes.')}
            </Box>
          )}
          {tab === 'brief' && (
            <Box flexDirection="column">
              {section('Its brief', 'becomes its instructions; one item per line')}
              {field('purpose', 'Purpose', 'Catch bugs and risky changes before they are merged.')}
              {field('responsibilities', 'Responsibilities', 'Review every diff it is given\nCheck tests cover the change', 3)}
              {field('approach', 'How it works', 'Read the diff, then the code around it\nRun the tests', 3)}
              {field('boundaries', 'Boundaries', 'Never edit code\nNever approve its own work', 2)}
              {field('doneWhen', 'Done when', 'Every finding has file:line and a fix, or the diff is clean.')}
            </Box>
          )}
          {tab === 'tools' && (
            <Box flexDirection="column">
              {section('What it may use', 'leave blank for every tool')}
              <Input
                key="f:tools"
                label="Tools"
                placeholder="Read, Grep, Glob, Bash, SendMessage"
                value={(d.member.tools ?? []).join(', ')}
                onInput={value => void setTools(value)}
                onSubmit={value => void setTools(value)}
              />
              {section('Anything else', 'optional')}
              {field('prompt', 'Extra instructions', 'Prefer small pull requests.', 3)}
            </Box>
          )}
        </Box>
        {d.error && <Text color="error">✗ {d.error}</Text>}
        <Box justifyContent="space-between">
          <Box gap={2}>
            <Button
              key="f:save"
              label={d.original ? 'Save changes' : 'Add member'}
              variant="primary"
              onPress={async () => {
                const err = await saveDraft($)
                if (err) await update($, draft, cur => (cur === null ? cur : { ...cur, error: err }))
              }}
            />
            <Button key="f:cancel" label="Cancel" onPress={() => update($, draft, () => null)} />
          </Box>
          {d.original && !d.member.isLead && (
            <Box gap={2}>
              <Text dimColor>Position {(t?.members.findIndex(o => o.name === d.original) ?? -1) + 1} of {t?.members.length ?? 0}</Text>
              {([['f:up', '↑ up', -1], ['f:down', '↓ down', 1]] as const).map(([k, label, delta]) => (
                <Button
                  key={k}
                  plain
                  label={label}
                  onPress={async () => {
                    const err = await moveMember($, d.original as string, delta)
                    if (err) await update($, draft, cur => (cur === null ? cur : { ...cur, error: err }))
                  }}
                />
              ))}
            </Box>
          )}
          {d.original && (
            <Button
              key="f:remove"
              plain
              label={`🗑 remove ${d.original}`}
              onPress={async () => {
                const err = await removeMember($, d.original as string)
                await update($, draft, cur => (err && cur ? { ...cur, error: err } : null))
              }}
            />
          )}
        </Box>
      </Box>
    )

    // ── Scrolling body under a fixed two-line header ────────────
    // The host cannot pin rows, so the body is windowed: whole blocks that fit the visible rows, with "more" buttons.
    type Block = { key: string; rows: number; node: unknown; id?: number }
    const bodyOff = await read($, bodyOffset)
    const anchor = await read($, chatAnchor)
    const lines = (text: string, w: number) => Math.max(1, Math.ceil(textWidth(text) / Math.max(1, w)))
    /** fromEnd (Chat) is anchored on a message id; the lists scroll by block count. */
    const windowed = (blocks: Block[], budget: number, fromEnd: boolean, step: number) => {
      const n = blocks.length
      const hs = blocks.map(b => b.rows)
      const total = hs.reduce((a, b) => a + b, 0)
      scrollMax = 0
      if (total <= budget) return <Box flexDirection="column" width={cols}>{blocks.map(b => b.node)}</Box>
      // The furthest the body can scroll: where the rest still fits beside one "more" row; always at least one block stays in view.
      let acc = 0
      let edge = fromEnd ? 0 : n
      if (fromEnd) {
        for (let i = 0; i < n && acc + hs[i] <= budget - 1; i++) { acc += hs[i]; edge = i + 1 }
        edge = Math.max(edge, 1)
      } else {
        for (let i = n - 1; i >= 0 && acc + hs[i] <= budget - 1; i--) { acc += hs[i]; edge = i }
        edge = Math.min(edge, n - 1)
      }
      scrollMax = fromEnd ? n - edge : edge
      let want = bodyOff
      if (fromEnd) {
        let at = -1
        if (anchor > 0) blocks.forEach((b, i) => { if ((b.id ?? 0) <= anchor) at = i })
        want = anchor > 0 && at >= 0 ? n - 1 - at : 0
      }
      const o = Math.min(Math.max(want, 0), fromEnd ? n - edge : edge)
      let start = 0
      let end = n
      const fill = (avail: number) => {
        let sum = 0
        if (fromEnd) {
          end = n - o
          start = end
          while (start > 0 && (start === end || sum + hs[start - 1] <= avail)) { start -= 1; sum += hs[start] }
        } else {
          start = o
          end = start
          while (end < n && (end === start || sum + hs[end] <= avail)) { sum += hs[end]; end += 1 }
        }
      }
      const reserveNear = o > 0 ? 1 : 0
      fill(budget - reserveNear - 1)
      if (fromEnd ? start === 0 : end === n) fill(budget - reserveNear)
      const before = start
      const after = n - end
      // A page is never more than what is in view, so nothing is skipped.
      const page = Math.max(1, Math.min(step, end - start))
      const go = async (to: number) => {
        const next = Math.max(0, to)
        if (fromEnd) await update($, chatAnchor, () => (next === 0 ? 0 : (blocks[Math.max(0, n - 1 - next)]?.id ?? 0)))
        else await update($, bodyOffset, () => next)
      }
      return (
        <Box flexDirection="column" width={cols}>
          {before > 0 && <Button key="body:up" plain label={fromEnd ? `↑ ${before} older` : `↑ ${before} more`} onPress={() => go(fromEnd ? o + page : o - page)} />}
          {blocks.slice(start, end).map(b => b.node)}
          {after > 0 && (fromEnd
            ? (
              <Box gap={2}>
                <Button key="chat:newer" plain label={`↓ ${after} newer`} onPress={() => go(o - page)} />
                <Button key="chat:end" plain label="⇣ latest" onPress={() => go(0)} />
              </Box>
            )
            : <Button key="body:down" plain label={`↓ ${after} more`} onPress={() => go(o + page)} />)}
        </Box>
      )
    }
    // Fixed header: two lines, plus a banner line per member that needs help or you (at most two), plus the working strip.
    // They sit above the body on every tab, so the body gets what is left.
    const flagged = crew.filter(m => ['waiting', 'human'].includes((l[m.name] ?? blank()).status))
    const banners = flagged.slice(0, 2)
    const workers = crew.filter(m => (l[m.name] ?? blank()).status === 'working')
    const headerRows = 2 + banners.length + (workers.length > 0 ? 1 : 0)
    const bodyBudget = Math.max(4, rows - headerRows)

    // ── Feed: grouped by sender, chat style ──────────────────────
    const shown = v === '#team'
      ? msgs
      : msgs.filter(m => {
          const peer = v.slice(3)
          return m.from === peer || m.to === peer
        })
    // Newest first: the latest message is on top and "↓ more" goes back in time.
    const newestFirst = [...shown].reverse()
    const feedBlocks: Block[] = newestFirst.map((m, i) => {
      const prev = newestFirst[i - 1]
      const isSame = prev !== undefined && prev.from === m.from && prev.to === m.to && prev.ts - m.ts < 120000
      const f = label(m.from)
      const to = label(m.to)
      const isOpenMsg = openMsg.includes(m.id)
      const text = isOpenMsg ? m.text : m.text.split('\n').filter(x => x.trim()).join(' ').replace(/\s+/g, ' ')
      // A closed message is one truncated row, so the height is exact; an open one is estimated with a margin for word wrap.
      const nRows = (isSame ? 0 : 1) + (isOpenMsg ? text.split('\n').reduce((a, x) => a + lines(x, cols - 4) + (textWidth(x) > cols - 4 ? 1 : 0), 0) : 1)
      return {
        key: `msg:${m.id}`,
        id: m.id,
        rows: nRows,
        node: (
          <Box key={`msgbox:${m.id}`} flexDirection="column" width={cols}>
            {!isSame && (
              <Box justifyContent="space-between">
                <Text wrap="truncate-end">
                  {f.icon} <Text weight="bold" color={f.color}>{f.text}</Text>
                  <Text dimColor> → </Text>
                  <Text color={to.color}>{to.text}</Text>
                </Text>
                <Text dimColor>{` ${hhmm(m.ts)}`}</Text>
              </Box>
            )}
            <Button key={`msg:${m.id}`} plain onPress={() => update($, openMsgs, cur => (cur.includes(m.id) ? cur.filter(x => x !== m.id) : [...cur, m.id]))}>
              <Text wrap={isOpenMsg ? 'wrap' : 'truncate-end'}><Text color={f.color}>{isOpenMsg ? ' ┃ ' : ' │ '}</Text>{text}</Text>
            </Button>
          </Box>
        ),
      }
    })

    // ── Shared files: the list, or one file ─────────────────────
    const openFile = async (name: string) => {
      const text = await $.fs.read(`${filesDir(t)}/${name}`).catch(() => '(this file is gone)')
      await update($, fileText, () => text)
      await update($, filesView, () => name)
      await resetScroll($)
    }
    const shownFile = fvv ? fileList.find(f => f.name === fvv) : undefined
    const fileBlocks: Block[] = []
    if (fvv) {
      // Paragraphs; a code fence is a paragraph of its own. Long ones are cut into pieces that fit the window,
      // and a cut fence is closed and reopened so every piece is valid Markdown.
      const paras: string[][] = [[]]
      let isFenced = false
      for (const ln of (await read($, fileText)).slice(0, 20000).split('\n')) {
        const isFence = ln.trim().startsWith('```')
        if (isFence && !isFenced) paras.push([])
        if (isFence) isFenced = !isFenced
        if (!isFenced && !isFence && !ln.trim()) paras.push([])
        else paras[paras.length - 1].push(ln)
        if (isFence && !isFenced) paras.push([])
      }
      const piece = Math.max(3, bodyBudget - 6)
      const rowsOf = (ls: string[]) => ls.reduce((a, x) => a + lines(x, cols) + (/^#{1,6}\s/.test(x) ? 1 : 0), 0)
      let seq = 0
      for (const p of paras.filter(q => q.length > 0)) {
        const isCode = p[0].trim().startsWith('```')
        const closed = isCode && p.length > 1 && p[p.length - 1].trim().startsWith('```')
        const body = isCode ? p.slice(1, closed ? -1 : undefined) : p
        const chunks: string[][] = []
        // A wrapped line can be taller than one row: cut by rows, not by line count.
        let cur: string[] = []
        let curRows = 0
        for (const x of body) {
          const r = lines(x, cols) + (/^#{1,6}\s/.test(x) ? 1 : 0)
          if (cur.length > 0 && curRows + r > piece) { chunks.push(cur); cur = []; curRows = 0 }
          cur.push(x)
          curRows += r
        }
        if (cur.length > 0 || chunks.length === 0) chunks.push(cur)
        for (const c of chunks) {
          const text = isCode ? [p[0], ...c, '```'].join('\n') : c.join('\n')
          const k = `fp:${seq++}`
          // Spacing, plus the padding a code fence, table or list adds.
          fileBlocks.push({ key: k, rows: rowsOf(c) + 1 + (isCode ? 2 : 0), node: <Markdown key={k} text={text} /> })
        }
      }
    } else {
      fileList.forEach(f => {
        fileBlocks.push({
          key: `file:${f.name}`,
          rows: 1,
          node: (
            <Button key={`file:${f.name}`} plain onPress={() => openFile(f.name)}>
              <Text weight="bold">{f.name}</Text>
              <Text dimColor>
                {'  '}{f.author ? `${label(f.author).icon} ${f.author} · ` : ''}{hhmm(f.updatedAt)}{f.note ? ` · ${f.note}` : ''}
              </Text>
            </Button>
          ),
        })
      })
    }
    const filesPanel = (
      <Box flexDirection="column" width={cols}>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text weight="bold" color="claude">📁 {fvv ? fv : 'Shared files'}</Text>
            <Text dimColor>  {fvv ? (shownFile?.author ? `by ${shownFile.author} · ${hhmm(shownFile.updatedAt)}` : '') : `${filesDir(t)}/`}</Text>
          </Text>
          <Box gap={2}>
            {fvv ? <Button key="files:back" plain label="← all files" onPress={async () => { await update($, filesView, () => ''); await resetScroll($) }} /> : null}
            <Button key="files:close" plain label="× close" onPress={async () => { await update($, filesView, () => null); await selectTab($, 'overview') }} />
          </Box>
        </Box>
        {rule()}
        {!fvv && fileList.length === 0 && <Text dimColor>No files yet. Members save plans, decisions and notes here; try asking the lead to "write the plan to a team file".</Text>}
        {fileBlocks.length > 0 && windowed(fileBlocks, bodyBudget - 2, false, 3)}
      </Box>
    )

    // ── Header: two lines that never scroll ─────────────────────
    const flaggedN = flagged.length
    const queuedN = qList.filter(x => x.status === 'queued').length
    const header = (
      <Box flexDirection="column" width={cols}>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end" weight="bold" color="claude">{t.name}</Text>
          <Box gap={2}>
            {isBusy ? (
              <Text dimColor>⇄ switch (busy)</Text>
            ) : (
              <Button
                key="switch"
                plain
                label="⇄ switch"
                onPress={async () => {
                  const entries = await listTeams($)
                  await update($, teamList, () => entries)
                  await update($, isPicking, () => true)
                }}
              />
            )}
            <Button key="help" plain label="? help" onPress={() => update($, isHelpOpen, () => true)} />
          </Box>
        </Box>
        {banners.map(m => {
          const one = l[m.name] ?? blank()
          const lk = look(one, tNow)
          return (
            <Box key={`banner:${m.name}`} justifyContent="space-between">
              <Text wrap="truncate-end" color={pc(lk.color)} weight="bold" inverse={lk.color !== 'subtle'}>
                {` ${lk.glyph} ${m.emoji} ${m.name}: ${one.status === 'human' ? 'needs you' : 'needs help'}${one.reason ? ` · ${one.reason}` : ''} `}
              </Text>
              <Button
                key={`flag:${m.name}`}
                plain
                label="✉ answer"
                onPress={async () => {
                  await update($, view, () => `dm:${m.name}`)
                  await selectTab($, 'overview')
                  await quietly(async () => { await $.prompt.fill({ text: `@${m.name} `, mode: 'replace' }) })
                }}
              />
            </Box>
          )
        })}
        {workers.length > 0 && (
          <Box key="working-strip" width={cols}>
          <Text wrap="truncate-end">
            <Text dimColor>working </Text>
            {workers.map(m => {
              const one = l[m.name] ?? blank()
              return (
                <Text key={`work:${m.name}`}>
                  <Text color={pc('suggestion')}>{look(one, tNow).glyph}</Text> {m.emoji} <Text weight="bold" color={accent(m)}>{m.name}</Text>
                  <Text dimColor>{one.startedAt ? ` ${clock(tNow - one.startedAt)}` : ''}</Text>{'  '}
                </Text>
              )
            })}
          </Text>
          </Box>
        )}
        <Box justifyContent="space-between">
          <Box gap={1}>
            {TABS.map(x => {
              const isOn = curTab === x.id
              const badge = x.id === 'overview' && !isOn && flaggedN > 0 ? ` ⚑${flaggedN}` : x.id === 'queue' && queuedN > 0 ? ` ${queuedN}` : ''
              return (
                <Button key={`tab:${x.id}`} plain onPress={() => selectTab($, x.id)}>
                  <Text weight="bold" color={isOn ? 'claude' : undefined} inverse={isOn}>{` ${x.label} `}</Text>
                  {badge && <Text weight="bold" color={x.id === 'overview' ? 'error' : 'warning'}>{badge}</Text>}
                </Button>
              )
            })}
          </Box>
          <Button key="add" plain label="+" onPress={() => update($, draft, () => ({ member: blankMember() }))} />
        </Box>
      </Box>
    )

    // ── Queue: read only. Active, queued and done tasks, one row each; only what fits the pane is drawn ──
    const byEnd = (a: QueueItem, b: QueueItem) => (b.endedAt ?? 0) - (a.endedAt ?? 0)
    const groups: { key: string; title: string; color: string; items: QueueItem[] }[] = [
      { key: 'active', title: 'Active', color: 'suggestion', items: qList.filter(x => x.status === 'running') },
      { key: 'queued', title: 'Queued', color: 'warning', items: qList.filter(x => x.status === 'queued') },
      { key: 'done', title: 'Done', color: 'success', items: qList.filter(x => x.status === 'done' || x.status === 'failed').sort(byEnd) },
    ]
    const qRow = (x: QueueItem) => {
      const person = who(x.member ?? x.to)
      const failed = x.status === 'failed'
      const age = clock(tNow - (x.status === 'running' ? (x.startedAt ?? x.addedAt) : x.status === 'queued' ? x.addedAt : (x.endedAt ?? tNow)))
      return (
        <Text key={`qi:${x.id}`} wrap="truncate-end">
          <Text dimColor>{`#${x.id} `}</Text>
          {person ? <Text>{person.emoji} </Text> : <Text dimColor>any </Text>}
          <Text color={failed ? pc('error') : undefined}>{`${failed ? '✕ ' : ''}${x.text.split('\n')[0]}`}</Text>
          <Text dimColor>{` ${age}`}</Text>
        </Text>
      )
    }
    // The groups share the rows: each non-empty one gets its header and one entry first, the rest goes in order. Hidden entries are counted in the header.
    const shownG = groups.filter(g => g.items.length > 0)
    // Rows each group gets for a budget; a group that does not fit is dropped.
    const plan = (budget: number) => {
      let spare = budget - 2 * shownG.length
      let used = 0
      const kept: { g: (typeof groups)[number]; n: number }[] = []
      const dropped: string[] = []
      for (const g of shownG) {
        const extra = Math.max(0, Math.min(g.items.length - 1, spare))
        spare -= extra
        const n = 1 + extra
        if (used + 1 + n > budget) dropped.push(`${g.title} ${g.items.length}`)
        else { used += 1 + n; kept.push({ g, n }) }
      }
      return { kept, dropped }
    }
    // The "hidden" line takes a row too: plan for one row less when something is dropped.
    let { kept, dropped } = plan(bodyBudget)
    if (dropped.length > 0) ({ kept, dropped } = plan(bodyBudget - 1))
    const qNodes: JSX.Element[] = []
    for (const { g, n } of kept) {
      const hidden = g.items.length - n
      qNodes.push(
        <Text key={`qg:${g.key}`} weight="bold" color={pc(g.color)}>{`${g.title} ${g.items.length}${hidden > 0 ? ` · +${hidden} more` : ''}`}</Text>,
        ...g.items.slice(0, n).map(qRow),
      )
    }
    if (dropped.length > 0) qNodes.push(<Text key="qg:hidden" dimColor>{`${dropped.join(', ')} hidden`}</Text>)
    const EMPTY_Q = 'No tasks. Queue work with /team queue <member|any> <task>.'
    const queueBody = (
      <Box flexDirection="column" width={cols}>
        {qNodes.length > 0 ? qNodes : <Text dimColor>{EMPTY_Q}</Text>}
      </Box>
    )

    // ── Overview ────────────────────────────────────────────────
    const cardH = (m: Member) => {
      const one = l[m.name] ?? blank()
      const isOpen = open === m.name
      let n = 4
      if (one.status === 'human' || one.status === 'waiting') n += 1
      if (one.task) n += isOpen ? lines(`   task ${one.task}`, cols - 4) : 1
      if (one.summary) n += 1
      if (one.activity) n += 1
      if (isOpen) n += Math.min(3, one.recent.length) + (one.answer ? one.answer.slice(0, 300).split('\n').reduce((a, x) => a + lines(x, cols - 7), 0) : 0) + (m.purpose ? 1 : 0)
      if (!m.isLead) n += 1
      return n
    }
    const isChainOpen1 = await read($, isChainOpen)
    const ovBlocks: Block[] = [
      {
        key: 'ov:top',
        rows: 1,
        node: (
          <Box key="ov:top" justifyContent="space-between" width={cols}>
            {counts.length > 0 ? <Box gap={1}>{counts.map(c => pill(c.s, c.n))}</Box> : <Text dimColor wrap="truncate-end">all quiet · give the lead a task in the chat</Text>}
            <Button key="log" plain {...hk('l')} label={`${logOpen ? '▾' : '▸'} log`} onPress={() => update($, isLogOpen, cur => !cur)} />
          </Box>
        ),
      },
    ]
    if (pi >= 0) ovBlocks.push({ key: 'ov:movebar', rows: 1, node: <Box key="ov:movebar" gap={2}><Text color="claude" weight="bold">{`moving ${mv}`}</Text><Button key="move:cancel" label="Cancel" onPress={() => update($, moving, () => null)} /></Box> })
    if (crew.length === 0) ovBlocks.push({ key: 'ov:none', rows: 1, node: <Text key="ov:none" dimColor>No members yet. Press + to add one.</Text> })
    if (hasRelations(t)) {
      const rowsC = chainRows(t)
      ovBlocks.push({
        key: 'ov:chainbtn',
        rows: 1,
        node: <Button key="chain" plain label={`${isChainOpen1 ? '▾' : '▸'} chain`} onPress={() => update($, isChainOpen, cur => !cur)} />,
      })
      if (isChainOpen1) {
        ovBlocks.push({
          key: 'ov:chain',
          rows: rowsC.length,
          node: (
            <Box key="ov:chain" flexDirection="column" width={cols}>
              {rowsC.map(r => {
                const m = who(r.name)
                return (
                  <Text key={`chain:${r.name}`} wrap="truncate-end">
                    <Text dimColor>{r.prefix}</Text>
                    {r.depth === 0 ? <Text weight="bold">👤 you</Text> : <Text>{star(m as Member)}{m?.emoji} <Text color={m ? accent(m) : undefined}>{r.name}</Text></Text>}
                    {r.handsTo.length > 0 ? <Text dimColor>{` → ${r.handsTo.map(h => (who(h)?.isLead ? 'you' : h)).join(', ')}`}</Text> : null}
                  </Text>
                )
              })}
            </Box>
          ),
        })
      }
    }
    if (mode === 'mini') {
      ovBlocks.push({ key: 'ov:mini', rows: pi >= 0 ? crew.length + crew.filter((_, k) => slotOpen(k)).length + (slotOpen(crew.length) ? 1 : 0) : Math.max(1, lines(crew.map(m => `◎ ${m.emoji} ${star(m)}${m.name}  `).join(''), cols)), node: <Box key="ov:mini" width={cols}>{miniLine}</Box> })
      crew.forEach((m, i) => {
        if (open === m.name) ovBlocks.push({ key: `ov:${m.name}`, rows: cardH(m), node: card(m, i) })
      })
    } else {
      crew.forEach((m, i) => {
        if (slotOpen(i)) ovBlocks.push({ key: `ov:slot:${i}`, rows: 1, node: slotBtn(i) })
        const isCard = mode === 'wide' || open === m.name
        ovBlocks.push({ key: `ov:${m.name}`, rows: isCard ? cardH(m) : 1, node: isCard ? card(m, i) : row(m, i) })
      })
      if (slotOpen(crew.length)) ovBlocks.push({ key: `ov:slot:${crew.length}`, rows: 1, node: slotBtn(crew.length) })
    }
    if (rcpt !== null) ovBlocks.push({ key: 'ov:receipt', rows: 1 + lines(`receipt  ${clock(0)} · ${(rcpt?.agents.length ?? 0)} agents · ${rcpt?.edits ?? 0} edits · ${rcpt?.errors ?? 0} err`, cols), node: <Box key="ov:receipt" flexDirection="column" width={cols}>{rule()}{receiptLine}</Box> })
    if (logRows.length > 0) ovBlocks.push({ key: 'ov:log', rows: 1 + logRows.reduce((a, x) => a + lines(`${hhmm(x.ts)} ${label(x.who).icon} ${x.who} ${x.kind} · ${x.text}`, cols), 0), node: logPanel })
    // Bottom panel: only the latest message, pinned at the bottom of the pane (one row).
    const lastMsg = msgs[msgs.length - 1]
    const lastPanel = lastMsg && (() => {
      const f = label(lastMsg.from)
      const to = label(lastMsg.to)
      return (
        <Box key="ov:last" width={cols}>
          <Text wrap="truncate-end">
            <Text dimColor>{`${hhmm(lastMsg.ts)} `}</Text>{f.icon} <Text weight="bold" color={f.color}>{f.text}</Text>
            <Text dimColor>{' → '}</Text>
            <Text color={to.color}>{to.text}</Text>
            <Text dimColor>{' · '}</Text>{lastMsg.text.split('\n').filter(x => x.trim()).join(' ').replace(/\s+/g, ' ')}
          </Text>
        </Box>
      )
    })()
    const overviewBody = (
      <Box flexDirection="column" width={cols} height={bodyBudget}>
        {windowed(ovBlocks, bodyBudget - (lastPanel ? 1 : 0), false, 1)}
        <Box flexGrow={1} />
        {lastPanel || null}
      </Box>
    )

    // ── Chat: only the newest messages that fit, newest at the bottom ──
    const dmHead = v.startsWith('dm:')
    const chatBody = (
      <Box flexDirection="column" width={cols}>
        {dmHead ? (
          <Box justifyContent="space-between">
            <Text>
              <Text dimColor>To: </Text>
              <Text weight="bold" color={label(v.slice(3)).color}>{v.slice(3)}</Text>
              <Text dimColor> · only this conversation</Text>
            </Text>
            <Button key="back" plain label="× back to #team" onPress={async () => { await update($, view, () => '#team'); await resetScroll($) }} />
          </Box>
        ) : (
          shown.length > 0 && <Text weight="bold" dimColor>#team</Text>
        )}
        {shown.length === 0 && <Text dimColor>No messages yet.</Text>}
        {feedBlocks.length > 0 && windowed(feedBlocks, bodyBudget - 2, false, 5)}
      </Box>
    )

    return (
      <Box flexDirection="column" width={cols}>
        {header}
        {formView}
        {d !== null ? null : curTab === 'overview' ? overviewBody : curTab === 'files' ? filesPanel : queueBody}
      </Box>
    )
  })

  // Narrow fallback: a one-line band while the pane is not on screen.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, team)
    if (t === null || (await read($, isPanePlaced)) || e.props.hasSurvey) return next(e)
    const l = await read($, live)
    const busy = t.members.filter(m => (l[m.name] ?? blank()).status !== 'idle')
    if (busy.length === 0) return next(e)
    const { Button, Text } = $.ui.resolve(e)

    return (
      <Button
        key="open"
        plain
        onPress={async () => {
          const r = await $.ui.open({ id: PANE, title: `Team · ${t.name}` })
          await update($, isPanePlaced, () => r.isPlaced)
        }}
      >
        {busy.map(m => {
          const one = l[m.name] ?? blank()
          return (
            <Text color={COLOR[one.status]}>
              {GLYPH[one.status]} {m.name}
              <Text dimColor> {one.activity ?? one.status} </Text>
            </Text>
          )
        })}
      </Button>
    )
  })
}

function blankMember(name = ''): Member {
  return { name, role: '', emoji: '🤖', model: 'sonnet', effort: 'medium', description: '', prompt: '', color: 'cyan' }
}

async function isMember($: EngineInterface, name: string): Promise<boolean> {
  try {
    const t = await read($, team)
    return t === null || t.members.some(m => m.name === name && !m.isLead)
  } catch {
    return true
  }
}

/** Registers every member's agent type and, when `before` is given, tells the lead what changed. */
async function applyTeam($: EngineInterface, t: Team, before?: Team | null) {
  await update($, team, () => t)
  for (const m of t.members) {
    if (m.isLead) continue
    await $.agent.register({
      name: m.name,
      description: `${m.role} on team ${t.name}. ${m.description}`,
      prompt: memberPrompt(t, m),
      model: m.model,
      effort: m.effort,
      ...(m.tools && m.tools.length > 0 ? { tools: [...new Set([...m.tools.filter(x => !SPAWN_TOOLS.includes(x)), ...FILE_TOOLS])] } : {}),
    })
  }
  if (!before) return
  const was = new Map(before.members.map(m => [m.name, JSON.stringify(m)]))
  const now = new Set(t.members.map(m => m.name))
  const added = t.members.filter(m => !was.has(m.name))
  const changed = t.members.filter(m => was.has(m.name) && was.get(m.name) !== JSON.stringify(m))
  const removed = before.members.filter(m => !now.has(m.name))
  await failTasksOf($, removed.map(m => m.name))
  const chainWas = chainLines(before)
  const chainNow = chainLines(t)
  const isChainChanged = chainWas !== chainNow
  const isMainChanged = before.main !== t.main
  if (added.length + changed.length + removed.length === 0 && !isChainChanged && !isMainChanged) return
  const line = (m: Member) => `- ${m.name}: ${m.role}, ${m.model}/${m.effort}. ${m.description}`
  const parts = [
    added.length ? `Added (subagent_type "${TYPE_PREFIX}<name>"):\n${added.map(line).join('\n')}` : '',
    changed.length ? `Changed:\n${changed.map(line).join('\n')}` : '',
    removed.length ? `Removed, do not assign work to: ${removed.map(m => m.name).join(', ')}` : '',
    isMainChanged ? (t.main ? `Main member now: ${t.main}. Untargeted prompts from the person go to it.` : 'No main member now: untargeted prompts come to you.') : '',
    isChainChanged ? `Chain now:\n${chainNow || '(no chain)'}` : '',
  ].filter(Boolean)
  // The lead's system prompt is fixed for this thread: tell it in a new row.
  await quietly(async () => {
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: `[team-chat] The team "${t.name}" changed.\n${parts.join('\n')}` }] },
    })
  })
  await post($, { from: 'team', to: 'all', text: parts.join(' · ').replace(/\n/g, ' ') })
}

async function saveTeam($: EngineInterface, t: Team) {
  const before = await read($, team)
  const { file: _file, ...plain } = t
  const leadAt = plain.members.findIndex(m => m.isLead)
  if (leadAt > 0) plain.members = [plain.members[leadAt], ...plain.members.filter((_, k) => k !== leadAt)]  // the lead is always first
  await $.fs.write(teamFile(t), `${JSON.stringify(plain, null, 2)}\n`)
  await quietly(async () => {
    const st = await $.fs.stat(teamFile(t))
    await update($, teamMtime, () => st.mtimeMs)
  })
  await applyTeam($, t, before)
}

/** Validates the form and saves it; answers an error to show, or undefined. */
async function saveDraft($: EngineInterface): Promise<string | undefined> {
  const d = await read($, draft)
  const t = await read($, team)
  if (d === null || t === null) return undefined
  const m = { ...d.member, name: d.member.name.trim() }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.name)) return 'Name: letters, digits, - and _ only.'
  if (RESERVED.includes(m.name)) return `"${m.name}" is reserved.`
  if (m.name !== d.original && t.members.some(o => o.name === m.name)) return `"${m.name}" already exists.`
  if (!m.role.trim()) return 'Give the member a role.'
  if (!m.description.trim()) m.description = m.purpose?.trim() || m.role
  const renamed = (h: string) => (d.original && h === d.original ? m.name : h)
  const members = (d.original
    ? t.members.map(o => (o.name === d.original ? m : o))
    : [...t.members, m]
  ).map(o => ({
    ...o,
    ...(o.reportsTo ? { reportsTo: renamed(o.reportsTo) } : {}),
    ...(o.handsTo ? { handsTo: o.handsTo.map(renamed) } : {}),
  }))
  const rel = relate(members, true)
  if (rel.error) return rel.error
  const { main: oldMain, ...noMain } = t
  const main = d.original && d.isMain !== undefined
    ? (d.isMain && !m.isLead ? m.name : oldMain === d.original ? undefined : oldMain === undefined ? undefined : renamed(oldMain))
    : oldMain === undefined ? undefined : renamed(oldMain)
  await saveTeam($, { ...noMain, members: rel.members, ...(main ? { main } : {}) })
  if (d.original && d.original !== m.name) {
    await update($, live, all => {
      const { [d.original as string]: old, ...rest } = all
      return old ? { ...rest, [m.name]: old } : rest
    })
  }
  await update($, draft, () => null)
  return undefined
}

async function removeMember($: EngineInterface, name: string): Promise<string | undefined> {
  const t = await read($, team)
  if (t === null) return 'The team is still loading.'
  const m = t.members.find(o => o.name === name)
  if (!m) return `No member "${name}".`
  if (m.isLead) return 'The lead is your main session and cannot be removed.'
  const members = t.members.filter(o => o.name !== name).map(o => {
    const { reportsTo, handsTo, ...rest } = o
    const up = reportsTo === name ? m.reportsTo : reportsTo
    const hands = handsTo?.filter(h => h !== name)
    return { ...rest, ...(up ? { reportsTo: up } : {}), ...(hands?.length ? { handsTo: hands } : {}) }
  })
  const { main: oldMain, ...noMain } = t
  await saveTeam($, { ...noMain, members: relate(members, false).members, ...(oldMain && oldMain !== name ? { main: oldMain } : {}) })
  await failTasksOf($, [name])
  await update($, live, all => {
    const { [name]: _gone, ...rest } = all
    return rest
  })
  return undefined
}

/** Moves a member up (delta -1) or down (+1) in the team; the lead stays first. */
async function moveMember($: EngineInterface, name: string, delta: number): Promise<string | undefined> {
  const t = await read($, team)
  if (t === null) return 'The team is still loading.'
  const i = t.members.findIndex(o => o.name === name)
  if (i < 0) return `No member "${name}".`
  if (t.members[i].isLead) return 'The lead stays first.'
  const j = i + delta
  if (j < 0 || j >= t.members.length || t.members[j].isLead) return undefined
  const members = [...t.members]
  ;[members[i], members[j]] = [members[j], members[i]]
  await saveTeam($, { ...t, members })
  return undefined
}

/** Moves a member to a new position (index in the final member list; the lead stays at 0, so the lowest is 1). Clears the pick. */
async function moveMemberTo($: EngineInterface, name: string, index: number): Promise<string | undefined> {
  await update($, moving, () => null)
  const t = await read($, team)
  if (t === null) return 'The team is still loading.'
  const i = t.members.findIndex(o => o.name === name)
  if (i < 0) return `No member "${name}".`
  if (t.members[i].isLead) return 'The lead stays first.'
  const to = Math.max(1, Math.min(index, t.members.length - 1))
  if (to === i) return undefined
  const members = [...t.members]
  const [m] = members.splice(i, 1)
  members.splice(to, 0, m)
  await saveTeam($, { ...t, members })
  return undefined
}

/** Unloads a team whose file is gone, refreshes the list and opens the picker. */
async function dropTeam($: EngineInterface, name: string) {
  await update($, team, () => null)
  await update($, teamMtime, () => 0)
  const entries = await listTeams($)
  await update($, teamList, () => entries)
  await update($, isPicking, () => true)
  await quietly(async () => {
    if ((await $.fs.read(ACTIVE_FILE)).trim() === name) await $.fs.write(ACTIVE_FILE, '')
  })
  $.ui.toast(`Team "${name}" was deleted`)
}

/** Picks up hand edits of the team file, and its deletion. */
async function watchTeamFile($: EngineInterface) {
  const cur = await read($, team)
  if (cur === null) {
    // No team loaded (e.g. files were unreadable right after /clear): keep looking, and pick the team up once it reads.
    const entries = await listTeams($)
    if (entries.length === 0 || entries.length === (await read($, teamList)).length) return
    await update($, teamList, () => entries)
    let name: unknown = (await $.fs.read(ACTIVE_FILE).catch(() => '')).trim() || undefined
    if (!name) name = await $.store.get(await lastTeamKey($)).catch(() => undefined)
    const p = entries.find(o => o.name === name) ?? (entries.length === 1 ? entries[0] : undefined)
    if (p) await switchTeam($, p.name, true)
    return
  }
  const file = teamFile(cur)
  let mtime = 0
  try {
    mtime = (await $.fs.stat(file)).mtimeMs
  } catch {
    // The team file is gone (deleted by hand or by the janitor): drop the team and show the picker.
    // Only a definite "not there" drops it; a failed check (e.g. during /clear) keeps the team.
    if ((await $.fs.exists(file).catch(() => true)) === false) await dropTeam($, cur.name)
    return
  }
  if (mtime === (await read($, teamMtime))) return
  await update($, teamMtime, () => mtime)
  const before = await read($, team)
  try {
    const t = await readTeam($, { name: cur.name, file, members: 0 })
    await applyTeam($, t, before)
    $.ui.toast(`Team reloaded: ${t.members.map(m => m.name).join(', ')}`)
  } catch (err) {
    $.ui.toast(`${file} not loaded: ${String(err).slice(0, 120)}`)
  }
}

function spawnType(e: unknown): string {
  const r = e as { subagentType?: string; subagent_type?: string }
  return r.subagentType ?? r.subagent_type ?? ''
}

function splitTools(value: string): string[] | undefined {
  const list = value.split(',').map(x => x.trim()).filter(Boolean)
  return list.length ? list : undefined
}

const MEMBER_SCHEMA = {
  type: 'object',
  required: ['name', 'role', 'model', 'effort', 'purpose'],
  properties: {
    name: { type: 'string', description: 'Handle, how the person @mentions it: lowercase letters, digits, - or _ (e.g. "backend")' },
    role: { type: 'string', description: 'Job title, e.g. "Backend engineer"' },
    emoji: { type: 'string', description: 'One emoji avatar' },
    color: { type: 'string', enum: ['cyan', 'magenta', 'green', 'yellow', 'blue', 'red', 'claude'] },
    model: { type: 'string', description: 'haiku, sonnet, opus, inherit, or a full model id' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    description: { type: 'string', description: 'When the lead should hand work to it (one sentence)' },
    purpose: { type: 'string', description: 'What the member is for (one line)' },
    responsibilities: { type: 'string', description: 'What it should do, one item per line' },
    approach: { type: 'string', description: 'How it works, its process, one step per line' },
    boundaries: { type: 'string', description: 'What it must never do, one item per line' },
    doneWhen: { type: 'string', description: 'Its definition of done' },
    tools: { type: 'array', items: { type: 'string' }, description: 'Tools it may use; leave out for all tools. Agent and Task are removed from a list: members never start agents. With no list the member has all tools, and only its prompt forbids starting agents' },
    reportsTo: { type: 'string', description: 'Handle of the member it answers to; leave out for the lead' },
    handsTo: { type: 'array', items: { type: 'string' }, description: 'Handles that receive its finished work' },
    prompt: { type: 'string', description: 'Extra instructions (optional)' },
  },
}

async function registerTools($: EngineInterface) {
  await $.tool.register({
    name: 'save_team',
    description:
      'Saves a team-chat team to .claude/teams/<name>.json, registers its members as subagent types and opens the team pane on it. ' +
      'Call it only after the person approved the team. The lead (the main session) is added automatically; do not include it. ' +
      'Set overwrite to true to replace an existing team of that name. ' +
      'Members may set reportsTo (who they answer to, default the lead) and handsTo (who gets their finished work).',
    inputSchema: {
      type: 'object',
      required: ['name', 'members'],
      properties: {
        name: { type: 'string', description: 'Team name: letters, digits, - or _ (e.g. "dev-team")' },
        overwrite: { type: 'boolean' },
        main: { type: 'string', description: 'Handle of the member that gets the person\'s prompts when they @mention nobody; leave out to keep the main session (the lead)' },
        members: { type: 'array', items: MEMBER_SCHEMA, minItems: 1 },
      },
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'start_team',
    description:
      'Starts working with a team-chat team: makes it the active team and opens the team pane. ' +
      'Without a name it lists the project\'s teams instead, so you can ask the person which one.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'write_file',
    description:
      "Saves a shared team file in .claude/teams/<team>/files/: a plan, spec, decision, API contract, finding or handoff note the team and later sessions need. " +
      'It persists across sessions and every member can read it. Records you as its author and posts it in #team. Not for product code.',
    inputSchema: {
      type: 'object',
      required: ['name', 'content'],
      properties: {
        name: { type: 'string', description: 'Plain file name, no folders, e.g. "api-plan.md"; .md is added when there is no extension' },
        content: { type: 'string', description: 'The text (Markdown preferred)' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) or append to the end' },
        note: { type: 'string', description: 'One-line summary shown in the file list' },
      },
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'add_task',
    description:
      "Adds a task to the team queue. It is sent to the member when that member is idle or done. " +
      'Use "any" as member to let the first idle member take it. The lead cannot be queued: it is the main session.',
    inputSchema: {
      type: 'object',
      required: ['member', 'task'],
      properties: {
        member: { type: 'string', description: 'Member handle, or "any"' },
        task: { type: 'string', description: 'What the member should do (max 400 characters)' },
      },
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'read_file',
    description: "Reads a shared team file from .claude/teams/<team>/files/ by name, with who last wrote it.",
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'list_files',
    description: "Lists the team's shared files, newest first, with author and one-line summary.",
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
}

/** A plugin tool's arguments: the engine spreads them onto the tool.call event beside tool, tool_use_id and agentId. */
function toolArgs(e: object): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...args } = e as Record<string, unknown>
  return args
}

function fileToolText(text: string) {
  return toolText(text, text.startsWith('Error:'))
}

function toolText(text: string, isError = false) {
  // A plugin tool's answer is { result: string } (the engine takes string | array | undefined); an error is a deny.
  return (isError ? { deny: text } : { result: text }) as never
}

async function openTeamPane($: EngineInterface) {
  const cur = await read($, team)
  const r = await $.ui.open({ id: PANE, title: cur ? `Team · ${cur.name}` : 'Team' })
  await update($, isPanePlaced, () => r.isPlaced)
}

async function saveTeamTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const name = String(input.name ?? '').trim()
  if (!NAME_RE.test(name)) return `Error: team name "${name}" must be letters, digits, - or _.`
  const raw = Array.isArray(input.members) ? (input.members as Record<string, unknown>[]) : []
  if (raw.length === 0) return 'Error: a team needs at least one member besides the lead.'
  const entries = await listTeams($)
  if (entries.some(o => o.name === name) && input.overwrite !== true) {
    return `Error: a team "${name}" already exists. Ask the person, then call again with overwrite: true, or pick another name.`
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const members: Member[] = [
    { name: 'lead', role: 'Team lead', emoji: '🧭', model: 'inherit', effort: 'high', isLead: true, color: 'claude', description: 'Your main session.', purpose: 'Turn the request into a plan, assign the parts, and deliver one checked result.', prompt: '' },
  ]
  for (const r of raw) {
    const m: Member = {
      name: str(r.name).toLowerCase(),
      role: str(r.role),
      emoji: str(r.emoji) || '🤖',
      color: COLORS.includes(str(r.color)) ? str(r.color) : COLORS[members.length % (COLORS.length - 1)],
      model: str(r.model) || 'sonnet',
      effort: EFFORTS.includes(str(r.effort)) ? str(r.effort) : 'medium',
      description: str(r.description) || str(r.purpose) || str(r.role),
      purpose: str(r.purpose),
      responsibilities: str(r.responsibilities),
      approach: str(r.approach),
      boundaries: str(r.boundaries),
      doneWhen: str(r.doneWhen),
      prompt: str(r.prompt),
      ...(Array.isArray(r.tools) && r.tools.length ? { tools: (r.tools as unknown[]).map(String) } : {}),
      ...(r.reportsTo !== undefined && r.reportsTo !== null ? { reportsTo: typeof r.reportsTo === 'string' ? r.reportsTo : String(r.reportsTo) } : {}),
      ...(r.handsTo !== undefined && r.handsTo !== null ? { handsTo: r.handsTo as string[] } : {}),
    }
    if (!NAME_RE.test(m.name) || m.name.includes('--')) return `Error: member handle "${m.name}" must be letters, digits, - or _.`
    if (RESERVED.includes(m.name) || m.name === 'lead') return `Error: "${m.name}" is reserved.`
    if (members.some(o => o.name === m.name)) return `Error: two members are called "${m.name}".`
    if (!m.role) return `Error: member "${m.name}" needs a role.`
    members.push(m)
  }
  const rel = relate(members, true)
  if (rel.error) return `Error: ${rel.error}`
  members.splice(0, members.length, ...rel.members)
  if (input.main !== undefined && input.main !== null && typeof input.main !== 'string') return 'Error: main must be a member handle.'
  const mainIn = typeof input.main === 'string' ? input.main.trim() : ''
  const mainHit = mainIn ? members.find(m => m.name.toLowerCase() === mainIn.toLowerCase()) : undefined
  if (mainIn && (!mainHit || mainHit.isLead)) return `Error: main "${mainIn}": ${mainHit ? 'the lead cannot be main' : 'no such member'}`
  const main = mainHit?.name ?? ''
  const file = `${TEAMS_DIR}/${name}/team.json`
  await $.fs.write(file, `${JSON.stringify({ name, members, ...(main ? { main } : {}) }, null, 2)}\n`)
  const err = await switchTeam($, name, true)
  if (err) return `Error: saved ${file} but could not start it: ${err}`
  await quietly(() => openTeamPane($))
  return `Saved team "${name}" to ${file} with ${members.length - 1} members (${members.slice(1).map(m => m.name).join(', ')}) and opened it in the team pane. You are its lead from now on: you start every member with the Agent tool, subagent_type "team-chat:<member>", name "<member>", run_in_background true; members never start agents, they message teammates with SendMessage and ask you to start any that are not running.`
}

async function startTeamTool($: EngineInterface, name?: string): Promise<string> {
  const entries = await listTeams($)
  await update($, teamList, () => entries)
  const cur = await read($, team)
  if (cur && !entries.some(o => o.name === cur.name)) await dropTeam($, cur.name)
  if (entries.length === 0) return NO_TEAM_TOOL_TEXT
  if (!name) {
    return `Teams in this project:\n${entries.map(o => `- ${o.name} (${o.members} members${o.name === cur?.name ? ', current' : ''})`).join('\n')}\nAsk the person which one to start, then call start_team with its name.`
  }
  const err = await switchTeam($, name)
  if (err) return `Error: ${err}`
  await quietly(() => openTeamPane($))
  const t = await read($, team)
  return `Started team "${name}" and opened the team pane. You are its lead.\n${t ? leadSection(t) : ''}`
}

async function quietly(fn: () => Promise<void>) {
  try {
    await fn()
  } catch (err) {
    void err
    // bookkeeping must never break the engine's own work
  }
}

/** Texts route() just sent to the lead, with a count each: the prompt.submit hook consumes one when it sees the text, so it is not routed again. */
const sentToLead = new Map<string, number>()

function consumeSentToLead(text: string): boolean {
  const key = text.trim()
  const n = sentToLead.get(key) ?? 0
  if (n === 0) return false
  if (n === 1) sentToLead.delete(key)
  else sentToLead.set(key, n - 1)
  return true
}

/** Sends text to a member (or the lead). Resolves true when it was delivered or started. */
/** ownedId: the queue item that dispatchQueue already started for this send, so no second item is made. */
async function route($: EngineInterface, v: string, raw: string, ownedId?: number): Promise<boolean> {
  const text = raw.trim()
  if (!text) return false
  const t = await read($, team)
  if (t === null) return false
  const at = /^@(\S+)\s+([\s\S]+)$/.exec(text)
  let to = v.startsWith('dm:') ? v.slice(3) : (t.main ?? lead(t)?.name ?? 'lead')
  let body = text
  if (at && t.members.some(m => m.name === at[1])) {
    to = at[1]
    body = at[2]
  }
  const target = t.members.find(m => m.name === to)
  await post($, { from: 'you', to, text: body })

  if (!target || target.isLead) {
    sentToLead.set(body.trim(), (sentToLead.get(body.trim()) ?? 0) + 1)
    try {
      await $.prompt.submit({ text: body, asUser: true })
    } catch (err) {
      // The submit failed before the hook saw it: do not let the entry catch a later real prompt.
      consumeSentToLead(body)
      throw err
    }
    return true
  }
  const one = (await read($, live))[to]
  if (one?.agentId) {
    const r = await $.session.send({ to: { agentId: one.agentId }, text: body })
    if (r.isDelivered) {
      const t0 = await $.clock.now()
      // Same reset as a fresh spawn; graceLeft keeps the poll from flipping it back to idle at once.
      await setLive($, to, cur => ({ ...cur, status: 'working', startedAt: t0, graceLeft: 2, endedAt: undefined, reason: undefined, activity: body.slice(0, 60), task: taskLine('', body), steps: 0, recent: [], summary: undefined, summaryAt: undefined, summaryFor: undefined, out: 0, hitMax: false }))
      await noteAgent($, to)
      await logEvent($, 'you', 'handoff', `${to}: ${body.split('\n')[0].slice(0, 80)}`)
      if (ownedId === undefined) await trackWork($, to, { source: 'route', text: taskLine('', body), from: 'you', agentId: one.agentId })
      return true

    }
  }
  const res = await $.agent.spawn({
    subagentType: `${TYPE_PREFIX}${to}`,
    name: to,
    description: body.slice(0, 40),
    prompt: body,
  })
  if (res.deny || res.agentId === undefined) {
    $.ui.toast(`${to}: ${res.deny ?? 'not started'}`)
    return false
  }
  // Our own spawn skips our own agent.spawn hook: record it here.
  const t0 = await $.clock.now()
  await setLive($, to, () => ({ agentId: res.agentId, status: 'working', startedAt: t0, steps: 0, recent: [], activity: body.slice(0, 60), task: taskLine('', body), ...takeStats(res.agentId) }))
  await noteAgent($, to)
  await logEvent($, 'you', 'spawn', `${to}: ${body.slice(0, 80)}`)
  if (ownedId === undefined) await trackWork($, to, { source: 'route', text: taskLine('', body), from: 'you', agentId: res.agentId })
  return true
}

/** Advances the frame clock only while something on screen moves. */
const SUMMARY_EVERY_MS = 20000
const summarizing = new Set<string>()

/** claude-opus-5-5 → opus 5.5; claude-sonnet-4-5-20250929 → sonnet 4.5; aliases stay. */
function shortModel(id: string): string {
  const m = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!m) return id
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' 1M' : ''}`
}

/** Reads the lead's model (and effort, where settings name one) from the session. */
async function readLeadModel($: EngineInterface) {
  const l = lead(await read($, team))
  if (!l) return
  const model = await $.session.model()
  let effort: string | undefined
  await quietly(async () => {
    const v = await $.env.get('CLAUDE_EFFORT')
    if (v) effort = v
  })
  if (!effort) {
    await quietly(async () => {
      const v = await $.settings.read({ key: 'effortLevel' })
      if (typeof v === 'string' || typeof v === 'number') effort = String(v)
    })
  }
  // A request's own effort (turn.step) is the truth; this only fills in before the first one.
  await setLive($, l.name, one => ({ ...one, model, ...(effort && !one.effortSeen ? { effort } : {}) }))
}

function taskLine(description: string, prompt: string): string {
  const first = prompt.split('\n').map(x => x.trim()).find(Boolean) ?? ''
  const text = description && !first.startsWith(description) ? `${description}: ${first}` : first || description
  return text.slice(0, 160)
}

/** Asks a small model, now and then, for one line on what each working member is doing. */
async function summarizeWorking($: EngineInterface) {
  const t = await read($, team)
  if (t === null) return
  const tNow = await $.clock.now()
  const l = await read($, live)
  for (const m of t.members) {
    const one = l[m.name]
    if (!one || one.status !== 'working' || summarizing.has(m.name)) continue
    if (one.steps === 0 || one.steps === one.summaryFor) continue
    if (one.summaryAt && tNow - one.summaryAt < SUMMARY_EVERY_MS) continue
    summarizing.add(m.name)
    const steps = one.steps
    void quietly(async () => {
      try {
        const res = await $.model.complete({
          model: 'haiku',
          maxTokens: 60,
          timeoutMs: 15000,
          system: 'You write one status line for a dashboard. Present tense, under 90 characters, no quotes, no preamble.',
          prompt: `Agent "${m.name}" (${m.role}) was asked: ${one.task ?? 'unknown'}\nIts latest actions, oldest first:\n${one.recent.join('\n')}\nCurrent: ${one.activity ?? ''}\n\nWhat is it doing right now?`,
        })
        const line = res.isAnswered ? res.text.split('\n')[0]?.replace(/^["']|["']$/g, '').trim() : undefined
        const tDone = await $.clock.now()
        await setLive($, m.name, cur => ({ ...cur, summaryAt: tDone, summaryFor: steps, ...(line ? { summary: line.slice(0, 120) } : {}) }))
      } finally {
        summarizing.delete(m.name)
      }
    })
  }
}

async function animate($: EngineInterface) {
  const tNow = await $.clock.now()
  const l = await read($, live)
  if (Object.values(l).some(o => look(o, tNow).isLive)) await update($, now, () => tNow)
}

async function poll($: EngineInterface) {
  await quietly(() => watchTeamFile($))
  await quietly(() => refreshFiles($))
  await quietly(() => summarizeWorking($))
  await quietly(() => dispatchQueue($))
  const t = await read($, team)
  if (t === null) return
  const l = await read($, live)
  const ids = Object.entries(l).filter(([, o]) => o.agentId)
  if (ids.length === 0) return
  const agents = await $.agent.list()
  for (const [name, one] of ids) {
    const info = agents.find(a => a.id === one.agentId)
    if (!info) continue
    const status: MemberStatus | undefined =
      info.status === 'running' || info.status === 'pending' ? 'working'
      // 'waiting' is a member held on its own background work or a plan, not a permission prompt: it is still working.
      : info.status === 'waiting' ? 'working'
      : info.status === 'failed' || info.status === 'killed' ? 'failed'
      : info.status === 'completed' ? 'done'
      : info.status === 'idle' ? (one.status === 'done' ? 'done' : 'idle')
      : undefined
    if (!status || status === one.status) continue
    // Just sent a message (route): ignore the next couple of idle/completed reports before believing them.
    if (one.status === 'working' && (one.graceLeft ?? 0) > 0 && status !== 'failed' && status !== 'human') {
      await setLive($, name, cur => ({ ...cur, graceLeft: (cur.graceLeft ?? 1) - 1 }))
      continue
    }
    // A member that asked for help or the person keeps its flag: only a real resume (resume(), a tool call) or a failure clears it.
    // Decided inside the update, on the state as it is then, so a turn.complete racing the poll wins.
    const tEnd = await $.clock.now()
    let isApplied = false
    await update($, live, all => {
      const cur = all[name]
      if (!cur || cur.status === status) return all
      // A permission flag ends when the engine reports the agent running again; answer/message flags stay.
      const isPermissionOver = cur.flagSource === 'permission' && status === 'working'
      if ((cur.status === 'waiting' || cur.status === 'human') && status !== 'failed' && !isPermissionOver) return all
      isApplied = true
      return {
        ...all,
        [name]: {
          ...cur,
          status,
          ...(status === 'working' ? {} : { activity: undefined }),
          ...(status === 'waiting' || status === 'human' ? {} : { reason: undefined, flagSource: undefined, flagCall: undefined, flagTool: undefined }),
          ...(status === 'done' ? { endedAt: tEnd } : {}),
        },
      }
    })
    if (isApplied && status === 'done') await finishQueued($, name, 'done')
    if (isApplied && status === 'failed') {
      await touchReceipt($, r => (r.endedAt === undefined ? { ...r, errors: r.errors + 1 } : r))
      await logEvent($, name, 'error', 'agent failed')
      await finishQueued($, name, 'failed')
    }
  }
}
