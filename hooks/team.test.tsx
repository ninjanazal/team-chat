import { expect, mock, test } from 'claude-code/testing'
import { resetIn, setPermissionMode, afterCall, keepsFlag, ctxBar, crewTokens, marqueeSlice, permissionFlag, permissionSkip, schedulePermissionFlag, cancelPendingAsk } from './register'

const PANE = {
  plugin: 'team-chat',
  component: 'Pane',
  requestId: 'team-chat',
  props: {
    title: 'Team',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TEAM = JSON.stringify({
  name: 'dev-team',
  members: [
    { name: 'lead', role: 'Tech lead', emoji: 'L', model: 'opus', effort: 'high', isLead: true, description: '', prompt: '' },
    { name: 'backend', role: 'Backend engineer', emoji: 'B', model: 'sonnet', effort: 'medium', description: 'APIs', prompt: 'Build APIs.' },
  ],
})

test('cards show members, and a spawn plus a tool call mark backend working', async ($, on) => {
  const registered: string[] = []
  on('fs.list', () => ({ value: [{ name: 'dev-team.json', kind: 'file', size: TEAM.length, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => { if ((e as { path: string }).path.endsWith('.active')) throw new Error('ENOENT'); return { value: TEAM } })
  on('agent.register', (_, e) => {
    registered.push(e.name)
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 3, 14, 2) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('tool.call', () => ({ result: '' }))
  on('session.send', () => ({ isDelivered: true }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual(['backend'])

  await $.agent.spawn({ prompt: 'Add GET /health', description: 'health endpoint', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The lead is the person's own session: no card for it.
  expect(await ui.find({ key: 'card:lead' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Tech lead/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /working/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Bash npm test/ })) !== undefined).toBe(true)
  await ui.press({ key: 'tab:chat' })
  expect((await ui.find({ type: 'Button', text: /\[task\] health endpoint/ })) !== undefined).toBe(true)
  await ui.unmount()
})

const regTools: Record<string, string[] | undefined> = {}
function stubEngine(on: Parameters<Parameters<typeof test>[1]>[1], written: string[], registered: string[], ticks?: (() => void)[], prompts?: Record<string, string>) {
  on('fs.list', () => ({ value: [{ name: 'dev-team.json', kind: 'file', size: TEAM.length, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => { if ((e as { path: string }).path.endsWith('.active')) throw new Error('ENOENT'); return { value: written.at(-1) ?? TEAM } })
  on('fs.write', (_, e) => {
    if (!(e as { path: string }).path.endsWith('.active')) written.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: written.length, isLink: false } }))
  on('agent.register', (_, e) => {
    registered.push(e.name)
    if (prompts) prompts[e.name] = String((e as { prompt?: string }).prompt)
    regTools[e.name] = (e as { tools?: string[] }).tools
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', (_, e) => {
    ticks?.push((e as { fn?: () => void }).fn ?? (() => {}))
    return { value: undefined }
  })
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 3, 14, 2) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
}

test('the + member form adds a member, saves team.json and registers it', async ($, on) => {
  const written: string[] = []
  const registered: string[] = []
  stubEngine(on, written, registered)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  await ui.input({ key: 'f:name', text: 'reviewer' })
  await ui.input({ key: 'f:role', text: 'Code reviewer' })
  await ui.select({ key: 'f:model', value: 'opus' })
  await ui.press({ key: 'f:save' })

  const saved = JSON.parse(written.at(-1) ?? '{}')
  expect(saved.members.map((m: { name: string }) => m.name)).toEqual(['lead', 'backend', 'reviewer'])
  expect(saved.members[2].model).toBe('opus')
  expect(registered.includes('reviewer')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Code reviewer/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the pane removes a member; /team remove only points to the pane and leaves the team unchanged', async ($, on) => {
  const written: string[] = []
  stubEngine(on, written, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const hint = await $.command.run({ command: 'team', args: 'remove backend' } as never)
  expect(String((hint as { text: string }).text)).toContain('janitor')
  expect(written.length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit:backend' })
  await ui.press({ key: 'f:remove' })
  expect(JSON.parse(written.at(-1) ?? '{}').members.length).toBe(1)
  await ui.unmount()
})

test('the edit form moves a member up and down; the first member cannot go above the lead, the last cannot go lower', async ($, on) => {
  const three = JSON.parse(TEAM)
  three.members.push({ name: 'qa', role: 'QA', emoji: 'Q', model: 'haiku', effort: 'low', description: 'tests', prompt: 'Test.' })
  const written: string[] = [JSON.stringify(three)]
  stubEngine(on, written, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = () => JSON.parse(written.at(-1) ?? '{}').members.map((m: { name: string }) => m.name)
  await ui.press({ key: 'edit:qa' })
  expect(await ui.find({ type: 'Text', text: /Position 3 of 3/ })).toBeDefined()
  await ui.press({ key: 'f:down' })
  expect(written.length).toBe(1)
  await ui.press({ key: 'f:up' })
  expect(names()).toEqual(['lead', 'qa', 'backend'])
  expect(await ui.find({ type: 'Text', text: /Position 2 of 3/ })).toBeDefined()
  await ui.press({ key: 'f:up' })
  expect(names()).toEqual(['lead', 'qa', 'backend'])
  await ui.press({ key: 'f:down' })
  expect(names()).toEqual(['lead', 'backend', 'qa'])
  await ui.unmount()
})

test('click to pick, click to place: splice to a new index, lead stays first, same spot saves nothing, cancel', async ($, on) => {
  const four = JSON.parse(TEAM)
  for (const n of ['qa', 'ops']) four.members.push({ name: n, role: n, emoji: 'X', model: 'haiku', effort: 'low', description: n, prompt: 'x' })
  const written: string[] = [JSON.stringify(four)]
  stubEngine(on, written, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = () => JSON.parse(written.at(-1) ?? '{}').members.map((m: { name: string }) => m.name)
  // roster order numbers, and no move button for the lead
  expect(await ui.find({ type: 'Text', text: /1\. / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3\. / })).toBeDefined()
  expect(await ui.find({ key: 'move:lead' })).toBeUndefined()
  // pick ops, place at the very top of the crew (gap 0): lead stays first
  await ui.press({ key: 'move:ops' })
  expect(await ui.find({ type: 'Text', text: /moving/ })).toBeDefined()
  expect(await ui.find({ key: 'slot:3' })).toBeUndefined()  // next to the picked row
  expect(await ui.find({ key: 'slot:2' })).toBeUndefined()
  await ui.press({ key: 'slot:0' })
  expect(names()).toEqual(['lead', 'ops', 'backend', 'qa'])
  expect(await ui.find({ key: 'move:cancel' })).toBeUndefined()
  // pick ops again, place after qa
  await ui.press({ key: 'move:ops' })
  await ui.press({ key: 'slot:3' })
  expect(names()).toEqual(['lead', 'backend', 'qa', 'ops'])
  // cancel changes nothing
  const n = written.length
  await ui.press({ key: 'move:qa' })
  await ui.press({ key: 'move:cancel' })
  expect(written.length).toBe(n)
  expect(await ui.find({ key: 'slot:0' })).toBeUndefined()
  await ui.unmount()
})

test('@member in the main chat goes to that member, not the lead', async ($, on) => {
  const spawned: string[] = []
  stubEngine(on, [], [])
  on('agent.spawn', (_, e) => {
    spawned.push(`${(e as { subagent_type?: string }).subagent_type ?? e.subagentType}|${e.prompt}`)
    return { agentId: 'b1', model: 'sonnet' }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const res = await $.prompt.submit({ text: '@backend add a /health route' } as never)
  expect(String((res as { drop?: string }).drop)).toContain('sent to backend')
  expect(spawned).toEqual(['team-chat:backend|add a /health route'])

  const plain = await $.prompt.submit({ text: 'plan the release' } as never)
  expect((plain as { text?: string }).text).toBe('plan the release')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /To: backend/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('/team close switches to one line per member, /team open goes back to cards; no empty feed', async ($, on) => {
  stubEngine(on, [], [])
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No messages/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /#team/ })).toBe(undefined)
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)

  await $.command.run({ command: 'team', args: 'view compact' } as never)
  expect(await ui.find({ key: 'card:backend' })).toBe(undefined)
  expect((await ui.find({ key: 'row:backend' })) !== undefined).toBe(true)

  await $.command.run({ command: 'team', args: 'view full' } as never)
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  // The older spellings still work.
  await $.command.run({ command: 'team', args: 'close' } as never)
  expect((await ui.find({ key: 'row:backend' })) !== undefined).toBe(true)
  await $.command.run({ command: 'team', args: 'open' } as never)
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('two teams: the pane asks which one, picking registers its members, the picker adds one', async ($, on) => {
  const files: Record<string, string> = {
    '.claude/teams/dev-team.json': TEAM,
    '.claude/teams/docs.json': JSON.stringify({
      name: 'docs',
      members: [{ name: 'writer', role: 'Tech writer', emoji: 'W', model: 'haiku', effort: 'low', description: 'Docs', prompt: 'Write.' }],
    }),
  }
  const registered: string[] = []
  on('fs.list', () => ({
    value: [...new Set(Object.keys(files).map(f => f.slice('.claude/teams/'.length).split('/')[0]))]
      .filter(n => !n.startsWith('.'))
      .map(n => ({ name: n, kind: n.endsWith('.json') ? 'file' : 'dir', size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    const text = Object.entries(files).find(([k]) => path.endsWith(k))?.[1]
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    const w = e as { path: string; text: string }
    files[w.path.slice(w.path.lastIndexOf('.claude/teams/'))] = w.text
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: Object.keys(files).some(k => (e as { path: string }).path.endsWith(k)) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => {
    registered.push(e.name)
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Which team/ })) !== undefined).toBe(true)
  expect(registered).toEqual([])

  await ui.press({ key: 'pick:docs' })
  expect(registered).toEqual(['writer'])
  expect((await ui.find({ type: 'Text', text: /Tech writer/ })) !== undefined).toBe(true)

  const made = await $.command.run({ command: 'team', args: 'new qa-squad dev-team' } as never)
  expect(String((made as { text: string }).text)).toContain('/team-chat:create')
  await ui.press({ key: 'switch' })
  await ui.input({ key: 'newteam', text: 'qa-squad' })
  // Submitting the name in the picker creates a lead-only team.
  expect(JSON.parse(files['.claude/teams/qa-squad/team.json'] ?? '{}').members.length).toBe(1)
  expect((await ui.find({ type: 'Text', text: /qa-squad/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a working member gets a task line and a model-written summary of what it is doing', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 3, 14, 0) })
  on('fs.list', () => ({ value: [{ name: 'dev-team.json', kind: 'file', size: TEAM.length, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => { if ((e as { path: string }).path.endsWith('.active')) throw new Error('ENOENT'); return { value: TEAM } })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('tool.call', () => ({ result: '' }))
  on('agent.list', () => ({ value: [{ id: 'a1', status: 'running', description: '', type: 'team-chat:backend' }] }))
  const asked: string[] = []
  on('model.complete', (_, e) => {
    asked.push((e as { prompt: string }).prompt)
    return { value: { isAnswered: true, text: 'Writing the /health handler and its test', usage: {} } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Add GET /health with a test', description: 'health endpoint', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Write', file_path: 'src/api/health.ts', content: '', agentId: 'a1' } as never)
  await clock.advance(1100)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /health endpoint: Add GET \/health/ })) !== undefined).toBe(true)
  expect(asked.length).toBe(1)
  expect(String(asked[0])).toContain('Write api/health.ts')
  expect((await ui.find({ type: 'Text', text: /Writing the \/health handler/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('each card has a status label inside its box, on the name row, and the card rows still count in the scroll budget', async ($, on) => {
  on('fs.list', () => ({ value: [{ name: 'dev-team.json', kind: 'file', size: TEAM.length, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => { if ((e as { path: string }).path.endsWith('.active')) throw new Error('ENOENT'); return { value: TEAM } })
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 3, 14, 2) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('tool.call', () => ({ result: '' }))
  on('session.send', () => ({ isDelivered: true }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /idle/ })) !== undefined).toBe(true)
  await $.agent.spawn({ prompt: 'Add GET /health', description: 'health endpoint', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
  expect((await ui.find({ type: 'Text', text: /^ .* working/ })) !== undefined).toBe(true)
  await ui.unmount()

  // A pane too short for the card (label + box) scrolls instead of showing it whole.
  const small = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 4 } }, surface: 'desktop' })
  expect(await small.find({ key: 'status:backend' })).toBe(undefined)
  await small.unmount()
})

test('with no team files, /team list and start_team say there is no team and suggest /team-chat:create', async ($, on) => {
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const list = await $.command.run({ command: 'team', args: 'list' } as never)
  expect(String((list as { text: string }).text)).toContain('/team-chat:create')

  const start = await $.tool.call({ tool: 'mcp__team-chat__start_team' } as never)
  const startText = String((start as { result?: string }).result)
  expect(startText.toLowerCase()).toContain('no team')
  expect(startText).toContain('/team-chat:create')
})

test('save_team writes the team with the lead added, registers the members and makes it current', async ($, on) => {
  const written: Record<string, string> = { '.claude/teams/dev-team.json': TEAM }
  const registered: string[] = []
  on('fs.list', () => ({
    value: [...new Set(Object.keys(written).map(f => f.slice('.claude/teams/'.length).split('/')[0]))]
      .filter(n => !n.startsWith('.'))
      .map(n => ({ name: n, kind: n.endsWith('.json') ? 'file' : 'dir', size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    const hit = Object.entries(written).find(([k]) => path.endsWith(k))?.[1]
    if (hit === undefined) throw new Error('ENOENT')
    return { value: hit }
  })
  on('fs.write', (_, e) => {
    const w = e as { path: string; text: string }
    written[w.path.slice(w.path.lastIndexOf('.claude/teams/'))] = w.text
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: Object.keys(written).some(k => (e as { path: string }).path.endsWith(k)) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => {
    registered.push(e.name)
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: 'dev-team' }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const res = await $.tool.call({
    tool: 'mcp__team-chat__save_team',
    name: 'docs-squad',
    members: [
      { name: 'writer', role: 'Tech writer', model: 'sonnet', effort: 'medium', purpose: 'Write the docs.', boundaries: 'Never edit code' },
      { name: 'checker', role: 'Docs reviewer', model: 'haiku', effort: 'low', purpose: 'Check the docs.' },
    ],
  } as never)
  expect(JSON.stringify(res)).toContain('Saved team')
  const saved = JSON.parse(written['.claude/teams/docs-squad/team.json'] ?? '{}')
  expect(saved.members.map((m: { name: string }) => m.name)).toEqual(['lead', 'writer', 'checker'])
  expect(registered.includes('writer') && registered.includes('checker')).toBe(true)

  const again = await $.tool.call({ tool: 'mcp__team-chat__save_team', name: 'docs-squad', members: [{ name: 'x', role: 'X', model: 'haiku', effort: 'low', purpose: 'x' }] } as never)
  expect(JSON.stringify(again)).toContain('already exists')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /docs-squad/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Tech writer/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('help: /team help answers the guide, and ? help shows it in the pane', async ($, on) => {
  stubEngine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const res = await $.command.run({ command: 'team', args: 'help' } as never)
  expect(String((res as { text: string }).text)).toContain('/team-chat:create')
  expect(String((res as { text: string }).text)).toContain('/team-chat:help')
  expect(String((res as { text: string }).text)).not.toContain('Reading the pane')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'help' })
  expect((await ui.find({ type: 'Markdown', text: /Reading the pane/ })) !== undefined).toBe(true)
  await ui.press({ key: 'help:close' })
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('team files: a member writes one, it is indexed with its author, posted, readable and shown in the pane', async ($, on) => {
  const disk: Record<string, string> = { '.claude/teams/dev-team.json': TEAM }
  const registered: { name: string; tools?: string[] }[] = []
  const rel = (path: string) => path.slice(Math.max(0, path.indexOf('.claude/')))
  on('fs.list', (_, e) => {
    const dir = `${rel((e as { path: string }).path)}/`
    const names = Object.keys(disk).filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(k => k.slice(dir.length))
    if (names.length === 0) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'file', size: disk[dir + name]?.length ?? 0, mtimeMs: 5, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    const text = disk[rel((e as { path: string }).path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    const w = e as { path: string; text: string }
    disk[rel(w.path)] = w.text
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => {
    registered.push({ name: e.name, tools: (e as { tools?: string[] }).tools })
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 3, 14, 2) }))
  on('store.get', () => ({ value: 'dev-team' }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Design the API', description: 'api plan', subagentType: 'team-chat:backend' })

  const bad = await $.tool.call({ tool: 'mcp__team-chat__write_file', name: '../x', content: 'no', agentId: 'a1' } as never)
  expect(String((bad as { deny?: string }).deny)).toContain('Error')

  const res = await $.tool.call({ tool: 'mcp__team-chat__write_file', name: 'api-plan', content: '# API\nGET /health', note: 'the API contract', agentId: 'a1' } as never)
  expect(JSON.stringify(res)).toContain('.claude/teams/dev-team/files/api-plan.md')
  expect(disk['.claude/teams/dev-team/files/api-plan.md']).toBe('# API\nGET /health\n')
  expect(JSON.parse(disk['.claude/teams/dev-team/files/.index.json'] ?? '{}')['api-plan.md'].author).toBe('backend')

  await $.tool.call({ tool: 'mcp__team-chat__write_file', name: 'api-plan.md', content: 'POST /items', mode: 'append' } as never)
  const got = await $.tool.call({ tool: 'mcp__team-chat__read_file', name: 'api-plan.md' } as never)
  expect(JSON.stringify(got)).toContain('GET /health\\n\\nPOST /items')
  expect(JSON.stringify(got)).toContain('last written by lead')
  const listed = await $.tool.call({ tool: 'mcp__team-chat__list_files' } as never)
  expect(JSON.stringify(listed)).toContain('api-plan.md (by lead')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:chat' })
  expect((await ui.find({ type: 'Button', text: /📄 wrote api-plan.md: the API contract/ })) !== undefined).toBe(true)
  await ui.press({ key: 'tab:files' })
  await ui.press({ key: 'file:api-plan.md' })
  expect((await ui.find({ type: 'Markdown', text: /POST \/items/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a second session.start (/new) keeps the team, skips the picker and re-tells the lead', async ($, on) => {
  const appended: string[] = []
  const other = JSON.stringify({ name: 'docs', members: [{ name: 'writer', role: 'Tech writer', emoji: 'W', model: 'haiku', effort: 'low', description: 'Docs', prompt: 'Write.' }] })
  on('fs.list', () => ({ value: [{ name: 'dev-team', kind: 'dir', size: 0, mtimeMs: 1, isLink: false }, { name: 'docs', kind: 'dir', size: 0, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('.active')) return { value: 'dev-team\n' }
    if (path.endsWith('.index.json')) throw new Error('ENOENT')
    return { value: path.includes('/docs/') ? other : TEAM }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.append', (_, e, next) => {
    appended.push(JSON.stringify(e))
    return next(e)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  expect(appended.length).toBe(0)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  expect(appended.length).toBe(1)
  expect(appended[0]).toContain('dev-team')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Which team/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a member that ends BLOCKED or asks the person gets a needs-help or needs-human card, cleared when it resumes', async ($, on) => {
  on('fs.list', () => ({ value: [{ name: 'dev-team', kind: 'dir', size: 0, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('.active')) return { value: 'dev-team\n' }
    if (path.endsWith('.index.json')) throw new Error('ENOENT')
    return { value: TEAM }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('tool.call', () => ({ result: '' }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Add GET /health', description: 'health endpoint', subagentType: 'team-chat:backend' })

  await $.session.send({ to: 'lead', text: 'BLOCKED: waiting for the schema from lead', agentId: 'a1', origin: { kind: 'model' } } as never)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /needs help: waiting for the schema/ })) !== undefined).toBe(true)
  await ui.unmount()

  await $.session.send({ to: 'lead', text: 'Is this fine?\n```\nNEEDS-HUMAN: in code\n```\nNEEDS-HUMAN: Should I drop the old table?', agentId: 'a1', origin: { kind: 'model' } } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /needs you: .*Should I drop the old table\?/ })) !== undefined).toBe(true)
  await ui.unmount()

  await $.session.send({ to: 'backend', text: 'yes drop it', origin: { kind: 'user' } } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /needs (you|help)/ })) === undefined).toBe(true)
  await ui.unmount()

  await $.turn.complete({ agentId: 'a1', answer: 'All done. Anything else?' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /needs (you|help)/ })) === undefined).toBe(true)
  await ui.unmount()

  // A finished member never shows a flag, even when its last words were BLOCKED: or NEEDS-HUMAN:.
  for (const answer of ['BLOCKED: I could not reach builder or architect', 'NEEDS-HUMAN: may I drop it?', 'BLOCKED: need permission to run Bash']) {
    await $.turn.complete({ agentId: 'a1', answer } as never)
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /needs (you|help)/ })) === undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /done/ })) !== undefined).toBe(true)
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /needs (you|help)/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('each session.start registers its own poll and animate intervals (the older ones go inert)', async ($, on) => {
  const ticks: (() => void)[] = []
  let lists = 0
  on('fs.list', () => {
    lists++
    return { value: [] }
  })
  on('fs.read', () => { throw new Error('ENOENT') })
  on('fs.exists', () => ({ value: false }))
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', (_, e) => {
    ticks.push((e as { fn?: () => void }).fn ?? (() => {}))
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  expect(ticks.length).toBe(4)
})

test('the switch button is replaced by a reason while a member works, and channel messages expand and collapse', async ($, on) => {
  on('fs.list', () => ({ value: [{ name: 'dev-team', kind: 'dir', size: 0, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('.active')) return { value: 'dev-team\n' }
    if (path.endsWith('.index.json')) throw new Error('ENOENT')
    return { value: TEAM }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', text: /switch/ })) !== undefined).toBe(true)
  await ui.unmount()

  await $.agent.spawn({ prompt: 'Add GET /health', description: 'health endpoint', subagentType: 'team-chat:backend' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /switch \(busy\)/ })) !== undefined).toBe(true)
  await ui.unmount()

  const long = 'Report line one.\nSecond line with detail.\nThird line only when expanded.'
  await $.turn.complete({ agentId: 'a1', answer: long } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:chat' })
  expect((await ui.find({ type: 'Text', text: /switch \(busy\)/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Button', text: /Third line only/ })) === undefined).toBe(true)
  const msgKey = ((await ui.find({ type: 'Button', text: /Report line one/ })) as unknown as { key: string }).key
  await ui.press({ key: msgKey })
  expect((await ui.find({ type: 'Button', text: /Third line only/ })) !== undefined).toBe(true)
  await ui.press({ key: msgKey })
  expect((await ui.find({ type: 'Button', text: /Third line only/ })) === undefined).toBe(true)
  await ui.unmount()
})

function stubTeam(on: Parameters<Parameters<typeof test>[1]>[1], ticks?: (() => void)[], own: { store?: boolean; spawn?: boolean; get?: boolean } = {}) {
  stubEngine(on, [], [], ticks)
  on('session.cwd', () => ({ value: '/proj' }))
  if (!own.get) on('store.get', () => ({ value: undefined }))
  if (!own.store) on('store.set', () => ({ value: undefined }))
  if (!own.spawn) on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('tool.call', (_, e) => ((e as { tool: string }).tool === 'Write' ? { result: '', isError: true } : { result: '' }) as never)
}

const HINT = { plugin: 'team-chat', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' }, surface: 'desktop' } as never
const STEP = { turnId: 't1', index: 0, model: 'claude-sonnet-4-5', messageCount: 3, agentId: 'a1' } as never

test('per-member stats from turn.step usage, max_tokens in red, receipt counts agents and edits', async ($, on) => {
  stubTeam(on)
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'max_tokens', usage: { model: 'claude-sonnet-4-5', input_tokens: 800, output_tokens: 4100, cache_read_input_tokens: 36000, cache_creation_input_tokens: 1200 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'do it' } as never).catch(() => undefined)
  await $.agent.spawn({ prompt: 'Add GET /health', description: 'health endpoint', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', agentId: 'a1' } as never)
  const stream = $.turn.step(STEP)
  for await (const _ of stream) { /* drain */ }

  for (const cols of [90, 140]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols }, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /ctx 38k/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /4\.1k max_tokens/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /1 agent/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /1 edit/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /1 err/ })) !== undefined).toBe(true)
    // The usage row's total: 38k ctx + 4.1k out from that one request.
    expect((await ui.find({ type: 'Text', text: /Σ 42k/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('narrow width auto-falls back to rows with ctx hidden; layout wide forces cards; mini is one line', async ($, on) => {
  stubTeam(on)
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'm', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  for await (const _ of $.turn.step(STEP)) { /* drain */ }
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface: 'desktop' } as const

  let ui = await $.ui.mount(narrow)
  expect((await ui.find({ key: 'row:backend' })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Text', text: /ctx 40k/ })).toBe(undefined)
  await ui.unmount()

  await $.command.run({ command: 'team', args: 'view wide' } as never)
  ui = await $.ui.mount(narrow)
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /ctx 40k/ })) !== undefined).toBe(true)
  await ui.unmount()

  await $.command.run({ command: 'team', args: 'view mini' } as never)
  ui = await $.ui.mount(narrow)
  expect(await ui.find({ key: 'card:backend' })).toBe(undefined)
  expect(await ui.find({ key: 'row:backend' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /backend/ })) !== undefined).toBe(true)
  await ui.unmount()

  const res = await $.command.run({ command: 'team', args: 'view bogus' } as never)
  expect(String((res as { text: string }).text)).toContain('Usage: /team view')
  const bare = await $.command.run({ command: 'team', args: 'view' } as never)
  expect(String((bare as { text: string }).text)).toContain('Usage: /team view')
})

test('a needs-help flag clears when the status poll reports idle, completed or running; a finished BLOCKED answer is never flagged', async ($, on) => {
  const ticks: (() => void)[] = []
  stubTeam(on, ticks)
  let status = 'idle'
  on('session.send', () => ({ isDelivered: true }))
  on('agent.list', () => ({ value: [{ id: 'a1', status, description: '', type: 'team-chat:backend' }] }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  const poll = async () => { for (const t of ticks) t(); await new Promise(r => setTimeout(r, 20)) }
  const shows = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const got = (await ui.find({ type: 'Text', text: re })) !== undefined
    await ui.unmount()
    return got
  }
  const block = () => $.session.send({ to: 'lead', text: 'BLOCKED: need the schema', agentId: 'a1', origin: { kind: 'model' } } as never)

  // The engine saying idle or completed means the member is over, so the flag clears.
  for (const s of ['idle', 'completed']) {
    await block()
    status = s
    await poll()
    expect(await shows(/needs help/)).toBe(false)
  }
  // Running again after its own BLOCKED words is a resume.
  status = 'running'
  await block()
  await poll()
  await $.session.send({ to: 'backend', text: 'carry on', origin: { kind: 'user' } } as never)
  expect(await shows(/needs help/)).toBe(false)
  // The BLOCKED answer of a finished member: done, no flag, after the poll too.
  await $.turn.complete({ agentId: 'a1', answer: 'BLOCKED: I could not reach builder or architect' } as never)
  status = 'completed'
  await poll()
  expect(await shows(/needs help/)).toBe(false)
  expect(await shows(/done/)).toBe(true)
  // A failure never keeps one either.
  status = 'running'
  await block()
  status = 'failed'
  await poll()
  expect(await shows(/needs help/)).toBe(false)
})

test('compact rows and the mini line show the needs-help reason, a long role at 50 columns still renders, and a row expands in place', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'a long task description for the card', subagentType: 'team-chat:backend' })
  await $.session.send({ to: 'lead', text: 'NEEDS-HUMAN: may I drop the old users table?', agentId: 'a1', origin: { kind: 'model' } } as never)
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface: 'desktop' } as const

  let ui = await $.ui.mount(narrow)
  expect((await ui.find({ key: 'row:backend' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /needs you: may I drop/ })) !== undefined).toBe(true)
  await ui.press({ key: 'row:backend' })
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  await ui.press({ key: 'card:backend' })
  expect((await ui.find({ key: 'row:backend' })) !== undefined).toBe(true)
  await ui.unmount()

  await $.command.run({ command: 'team', args: 'layout mini' } as never)
  ui = await $.ui.mount(narrow)
  expect((await ui.find({ type: 'Text', text: /needs you: may I drop/ })) !== undefined).toBe(true)
  await ui.press({ key: 'mini:backend' })
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a failed edit is an error not an edit, subagent tokens before spawn are merged', async ($, on) => {
  stubTeam(on)
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'm', input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' } as never).catch(() => undefined)
  for await (const _ of $.turn.step(STEP)) { /* before the spawn is registered */ }
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Write', file_path: 'a.ts', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'b.ts', agentId: 'a1' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ctx 5\.0k/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /1 edit\b/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /1 err/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('tabs: Overview by default, Chat/Files/Queue switch by button and /team tab, the choice is stored, Overview shows a needs-help badge', async ($, on) => {
  stubTeam(on, undefined, { store: true })
  const stored: Record<string, unknown> = {}
  on('store.set', (_, e) => { stored[(e as { key: string }).key] = (e as { value: unknown }).value; return { value: undefined } })
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  on('ui.scroll', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Text', text: /⚑1/ })).toBe(undefined)
  await ui.press({ key: 'tab:chat' })
  expect(await ui.find({ key: 'card:backend' })).toBe(undefined)
  expect((await ui.find({ type: 'Button', text: /\[task\]/ })) !== undefined).toBe(true)
  expect(stored.tab).toBe('chat')

  await $.turn.complete({ agentId: 'a1', answer: 'BLOCKED: need the schema' } as never)
  expect((await ui.find({ type: 'Text', text: /⚑1/ })) !== undefined).toBe(true)

  await ui.press({ key: 'tab:files' })
  expect((await ui.find({ type: 'Text', text: /No files yet|Shared files/ })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Button', text: /\[task\]/ })).toBe(undefined)
  await ui.press({ key: 'tab:queue' })
  // The spawned backend is tracked as Active work, so the tab is not empty.
  expect((await ui.find({ type: 'Text', text: /Active 1/ })) !== undefined).toBe(true)
  expect(await ui.find({ key: 'q:add' })).toBe(undefined)
  const tabHint = await $.command.run({ command: 'team', args: 'tab overview' } as never)
  expect(String((tabHint as { text: string }).text)).toContain('Click a tab')
  await ui.press({ key: 'tab:overview' })
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Text', text: /⚑1/ })).toBe(undefined)
  expect(stored.tab).toBe('overview')
  const bad = await $.command.run({ command: 'team', args: 'tab nope' } as never)
  expect(String((bad as { text: string }).text)).toContain('Click a tab')
  await ui.unmount()
})

test('scrolling: header stays two fixed lines; Chat shows only the newest messages that fit, older ones by button', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let n = 1; n <= 120; n++) await $.session.send({ to: 'backend', text: `message number ${n}`, origin: { kind: 'model' } } as never)
  const small = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } }, surface: 'desktop' } as const
  const ui = await $.ui.mount(small)
  // Header: tabs and the "+" button are always there, and the old files button is gone.
  expect((await ui.find({ key: 'tab:queue' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'add' })) !== undefined).toBe(true)
  expect(await ui.find({ key: 'files' })).toBe(undefined)
  await ui.press({ key: 'tab:chat' })
  expect((await ui.find({ type: 'Button', text: /message number 120$/ })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Button', text: /message number 100$/ })).toBe(undefined)
  expect((await ui.find({ key: 'body:up' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'tab:queue' })) !== undefined).toBe(true)
  expect(await ui.find({ key: 'chat:end' })).toBe(undefined)
  await ui.press({ key: 'body:up' })
  expect((await ui.find({ key: 'chat:end' })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Button', text: /message number 120$/ })).toBe(undefined)
  await ui.press({ key: 'chat:end' })
  expect((await ui.find({ type: 'Button', text: /message number 120$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

async function seenMessages(ui: { find: (q: never) => Promise<unknown> }, from: number, to: number): Promise<number[]> {
  const out: number[] = []
  for (let n = from; n <= to; n++) {
    if ((await ui.find({ type: 'Button', text: new RegExp(`message number ${n}$`) } as never)) !== undefined) out.push(n)
  }
  return out
}

test('paging never skips: older then newer returns to the same window, and each page overlaps or touches the last', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let n = 1; n <= 40; n++) await $.session.send({ to: 'backend', text: `message number ${n}`, origin: { kind: 'model' } } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 9 } }, surface: 'desktop' } as never)
  await ui.press({ key: 'tab:chat' })
  const first = await seenMessages(ui as never, 1, 40)
  expect(first.at(-1)).toBe(40)
  await ui.press({ key: 'body:up' })
  const second = await seenMessages(ui as never, 1, 40)
  // The page above starts no lower than just under the old window: nothing between is skipped.
  expect(second.at(-1)).toBeGreaterThanOrEqual((first[0] ?? 0) - 1)
  expect(second.at(-1)).toBeLessThan(40)
  // Newer pages walk back down to the latest, then the "newer" button is gone.
  for (let n = 0; n < 20 && (await ui.find({ key: 'chat:newer' })) !== undefined; n++) await ui.press({ key: 'chat:newer' })
  expect(await seenMessages(ui as never, 1, 40)).toEqual(first)
  await ui.press({ key: 'body:up' })
  await ui.press({ key: 'chat:end' })
  expect(await seenMessages(ui as never, 1, 40)).toEqual(first)
  await ui.unmount()
})

test('new messages do not move an older view', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  // Chat: scroll up, then new messages arrive: the view stays on the same messages.
  for (let n = 1; n <= 20; n++) await $.session.send({ to: 'backend', text: `message number ${n}`, origin: { kind: 'model' } } as never)
  const chat = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 9 } }, surface: 'desktop' } as never)
  await chat.press({ key: 'tab:chat' })
  await chat.press({ key: 'body:up' })
  const before = await seenMessages(chat as never, 1, 30)
  for (let n = 21; n <= 30; n++) await $.session.send({ to: 'backend', text: `message number ${n}`, origin: { kind: 'model' } } as never)
  expect(await seenMessages(chat as never, 1, 30)).toEqual(before)
  await chat.unmount()
})

test('queue tab is read only: active, queued, done in order, only what fits, no inputs or buttons', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  for (const w of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) await $.command.run({ command: 'team', args: `queue backend ${w}` } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'desktop' } as never)
  await ui.press({ key: 'tab:queue' })
  const has = async (f: object) => (await ui.find(f as never)) !== undefined
  // The spawned backend is Active (source spawn); the six queued tasks wait because it is busy.
  expect(await has({ type: 'Text', text: /Active 1/ })).toBe(true)
  expect(await has({ type: 'Text', text: /Queued 6/ })).toBe(true)
  expect(await has({ type: 'Text', text: /alpha/ })).toBe(true)
  // Read only: no input, select, or action buttons.
  for (const k of ['q:text', 'q:to', 'q:add', 'q:up:2', 'q:down:2', 'q:rm:2']) expect(await has({ key: k })).toBe(false)
  await ui.unmount()

  // A short pane keeps the head of each group and says how many are left out.
  const small = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } }, surface: 'desktop' } as never)
  await small.press({ key: 'tab:queue' })
  expect((await small.find({ type: 'Text', text: /Active 1/ })) !== undefined).toBe(true)
  expect((await small.find({ type: 'Text', text: /\+\d+ more/ })) !== undefined).toBe(true)
  expect(await small.find({ type: 'Text', text: /zeta/ })).toBe(undefined)
  await small.unmount()
})

test('queue tracks real work: a spawn and a routed message become Active items, a dispatched task makes exactly one, finishing moves them to Done', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'warm up', description: 'warm up', subagentType: 'team-chat:backend' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:queue' })
  const listing = async () => String(((await $.command.run({ command: 'team', args: 'queue' } as never)) as { text: string }).text)
  expect((await ui.find({ type: 'Text', text: /Active 1/ })) !== undefined).toBe(true)
  expect(await listing()).toContain('#1 running')
  await $.turn.complete({ agentId: 'a1', answer: 'ready' } as never)
  expect((await ui.find({ type: 'Text', text: /Done 1/ })) !== undefined).toBe(true)

  // Dispatched from the queue: one item (#2), not two.
  await $.command.run({ command: 'team', args: 'queue backend from the queue' } as never)
  const l1 = await listing()
  expect(l1).toContain('#2 running')
  expect(l1).not.toContain('#3')
  await $.turn.complete({ agentId: 'a1', answer: 'done' } as never)
  expect((await ui.find({ type: 'Text', text: /Done 2/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('queue tab on a small pane keeps a row for every non-empty group', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'warm up', description: 'warm up', subagentType: 'team-chat:backend' })
  await $.turn.complete({ agentId: 'a1', answer: 'ready' } as never)
  for (const w of ['one', 'two', 'three', 'four']) await $.command.run({ command: 'team', args: `queue backend ${w}` } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } }, surface: 'desktop' } as never)
  await ui.press({ key: 'tab:queue' })
  for (const g of [/Active 1/, /Queued 3/, /Done 1/]) expect((await ui.find({ type: 'Text', text: g })) !== undefined).toBe(true)
  await ui.unmount()
})

test('queue tab on a tiny pane says which groups are hidden', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'warm up', description: 'warm up', subagentType: 'team-chat:backend' })
  await $.turn.complete({ agentId: 'a1', answer: 'ready' } as never)
  for (const w of ['one', 'two']) await $.command.run({ command: 'team', args: `queue backend ${w}` } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 1 } }, surface: 'desktop' } as never)
  await ui.press({ key: 'tab:queue' })
  // Budget is 4 rows: the hidden line takes one, so Active (2 rows) + the line (1) = 3 rows, within the budget.
  expect((await ui.find({ type: 'Text', text: /Active 1/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Queued 1, Done 1 hidden/ })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Queued 1$/ })).toBe(undefined)
  await ui.unmount()
})

test('/team v2: unknown input suggests or refuses without opening the pane or queueing; view sets the palette; old verbs answer with hints', async ($, on) => {
  stubEngine(on, [], [])
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = async (args: string) => String(((await $.command.run({ command: 'team', args } as never)) as { text: string }).text)

  expect(await run('lsit')).toContain('Did you mean /team list')
  expect(await run('this is confusing')).toContain('takes a verb')
  expect(await run('qzxwv')).toContain('Unknown "qzxwv"')
  expect((await $.command.run({ command: 'team', args: 'queue' } as never)) !== undefined).toBe(true)
  expect(await run('view pastel')).toContain('pastel')
  expect(await run('files')).toContain('Files')
  expect(await run('reload')).toContain('automatically')
  expect(await run('new x')).toContain('/team-chat:create')
  expect(await run('add x')).toContain('janitor')
  expect(await run('layout mini')).toContain('mini')
})

test('there is no banner above the tabs: flagged members show only on their cards, and the tabs stay', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  await $.session.send({ to: 'lead', text: 'BLOCKED: need the schema', agentId: 'a1', origin: { kind: 'model' } } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'banner:backend' })).toBe(undefined)
  expect(await ui.find({ key: 'flag:backend' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /\d+ need (help|you)/ })).toBe(undefined)
  expect((await ui.find({ key: 'tab:overview' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'card:backend' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /needs help: need the schema/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('queue: enqueue, auto-dispatch to a free member only, hold while flagged, reorder and remove', async ($, on) => {
  stubTeam(on)
  let sent = 0
  on('session.send', () => { sent++; return { isDelivered: true } })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // backend exists as a finished agent, so tasks reach it by message (the usual routing).
  await $.agent.spawn({ prompt: 'warm up', description: 'warm up', subagentType: 'team-chat:backend' })
  await $.turn.complete({ agentId: 'a1', answer: 'ready' } as never)
  sent = 0
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:queue' })

  // By command: it goes out at once.
  await $.command.run({ command: 'team', args: 'queue backend write the health test' } as never)
  expect(sent).toBe(1)
  // Two more: backend is busy, so they wait (listed read only under Queued).
  await $.command.run({ command: 'team', args: 'queue backend second task' } as never)
  await $.command.run({ command: 'team', args: 'queue backend third task' } as never)
  expect(sent).toBe(1)
  expect((await ui.find({ type: 'Text', text: /Queued 2/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Active 1/ })) !== undefined).toBe(true)
  expect(await ui.find({ key: 'q:up:2' })).toBe(undefined)

  // Ids: 1 is the warm-up spawn, 2 runs, 3 and 4 wait. Remove #3 by command.
  await $.command.run({ command: 'team', args: 'queue rm #3' } as never)
  expect((await ui.find({ type: 'Text', text: /Queued 1/ })) !== undefined).toBe(true)

  // The member asks for help: the next task is held.
  await $.turn.complete({ agentId: 'a1', answer: 'BLOCKED: need the schema' } as never)
  expect(sent).toBe(1)

  // It finishes: task #1 is done and #3 goes out automatically.
  await $.turn.complete({ agentId: 'a1', answer: 'All done.' } as never)
  expect(sent).toBe(2)
  expect((await ui.find({ type: 'Text', text: /Done 2/ })) !== undefined).toBe(true)

  // Bad member, and a running task cannot be removed.
  const res = await $.command.run({ command: 'team', args: 'queue nobody x' } as never)
  expect(String((res as { text: string }).text)).toContain('No member')
  await $.command.run({ command: 'team', args: 'queue rm #3' } as never)
  await ui.unmount()
})

test('queue: "any" goes to an idle non-lead member, and the queue is saved per team', async ($, on) => {
  stubTeam(on, undefined, { store: true })
  const stored: Record<string, unknown> = {}
  on('store.set', (_, e) => { stored[(e as { key: string }).key] = (e as { value: unknown }).value; return { value: undefined } })
  const targets: string[] = []
  on('session.send', (_, e) => { targets.push(JSON.stringify((e as { to: unknown }).to)); return { isDelivered: true } })
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'warm up', description: 'warm up', subagentType: 'team-chat:backend' })
  await $.turn.complete({ agentId: 'a1', answer: 'ready' } as never)
  targets.length = 0
  await $.command.run({ command: 'team', args: 'queue any do the thing' } as never)
  expect(targets).toEqual(['"a1"'])
  expect(JSON.stringify(Object.entries(stored).find(([k]) => k.startsWith('queue:'))?.[1])).toContain('do the thing')
})

async function readyBackend($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.agent.spawn({ prompt: 'warm up', description: 'warm up', subagentType: 'team-chat:backend' })
  await $.turn.complete({ agentId: 'a1', answer: 'ready' } as never)
}

test('queue: a failing send marks the task failed; a poll idle report right after a successful send does not', async ($, on) => {
  const ticks: (() => void)[] = []
  stubTeam(on, ticks)
  let isThrowing = true
  on('session.send', () => { if (isThrowing) throw new Error('boom'); return { isDelivered: true } })
  on('agent.list', () => ({ value: [{ id: 'a1', status: 'idle', description: '', type: 'team-chat:backend' }] }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await readyBackend($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.command.run({ command: 'team', args: 'queue backend first' } as never)
  await ui.press({ key: 'tab:queue' })
  expect((await ui.find({ type: 'Text', text: /✕ first/ })) !== undefined).toBe(true)

  isThrowing = false
  await $.command.run({ command: 'team', args: 'queue backend second' } as never)
  for (const t of ticks) t()
  await new Promise(r => setTimeout(r, 20))
  // The second task stays Active (not finished by the early idle report); the failed one is under Done.
  expect((await ui.find({ type: 'Text', text: /Active 1/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Done 2/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('queue: the poll reporting completed finishes the running task; the next one goes out; ids are never reused', async ($, on) => {
  const ticks: (() => void)[] = []
  stubTeam(on, ticks)
  on('session.send', () => ({ isDelivered: true }))
  let status = 'running'
  on('agent.list', () => ({ value: [{ id: 'a1', status, description: '', type: 'team-chat:backend' }] }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  {
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await readyBackend($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await $.command.run({ command: 'team', args: 'queue backend first\nwith a second line' } as never)
    await $.command.run({ command: 'team', args: 'queue backend second' } as never)
    // Ids: 1 is the warm-up spawn, 2 and 3 the queued tasks. Remove #3 by command.
    await $.command.run({ command: 'team', args: 'queue rm #3' } as never)
    // The first reports right after the send are ignored; then completed counts.
    status = 'completed'
    for (let n = 0; n < 4; n++) {
      for (const t of ticks) t()
      await new Promise(r => setTimeout(r, 20))
    }
    await $.command.run({ command: 'team', args: 'queue backend third' } as never)
    // #3 was removed and is not reused: the new task is #4.
    const listing = await $.command.run({ command: 'team', args: 'queue' } as never)
    expect(String((listing as { text: string }).text)).toContain('#4 ')
    expect(String((listing as { text: string }).text)).not.toContain('#3 ')
  }
})

test('queue: the lead and bad ids are refused; any needs a non-lead member', async ($, on) => {
  stubTeam(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const lead = await $.command.run({ command: 'team', args: 'queue lead do it' } as never)
  expect(String((lead as { text: string }).text)).toContain('lead is your main session')
  const bad = await $.command.run({ command: 'team', args: 'queue rm #99' } as never)
  expect(String((bad as { text: string }).text)).toContain('No task #99')
  const usage = await $.command.run({ command: 'team', args: 'queue rm abc' } as never)
  expect(String((usage as { text: string }).text)).toContain('Usage')
})

test('switching teams clears the queue and never saves the old queue under the new team', async ($, on) => {
  const files: Record<string, string> = {
    '.claude/teams/dev-team.json': TEAM,
    '.claude/teams/docs.json': JSON.stringify({
      name: 'docs',
      members: [{ name: 'writer', role: 'Tech writer', emoji: 'W', model: 'haiku', effort: 'low', description: 'Docs', prompt: 'Write.' }],
    }),
  }
  const sets: [string, string][] = []
  on('fs.list', () => ({ value: Object.keys(files).map(f => ({ name: f.slice('.claude/teams/'.length), kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    const text = Object.entries(files).find(([k]) => path.endsWith(k))?.[1]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => ({ value: { agent: `team-chat:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => { sets.push([(e as { key: string }).key, JSON.stringify((e as { value: unknown }).value)]); return { value: undefined } })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'team', args: 'dev-team' } as never)
  await $.command.run({ command: 'team', args: 'queue backend write the plan' } as never)
  expect(sets.some(([k, v]) => k === 'queue:/proj:dev-team' && v.includes('write the plan'))).toBe(true)

  await $.command.run({ command: 'team', args: 'docs' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:queue' })
  expect((await ui.find({ type: 'Text', text: /No tasks/ })) !== undefined).toBe(true)
  expect(sets.some(([k, v]) => k === 'queue:/proj:docs' && v.includes('write the plan'))).toBe(false)
  await ui.unmount()
})

test('saved #team messages without ids get unique ids on restore, so their buttons and open state work', async ($, on) => {
  stubTeam(on, undefined, { get: true })
  on('store.get', (_, e) => ({ value: (e as { key: string }).key.startsWith('channel:') ? [
    { ts: 1, from: 'you', to: 'lead', text: 'first old message' },
    { ts: 2, from: 'lead', to: 'you', text: 'second old message' },
    { id: 0, ts: 3, from: 'you', to: 'lead', text: 'third old message' },
  ] : undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:chat' })
  const keys = await Promise.all(['first', 'second', 'third'].map(async w => ((await ui.find({ type: 'Button', text: new RegExp(`${w} old message`) })) as unknown as { key: string } | undefined)?.key))
  expect(keys.every(k => typeof k === 'string' && k.startsWith('msg:'))).toBe(true)
  expect(new Set(keys).size).toBe(3)
  await ui.unmount()
})

function twoTeams(on: Parameters<Parameters<typeof test>[1]>[1], hooks: { gateRegister?: Promise<void>; gateSend?: Promise<void> }) {
  const files: Record<string, string> = {
    '.claude/teams/dev-team.json': TEAM,
    '.claude/teams/docs.json': JSON.stringify({
      name: 'docs',
      members: [{ name: 'writer', role: 'Tech writer', emoji: 'W', model: 'haiku', effort: 'low', description: 'Docs', prompt: 'Write.' }],
    }),
  }
  const sets: [string, string][] = []
  on('fs.list', () => ({ value: Object.keys(files).map(f => ({ name: f.slice('.claude/teams/'.length), kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }))
  on('fs.read', (_, e) => {
    const text = Object.entries(files).find(([k]) => (e as { path: string }).path.endsWith(k))?.[1]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', async (_, e) => {
    if (e.name === 'writer') await hooks.gateRegister
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('command.register', () => ({ value: { command: 'team' } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => { sets.push([(e as { key: string }).key, JSON.stringify((e as { value: unknown }).value)]); return { value: undefined } })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'sonnet' }))
  on('session.send', async () => { await hooks.gateSend; return { isDelivered: true } })
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  return sets
}

test('queue: enqueue is refused while teams are switching', async ($, on) => {
  let open!: () => void
  const gateRegister = new Promise<void>(r => { open = r })
  twoTeams(on, { gateRegister })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'team', args: 'dev-team' } as never)
  const switching = $.command.run({ command: 'team', args: 'docs' } as never)
  await new Promise(r => setTimeout(r, 30))
  const res = await $.command.run({ command: 'team', args: 'queue writer a task' } as never)
  expect(String((res as { text: string }).text)).toContain('Switching teams')
  open()
  await switching
  const ok = await $.command.run({ command: 'team', args: 'queue writer a task' } as never)
  expect(String((ok as { text: string }).text)).toContain('Queued for writer')
})

test('queue: a dispatch pass in flight when the team switches does not write into the new team', async ($, on) => {
  let open!: () => void
  const gateSend = new Promise<void>(r => { open = r })
  const sets = twoTeams(on, { gateSend })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'team', args: 'dev-team' } as never)
  await readyBackend($)
  const pass = $.command.run({ command: 'team', args: 'queue backend old team task' } as never)
  await new Promise(r => setTimeout(r, 30))
  await $.command.run({ command: 'team', args: 'docs' } as never)
  open()
  await pass
  await new Promise(r => setTimeout(r, 30))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:queue' })
  expect((await ui.find({ type: 'Text', text: /No tasks/ })) !== undefined).toBe(true)
  expect(sets.some(([k, v]) => k === 'queue:/proj:docs' && v.includes('old team task'))).toBe(false)
  await ui.unmount()
})

const mem = (name: string, extra: Record<string, unknown> = {}) => ({ name, role: name.toUpperCase(), emoji: 'X', model: 'sonnet', effort: 'low', description: '', prompt: '', ...extra })
const LEAD = { name: 'lead', role: 'Lead', emoji: 'L', model: 'opus', effort: 'high', isLead: true, description: '', prompt: '' }

test('save_team accepts relations and rejects unknown, self, loop and lead relations', async ($, on) => {
  const written: Record<string, string> = {}
  const prompts: Record<string, string> = {}
  on('fs.list', () => ({
    value: [...new Set(Object.keys(written).map(f => f.slice('.claude/teams/'.length).split('/')[0]))]
      .map(n => ({ name: n, kind: 'dir', size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    const hit = Object.entries(written).find(([k]) => path.endsWith(k))?.[1]
    if (hit === undefined) throw new Error('ENOENT')
    return { value: hit }
  })
  on('fs.write', (_, e) => {
    const w = e as { path: string; text: string }
    written[w.path.slice(w.path.lastIndexOf('.claude/teams/'))] = w.text
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: Object.keys(written).some(k => (e as { path: string }).path.endsWith(k)) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('agent.register', (_, e) => {
    prompts[e.name] = String((e as { prompt?: string }).prompt)
    return { value: { agent: `team-chat:${e.name}` } }
  })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'team' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1 }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: JSON.stringify(e).includes('TEAM_CHAT') ? 'on' : undefined }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const base = { model: 'sonnet', effort: 'low', purpose: 'p' }
  const save = async (name: string, members: unknown[]) =>
    JSON.stringify(await $.tool.call({ tool: 'mcp__team-chat__save_team', name, members } as never))

  expect(await save('t-unknown', [{ name: 'a', role: 'A', ...base, handsTo: ['ghost'] }])).toContain('no such member')
  expect(await save('t-self', [{ name: 'a', role: 'A', ...base, reportsTo: 'a' }])).toContain('itself')
  expect(await save('t-loop', [
    { name: 'a', role: 'A', ...base, reportsTo: 'b' },
    { name: 'b', role: 'B', ...base, reportsTo: 'a' },
  ])).toContain('reportsTo loops: a → b → a')
  expect(Object.keys(written).length).toBe(0)

  const ok = await save('t-ok', [
    { name: 'A', role: 'A', ...base, handsTo: ['B', 'lead'] },
    { name: 'b', role: 'B', ...base, reportsTo: 'lead', handsTo: ['a'] },
    { name: 'c', role: 'C', ...base, reportsTo: 'a' },
  ])
  expect(ok).toContain('Saved team')
  const saved = JSON.parse(written['.claude/teams/t-ok/team.json'] ?? '{}')
  const by = (n: string) => saved.members.find((m: { name: string }) => m.name === n)
  expect(by('a').handsTo).toEqual(['b', 'lead'])
  expect('reportsTo' in by('b')).toBe(false)
  expect(by('c').reportsTo).toBe('a')
  expect(prompts.c).toContain('You answer to a; you may also message any teammate directly.')
  expect(prompts.a).toContain('your work goes to: b, lead')
  expect(prompts.a).toContain('You answer to lead')
})

test('a hand-edited bad file loads with the bad relations dropped; remove reparents and drops handoffs', async ($, on) => {
  const written: string[] = []
  const prompts: Record<string, string> = {}
  written.push(JSON.stringify({
    name: 'dev-team',
    members: [
      { ...LEAD, reportsTo: 'a', handsTo: ['a'] },
      mem('a', { reportsTo: 'b', handsTo: 'ghost, b, B' }),
      mem('b', { reportsTo: 'a', handsTo: ['a', 'c'] }),
      mem('c', { reportsTo: 'b' }),
      mem('d', { reportsTo: 'nobody' }),
    ],
  }))
  stubEngine(on, written, [], undefined, prompts)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The loop a <-> b is cut where it closes; an unknown boss falls back to the lead; the lead loses its relations.
  expect(prompts.d).toContain('You answer to lead')
  expect(prompts.a).toContain('your work goes to: b')
  expect(prompts.a).not.toContain('ghost')
  expect(prompts.a).toContain('You answer to b')
  expect(prompts.b).toContain('You answer to lead')
  expect(written.length).toBe(1) // loading never rewrites the file

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'card:b' })
  await ui.press({ key: 'edit:b' })
  await ui.press({ key: 'f:remove' })
  const saved = JSON.parse(written.at(-1) ?? '{}')
  const by = (n: string) => saved.members.find((m: { name: string }) => m.name === n)
  expect(by('b')).toBeUndefined()
  expect('reportsTo' in by('c')).toBe(false) // b answered to the lead, so c now does
  expect(by('a').handsTo ?? []).not.toContain('b')
  await ui.unmount()
})

test('Chain tab: a tree with connectors, role, model and handsTo arrows; the old Overview chain button is gone', async ($, on) => {
  const written: string[] = []
  written.push(JSON.stringify({ name: 'dev-team', members: [LEAD, mem('a', { handsTo: ['b'] }), mem('b', { reportsTo: 'a' }), mem('c')] }))
  stubEngine(on, written, [])
  on('store.set', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'chain' })).toBe(undefined)
  await ui.press({ key: 'tab:chain' })
  expect(["{ type: 'Text', text: /you/ }", (await ui.find({ type: 'Text', text: /you/ })) !== undefined]).toEqual(["{ type: 'Text', text: /you/ }", true])
  expect(["{ type: 'Text', text: /├─ / }", (await ui.find({ type: 'Text', text: /├─ / })) !== undefined]).toEqual(["{ type: 'Text', text: /├─ / }", true])
  expect(["{ type: 'Text', text: /└─ / }", (await ui.find({ type: 'Text', text: /└─ / })) !== undefined]).toEqual(["{ type: 'Text', text: /└─ / }", true])
  expect(["{ type: 'Text', text: /⇢ b/ }", (await ui.find({ type: 'Text', text: /⇢ b/ })) !== undefined]).toEqual(["{ type: 'Text', text: /⇢ b/ }", true])
  // Role and model share the middle column; "hands to" is a dim right-column header; the legend names the connectors.
  expect(["role · model", (await ui.find({ type: 'Text', text: /A · sonnet/ })) !== undefined]).toEqual(["role · model", true])
  expect(["hands to header", (await ui.find({ type: 'Text', text: /hands to/ })) !== undefined]).toEqual(["hands to header", true])
  expect(["legend", (await ui.find({ type: 'Text', text: /reports to/ })) !== undefined]).toEqual(["legend", true])
  expect(await ui.find({ key: 'card:a' })).toBe(undefined)
  await ui.unmount()
})

test('the lead prompt has a Chain block only when relations exist', async ($, on) => {
  const written: string[] = []
  stubEngine(on, written, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const none = JSON.stringify(await $.tool.call({ tool: 'mcp__team-chat__start_team', name: 'dev-team' } as never))
  expect(none).not.toContain('Chain (')
})

test('no sub-sub-agents: members are told never to use the Agent tool, the lead starts and relays, registered tools exclude Agent', async ($, on) => {
  const written: string[] = []
  const prompts: Record<string, string> = {}
  written.push(JSON.stringify({ name: 'dev-team', members: [LEAD, mem('a', { tools: ['Agent', 'Task', 'Read'] }), mem('b')] }))
  stubEngine(on, written, [], undefined, prompts)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(prompts.a).toContain('Never use the Agent tool')
  expect(prompts.b).toContain('ask the lead')
  expect(regTools.a).toContain('Read')
  expect(regTools.a).not.toContain('Agent')
  expect(regTools.a).not.toContain('Task')
  const lead = JSON.stringify(await $.tool.call({ tool: 'mcp__team-chat__start_team', name: 'dev-team' } as never))
  expect(lead).toContain('you relay every handoff')
  expect(lead).toContain('never start agents')
})

test('main: untargeted prompts go to the main member, @member still targets, a bad main is dropped on load', async ($, on) => {
  const written: string[] = []
  const prompts: Record<string, string> = {}
  written.push(JSON.stringify({ name: 'dev-team', main: 'Backend', members: [LEAD, mem('backend'), mem('other')] }))
  const spawned: string[] = []
  stubEngine(on, written, [], undefined, prompts)
  on('agent.spawn', (_, e) => {
    spawned.push(`${(e as { subagent_type?: string }).subagent_type ?? e.subagentType}|${e.prompt}`)
    return { agentId: 'b1', model: 'sonnet' }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: '' }))
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const plain = await $.prompt.submit({ text: 'plan the release' } as never)
  expect(String((plain as { drop?: string }).drop)).toContain('sent to backend (main)')
  const other = await $.prompt.submit({ text: '@other check it' } as never)
  expect(String((other as { drop?: string }).drop)).toContain('sent to other')
  expect(spawned).toEqual(['team-chat:backend|plan the release', 'team-chat:other|check it'])
  expect(written.length).toBe(1)
})

test('main: a bad main is dropped, no main keeps the old behaviour, save_team validates it', async ($, on) => {
  const written: string[] = []
  written.push(JSON.stringify({ name: 'dev-team', main: 'lead', members: [LEAD, mem('backend')] }))
  stubEngine(on, written, [])
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: false }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const plain = await $.prompt.submit({ text: 'plan the release' } as never)
  expect((plain as { text?: string }).text).toBe('plan the release')

  const bad = JSON.stringify(await $.tool.call({
    tool: 'mcp__team-chat__save_team', name: 'x1', main: 'ghost',
    members: [{ name: 'a', role: 'A', model: 'sonnet', effort: 'low', purpose: 'p' }],
  } as never))
  expect(bad).toContain('no such member')
  const lead = JSON.stringify(await $.tool.call({
    tool: 'mcp__team-chat__save_team', name: 'x2', main: 'lead',
    members: [{ name: 'a', role: 'A', model: 'sonnet', effort: 'low', purpose: 'p' }],
  } as never))
  expect(lead).toContain('lead cannot be main')
})

test('main: @lead goes to the lead, a dangling main is ignored, removing main clears it, null relations are unset, case is forgiven', async ($, on) => {
  const written: string[] = []
  written.push(JSON.stringify({ name: 'dev-team', main: 'ghost', members: [LEAD, mem('backend', { reportsTo: 'LEAD', handsTo: ['Other'] }), mem('Other')] }))
  stubEngine(on, written, [])
  const submitted: string[] = []
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: false }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // A main that names nobody is dropped on load: the prompt reaches the main session untouched.
  const plain = await $.prompt.submit({ text: 'plan it' } as never)
  expect((plain as { text?: string }).text).toBe('plan it')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'card:backend' })
  await ui.press({ key: 'edit:backend' })
  await ui.press({ key: 'f:save' })
  const saved = JSON.parse(written.at(-1) ?? '{}')
  expect('main' in saved).toBe(false)
  const be = saved.members.find((m: { name: string }) => m.name === 'backend')
  expect('reportsTo' in be).toBe(false) // "LEAD" is the lead
  expect(be.handsTo).toEqual(['Other']) // matched case-insensitively, stored as the real handle
  await ui.unmount()
})

test('main: @lead with a main set reaches the lead without the prefix; removing the main clears it; null means unset', async ($, on) => {
  const written: string[] = []
  written.push(JSON.stringify({ name: 'dev-team', main: 'backend', members: [LEAD, mem('backend'), mem('other')] }))
  stubEngine(on, written, [])
  on('agent.spawn', () => ({ agentId: 'b1', model: 'sonnet' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: false }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const toLead = await $.prompt.submit({ text: '@lead what is the state' } as never)
  expect((toLead as { text?: string }).text).toBe('what is the state')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'card:backend' })
  await ui.press({ key: 'edit:backend' })
  await ui.press({ key: 'f:remove' })
  expect('main' in JSON.parse(written.at(-1) ?? '{}')).toBe(false)
  await ui.unmount()

  const res = JSON.stringify(await $.tool.call({
    tool: 'mcp__team-chat__save_team', name: 'nulls', main: null,
    members: [{ name: 'a', role: 'A', model: 'sonnet', effort: 'low', purpose: 'p', reportsTo: null, handsTo: null }],
  } as never))
  expect(res).not.toContain('Error')
})

test('needs-help flag: set after a short delay on a permission ask, cleared by its own call or a poll; a held (waiting) agent is not flagged; resume clears', async ($, on) => {
  const ticks: (() => void)[] = []
  stubTeam(on, ticks)
  let status = 'running'
  const sent: string[] = []
  on('session.send', (_, e) => { sent.push(String((e as { text: string }).text)); return { isDelivered: true } })
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  on('agent.list', () => ({ value: [{ id: 'a1', status, description: '', type: 'team-chat:backend' }] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  const poll = async () => { for (const t of ticks) t(); await new Promise(r => setTimeout(r, 20)) }
  const shows = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const got = (await ui.find({ type: 'Text', text: re })) !== undefined
    await ui.unmount()
    return got
  }

  // The tool.check hook body is pure and tested directly (the harness skips the plugin's own hooks). Its flag is tied to the call.
  const flag = permissionFlag({ tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' }, { decision: 'ask' })
  expect(flag).toEqual({ status: 'human', reason: 'permission: Bash', flagSource: 'permission', flagCall: 'u1', flagTool: 'Bash' })
  expect(permissionFlag({ tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' }, { decision: 'allow' })).toBe(undefined)
  expect(permissionFlag({ tool: 'Bash' }, { decision: 'ask' })).toBe(undefined)
  const flagged = { status: 'human', steps: 0, recent: [], ...flag } as never
  // Another call ending keeps the flag; the same call ending (run or denied) clears it.
  expect((afterCall(flagged, { tool: 'Read', tool_use_id: 'u2' }) as { status: string }).status).toBe('human')
  expect((afterCall(flagged, { tool: 'Bash', tool_use_id: 'u1' }) as { status: string }).status).toBe('working')
  // Two different ids never clear each other, even for the same tool (parallel Bash calls).
  expect((afterCall({ ...(flagged as object), flagCall: 'u1', flagTool: 'Bash' } as never, { tool: 'Bash', tool_use_id: 'u2' }) as { status: string }).status).toBe('human')
  // A poll-set permission flag (no call) does not survive the next tool call; a call-bound one does.
  // A needs-you flag persists across any later call until the person responds, whatever its source.
  expect(keepsFlag({ status: 'human', flagSource: 'permission' } as never, false)).toBe(true)
  expect(keepsFlag({ status: 'human', flagSource: 'message' } as never, false)).toBe(false)
  expect(keepsFlag({ status: 'human', flagSource: 'message' } as never, true)).toBe(true)
  expect(keepsFlag({ status: 'working' } as never, false)).toBe(false)
  // The pending call itself starting keeps its prompt flag; any other step clears it.
  const pending = { status: 'human', flagSource: 'permission', flagCall: 'u1', flagTool: 'Bash' } as never
  expect(keepsFlag(pending, false, { tool: 'Bash', tool_use_id: 'u1' })).toBe(true)
  expect(keepsFlag(pending, false, { tool: 'Bash' })).toBe(true)
  expect(keepsFlag(pending, false, { tool: 'Bash', tool_use_id: 'u2' })).toBe(false)
  expect(keepsFlag(pending, false, { tool: 'Read', tool_use_id: 'u2' })).toBe(false)
  expect(keepsFlag(pending, false, { tool: 'Read' })).toBe(false)
  expect(keepsFlag({ status: 'waiting', flagSource: 'message' } as never, true)).toBe(true)
  expect(keepsFlag({ status: 'waiting', flagSource: 'message' } as never, false)).toBe(false)
  // The check had an id, the call has none (or another): the same tool still clears it.
  expect((afterCall(flagged, { tool: 'Bash' }) as { status: string }).status).toBe('working')

  // The engine's 'waiting' means held on background work, not a permission prompt: no flag, still working.
  status = 'waiting'
  await poll()
  await poll()
  expect(await shows(/needs you/)).toBe(false)
  expect(await shows(/working/)).toBe(true)
  // A real ask by the member stays through a 'waiting' poll.
  await $.session.send({ to: 'lead', text: 'NEEDS-HUMAN: may I drop it?', agentId: 'a1', origin: { kind: 'model' } } as never)
  await poll()
  expect(await shows(/needs you: may I drop it/)).toBe(true)

  // A message to the member (resume) clears it.
  await $.session.send({ to: 'backend', text: 'ok, go ahead', origin: { kind: 'user' } } as never).catch(() => undefined)
  expect(await shows(/needs you/)).toBe(false)
})

test('needs-help flag: BLOCKED in a mid-run SendMessage flags the member; its own SendMessage keeps it, the next other tool call clears it', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  const shows = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const got = (await ui.find({ type: 'Text', text: re })) !== undefined
    await ui.unmount()
    return got
  }

  await $.tool.call({ tool: 'SendMessage', agentId: 'a1' } as never)
  await $.session.send({ to: 'lead', text: 'BLOCKED: need the schema', agentId: 'a1', origin: { kind: 'model' } } as never)
  expect(await shows(/needs help: need the schema/)).toBe(true)
  await $.tool.call({ tool: 'SendMessage', agentId: 'a1' } as never)
  expect(await shows(/needs help: need the schema/)).toBe(true)
  await $.tool.call({ tool: 'Read', file_path: 'a', agentId: 'a1' } as never)
  expect(await shows(/needs help/)).toBe(false)

  await $.session.send({ to: 'lead', text: 'NEEDS-HUMAN: may I drop the table?', agentId: 'a1', origin: { kind: 'model' } } as never)
  expect(await shows(/needs you: may I drop the table/)).toBe(true)
})

test('marqueeSlice: static when it fits, pauses at the start, loops with a gap, stays width-safe for wide chars', () => {
  expect(marqueeSlice('short', 10, 99)).toBe('short')
  const t = 'abcdefghij klmnop'
  expect(marqueeSlice(t, 8, 0)).toBe('abcdefgh')
  expect(marqueeSlice(t, 8, 5)).toBe('abcdefgh')
  expect(marqueeSlice(t, 8, 8)).toBe('cdefghij')
  const period = t.length + 3 + 6
  expect(marqueeSlice(t, 8, period)).toBe('abcdefgh')
  for (let f = 0; f < 40; f++) {
    const s = marqueeSlice('日本語のテキスト👍 more', 7, f)
    expect([...s].reduce((a, c) => a + ((c.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0)).toBe(7)
  }
})

test('context row: bar text and width, narrow form, color thresholds, hidden without tokens, session.measure feeds the pane', async ($, on) => {
  expect(ctxBar({ tokens: 38000, window: 200000, percent: 19 }, 90)).toMatchObject({ text: '🧠 █▉░░░░░░░░ 19%', color: 'subtle' })
  expect(ctxBar({ tokens: 38000, window: 200000, percent: 19 }, 19)?.text).toBe('█▉░░░░░░░░')
  for (const c of [0, 55, 100]) expect([...(ctxBar({ tokens: 1, window: 100, percent: c }, 19)?.text ?? '')].length).toBe(10)
  expect(ctxBar({ tokens: 1, window: 100, percent: 69 }, 90)?.color).toBe('subtle')
  expect(ctxBar({ tokens: 1, window: 100, percent: 70 }, 90)?.color).toBe('warning')
  expect(ctxBar({ tokens: 1, window: 100, percent: 90 }, 90)?.color).toBe('warning')
  expect(ctxBar({ tokens: 1, window: 100, percent: 91 }, 90)?.color).toBe('error')
  expect(ctxBar({ window: 200000 }, 90)).toBe(undefined)

  stubTeam(on)
  on('session.measure', () => ({ changed: ['context'] }))
  const paneShows = async (re: RegExp, width?: number) => {
    const props = width ? { ...PANE.props, bodyColumns: width } : PANE.props
    const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop' } as never)
    const got = await ui.find({ type: 'Text', text: re })
    await ui.unmount()
    return got !== undefined
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await paneShows(/█|░/)).toBe(false)
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  expect(await paneShows(/█|░/)).toBe(false)
  await $.session.measure({ context: { tokens: 150000, window: 200000, percent: 75 }, rateLimits: [], changed: ['context'] } as never)
  expect(await paneShows(/🧠 ███████▌░░ 75%/)).toBe(true)
})

test('ctxBar limit parts: 5h and wk percent, hidden when missing, dropped at narrow widths, worst color wins', () => {
  const c = { tokens: 38000, window: 200000, percent: 19 }
  const rl = [{ kind: 'five_hour', percentUsed: 40.4 }, { kind: 'seven_day', percentUsed: 12 }]
  expect(ctxBar(c, 90, rl)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% · 📅 wk 12%')
  expect(ctxBar(c, 90, [rl[1]])?.text).toBe('🧠 █▉░░░░░░░░ 19% · 📅 wk 12%')
  expect(ctxBar(c, 90, [{ kind: 'spend_limit', percentUsed: 50 }])?.text).toBe('🧠 █▉░░░░░░░░ 19%')
  expect(ctxBar(c, 90, [])?.text).toBe('🧠 █▉░░░░░░░░ 19%')
  expect(ctxBar(c, 39, rl)?.text).toBe('🧠 █▉░░░░░░░░ 19%')
  expect(ctxBar(c, 19, rl)?.text).toBe('█▉░░░░░░░░')
  expect(ctxBar(c, 90, [{ kind: 'five_hour', percentUsed: 95 }])?.color).toBe('error')
  expect(ctxBar(c, 90, [{ kind: 'seven_day', percentUsed: 75 }])?.color).toBe('warning')
  expect(ctxBar(c, 39, [{ kind: 'five_hour', percentUsed: 95 }])?.color).toBe('subtle')
  expect(ctxBar(undefined, 90, rl)?.text).toBe('⏳ 5h 40% · 📅 wk 12%')
  expect(ctxBar(undefined, 90, [])).toBe(undefined)
})

test('5h reset countdown: shown after the 5h percent, hidden when missing, past or invalid', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const at = (m: number) => new Date(now + m * 60000).toISOString()
  const c = { tokens: 38000, window: 200000, percent: 19 }
  expect(ctxBar(c, 90, [{ kind: 'five_hour', percentUsed: 40, resetsAt: at(134) }, { kind: 'seven_day', percentUsed: 12, resetsAt: at(500) }], 0, now)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% ↻ 2h 14m · 📅 wk 12%')
  expect(ctxBar(c, 90, [{ kind: 'five_hour', percentUsed: 40, resetsAt: at(14) }], 0, now)?.text).toContain('5h 40% ↻ 14m')
  expect(ctxBar(c, 90, [{ kind: 'five_hour', percentUsed: 40 }], 0, now)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40%')
  expect(ctxBar(c, 90, [{ kind: 'five_hour', percentUsed: 40, resetsAt: 'nope' }], 0, now)?.text).toContain('5h 40%')
  expect(ctxBar(c, 59, [{ kind: 'five_hour', percentUsed: 40, resetsAt: at(134) }, { kind: 'seven_day', percentUsed: 12 }], 0, now)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% · 📅 wk 12%')
  expect(ctxBar(c, 60, [{ kind: 'five_hour', percentUsed: 40, resetsAt: at(134) }], 0, now)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% ↻ 2h 14m')
  expect(resetIn(at(-5), now)).toBe('')
  expect(resetIn(at(0.5), now)).toBe('1m')
  expect(resetIn(String(now / 1000 + 3600), now)).toBe('1h 0m')
  expect(resetIn(now / 1000 + 3600, now)).toBe('1h 0m')
  expect(resetIn(undefined, now)).toBe('')
})

test('usage row total: Σ crew tokens last, after the limits; hidden at 0 and under 40 columns', () => {
  const c = { tokens: 38000, window: 200000, percent: 19 }
  const rl = [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 12 }]
  expect(ctxBar(c, 90, rl, 42100)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% · 📅 wk 12% · Σ 42k')
  expect(ctxBar(c, 90, [], 42100)?.text).toBe('🧠 █▉░░░░░░░░ 19% · Σ 42k')
  expect(ctxBar(c, 90, rl, 0)?.text).toBe('🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% · 📅 wk 12%')
  expect(ctxBar(c, 39, rl, 42100)?.text).toBe('🧠 █▉░░░░░░░░ 19%')
  expect(ctxBar(undefined, 90, [], 1500)?.text).toBe('Σ 1.5k')
  expect(ctxBar(undefined, 90, [], 0)).toBe(undefined)
  expect(ctxBar(undefined, 39, [], 42100)).toBe(undefined)
  expect(ctxBar(c, 90, rl, 42100)?.color).toBe('subtle')
})

test('crew tokens sum each member: latest input plus output so far; members without stats add nothing', () => {
  const base = { status: 'idle', steps: 0, recent: [] } as const
  expect(crewTokens({})).toBe(0)
  expect(crewTokens({
    lead: { ...base, ctx: 38000, out: 4100 },
    backend: { ...base, out: 900 },
    qa: { ...base },
  })).toBe(43000)
})

test('context bar is the last row of the pane, with limits; narrow widths drop parts; the prompt hint has no tail', async ($, on) => {
  stubTeam(on)
  on('session.measure', () => ({ changed: ['context'] }))
  let tail: unknown = 'unset'
  on('ui.render', { component: 'PromptHint' }, ($, e) => { tail = (e as { props: { tail?: string } }).props.tail; const { Text } = $.ui.resolve(e as never); return (<Text>hint</Text>) as never })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.session.measure({ context: { tokens: 38000, window: 200000, percent: 19 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 12 }], changed: ['context', 'rateLimits'] } as never)
  await $.ui.mount(HINT)
  expect(tail).toBe(undefined)
  const shows = async (re: RegExp, width?: number) => {
    const props = width ? { ...PANE.props, bodyColumns: width } : PANE.props
    const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop' } as never)
    const got = await ui.find({ type: 'Text', text: re })
    await ui.unmount()
    return got !== undefined
  }
  expect(await shows(/🧠 █▉░░░░░░░░ 19% · ⏳ 5h 40% · 📅 wk 12%/)).toBe(true)
  expect(await shows(/🧠 █▉░░░░░░░░ 19%$/, 39)).toBe(true)
  expect(await shows(/5h/, 39)).toBe(false)
  expect(await shows(/^█▉░░░░░░░░$/, 19)).toBe(true)
})

test('a finished member is never flagged; a newer message from the member supersedes its blocked one', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  const shows = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const got = (await ui.find({ type: 'Text', text: re })) !== undefined
    await ui.unmount()
    return got
  }
  const say = (text: string) => $.session.send({ to: 'lead', text, agentId: 'a1', origin: { kind: 'model' } } as never)
  await $.turn.complete({ agentId: 'a1', answer: 'BLOCKED: I could not reach builder' } as never)
  expect(await shows(/needs help/)).toBe(false)

  await say('BLOCKED: I could not reach builder')
  expect(await shows(/needs help: I could not reach builder/)).toBe(true)
  await say('builder answered, continuing')
  expect(await shows(/needs help/)).toBe(false)

  await say('NEEDS-HUMAN: may I drop the table?')
  expect(await shows(/needs you: may I drop the table/)).toBe(true)
  await $.turn.complete({ agentId: 'a1', answer: 'finished' } as never)
  expect(await shows(/needs you/)).toBe(false)
})

test('permission flag by mode: bypass/dontAsk drop core asks, auto keeps only asks with a setting, hook asks always flag', () => {
  const e = { tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' }
  const hard = { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' }
  setPermissionMode('auto')
  expect(permissionFlag(e, { decision: 'ask' })).toBe(undefined)
  expect(permissionFlag(e, hard)?.status).toBe('human')
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    setPermissionMode(mode)
    expect(permissionFlag(e, { decision: 'ask' })).toBe(undefined)
    expect(permissionFlag(e, hard)).toBe(undefined)
    expect(permissionFlag(e, { decision: 'ask', plugin: 'x' })?.status).toBe('human')
  }
  setPermissionMode('default')
  expect(permissionFlag(e, { decision: 'ask' })?.status).toBe('human')
})

test('permissionSkip names why an ask raises no flag', () => {
  setPermissionMode('dontAsk')
  expect(permissionSkip({ agentId: 'a1' }, { decision: 'ask' })).toBe('mode')
  expect(permissionSkip({}, { decision: 'ask' })).toBe('no-agent')
  expect(permissionSkip({}, { decision: 'allow' })).toBe(undefined)
  setPermissionMode('default')
})

test('permission flag is delayed: it fires only if the same call is still pending, and a call start or end cancels it', async () => {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  const fired: string[] = []
  const ask = { tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' }
  // Still pending after the delay: flagged.
  schedulePermissionFlag(f => fired.push(String(f.reason)), ask, { decision: 'ask' }, 20)
  expect(fired).toEqual([])
  await wait(50)
  expect(fired).toEqual(['permission: Bash'])
  // The same call starts or ends before the delay (no prompt shown): never flagged.
  schedulePermissionFlag(f => fired.push('late'), ask, { decision: 'ask' }, 20)
  cancelPendingAsk({ tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' })
  // Id missing on the call: the tool name matches.
  schedulePermissionFlag(f => fired.push('late'), ask, { decision: 'ask' }, 20)
  cancelPendingAsk({ tool: 'Bash', agentId: 'a1' })
  // A different call (other id) does not cancel it.
  schedulePermissionFlag(f => fired.push('other'), ask, { decision: 'ask' }, 20)
  cancelPendingAsk({ tool: 'Bash', tool_use_id: 'u2', agentId: 'a1' })
  // A non-ask verdict schedules nothing.
  schedulePermissionFlag(f => fired.push('allow'), ask, { decision: 'allow' }, 20)
  await wait(50)
  expect(fired).toEqual(['permission: Bash', 'other'])
})

test('a permission flag clears when its call ends, when another step starts, or when the member finishes; the pending call keeps it', async ($, on) => {
  stubTeam(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  // The flag is set from the pure hook body (the harness does not run the plugin's own tool.check), tied to the call.
  const flagged = { status: 'human', steps: 0, recent: [], ...permissionFlag({ tool: 'Bash', tool_use_id: 'u1', agentId: 'a1' }, { decision: 'ask' }) } as never
  // Answered or denied: its own call ends.
  expect((afterCall(flagged, { tool: 'Bash', tool_use_id: 'u1' }) as { status: string; reason?: string }).status).toBe('working')
  expect((afterCall(flagged, { tool: 'Bash', tool_use_id: 'u1' }) as { reason?: string }).reason).toBe(undefined)
  // Next step starts (a different call): not kept. The same call starting (the prompt is open): kept.
  expect(keepsFlag(flagged, false, { tool: 'Read', tool_use_id: 'u2' })).toBe(false)
  expect(keepsFlag(flagged, false, { tool: 'Bash', tool_use_id: 'u1' })).toBe(true)
})

test('counts row shows only attention counts and is gone when there are none', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('turn.complete', (_, e) => ({ text: (e as { answer: string }).answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const shows = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const got = (await ui.find({ type: 'Text', text: re })) !== undefined
    await ui.unmount()
    return got
  }
  await $.agent.spawn({ name: 'backend', prompt: 'x' } as never).catch(() => undefined)
  expect(await shows(/\d+ working/)).toBe(false)
  expect(await shows(/all quiet/)).toBe(false)
})

test('usage row shows on an idle crew as soon as the pane loads, centered; /team on refills it', async ($, on) => {
  stubTeam(on)
  on('session.usage', () => ({ value: { context: { tokens: 100000, window: 200000, percent: 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 12 }] } }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /🧠 .* 50%/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /5h/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Box', key: 'usage', justifyContent: 'center' } as never)) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Box', key: 'usage-rule' } as never)) !== undefined).toBe(true)
  await ui.unmount()
})

test('team view is off by default; /team on persists it, /team off clears it, /team says how to turn it on', async ($, on) => {
  const stored: Record<string, unknown> = {}
  stubTeam(on, undefined, { store: true, get: true })
  on('store.get', (_, e) => ({ value: stored[(e as { key: string }).key] }))
  on('store.set', (_, e) => { stored[(e as { key: string }).key] = (e as { value: unknown }).value; return { value: undefined } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [] }))
  const closed: string[] = []
  on('ui.close', (_, e) => { closed.push((e as { id: string }).id); return { value: undefined } as never })
  const sections = async () => ((await $.prompt.compose({ promptModel: 'm', outputStyle: null, tools: [], traits: [], surfaces: [] } as never)) as { sections: { id: string }[] }).sections.map(s => s.id)
  // Env says on, but an explicit stored false wins: start with that.
  stored['isOn:/proj'] = false
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await sections()).not.toContain('team-chat-lead')
  expect(((await $.prompt.submit({ text: '@backend do it' } as never)) as { text?: string }).text).toBe('@backend do it')
  expect(String(((await $.command.run({ command: 'team', args: '' } as never)) as { text: string }).text)).toContain('/team on')
  expect(String(((await $.command.run({ command: 'team', args: 'list' } as never)) as { text: string }).text)).toContain('dev-team')

  await $.command.run({ command: 'team', args: 'on' } as never)
  expect(stored['isOn:/proj']).toBe(true)
  expect(await sections()).toContain('team-chat-lead')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await sections()).toContain('team-chat-lead')

  expect(closed).toEqual([])
  await $.command.run({ command: 'team', args: 'off' } as never)
  expect(closed).toEqual(['team-chat'])
  expect(stored['isOn:/proj']).toBe(false)
  expect(await sections()).not.toContain('team-chat-lead')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await sections()).not.toContain('team-chat-lead')
  // /team <name> turns it on again.
  await $.command.run({ command: 'team', args: 'dev-team' } as never)
  expect(stored['isOn:/proj']).toBe(true)
})

test('with no stored choice the view is off, unless TEAM_CHAT=on at launch', async ($, on) => {
  stubTeam(on)
  on('prompt.compose', () => ({ sections: [] }))
  const sections = async () => ((await $.prompt.compose({ promptModel: 'm', outputStyle: null, tools: [], traits: [], surfaces: [] } as never)) as { sections: { id: string }[] }).sections.map(s => s.id)
  // stubEngine answers TEAM_CHAT=on: the launch override turns it on with no stored flag.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await sections()).toContain('team-chat-lead')
})

test('overview bottom chat shows the 5 newest messages, newest last; long lines roll, short ones stay still', async ($, on) => {
  stubTeam(on)
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'team-chat:backend' })
  for (let n = 1; n <= 7; n++) await $.session.send({ to: 'backend', text: `short ${n}`, origin: { kind: 'model' } } as never)
  const long = 'a very long message that cannot possibly fit in a forty column wide side pane at all'
  await $.session.send({ to: 'backend', text: long, origin: { kind: 'model' } } as never)
  const props = { ...PANE.props, bodyColumns: 40, scroll: { offset: 0, bodyRows: 30 } }
  const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop' } as never)
  const has = async (re: RegExp) => (await ui.find({ type: 'Text', text: re })) !== undefined
  expect(await has(/short 7/)).toBe(true)
  expect(await has(/short 7/)).toBe(true)
  expect(await has(/short 4/)).toBe(true)
  expect(await has(/short 3/)).toBe(false)
  // The long line is cut to the pane (it rolls), never shown whole.
  expect(await has(new RegExp(long))).toBe(false)
  // ...but one row still carries a window of it, exactly as wide as what is left of the row (rolling).
  expect(await has(/→ backend · (?!short).{15}$/)).toBe(true)
  await ui.unmount()
})
