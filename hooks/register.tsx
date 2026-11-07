import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Column, Comment, Question } from '../types'

type Engine = EngineInterface

const PANE = 'agent-board'
const CARDS_DIR = '.board/cards'
const POLL_MS = 3000

// Waiting for input comes first: it is what needs the user, so it sits where
// the eye starts. The rest is the flow of work, left to right.
const COLUMNS: { id: Column; label: string }[] = [
  { id: 'waiting', label: 'Waiting for input' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'done', label: 'Done' },
]
const COLUMN_IDS = COLUMNS.map(c => c.id)
// The flow the chevrons step through. Waiting is off to the side: a card
// goes there to ask, and leaves it for To do.
const FLOW = COLUMNS.filter(c => c.id !== 'waiting')
const labelOf = (column: Column) => COLUMNS.find(c => c.id === column)?.label ?? column

// What the pane draws from. Change the shape tag when Card's fields change.
const cards = atom({ plugin: 'agent-board', key: 'cards' } as const, [], {
  shape: 'cards-3',
})
// The card open in the detail view; 0 is the board itself.
const selected = atom({ plugin: 'agent-board', key: 'selected' } as const, 0)
// Absolute path of .board/cards in the repo; '' until the session has started.
const boardDir = atom({ plugin: 'agent-board', key: 'boardDir' } as const, '')
// The card whose Delete was pressed once and waits for confirmation; 0 is none.
const confirmDelete = atom({ plugin: 'agent-board', key: 'confirmDelete' } as const, 0)
// Columns folded open in the narrow layout (Backlog and Done start folded).
const expanded = atom({ plugin: 'agent-board', key: 'expanded' } as const, [] as string[])
// Last tool call per agent, so a tile can show who is working right now.
const activity = atom({ plugin: 'agent-board', key: 'activity' } as const, {} as Record<string, number>)
// Bumped on a timer so "5m ago" and idle states redraw.
const tick = atom({ plugin: 'agent-board', key: 'tick' } as const, 0)

// A claim lapses after this long without the holder doing anything, so a
// card held by an agent that died is never stuck.
const CLAIM_TTL_MS = 30 * 60_000
// Within this long of the holder's last tool call, the card shows as working.
const WORKING_MS = 2 * 60_000

// ---------------------------------------------------------------------------
// Card files: .board/cards/<id>.md, YAML-ish front matter, the description,
// then comments, each behind a marker line so free text can't break parsing.

const COMMENTS_MARK = '<!-- comments -->'
const COMMENT_RE = /<!-- comment at="([^"]*)" author="([^"]*)"(?: kind="([^"]*)")? -->\n/g

const clean = (s: string) => s.replace(/["\n\r]/g, ' ').trim()

function serialize(card: Card): string {
  const lines = [
    '---',
    `id: ${card.id}`,
    `title: ${JSON.stringify(card.title)}`,
    `column: ${card.column}`,
    `author: ${JSON.stringify(card.author)}`,
    `created: ${card.created}`,
    `updated: ${card.updated}`,
  ]
  if (card.holder) {
    lines.push(`holder: ${JSON.stringify(card.holder)}`, `assignee: ${JSON.stringify(card.assignee)}`, `claimed: ${card.claimedAt}`)
  }
  // One line of JSON, so the front matter stays one key per line.
  if (card.question) lines.push(`question: ${JSON.stringify(card.question)}`)
  lines.push('---', '')
  let text = lines.join('\n')
  if (card.description.trim()) text += card.description.trim() + '\n'
  if (card.comments.length > 0) {
    text += `\n${COMMENTS_MARK}\n## Comments\n`
    for (const c of card.comments) {
      const at = clean(c.at)
      const author = clean(c.author)
      const kind = c.kind ? ` kind="${c.kind}"` : ''
      const tag = c.kind === 'handoff' ? ' · handoff' : ''
      text += `\n<!-- comment at="${at}" author="${author}"${kind} -->\n**${author}**${tag} · ${at}\n\n${c.text.trim()}\n`
    }
  }
  return text
}

function parse(text: string): Card | undefined {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!fm) return undefined
  const meta: Record<string, string> = {}
  for (const line of (fm[1] ?? '').split('\n')) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (key === 'question') {
      meta[key] = value
      continue
    }
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    }
    meta[key] = value
  }
  const id = Number(meta.id)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const column = asColumn(meta.column) ?? 'backlog'

  const rest = text.slice(fm[0].length)
  const mark = rest.indexOf(COMMENTS_MARK)
  const description = (mark < 0 ? rest : rest.slice(0, mark)).trim()
  const comments: Comment[] = []
  if (mark >= 0) {
    const tail = rest.slice(mark)
    const heads = [...tail.matchAll(COMMENT_RE)]
    heads.forEach((m, i) => {
      const start = (m.index ?? 0) + m[0].length
      const end = heads[i + 1]?.index ?? tail.length
      // Drop the "**author** · date" line drawn for human readers.
      const body = tail.slice(start, end).replace(/^\*\*[^\n]*\n/, '').trim()
      comments.push({ at: m[1] ?? '', author: m[2] ?? '', text: body, ...(m[3] === 'handoff' ? { kind: 'handoff' as const } : {}) })
    })
  }
  return {
    id,
    title: meta.title ?? `Card ${id}`,
    column,
    description,
    author: meta.author ?? '',
    created: meta.created ?? '',
    updated: meta.updated ?? '',
    comments,
    holder: meta.holder ?? '',
    assignee: meta.assignee ?? '',
    claimedAt: meta.claimed ?? '',
    ...(meta.question ? { question: parseQuestion(meta.question) } : {}),
  }
}

function parseQuestion(raw: string): Question | undefined {
  try {
    const q = JSON.parse(raw) as Partial<Question>
    if (typeof q.text !== 'string' || !Array.isArray(q.options)) return undefined
    return {
      text: q.text,
      options: q.options
        .filter(o => o && typeof o.label === 'string')
        .map(o => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
      recommended: typeof q.recommended === 'string' ? q.recommended : '',
      answer: typeof q.answer === 'string' ? q.answer : '',
      answeredAt: typeof q.answeredAt === 'string' ? q.answeredAt : '',
    }
  } catch {
    return undefined
  }
}

// Parsed files by name, kept while the file's mtime is unchanged.
const cache = new Map<string, { mtimeMs: number; card: Card | undefined }>()

async function loadCards($: Engine): Promise<Card[]> {
  const dir = await currentBoardDir($)
  if (!dir || !(await $.fs.exists(dir))) return []
  const entries = await $.fs.list(dir)
  const out: Card[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    seen.add(entry.name)
    let hit = cache.get(entry.name)
    if (!hit || hit.mtimeMs !== entry.mtimeMs) {
      const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')
      hit = { mtimeMs: entry.mtimeMs, card: parse(text) }
      cache.set(entry.name, hit)
    }
    if (hit.card) out.push(hit.card)
  }
  for (const name of [...cache.keys()]) if (!seen.has(name)) cache.delete(name)
  return out.sort((a, b) => a.id - b.id)
}

async function refresh($: Engine): Promise<Card[]> {
  const list = await loadCards($)
  const before = await read($, cards)
  if (JSON.stringify(before) !== JSON.stringify(list)) await update($, cards, () => list)
  return list
}

// Writes go one at a time, so two subagents creating cards at once get
// different ids.
let queue: Promise<unknown> = Promise.resolve()
function locked<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

async function saveCard($: Engine, card: Card): Promise<void> {
  const dir = await currentBoardDir($)
  await $.fs.write(`${dir}/${card.id}.md`, serialize(card))
}

async function createCard(
  $: Engine,
  input: { title: string; description?: string; column?: Column; author: string },
): Promise<Card> {
  return locked(async () => {
    const list = await loadCards($)
    const id = list.reduce((max, c) => Math.max(max, c.id), 0) + 1
    const card: Card = {
      id,
      title: input.title.trim() || `Card ${id}`,
      column: input.column ?? 'backlog',
      description: input.description ?? '',
      author: input.author,
      created: now(),
      updated: now(),
      comments: [],
      holder: '',
      assignee: '',
      claimedAt: '',
    }
    await saveCard($, card)
    await refresh($)
    return card
  })
}

async function changeCard(
  $: Engine,
  id: number,
  change: (card: Card) => Card,
): Promise<Card | undefined> {
  return locked(async () => {
    const card = (await loadCards($)).find(c => c.id === id)
    if (!card) return undefined
    const next = { ...change(card), updated: now() }
    await saveCard($, next)
    await refresh($)
    return next
  })
}

// Who acts: an agent (its holder id and display name), or the user in the pane.
type Actor = { holder: string; name: string }
const unclaimed = { holder: '', assignee: '', claimedAt: '' }

// Moving into Doing claims the card for the agent that moves it; moving it
// anywhere else lets go, so the next agent (a reviewer, say) can take it.
// A summary is saved as a handoff comment in the same write.
async function moveCard(
  $: Engine,
  id: number,
  column: Column,
  opts: { by?: Actor; summary?: string } = {},
): Promise<Card | undefined> {
  const { by, summary } = opts
  let released = ''
  const card = await changeCard($, id, c => {
    const comments = summary?.trim()
      ? [...c.comments, { at: now(), author: by?.name ?? 'you', text: summary.trim(), kind: 'handoff' as const }]
      : c.comments
    let claim = { holder: c.holder, assignee: c.assignee, claimedAt: c.claimedAt }
    if (column === 'doing' && by && c.holder !== by.holder) claim = { holder: by.holder, assignee: by.name, claimedAt: now() }
    if (column !== 'doing') {
      if (c.holder && !by && isLive(c)) released = c.assignee
      claim = unclaimed
    }
    return { ...c, column, comments, ...claim }
  })
  if (card && released) $.ui.toast(`Released ${released}'s claim on #${card.id}`)
  if (card && column === 'waiting') {
    $.ui.toast(`#${card.id} is waiting for your input: ${card.title}`)
    // Not every host has native notifications (the desktop app answers no-surface).
    try {
      void $.ui.notify(`#${card.id} needs your input: ${card.title}`).catch(() => undefined)
    } catch {
      // No notify on this host: the toast is enough.
    }
  }
  return card
}

async function addComment(
  $: Engine,
  id: number,
  author: string,
  text: string,
): Promise<Card | undefined> {
  return changeCard($, id, c => ({
    ...c,
    comments: [...c.comments, { at: now(), author, text: text.trim() }],
  }))
}

// Tick or untick one checklist item (0-based) by rewriting its line.
async function checkTask($: Engine, id: number, index: number, done: boolean): Promise<Card | undefined> {
  return changeCard($, id, c => ({ ...c, description: setTask(c.description, index, done) }))
}

async function askQuestion(
  $: Engine,
  input: { id?: number; title?: string; description?: string; question: Question; author: string; by?: Actor },
): Promise<Card | undefined> {
  let id = input.id
  if (id === undefined) {
    const made = await createCard($, {
      title: input.title || input.question.text,
      description: input.description ?? '',
      column: 'waiting',
      author: input.author,
    })
    id = made.id
  }
  const card = await changeCard($, id, c => ({ ...c, question: input.question }))
  if (card) await moveCard($, card.id, 'waiting', { by: input.by })
  return card
}

// Colors for graphical surfaces: white cards on a tinted pane. Picked from
// the user's Claude Code theme when the session starts.
type Palette = { pane: string; card: string; edge: string; waiting: string; waitingEdge: string }
const LIGHT: Palette = { pane: '#f1f1ee', card: '#ffffff', edge: '#e4e4df', waiting: '#fff4e2', waitingEdge: '#f3d7a6' }
const DARK: Palette = { pane: '#1b1b1d', card: '#2b2b2e', edge: '#3a3a3e', waiting: '#3b2c1a', waitingEdge: '#6b4d22' }
let palette: Palette = LIGHT

async function pickPalette($: Engine): Promise<void> {
  try {
    const theme = await $.settings.read({ key: 'theme' })
    palette = typeof theme === 'string' && theme.includes('dark') ? DARK : LIGHT
  } catch {
    palette = LIGHT
  }
}

function openPane($: Engine) {
  return $.ui.open({ id: PANE, title: 'Board', backgroundColor: palette.pane })
}

function ago(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const isOpenQuestion = (card: Card) => !!card.question && !card.question.answer

// The user picked an answer in the pane: record it, put the card back in
// To do, and tell Claude so the work goes on.
async function answerQuestion($: Engine, id: number, answer: string): Promise<void> {
  const text = answer.trim()
  if (!text) return
  const card = await changeCard($, id, c =>
    c.question
      ? {
          ...c,
          column: 'todo',
          question: { ...c.question, answer: text, answeredAt: now() },
          comments: [...c.comments, { at: now(), author: 'you', text: `Answered: ${text}` }],
        }
      : c,
  )
  if (!card?.question) return
  void $.prompt.submit({
    text:
      `I answered the question on board card #${card.id} ("${card.title}").\n` +
      `Question: ${card.question.text}\nAnswer: ${text}\n` +
      'The card is back in To do. Please continue with it (board_get has the details).',
  }).catch(() => undefined)
}

// $.fs has no delete, so the file goes with rm. The path is built from the
// board folder and a numeric id only.
async function deleteCard($: Engine, id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false
  return locked(async () => {
    const dir = await currentBoardDir($)
    const name = `${id}.md`
    if (!dir || !(await $.fs.exists(`${dir}/${name}`))) return false
    const rm = await $.process.run(['rm', '-f', '--', `${dir}/${name}`])
    cache.delete(name)
    await refresh($)
    return rm.exitCode === 0
  })
}

// The session root the board folder was last resolved from. The root can move
// after session.start (a host directory change, /cd, a worktree move), so the
// folder is resolved again whenever it differs.
let resolvedRoot = ''

async function currentBoardDir($: Engine): Promise<string> {
  const root = await $.session.root()
  const dir = await read($, boardDir)
  if (dir && root === resolvedRoot) return dir
  const next = await findBoardDir($, root)
  resolvedRoot = root
  if (next !== dir) await update($, boardDir, () => next)
  return next
}

async function findBoardDir($: Engine, root: string): Promise<string> {
  try {
    const git = await $.process.run(['git', '-C', root, 'rev-parse', '--show-toplevel'])
    if (git.exitCode === 0 && git.stdout.trim()) return `${git.stdout.trim()}/${CARDS_DIR}`
  } catch {
    // No git: fall back to the session's root.
  }
  return `${root}/${CARDS_DIR}`
}

// ---------------------------------------------------------------------------
// Checklist: the Markdown task items (`- [ ] …`, `- [x] …`) in a card's
// description. They stay in the description, so the file is plain Markdown
// and a hand edit is a tick too; ticking rewrites that one line.

const TASK_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/
type Task = { text: string; done: boolean; line: number }

function tasksOf(description: string): Task[] {
  const out: Task[] = []
  let inFence = false
  description.split('\n').forEach((text, line) => {
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence
    const m = inFence ? null : TASK_RE.exec(text)
    if (m) out.push({ text: (m[4] ?? '').trim(), done: m[2] !== ' ', line })
  })
  return out
}

function setTask(description: string, index: number, done: boolean): string {
  const task = tasksOf(description)[index]
  if (!task) return description
  const lines = description.split('\n')
  lines[task.line] = (lines[task.line] ?? '').replace(TASK_RE, (_, open, _mark, close, rest) => `${open}${done ? 'x' : ' '}${close}${rest}`)
  return lines.join('\n')
}

// The description with its task lines taken out: the card view draws those
// as checkboxes of their own.
function withoutTasks(description: string): string {
  const lines = description.split('\n')
  const drop = new Set(tasksOf(description).map(t => t.line))
  return lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function progressOf(card: Card): { done: number; total: number } {
  const tasks = tasksOf(card.description)
  return { done: tasks.filter(t => t.done).length, total: tasks.length }
}

// Which task an agent means: its 1-based number, or (part of) its text.
function findTask(tasks: Task[], item: unknown): number {
  if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item.trim()))) {
    const n = Number(item) - 1
    return n >= 0 && n < tasks.length ? n : -1
  }
  if (typeof item !== 'string' || !item.trim()) return -1
  const want = item.trim().toLowerCase()
  const exact = tasks.findIndex(t => t.text.toLowerCase() === want)
  return exact >= 0 ? exact : tasks.findIndex(t => t.text.toLowerCase().includes(want))
}

const checklistLines = (tasks: Task[]) => tasks.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`)

// ---------------------------------------------------------------------------
// Text the model reads back from the tools.

function summary(card: Card): string {
  const n = card.comments.length
  const q = isOpenQuestion(card) ? ' (question open)' : ''
  const by = isLive(card) ? ` (claimed by ${card.assignee})` : ''
  const p = progressOf(card)
  const checked = p.total ? ` (${p.done}/${p.total} checked)` : ''
  return `#${card.id} [${labelOf(card.column)}] ${card.title}${n ? ` (${n} comment${n === 1 ? '' : 's'})` : ''}${checked}${q}${by}`
}

function full(card: Card): string {
  const parts = [
    summary(card),
    `Created ${card.created} by ${card.author || 'unknown'}; updated ${card.updated}`,
    ...(isLive(card) ? [`Claimed by ${card.assignee} since ${card.claimedAt}; last active ${lastActiveAgo(card)}`] : []),
    '',
    card.description || '(no description)',
  ]
  const tasks = tasksOf(card.description)
  if (tasks.length > 0) {
    const p = progressOf(card)
    parts.push('', `Checklist (${p.done}/${p.total} done; tick items with board_check):`, ...checklistLines(tasks))
  }
  if (card.question) {
    const q = card.question
    parts.push('', `Question: ${q.text}`)
    for (const o of q.options)
      parts.push(`- ${o.label}${o.label === q.recommended ? ' (recommended)' : ''}${o.description ? `: ${o.description}` : ''}`)
    parts.push(q.answer ? `Answered ${q.answeredAt}: ${q.answer}` : 'Not answered yet.')
  }
  if (card.comments.length > 0) {
    parts.push('', 'Comments:')
    for (const c of card.comments) parts.push(`- ${c.author}${c.kind === 'handoff' ? ' (handoff)' : ''} at ${c.at}: ${c.text}`)
  }
  return parts.join('\n')
}

function authorOf(e: { agentId?: string; author?: unknown }): string {
  if (typeof e.author === 'string' && e.author.trim()) return clean(e.author).slice(0, 60)
  return e.agentId ? `subagent ${e.agentId.slice(0, 8)}` : 'claude'
}

// ---------------------------------------------------------------------------
// Claims: one agent per card. The holder is the agent's loop id ('main' for
// the main loop), so a subagent can't take over by signing another name.

// When each agent last made a tool call: module memory, refilled as agents work.
const lastSeen = new Map<string, number>()
const holderOf = (e: { agentId?: string }) => e.agentId ?? 'main'
const actorOf = (e: { agentId?: string; author?: unknown }): Actor => ({ holder: holderOf(e), name: authorOf(e) })

const lastActive = (card: Card) => Math.max(lastSeen.get(card.holder) ?? 0, Date.parse(card.claimedAt) || 0)
const isLive = (card: Card) => !!card.holder && Date.now() - lastActive(card) < CLAIM_TTL_MS
const isWorking = (card: Card) => !!card.holder && Date.now() - lastActive(card) < WORKING_MS
const lastActiveAgo = (card: Card) => ago(new Date(lastActive(card)).toISOString())

function touch($: Engine, holder: string) {
  const t = Date.now()
  const before = lastSeen.get(holder) ?? 0
  lastSeen.set(holder, t)
  // Redraw only when it shows: the dot lights up, or at most every 30 s.
  if (t - before > 30_000) void update($, activity, a => ({ ...a, [holder]: t }))
}

// The refusal an agent gets for touching a card someone else holds.
function heldByOther(card: Card, by: Actor): string | undefined {
  if (!isLive(card) || card.holder === by.holder) return undefined
  const state = isWorking(card) ? 'working on it now' : `last active ${lastActiveAgo(card)}`
  return (
    `Refused: #${card.id} is claimed by ${card.assignee} (${state}). Only its holder or the user can move or edit it. ` +
    'Take another card with board_next, or leave a board_comment on this one.'
  )
}

function refuseClaim(card: Card, by: Actor): string | undefined {
  const held = heldByOther(card, by)
  if (held) return held
  if (card.column === 'done') return `Refused: #${card.id} is already done.`
  if (isOpenQuestion(card)) return `Refused: #${card.id} is waiting for the user's answer to: ${card.question?.text ?? ''}`
  return undefined
}

const claimed = (card: Card, by: Actor): Card => ({
  ...card,
  holder: by.holder,
  assignee: by.name,
  claimedAt: now(),
  updated: now(),
  column: card.column === 'backlog' || card.column === 'todo' || card.column === 'waiting' ? 'doing' : card.column,
})

async function claimCard($: Engine, id: number, by: Actor): Promise<{ card?: Card; error?: string }> {
  return locked(async () => {
    const card = (await loadCards($)).find(c => c.id === id)
    if (!card) return { error: `No card #${id}.` }
    const error = refuseClaim(card, by)
    if (error) return { error }
    const next = claimed(card, by)
    await saveCard($, next)
    await refresh($)
    return { card: next }
  })
}

// Picks and claims in one locked step, so two agents asking at once never get
// the same card.
async function claimNext($: Engine, by: Actor): Promise<{ card?: Card; error?: string }> {
  return locked(async () => {
    const list = await loadCards($)
    const mine = list.find(c => c.holder === by.holder && isLive(c) && c.column !== 'done')
    if (mine) {
      return {
        error:
          `You already hold #${mine.id} (${labelOf(mine.column)}): ${mine.title}. Finish it first ` +
          '(board_move to reviewing or done, with a summary), or give it back with board_release.',
      }
    }
    const card = list.find(c => c.column === 'todo' && !isLive(c) && !isOpenQuestion(c))
    if (!card) {
      const backlog = list.filter(c => c.column === 'backlog').length
      return { error: `Nothing in To do to pick up.${backlog ? ` Backlog has ${backlog}; ask the user which to move to To do.` : ''}` }
    }
    const next = claimed(card, by)
    await saveCard($, next)
    await refresh($)
    return { card: next }
  })
}

// by: the agent asking (refused for a card someone else holds); absent: the user.
async function releaseCard($: Engine, id: number, by?: Actor): Promise<{ card?: Card; error?: string }> {
  return locked(async () => {
    const card = (await loadCards($)).find(c => c.id === id)
    if (!card) return { error: `No card #${id}.` }
    const held = by && heldByOther(card, by)
    if (held) return { error: held }
    const next = { ...card, ...unclaimed, updated: now() }
    await saveCard($, next)
    await refresh($)
    return { card: next }
  })
}

// A subagent that ends while holding cards: put them back in To do with a
// note, so nothing sits in Doing with nobody on it.
async function releaseAbandoned($: Engine, holder: string): Promise<void> {
  await locked(async () => {
    const held = (await loadCards($)).filter(c => c.holder === holder)
    for (const card of held) {
      await saveCard($, {
        ...card,
        ...unclaimed,
        column: card.column === 'doing' ? 'todo' : card.column,
        updated: now(),
        comments: [
          ...card.comments,
          {
            at: now(),
            author: 'board',
            text: `Released automatically: ${card.assignee} finished without handing this card off.${card.column === 'doing' ? ' Moved back to To do.' : ''}`,
          },
        ],
      })
    }
    if (held.length > 0) await refresh($)
  })
}

const asColumn = (value: unknown): Column | undefined =>
  (COLUMN_IDS as unknown[]).includes(value) ? (value as Column) : undefined

const COLUMN_SCHEMA = { type: 'string', enum: COLUMN_IDS }
const AUTHOR_SCHEMA = {
  type: 'string',
  description: 'Optional name to sign with, such as your role ("reviewer"). Defaults to claude or the subagent id.',
}
const BOARD_NOTE =
  'The board is shared by the user, the main Claude and every subagent, and is saved as Markdown files in the repo under .board/cards/. ' +
  'Columns: backlog, todo, doing, reviewing, done, waiting (waiting = waiting for input from the user). ' +
  'Before working on a card, take one with board_next (or board_claim a specific one): it moves to doing and only you can move or edit it. ' +
  'Moving to reviewing or done needs a summary, which hands the card off and releases it. ' +
  "A card's `- [ ]` lines are its acceptance criteria: tick each with board_check once you have verified it."

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    resolvedRoot = ''
    const dir = await currentBoardDir($)
    await refresh($)

    await $.tool.register({
      name: 'board_list',
      description:
        `List the cards on the project's Kanban board (id, column, title). ${BOARD_NOTE} ` +
        'Check the board when starting work, and keep it current: take a card with board_next, move it to reviewing (with a summary) when it needs review, use board_ask when you need the user, and move it to done (with a summary) when finished.',
      inputSchema: {
        type: 'object',
        properties: { column: { ...COLUMN_SCHEMA, description: 'Only list this column' } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_get',
      description: 'Read one board card in full: description and all comments.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_create',
      description: `Create a card on the Kanban board. ${BOARD_NOTE} New cards go to backlog unless a column is given.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string', description: 'Markdown body of the card' },
          column: COLUMN_SCHEMA,
          author: AUTHOR_SCHEMA,
        },
        required: ['title'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_move',
      description:
        'Move a board card to another column. Moving to "doing" claims it for you; moving anywhere else releases it. ' +
        'Moving to "reviewing" or "done" requires a summary. To ask the user something, use board_ask rather than moving to "waiting".',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          column: COLUMN_SCHEMA,
          summary: {
            type: 'string',
            description:
              'Required for reviewing and done: the handoff. What changed, where (files, branch), and how to check it.',
          },
        },
        required: ['id', 'column'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_comment',
      description: 'Add a comment to a board card: progress notes, findings, review remarks, or questions for the user.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, text: { type: 'string' }, author: AUTHOR_SCHEMA },
        required: ['id', 'text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_ask',
      description:
        'Ask the user a multiple-choice question on a board card. The card moves to "waiting" and the user picks an answer (or types their own) in the board pane; ' +
        'their answer then arrives as a message and the card returns to "todo". Give an existing card id, or a title to create a new card. ' +
        'Offer 2-5 options, each with a short description of its trade-off, and name the one you recommend.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Existing card to ask on' },
          title: { type: 'string', description: 'Title for a new card, when no id is given' },
          description: { type: 'string', description: 'Context for a new card (Markdown)' },
          question: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label'],
            },
          },
          recommended: { type: 'string', description: 'The label of the option you recommend' },
          author: AUTHOR_SCHEMA,
        },
        required: ['question', 'options'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_update',
      description: "Change a board card's title or description.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string' } },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_check',
      description:
        "Tick (or untick) an item on a card's acceptance-criteria checklist: the Markdown task lines (`- [ ] …`) in its description. " +
        'board_get lists them numbered. Tick an item only once you have verified it holds. ' +
        'To add items, put `- [ ] …` lines in the description with board_update.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          item: {
            type: ['integer', 'string'],
            description: "The item's number as board_get lists it (1 is the first), or its text",
          },
          done: { type: 'boolean', description: 'true ticks the item (the default), false unticks it' },
        },
        required: ['id', 'item'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_next',
      description:
        'Take the next card to work on: the first unclaimed card in To do. It is claimed for you and moved to doing in one step, ' +
        'so two agents never get the same card. Refused while you already hold an unfinished card. Returns the card in full.',
      inputSchema: { type: 'object', properties: { author: AUTHOR_SCHEMA } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_claim',
      description:
        'Claim a specific card to work on it (backlog, todo and waiting cards move to doing). Refused if another agent holds it, ' +
        'it is done, or it waits for the user\'s answer. A claim lapses after 30 minutes without activity.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, author: AUTHOR_SCHEMA },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_release',
      description: 'Give back a card you hold without finishing it, so another agent can take it. Say why in a board_comment.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      isDeferred: false,
    })

    $.clock.every(POLL_MS, async () => {
      await refresh($)
    })
    $.clock.every(30_000, async () => {
      await update($, tick, n => n + 1)
    })

    await pickPalette($)
    if (await $.fs.exists(dir)) void openPane($)

    try {
      await $.command.register({
        name: 'board',
        description: 'Open the Kanban board pane',
        immediate: true,
      })
    } catch {
      // Name taken: the tools still work.
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await refresh($)
    await openPane($)
    return {}
  })

  // Every tool call, ours or not, counts as the agent being active.
  on('tool.call', async ($, e, next) => {
    touch($, holderOf(e))
    return next(e)
  })

  // A subagent's turn ending is the subagent ending: free what it still holds.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) await releaseAbandoned($, e.agentId)
    return result
  })

  // ---- Tools ---------------------------------------------------------------

  on('tool.call', { tool: 'mcp__agent-board__board_list' }, async ($, e) => {
    const column = asColumn(e.column)
    const list = (await refresh($)).filter(c => !column || c.column === column)
    if (list.length === 0) return { result: column ? `No cards in ${labelOf(column)}.` : 'The board is empty.' }
    const lines: string[] = []
    for (const col of COLUMNS) {
      const inCol = list.filter(c => c.column === col.id)
      if (inCol.length === 0) continue
      lines.push(`${col.label}:`, ...inCol.map(c => '  ' + summary(c)))
    }
    return { result: lines.join('\n') }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_get' }, async ($, e) => {
    const card = (await refresh($)).find(c => c.id === Number(e.id))
    return { result: card ? full(card) : `No card #${String(e.id)}.` }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_create' }, async ($, e) => {
    if (typeof e.title !== 'string' || !e.title.trim()) return { result: 'A title is required.' }
    const card = await createCard($, {
      title: e.title,
      description: typeof e.description === 'string' ? e.description : '',
      column: asColumn(e.column),
      author: authorOf(e),
    })
    return { result: `Created ${summary(card)}` }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_move' }, async ($, e) => {
    const by = actorOf(e)
    touch($, by.holder)
    const column = asColumn(e.column)
    if (!column) return { result: `Unknown column. Use one of: ${COLUMN_IDS.join(', ')}.` }
    const before = (await loadCards($)).find(c => c.id === Number(e.id))
    if (!before) return { result: `No card #${String(e.id)}.` }
    const held = heldByOther(before, by)
    if (held) return { result: held }
    const handoff = typeof e.summary === 'string' ? e.summary.trim() : ''
    if ((column === 'reviewing' || column === 'done') && !handoff) {
      return {
        result:
          `Refused: moving #${before.id} to ${labelOf(column)} needs a summary. Call board_move again with summary: ` +
          'what changed, where (files, branch), and how to check it.',
      }
    }
    if (column === 'waiting') {
      return { result: `Use board_ask to move #${before.id} to Waiting for input: it puts your question to the user with options.` }
    }
    const card = await moveCard($, before.id, column, { by, summary: handoff })
    return { result: card ? `Moved ${summary(card)}` : `No card #${String(e.id)}.` }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_next' }, async ($, e) => {
    const by = actorOf(e)
    touch($, by.holder)
    const { card, error } = await claimNext($, by)
    return { result: card ? `Claimed for you and moved to Doing:\n${full(card)}` : (error ?? '') }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_claim' }, async ($, e) => {
    const by = actorOf(e)
    touch($, by.holder)
    const { card, error } = await claimCard($, Number(e.id), by)
    return { result: card ? `Claimed ${summary(card)}` : (error ?? '') }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_release' }, async ($, e) => {
    const by = actorOf(e)
    const { card, error } = await releaseCard($, Number(e.id), by)
    return { result: card ? `Released ${summary(card)}. Say why in a board_comment.` : (error ?? '') }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_check' }, async ($, e) => {
    const by = actorOf(e)
    touch($, by.holder)
    const before = (await loadCards($)).find(c => c.id === Number(e.id))
    if (!before) return { result: `No card #${String(e.id)}.` }
    const held = heldByOther(before, by)
    if (held) return { result: held }
    const tasks = tasksOf(before.description)
    if (tasks.length === 0) {
      return { result: `#${before.id} has no checklist. Add \`- [ ] …\` lines to its description with board_update.` }
    }
    const index = findTask(tasks, e.item)
    if (index < 0) {
      return { result: `No item ${JSON.stringify(e.item)} on #${before.id}. Its checklist:\n${checklistLines(tasks).join('\n')}` }
    }
    const done = e.done !== false
    const card = await checkTask($, before.id, index, done)
    if (!card) return { result: `No card #${String(e.id)}.` }
    const p = progressOf(card)
    const left = tasksOf(card.description).filter(t => !t.done)
    return {
      result:
        `${done ? 'Ticked' : 'Unticked'} "${tasks[index]?.text ?? ''}" on #${card.id}: ${p.done}/${p.total} done.` +
        (left.length ? `\nStill open:\n${left.map(t => `- ${t.text}`).join('\n')}` : '\nEvery item is ticked.'),
    }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_comment' }, async ($, e) => {
    if (typeof e.text !== 'string' || !e.text.trim()) return { result: 'Comment text is required.' }
    const card = await addComment($, Number(e.id), authorOf(e), e.text)
    return { result: card ? `Commented on ${summary(card)}` : `No card #${String(e.id)}.` }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_ask' }, async ($, e) => {
    const options = Array.isArray(e.options)
      ? e.options
          .filter(o => !!o && typeof o.label === 'string' && !!o.label.trim())
          .map(o => ({ label: o.label.trim(), description: typeof o.description === 'string' ? o.description : '' }))
      : []
    if (typeof e.question !== 'string' || !e.question.trim()) return { result: 'A question is required.' }
    if (options.length < 2) return { result: 'Give at least two options, each with a label.' }
    const wanted = typeof e.recommended === 'string' ? e.recommended.trim() : ''
    const recommended = options.some(o => o.label === wanted) ? wanted : ''
    const hasId = e.id !== undefined && e.id !== null
    if (hasId) {
      const before = (await loadCards($)).find(c => c.id === Number(e.id))
      const held = before && heldByOther(before, actorOf(e))
      if (held) return { result: held }
    }
    const card = await askQuestion($, {
      id: hasId ? Number(e.id) : undefined,
      title: typeof e.title === 'string' ? e.title.trim() : undefined,
      description: typeof e.description === 'string' ? e.description : undefined,
      question: { text: e.question.trim(), options, recommended, answer: '', answeredAt: '' },
      author: authorOf(e),
      by: actorOf(e),
    })
    return {
      result: card
        ? `Asked on ${summary(card)}. The user will answer in the board pane; their answer arrives as a message.`
        : `No card #${String(e.id)}.`,
    }
  })

  on('tool.call', { tool: 'mcp__agent-board__board_update' }, async ($, e) => {
    const before = (await loadCards($)).find(c => c.id === Number(e.id))
    const held = before && heldByOther(before, actorOf(e))
    if (held) return { result: held }
    const card = await changeCard($, Number(e.id), c => ({
      ...c,
      title: typeof e.title === 'string' && e.title.trim() ? e.title.trim() : c.title,
      description: typeof e.description === 'string' ? e.description : c.description,
    }))
    return { result: card ? `Updated ${summary(card)}` : `No card #${String(e.id)}.` }
  })

  // ---- Pane ----------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const table = e.surface === 'mobile' ? undefined : $.ui.resolve(e)
    const Input = table?.Input
    const Select = table?.Select
    const list = await read($, cards)
    const openId = await read($, selected)
    const dir = await read($, boardDir)
    const open = await read($, expanded)
    // Read so the pane redraws as agents work and as time passes.
    await read($, activity)
    await read($, tick)
    const width = e.props.bodyColumns
    // Graphical surfaces get filled cards; the terminal keeps thin borders.
    const isGui = e.surface !== 'terminal'
    const cardStyle = (isAccent = false) =>
      isGui
        ? {
            // The round border is what gives the card its rounded corners.
            borderStyle: 'round',
            borderColor: isAccent ? palette.waitingEdge : palette.edge,
            backgroundColor: isAccent ? palette.waiting : palette.card,
            paddingX: 1,
          }
        : {
            borderStyle: 'single',
            borderDimColor: true,
            borderColor: isAccent ? 'warning' : 'subtle',
            paddingX: 1,
          }

    // A plain Button. It used to wrap its text in a Text child on graphical
    // surfaces, but 2.1.317 takes only a label or one string child, so every
    // surface gets the label, drawn on one line.
    const wrapButton = (key: string, label: string, onPress: () => unknown, dim = false) => (
      <Button key={key} label={label} plain dimColor={dim || undefined} onPress={() => void onPress()} />
    )

    // A thin progress bar of ten segments, then "☑ 3/5".
    const progress = (c: Card) => {
      const p = progressOf(c)
      if (p.total === 0) return undefined
      const filled = Math.round((p.done / p.total) * 10)
      return (
        <Text>
          <Text color="success">{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(10 - filled)}</Text>
          <Text dimColor>
            {' '}☑ {p.done}/{p.total}
          </Text>
        </Text>
      )
    }

    // The tint lives on a Box of our own: a pane's backgroundColor is only a
    // request, and an already-open pane keeps the look it opened with.
    const frame = (tree: JSX.Element) =>
      isGui ? (
        // A round border in the tint's own color gives the area rounded corners
        // without a visible outline.
        <Box
          flexDirection="column"
          flexGrow={1}
          backgroundColor={palette.pane}
          borderStyle="round"
          borderColor={palette.pane}
          padding={1}
        >
          {tree}
        </Box>
      ) : (
        tree
      )

    const holderLine = (c: Card) =>
      !isLive(c) ? undefined : isWorking(c) ? (
        <Text color="success">● {c.assignee} is working on this</Text>
      ) : (
        <Text dimColor>
          ○ {c.assignee} · last active {lastActiveAgo(c)}
        </Text>
      )

    if (!dir) return <Text dimColor>Loading the board…</Text>

    const card = list.find(c => c.id === openId)
    const goTo = (id: number) => update($, selected, () => id)
    const pendingDelete = await read($, confirmDelete)

    // ---- One card ----
    if (card) {
      const q = card.question
      const isOpenQ = isOpenQuestion(card)
      return frame(
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Button key="back" label="← Board" plain onPress={() => goTo(0)} />
            {card.column !== 'done' && (
              <Button
                key="ask"
                label="Ask Claude to work on this"
                onPress={() => {
                  void $.prompt.submit({
                    text: `Please work on board card #${card.id} ("${card.title}"). Read it with board_get first, and keep the card's column and comments up to date as you go.`,
                    asUser: true,
                  }).catch(() => undefined)
                }}
              />
            )}
          </Box>

          <Box flexDirection="column">
            <Text bold>{card.title}</Text>
            <Text dimColor>
              #{card.id} · {labelOf(card.column)} · by {card.author || 'unknown'} · updated {ago(card.updated)}
            </Text>
            {isLive(card) && (
              <Box flexDirection="row" columnGap={2} alignItems="center">
                {holderLine(card)}
                <Button key="release" label="Release" plain dimColor onPress={() => releaseCard($, card.id)} />
              </Box>
            )}
          </Box>

          {q && (
            <Box
              flexDirection="column"
              gap={1}
              {...cardStyle(isOpenQ)}
            >
              <Text bold color={isOpenQ ? 'warning' : undefined}>
                {isOpenQ ? 'Claude needs your answer' : 'Answered'}
              </Text>
              <Text>{q.text}</Text>
              {q.options.map((o, i) => (
                <Box key={`option-${i}`} flexDirection="column">
                  {isOpenQ ? (
                    <Button
                      key={`answer-${i}`}
                      label={`${o.label}${o.label === q.recommended ? '  ★ recommended' : ''}`}
                      variant={o.label === q.recommended ? 'primary' : 'secondary'}
                      onPress={() => answerQuestion($, card.id, o.label)}
                    />
                  ) : (
                    <Text bold={q.answer === o.label} dimColor={q.answer !== o.label}>
                      {q.answer === o.label ? '● ' : '○ '}
                      {o.label}
                      {o.label === q.recommended ? '  ★' : ''}
                    </Text>
                  )}
                  {o.description && <Text dimColor>{o.description}</Text>}
                </Box>
              ))}
              {isOpenQ && Input && (
                <Input
                  key="other-answer"
                  placeholder="Or type your own answer…"
                  submitLabel="Answer"
                  onSubmit={text => answerQuestion($, card.id, text)}
                />
              )}
              {!isOpenQ && (
                <Text dimColor>
                  You chose “{q.answer}” {ago(q.answeredAt)}
                </Text>
              )}
            </Box>
          )}

          {(() => {
            const tasks = tasksOf(card.description)
            const rest = tasks.length ? withoutTasks(card.description) : card.description
            const p = progressOf(card)
            return (
              <Box key="body" flexDirection="column" gap={1}>
                {rest ? <Markdown text={rest} /> : !tasks.length && <Text dimColor>No description.</Text>}
                {tasks.length > 0 && (
                  <Box key="checklist" flexDirection="column">
                    <Text bold>
                      Checklist <Text dimColor>{p.done}/{p.total}</Text>
                    </Text>
                    {progress(card)}
                    {tasks.map((t, i) =>
                      wrapButton(`check-${i}`, `${t.done ? '☑' : '☐'} ${t.text}`, () => checkTask($, card.id, i, !t.done), t.done),
                    )}
                  </Box>
                )}
              </Box>
            )
          })()}

          {(() => {
            // The last handoff is what a reviewer needs first.
            const handoff = [...card.comments].reverse().find(c => c.kind === 'handoff')
            if (!handoff || (card.column !== 'reviewing' && card.column !== 'done')) return undefined
            return (
              <Box key="handoff" flexDirection="column" {...cardStyle()}>
                <Text>
                  <Text bold color="success">Handoff</Text> <Text dimColor>from {handoff.author} · {ago(handoff.at)}</Text>
                </Text>
                <Markdown text={handoff.text} />
              </Box>
            )
          })()}

          {Select ? (
            <Select
              key="move"
              label="Column"
              value={card.column}
              options={COLUMNS.map(c => ({ value: c.id, label: c.label }))}
              onSelect={value => {
                const to = asColumn(value)
                if (to && to !== card.column) void moveCard($, card.id, to)
              }}
            />
          ) : (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {COLUMNS.filter(c => c.id !== card.column).map(c => (
                <Button key={`move-${c.id}`} label={c.label} onPress={() => moveCard($, card.id, c.id)} />
              ))}
            </Box>
          )}

          <Box flexDirection="column" gap={1}>
            <Text bold>
              Comments <Text dimColor>{card.comments.length}</Text>
            </Text>
            {card.comments.map((c, i) => (
              <Box key={`comment-${i}`} flexDirection="column" {...cardStyle()}>
                <Text>
                  <Text bold>{c.author}</Text>
                  {c.kind === 'handoff' && <Text color="success"> handoff</Text>} <Text dimColor>· {ago(c.at)}</Text>
                </Text>
                <Markdown text={c.text} />
              </Box>
            ))}
            {Input && (
              <Input
                key="comment"
                rows={2}
                placeholder="Add a comment…"
                submitLabel="Comment"
                onSubmit={text => {
                  if (text.trim()) void addComment($, card.id, 'you', text)
                }}
              />
            )}
          </Box>

          {pendingDelete === card.id ? (
            <Box flexDirection="column" gap={1} {...cardStyle(true)}>
              <Text bold>Delete “{card.title}”?</Text>
              <Text dimColor>
                This removes .board/cards/{card.id}.md. If you committed it, git can bring it back.
              </Text>
              <Box flexDirection="row" columnGap={1}>
                <Button
                  key="confirm-delete"
                  label="Delete card"
                  variant="primary"
                  onPress={async () => {
                    await update($, confirmDelete, () => 0)
                    await update($, selected, () => 0)
                    await deleteCard($, card.id)
                  }}
                />
                <Button key="cancel-delete" label="Cancel" onPress={() => update($, confirmDelete, () => 0)} />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row">
              <Button key="delete" label="Delete card…" plain dimColor onPress={() => update($, confirmDelete, () => card.id)} />
            </Box>
          )}
        </Box>
      )
    }

    // ---- The board ----
    const inColumn = (id: Column) => list.filter(c => c.column === id)

    // Narrower than six columns of 22: the columns stack top to bottom.
    const isStacked = width < 6 * 22

    const tile = (c: Card) => {
      const isWaiting = c.column === 'waiting'
      const at = FLOW.findIndex(f => f.id === c.column)
      const prev = at > 0 ? FLOW[at - 1] : undefined
      const next = at < 0 ? FLOW.find(f => f.id === 'todo') : FLOW[at + 1]
      const question = isOpenQuestion(c) ? c.question : undefined
      const meta = [`#${c.id}`, c.comments.length > 0 ? `💬 ${c.comments.length}` : '', ago(c.updated)]
        .filter(Boolean)
        .join(' · ')
      return (
        <Box
          key={`tile-${c.id}`}
          flexDirection="row"
          alignItems="center"
          minWidth={0}
          overflow="hidden"
          {...cardStyle(isWaiting)}
        >
          {/* minWidth 0 lets the title shrink to the tile so it wraps, instead
              of a one-line label pushing past the tile's edge. */}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {wrapButton(`card-${c.id}`, c.title, () => goTo(c.id))}
            {question && <Text color="warning">❓ {question.text}</Text>}
            {holderLine(c)}
            {progress(c)}
            <Text dimColor>{meta}</Text>
          </Box>
          {/* Chevrons that move the card one column: centred on the tile's
              right edge, shown while the tile is hovered. Where the columns are
              stacked (the side panel), they point up and down, stacked too. */}
          <Box
            flexDirection={isStacked ? 'column' : 'row'}
            alignItems="center"
            flexShrink={0}
            gap={isStacked ? 0 : 1}
            marginLeft={1}
            display="none"
            hover={{ display: 'flex' }}
          >
            {prev && <Button key={`left-${c.id}`} label={isStacked ? '▲' : '❮'} plain onPress={() => moveCard($, c.id, prev.id)} />}
            {next && <Button key={`right-${c.id}`} label={isStacked ? '▼' : '❯'} plain onPress={() => moveCard($, c.id, next.id)} />}
          </Box>
        </Box>
      )
    }

    const heading = (col: { id: Column; label: string }, count: number, title = col.label) => (
      <Text bold color={col.id === 'waiting' && count > 0 ? 'warning' : undefined}>
        {title} <Text dimColor>{count}</Text>
      </Text>
    )

    const toggle = (col: { id: Column; label: string }, count: number) => {
      const isOpen = open.includes(col.id)
      return (
        <Button
          key={`toggle-${col.id}`}
          plain
          label={`${isOpen ? '▾' : '▸'} ${col.label}  ${count}`}
          onPress={() =>
            update($, expanded, list => (list.includes(col.id) ? list.filter(x => x !== col.id) : [...list, col.id]))
          }
        />
      )
    }

    const addCard = Input && (
      <Input
        key="new"
        placeholder="Add a card to Backlog…"
        submitLabel="Add"
        onSubmit={text => {
          if (!text.trim()) return
          void createCard($, { title: text, author: 'you' })
          // Unfold Backlog so the new card is in view.
          void update($, expanded, list => (list.includes('backlog') ? list : [...list, 'backlog']))
        }}
      />
    )

    const repo = dir.replace(/\/\.board\/cards$/, '').split('/').pop() ?? ''
    const needsYou = inColumn('waiting').length
    const footer = (
      <Text dimColor>
        {list.length} card{list.length === 1 ? '' : 's'}
        {needsYou > 0 ? ` · ${needsYou} need${needsYou === 1 ? 's' : ''} you` : ''} · saved in {repo}/.board
      </Text>
    )

    // Wide (the pane expanded): every column side by side, in board order.
    if (!isStacked) {
      return frame(
        <Box flexDirection="column" gap={1}>
          {addCard}
          <Box flexDirection="row" columnGap={1}>
            {COLUMNS.map(col => {
              const cs = inColumn(col.id)
              // Empty columns keep just room for their heading; the columns
              // with cards share the rest equally.
              const size = cs.length === 0 ? { width: 14, flexShrink: 0 } : { width: 0, flexGrow: 1, minWidth: 0 }
              return (
                <Box key={`col-${col.id}`} flexDirection="column" gap={1} {...size}>
                  {heading(col, cs.length, col.id === 'waiting' ? 'Needs you' : col.label)}
                  {cs.length === 0 ? <Text dimColor>No cards</Text> : cs.map(tile)}
                </Box>
              )
            })}
          </Box>
          {footer}
        </Box>
      )
    }

    // Narrow: what needs you first, then work in flight; empty columns hide,
    // Backlog and Done fold away.
    const ACTIVE: Column[] = ['waiting', 'doing', 'reviewing', 'todo']
    const FOLDED: Column[] = ['backlog', 'done']
    const active = COLUMNS.filter(c => ACTIVE.includes(c.id)).sort(
      (a, b) => ACTIVE.indexOf(a.id) - ACTIVE.indexOf(b.id),
    )
    const shown = active.filter(c => inColumn(c.id).length > 0)

    return frame(
      <Box flexDirection="column" gap={1}>
        {addCard}
        {list.length === 0 && (
          <Text dimColor>No cards yet. Add one above, or ask Claude to plan the work as board cards.</Text>
        )}
        {list.length > 0 && shown.length === 0 && <Text dimColor>Nothing in progress.</Text>}
        {shown.map(col => (
          <Box key={`col-${col.id}`} flexDirection="column" gap={1}>
            {heading(col, inColumn(col.id).length, col.id === 'waiting' ? 'Needs you' : col.label)}
            {inColumn(col.id).map(tile)}
          </Box>
        ))}
        {COLUMNS.filter(c => FOLDED.includes(c.id)).map(col => {
          const cs = inColumn(col.id)
          return (
            <Box key={`col-${col.id}`} flexDirection="column" gap={1}>
              {toggle(col, cs.length)}
              {open.includes(col.id) && (cs.length === 0 ? <Text dimColor>No cards</Text> : cs.map(tile))}
            </Box>
          )
        })}
        {footer}
      </Box>
    )
  })
}
