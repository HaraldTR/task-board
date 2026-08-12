# linear-board

Linear-style task board plugin for this vault. Tasks are one note each in
`projects/tasks/` with frontmatter fields (`status`, `priority`, `tag`, `due`).

## Build & install (any machine)

```bash
cd .tools/linear-board
npm run ship
```

That's the only command: it installs dependencies on first run (needs node 18+,
`brew install node` on a Mac), bundles the plugin, and copies it into
`.obsidian/plugins/linear-board/`. Then reload Obsidian
(cmd-P → "Reload app without saving").

`npm run check` typechecks. Built `main.js` and `node_modules/` are gitignored
here; the installed copy in `.obsidian/plugins/` IS committed so machines that
never build still get updates via git sync.

## Dev-machine convention (avoid conflicts)

This folder is the only canonical source. Before editing `src/`, always
`git pull --rebase`; after shipping, always commit and push (repo uses rebase,
not merge). One machine edits at a time — the current dev machine is declared
below; update this line when it changes:

**Current dev machine: Mac** (since 2026-08-12)

## Related files

- `projects/Task Board.base` — Bases fallback views over the same task notes
- `projects/cards/linear-in-obsidian.md` — full implementation plan & phases
