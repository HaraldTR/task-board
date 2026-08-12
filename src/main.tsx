import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from 'obsidian';
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { Root, createRoot } from 'react-dom/client';

const VIEW_TYPE = 'linear-board-view';
const TASKS_FOLDER = 'projects/tasks';

const COLUMNS = ['agent-inbox', 'backlog', 'this-week', 'today', 'waiting', 'done'] as const;
const COLUMN_LABELS: Record<string, string> = {
  'agent-inbox': 'Inbox',
  backlog: 'Backlog',
  'this-week': 'This week',
  today: 'Today',
  waiting: 'Waiting',
  done: 'Done',
};
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const PRIORITY_LABELS: Record<string, string> = {
  P0: 'Urgent',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

interface TaskItem {
  file: TFile;
  path: string;
  id: string;
  title: string;
  status: string;
  priority: string | null;
  tag: string | null;
  due: string | null;
}

function loadTasks(app: App): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(TASKS_FOLDER + '/')) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== 'task') continue;
    const id = typeof fm.id === 'string' ? fm.id : file.basename.split(' ')[0];
    tasks.push({
      file,
      path: file.path,
      id,
      title: file.basename.replace(/^T-\d+\s*/, ''),
      status: typeof fm.status === 'string' && fm.status ? fm.status : 'backlog',
      priority: typeof fm.priority === 'string' && fm.priority ? fm.priority : null,
      tag: typeof fm.tag === 'string' && fm.tag.trim() ? fm.tag.trim() : null,
      due: fm.due ? String(fm.due) : null,
    });
  }
  return tasks;
}

function nextId(tasks: TaskItem[]): string {
  let max = 0;
  for (const t of tasks) {
    const m = t.id.match(/^T-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'T-' + String(max + 1).padStart(3, '0');
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:|#^\[\]"*?<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function setProp(app: App, task: TaskItem, key: string, value: string | null) {
  await app.fileManager.processFrontMatter(task.file, (fm) => {
    fm[key] = value ?? '';
  });
}

async function createTask(
  app: App,
  tasks: TaskItem[],
  fields: { title: string; status: string; priority: string | null; tag: string | null }
): Promise<TFile> {
  const id = nextId(tasks);
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    `id: ${id}`,
    'type: task',
    `status: ${fields.status}`,
    `priority: ${fields.priority ?? ''}`,
    `tag: ${fields.tag ?? ''}`,
    'project:',
    'due:',
    `created: ${today}`,
    '---',
    '',
  ];
  const path = normalizePath(`${TASKS_FOLDER}/${id} ${sanitizeName(fields.title)}.md`);
  return app.vault.create(path, lines.join('\n'));
}

function priorityRank(p: string | null): number {
  return p ? PRIORITIES.indexOf(p as (typeof PRIORITIES)[number]) : PRIORITIES.length;
}

class TagPromptModal extends Modal {
  onSubmit: (tag: string) => void;

  constructor(app: App, onSubmit: (tag: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText('New tag');
    const input = this.contentEl.createEl('input', {
      type: 'text',
      placeholder: 'e.g. citadel, personal, music',
    });
    input.style.width = '100%';
    const submit = () => {
      const v = input.value.trim().toLowerCase().replace(/\s+/g, '-');
      if (v) this.onSubmit(v);
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const btn = row.createEl('button', { text: 'Add', cls: 'mod-cta' });
    btn.addEventListener('click', submit);
    window.setTimeout(() => input.focus(), 10);
  }

  onClose() {
    this.contentEl.empty();
  }
}

function tagMenu(
  app: App,
  allTags: string[],
  current: string | null,
  onPick: (tag: string | null) => void,
  e: React.MouseEvent
) {
  e.stopPropagation();
  const menu = new Menu();
  for (const tag of allTags) {
    menu.addItem((i) =>
      i.setTitle(tag).setChecked(current === tag).onClick(() => onPick(tag))
    );
  }
  if (allTags.length) menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle('New tag…').setIcon('plus').onClick(() => {
      new TagPromptModal(app, (t) => onPick(t)).open();
    })
  );
  if (current) {
    menu.addItem((i) => i.setTitle('Remove tag').setIcon('x').onClick(() => onPick(null)));
  }
  menu.showAtMouseEvent(e.nativeEvent);
}

/* ---------------- React UI ---------------- */

function Card({
  app,
  task,
  allTags,
  refresh,
}: {
  app: App;
  task: TaskItem;
  allTags: string[];
  refresh: () => void;
}) {
  const openNote = () => void app.workspace.getLeaf('tab').openFile(task.file);

  const priorityMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const menu = new Menu();
    for (const p of [...PRIORITIES, null]) {
      menu.addItem((i) =>
        i
          .setTitle(p ? `${p} · ${PRIORITY_LABELS[p]}` : 'No priority')
          .setChecked(task.priority === p)
          .onClick(async () => {
            await setProp(app, task, 'priority', p);
            refresh();
          })
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  const statusMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const menu = new Menu();
    for (const s of COLUMNS) {
      menu.addItem((i) =>
        i
          .setTitle(COLUMN_LABELS[s])
          .setChecked(task.status === s)
          .onClick(async () => {
            await setProp(app, task, 'status', s);
            refresh();
          })
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  return (
    <div
      className="lb-card"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-path', task.path)}
      onClick={openNote}
    >
      <div className="lb-title">{task.title}</div>
      <div className="lb-meta">
        <span
          className={`lb-priority lb-priority-${(task.priority ?? 'none').toLowerCase()}`}
          onClick={priorityMenu}
          title={task.priority ? PRIORITY_LABELS[task.priority] : 'Set priority'}
        >
          {task.priority ?? '·'}
        </span>
        <span className="lb-id">{task.id}</span>
        <span
          className={`lb-tag${task.tag ? '' : ' lb-tag-empty'}`}
          onClick={(e) =>
            tagMenu(app, allTags, task.tag, async (t) => {
              await setProp(app, task, 'tag', t);
              refresh();
            }, e)
          }
          title="Set tag"
        >
          {task.tag ?? '+'}
        </span>
        {task.due && <span className="lb-due">{task.due}</span>}
        <span className="lb-move" onClick={statusMenu} title="Move to…">
          ⇄
        </span>
      </div>
    </div>
  );
}

function Column({
  app,
  status,
  tasks,
  allTags,
  refresh,
}: {
  app: App;
  status: string;
  tasks: TaskItem[];
  allTags: string[];
  refresh: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`lb-column${over ? ' lb-column-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        const path = e.dataTransfer.getData('text/task-path');
        const task = loadTasks(app).find((t) => t.path === path);
        if (task && task.status !== status) {
          await setProp(app, task, 'status', status);
          refresh();
        }
      }}
    >
      <div className="lb-column-header">
        <span className={`lb-dot lb-dot-${status}`} />
        <span className="lb-column-name">{COLUMN_LABELS[status]}</span>
        <span className="lb-count">{tasks.length}</span>
      </div>
      <div className="lb-column-body">
        {tasks.map((t) => (
          <Card key={t.path} app={app} task={t} allTags={allTags} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}

function QuickAdd({
  app,
  tasks,
  allTags,
  onClose,
  refresh,
}: {
  app: App;
  tasks: TaskItem[];
  allTags: string[];
  onClose: () => void;
  refresh: () => void;
}) {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('today');
  const [priority, setPriority] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) return;
    await createTask(app, tasks, { title: title.trim(), status, priority, tag });
    new Notice(`Created in ${COLUMN_LABELS[status]}`);
    refresh();
    onClose();
  };

  const statusPill = (e: React.MouseEvent) => {
    const menu = new Menu();
    for (const s of COLUMNS) {
      menu.addItem((i) =>
        i.setTitle(COLUMN_LABELS[s]).setChecked(status === s).onClick(() => setStatus(s))
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  const priorityPill = (e: React.MouseEvent) => {
    const menu = new Menu();
    for (const p of [...PRIORITIES, null]) {
      menu.addItem((i) =>
        i
          .setTitle(p ? `${p} · ${PRIORITY_LABELS[p]}` : 'No priority')
          .setChecked(priority === p)
          .onClick(() => setPriority(p))
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  return (
    <div className="lb-overlay" onClick={onClose}>
      <div className="lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lb-modal-hint">New task</div>
        <input
          className="lb-modal-title"
          autoFocus
          placeholder="Task title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="lb-modal-row">
          <button className="lb-pill" onClick={statusPill}>
            <span className={`lb-dot lb-dot-${status}`} /> {COLUMN_LABELS[status]}
          </button>
          <button className="lb-pill" onClick={priorityPill}>
            <span className={`lb-priority lb-priority-${(priority ?? 'none').toLowerCase()}`}>
              {priority ?? '·'}
            </span>{' '}
            {priority ? PRIORITY_LABELS[priority] : 'Priority'}
          </button>
          <button
            className="lb-pill"
            onClick={(e) => tagMenu(app, allTags, tag, setTag, e)}
          >
            {tag ?? 'Tag'}
          </button>
        </div>
        <div className="lb-modal-actions">
          <span className="lb-modal-kbd">↵ to create · esc to close</span>
          <button className="mod-cta" onClick={() => void submit()}>
            Create task
          </button>
        </div>
      </div>
    </div>
  );
}

function BoardApp({ app }: { app: App }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>('ALL'); // ALL | UNTAGGED | <tag>
  const [priorityFilter, setPriorityFilter] = useState('');
  const [showDone, setShowDone] = useState(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const refs = [
      app.metadataCache.on('changed', refresh),
      app.vault.on('delete', refresh),
      app.vault.on('rename', refresh),
      app.vault.on('create', refresh),
    ];
    return () => refs.forEach((r) => app.metadataCache.offref(r));
  }, [app, refresh]);

  const tasks = useMemo(() => loadTasks(app), [app, tick]);
  const allTags = useMemo(
    () => [...new Set(tasks.map((t) => t.tag).filter((t): t is string => !!t))].sort(),
    [tasks]
  );
  const hasUntagged = tasks.some((t) => !t.tag);

  const visible = tasks.filter(
    (t) =>
      (tagFilter === 'ALL' ||
        (tagFilter === 'UNTAGGED' ? !t.tag : t.tag === tagFilter)) &&
      (!priorityFilter || t.priority === priorityFilter)
  );
  const columns = COLUMNS.filter((c) => showDone || c !== 'done');

  const pill = (key: string, label: string) => (
    <button
      key={key}
      className={`lb-pill lb-filter-pill${tagFilter === key ? ' lb-pill-active' : ''}`}
      onClick={() => setTagFilter(key)}
    >
      {label}
    </button>
  );

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header">
          <span className="lb-brand">Tasks</span>
          <div className="lb-pills">
            {pill('ALL', 'All')}
            {allTags.map((t) => pill(t, t))}
            {hasUntagged && pill('UNTAGGED', 'untagged')}
          </div>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="">Priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p} · {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <label className="lb-toggle">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            Done
          </label>
          <button className="mod-cta lb-new" onClick={() => setAdding(true)}>
            + New
          </button>
        </div>
        <div className="lb-board">
          {columns.map((c) => (
            <Column
              key={c}
              app={app}
              status={c}
              allTags={allTags}
              refresh={refresh}
              tasks={visible
                .filter((t) => t.status === c)
                .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id.localeCompare(b.id))}
            />
          ))}
        </div>
        {adding && (
          <QuickAdd
            app={app}
            tasks={tasks}
            allTags={allTags}
            onClose={() => setAdding(false)}
            refresh={refresh}
          />
        )}
      </div>
    </StrictMode>
  );
}

/* ---------------- Obsidian plumbing ---------------- */

class LinearBoardView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Task board';
  }
  getIcon() {
    return 'kanban-square';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('lb-view');
    this.root = createRoot(this.contentEl);
    this.root.render(<BoardApp app={this.app} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}

export default class LinearBoardPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new LinearBoardView(leaf));

    this.addRibbonIcon('kanban-square', 'Open task board', () => void this.activateView());

    this.addCommand({
      id: 'open-board',
      name: 'Open task board',
      callback: () => void this.activateView(),
    });
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  onunload() {}
}
