export type Column = 'backlog' | 'todo' | 'doing' | 'reviewing' | 'done' | 'waiting'

export type Comment = { at: string; author: string; text: string }

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
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      cards: Shaped<Card[]>
      selected: number
      boardDir: string
      expanded: string[]
      confirmDelete: number
    }
  }
}
