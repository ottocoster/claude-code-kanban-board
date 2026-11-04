# Agent board

A Kanban board for Claude Code, shared by you, Claude and its subagents.

- Columns: Backlog, To do, Doing, Reviewing, Done and Waiting for input.
- `/board` opens the board in a pane. Add cards, open a card to comment, change its column, answer a question or delete it. Hover over a card to move it one column with the chevrons.
- Claude gets tools to list, read, create, move, update and comment on cards, and to ask you a multiple-choice question on a card (`board_ask`). Your answer is sent back to Claude.
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
