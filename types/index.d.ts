export type Column = 'backlog' | 'todo' | 'doing' | 'reviewing' | 'done' | 'waiting'

export type Comment = {
  at: string
  author: string
  text: string
  /** 'handoff': the summary an agent leaves when it moves a card to Reviewing or Done */
  kind?: 'handoff'
}

export type QuestionOption = { label: string; description: string }

export type Question = {
  text: string
  options: QuestionOption[]
  /** Label of the option the asker recommends, or '' */
  recommended: string
  /** The chosen option's label, or the user's own words; '' while open */
  answer: string
  answeredAt: string
}

export type Card = {
  id: number
  title: string
  column: Column
  description: string
  author: string
  created: string
  updated: string
  comments: Comment[]
  question?: Question
  /** Who holds the card: an agent id, 'main' for the main loop; '' when unclaimed */
  holder: string
  /** The holder's display name */
  assignee: string
  claimedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      cards: Shaped<Card[]>
      selected: number
      boardDir: string
      expanded: string[]
      confirmDelete: number
      /** Last tool call per agent (holder id → epoch ms), for the working dot */
      activity: Record<string, number>
      /** Bumped every 30 s so relative times and idle states redraw */
      tick: number
    }
  }
}
