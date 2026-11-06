# Agent board

A Kanban board for Claude Code, shared by you, Claude and its subagents.

- Columns: Needs you (waiting for your input), Backlog, To do, Doing, Reviewing and Done.
- `/board` opens the board in a pane. Add cards, open a card to comment, change its column, answer a question or delete it. Hover over a card to move it one column with the chevrons.
- Claude gets tools to list, read, create, move, update and comment on cards, and to ask you a multiple-choice question on a card (`board_ask`). Your answer is sent back to Claude.
- Acceptance criteria: `- [ ]` lines in a card's description become a checklist. Tick items in the card view, or have agents tick them with `board_check`. The tile shows progress as a thin bar and `☑ 3/5`.
- Agents never step on each other: `board_next` hands an agent the next card in To do and claims it. A claimed card can only be moved or edited by its holder or by you, and the tile shows who is working on it. A claim lapses after 30 minutes without activity, and a subagent that ends gives its cards back.
- Moving a card to Reviewing or Done requires a handoff summary, which is shown at the top of the card for whoever reviews it.
- Each card is a Markdown file in `.board/cards/` at the root of your git repository. Nothing is committed for you.

## Install

At the prompt of a terminal session:

```
/plugin install agent-board --marketplace ottocoster/claude-code-kanban-board
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install agent-board --marketplace ottocoster/claude-code-kanban-board
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ottocoster/claude-code-kanban-board`, then Add plugin.
