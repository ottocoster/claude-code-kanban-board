import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const pane = (bodyColumns: number) =>
  ({
    plugin: 'agent-board',
    component: 'Pane',
    requestId: 'agent-board',
    props: {
      title: 'Board',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

// The engine beneath the plugin: an in-memory repo at /repo.
function fakeEngine(on: On, files: Map<string, { text: string; mtimeMs: number }>) {
  let tick = 1
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'rm') files.delete(String(e.argv.at(-1)))
    return { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? '/repo\n' : '', stderr: '' } }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, { text: e.text, mtimeMs: tick++ })
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const f = files.get(e.path)
    if (!f) throw new Error('ENOENT ' + e.path)
    return { value: f.text }
  })
  on('fs.exists', (_, e) => ({
    value: files.has(e.path) || [...files.keys()].some(p => p.startsWith(e.path + '/')),
  }))
  on('fs.list', (_, e) => ({
    value: [...files.entries()]
      .filter(([p]) => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
      .map(([p, f]) => ({
        name: p.slice(e.path.length + 1),
        kind: 'file' as const,
        size: f.text.length,
        mtimeMs: f.mtimeMs,
        isLink: false,
      })),
  }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => { submitted.push(String(e.text)); return { value: {} } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return mock.clock(on)
}

const submitted: string[] = []
const text = (r: unknown) => String((r as { result?: unknown }).result)

test('agents create, move and comment on cards, saved as Markdown files', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const made = await $.tool.call({
    tool: 'mcp__agent-board__board_create',
    title: 'Add login page',
    description: 'Form with **email** and password.',
  })
  expect(text(made)).toContain('#1 [Backlog] Add login page')
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Write tests', column: 'todo' })

  await $.tool.call({ tool: 'mcp__agent-board__board_move', id: 1, column: 'waiting' })
  await $.tool.call({
    tool: 'mcp__agent-board__board_comment',
    id: 1,
    text: 'Which OAuth providers?\n### not a heading break',
    author: 'planner',
  })

  const file = files.get('/repo/.board/cards/1.md')?.text ?? ''
  expect(file).toContain('column: waiting')
  expect(file).toContain('**planner**')

  const got = text(await $.tool.call({ tool: 'mcp__agent-board__board_get', id: 1 }))
  expect(got).toContain('[Waiting for input]')
  expect(got).toContain('planner')
  expect(got).toContain('### not a heading break')
  expect(got).toContain('Form with **email** and password.')

  const listed = text(await $.tool.call({ tool: 'mcp__agent-board__board_list' }))
  expect(listed).toContain('To do:\n  #2 [To do] Write tests')
})

test('the pane shows columns, opens a card, and takes a comment', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Ship it', column: 'doing' })

  for (const width of [140, 40]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...pane(width), surface })
      expect(await ui.find({ type: 'Text', text: width >= 132 ? /Waiting for input/ : /Doing/ })).toBeDefined()
      expect(await ui.find({ key: 'card-1' })).toBeDefined()
      await ui.unmount()
    }
  }

  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.input({ key: 'new', text: 'From the user' })
  expect(files.get('/repo/.board/cards/2.md')?.text).toContain('author: "you"')

  await ui.press({ key: 'card-1' })
  expect(await ui.find({ type: 'Text', text: /^Ship it$/ })).toBeDefined()
  await ui.input({ key: 'comment', text: 'Looks good' })
  expect(files.get('/repo/.board/cards/1.md')?.text).toContain('Looks good')
  await ui.select({ key: 'move', value: 'reviewing' })
  expect(files.get('/repo/.board/cards/1.md')?.text).toContain('column: reviewing')
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'new' })).toBeDefined()
  await ui.unmount()
})

test('edits made outside Claude Code show up on the next poll', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const clock = fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Old title' })

  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  const path = '/repo/.board/cards/1.md'
  const before = files.get(path)?.text ?? ''
  files.set(path, { text: before.replace('"Old title"', '"Renamed by hand"'), mtimeMs: 999 })
  await clock.advance(3000)
  expect((await ui.find({ key: 'card-1' }))?.text).toContain('Renamed by hand')
  await ui.unmount()
})

test('the user picks an answer to a question card', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const asked = await $.tool.call({
    tool: 'mcp__agent-board__board_ask',
    title: 'Pick a database',
    question: 'Which database?',
    options: [
      { label: 'SQLite', description: 'Simple' },
      { label: 'Postgres', description: 'Scales' },
    ],
    recommended: 'Postgres',
  })
  expect(text(asked)).toContain('[Waiting for input]')
  expect(files.get('/repo/.board/cards/1.md')?.text).toContain('"recommended":"Postgres"')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(140), surface })
    expect(await ui.find({ type: 'Text', text: /❓ Which database/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.press({ key: 'card-1' })
  expect((await ui.find({ key: 'answer-1' }))?.text).toContain('recommended')
  await ui.press({ key: 'answer-1' })
  const file = files.get('/repo/.board/cards/1.md')?.text ?? ''
  expect(file).toContain('column: todo')
  expect(file).toContain('"answer":"Postgres"')
  expect(submitted.at(-1)).toContain('Answer: Postgres')
  expect(await ui.find({ key: 'answer-0' })).toBeUndefined()
  await ui.unmount()

  const got = text(await $.tool.call({ tool: 'mcp__agent-board__board_get', id: 1 }))
  expect(got).toContain('- Postgres (recommended): Scales')
  expect(got).toContain(': Postgres')
})

test('the narrow board puts what needs you first and folds Backlog away', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Someday' })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Blocked', column: 'waiting' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(50), surface })
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ key: 'card-2' })).toBeDefined()
    expect(await ui.find({ key: 'card-1' })).toBeUndefined()
    await ui.press({ key: 'toggle-backlog' })
    expect(await ui.find({ key: 'card-1' })).toBeDefined()
    await ui.press({ key: 'toggle-backlog' })
    await ui.unmount()
  }
})

test('the user deletes a card after confirming', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Keep me', column: 'todo' })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Delete me', column: 'todo' })

  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.press({ key: 'card-2' })
  await ui.press({ key: 'delete' })
  await ui.press({ key: 'cancel-delete' })
  expect(files.has('/repo/.board/cards/2.md')).toBe(true)

  await ui.press({ key: 'delete' })
  await ui.press({ key: 'confirm-delete' })
  expect(files.has('/repo/.board/cards/2.md')).toBe(false)
  expect(files.has('/repo/.board/cards/1.md')).toBe(true)
  expect(await ui.find({ key: 'card-2' })).toBeUndefined()
  expect(await ui.find({ key: 'card-1' })).toBeDefined()
  await ui.unmount()
})

test('adding a card unfolds Backlog so it shows', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...pane(50), surface: 'desktop' })
  expect(await ui.find({ key: 'card-1' })).toBeUndefined()
  await ui.input({ key: 'new', text: 'Fresh idea' })
  expect((await ui.find({ key: 'card-1' }))?.text).toContain('Fresh idea')
  expect((await ui.find({ key: 'toggle-backlog' }))?.text).toContain('▾')
  await ui.unmount()
})

test('hover chevrons move a card one column', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Step along', column: 'todo' })

  const ui = await $.ui.mount({ ...pane(140), surface: 'desktop' })
  await ui.press({ key: 'right-1' })
  expect(files.get('/repo/.board/cards/1.md')?.text).toContain('column: doing')
  await ui.press({ key: 'left-1' })
  await ui.press({ key: 'left-1' })
  expect(files.get('/repo/.board/cards/1.md')?.text).toContain('column: backlog')
  expect(await ui.find({ key: 'left-1' })).toBeUndefined()
  await ui.unmount()
})

test('in the side panel the chevrons point up and down', async ($, on) => {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  fakeEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__agent-board__board_create', title: 'Stacked', column: 'doing' })

  const ui = await $.ui.mount({ ...pane(50), surface: 'desktop' })
  expect((await ui.find({ key: 'left-1' }))?.text).toContain('▲')
  expect((await ui.find({ key: 'right-1' }))?.text).toContain('▼')
  await ui.press({ key: 'right-1' })
  expect(files.get('/repo/.board/cards/1.md')?.text).toContain('column: reviewing')
  await ui.unmount()
})
