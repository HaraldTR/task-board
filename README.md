# linear-board

Linear-style task board plugin for this vault. Everything lives under `pm/`:

- `pm/tasks/active/` + `pm/tasks/inactive/` — one note per task. Status is
  canonical; the plugin auto-archives notes to `inactive/` when status becomes
  `done`/`cancelled` and moves them back on reopen (links survive the move).
- `pm/projects/active/<slug>/<slug>.md` — a project is a folder with a folder
  note (`type: project` frontmatter); everything else in the folder is
  free-form scratch. The folder list IS the canonical project list.
- `pm/tags.md` — canonical tag registry (frontmatter `tags:` list); the
  board's "New tag…" appends here.

Task frontmatter: `status` (agent-inbox/backlog/this-week/today/waiting/done/
cancelled), `priority` (P0–P3), `project` (mandatory slug), `tags` (free-form
list), `size` (XS–XL), `assignee` (free string, default harald), `origin`
(human|ai), `due`, `created`, `started` (auto on first move to Today),
`completed` (auto on Done, cleared on reopen). Saved filter views live in the
plugin's `data.json`.

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
