import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from 'obsidian';
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { Root, createRoot } from 'react-dom/client';

const VIEW_TYPE = 'linear-board-view';
const TASKS_FOLDER = 'pm/tasks';
const TASKS_ACTIVE = 'pm/tasks/active';
const TASKS_INACTIVE = 'pm/tasks/inactive';
const PROJECTS_ACTIVE = 'pm/projects/active';
const TAGS_FILE = 'pm/tags.md';
const DEFAULT_ASSIGNEE = 'harald';

const COLUMNS = ['agent-inbox', 'backlog', 'this-week', 'today', 'waiting', 'done', 'cancelled'] as const;
const CLOSED = ['done', 'cancelled'];
const COLUMN_LABELS: Record<string, string> = {
  'agent-inbox': 'Inbox',
  backlog: 'Backlog',
  'this-week': 'This week',
  today: 'Today',
  waiting: 'Waiting',
  done: 'Done',
  cancelled: 'Cancelled',
};
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const PRIORITY_LABELS: Record<string, string> = {
  P0: 'Urgent',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};
const PRIORITY_LEVEL: Record<string, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

interface TaskItem {
  file: TFile;
  path: string;
  id: string;
  title: string;
  status: string;
  priority: string | null;
  project: string | null;
  tags: string[];
  size: string | null;
  due: string | null;
  started: string | null;
  completed: string | null;
  assignee: string;
  origin: 'human' | 'ai';
}

/* ---------------- filters ---------------- */

const FILTER_FIELDS = [
  { key: 'project', label: 'Project' },
  { key: 'tags', label: 'Tags' },
  { key: 'priority', label: 'Priority' },
  { key: 'size', label: 'Size' },
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'origin', label: 'Origin' },
] as const;
type FilterField = (typeof FILTER_FIELDS)[number]['key'];
// OR within a field, AND across fields. 'none' matches tasks missing the field.
type Conditions = Partial<Record<FilterField, string[]>>;
interface SavedView {
  name: string;
  conditions: Conditions;
}

function matchesConditions(t: TaskItem, conds: Conditions): boolean {
  for (const f of FILTER_FIELDS) {
    const values = conds[f.key];
    if (!values || values.length === 0) continue;
    if (f.key === 'tags') {
      if (!t.tags.some((tag) => values.includes(tag))) return false;
    } else {
      const v =
        f.key === 'status' ? t.status : ((t[f.key] as string | null) ?? 'none');
      if (!values.includes(v)) return false;
    }
  }
  return true;
}

function hasConditions(conds: Conditions): boolean {
  return FILTER_FIELDS.some((f) => (conds[f.key]?.length ?? 0) > 0);
}

/* ---------------- data ---------------- */

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseProject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const wikilink = s.match(/^\[\[([^\]|]+)(\|[^\]]*)?\]\]$/);
  if (wikilink) return wikilink[1].split('/').pop()?.trim() || null;
  return s;
}

function parseTags(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return [...new Set(list.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()))];
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
      project: parseProject(fm.project),
      tags: parseTags(fm),
      size:
        typeof fm.size === 'string' && SIZES.includes(fm.size.toUpperCase() as (typeof SIZES)[number])
          ? fm.size.toUpperCase()
          : null,
      due: fm.due ? String(fm.due) : null,
      started: fm.started ? String(fm.started) : null,
      completed: fm.completed ? String(fm.completed) : null,
      assignee:
        typeof fm.assignee === 'string' && fm.assignee.trim() ? fm.assignee.trim() : DEFAULT_ASSIGNEE,
      origin: fm.origin === 'ai' ? 'ai' : 'human',
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

async function setTags(app: App, task: TaskItem, tags: string[]) {
  await app.fileManager.processFrontMatter(task.file, (fm) => {
    fm.tags = tags;
    delete fm.tag;
  });
}

async function ensureFolder(app: App, path: string) {
  if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
}

function taskFolderFor(status: string): string {
  return CLOSED.includes(status) ? TASKS_INACTIVE : TASKS_ACTIVE;
}

// Status changes stamp time: started on first entry to Today, completed on Done
// (cleared again when a task is reopened). Closed tasks are archived to
// inactive/; renameFile keeps links intact.
async function moveTask(app: App, task: TaskItem, status: string) {
  await app.fileManager.processFrontMatter(task.file, (fm) => {
    fm.status = status;
    if (status === 'today' && !fm.started) fm.started = todayStr();
    if (status === 'done') {
      if (!fm.completed) fm.completed = todayStr();
    } else if (fm.completed) {
      fm.completed = '';
    }
  });
  const target = normalizePath(`${taskFolderFor(status)}/${task.file.name}`);
  if (task.file.path !== target) {
    await ensureFolder(app, taskFolderFor(status));
    await app.fileManager.renameFile(task.file, target);
  }
}

function listProjects(app: App): string[] {
  const folder = app.vault.getAbstractFileByPath(PROJECTS_ACTIVE);
  if (!(folder instanceof TFolder)) return [];
  return folder.children
    .filter((c): c is TFolder => c instanceof TFolder)
    .map((f) => f.name)
    .sort();
}

// A project is a folder under pm/projects/active/ with a folder note
// (<slug>/<slug>.md) holding its metadata; everything else in it is scratch.
async function createProject(app: App, slug: string) {
  const dir = `${PROJECTS_ACTIVE}/${slug}`;
  await ensureFolder(app, dir);
  const notePath = normalizePath(`${dir}/${slug}.md`);
  if (!app.vault.getAbstractFileByPath(notePath)) {
    await app.vault.create(
      notePath,
      ['---', 'type: project', 'description:', `created: ${todayStr()}`, 'origin: human', 'tags: []', '---', ''].join('\n')
    );
  }
}

function loadTagRegistry(app: App): string[] {
  const f = app.vault.getAbstractFileByPath(TAGS_FILE);
  if (!(f instanceof TFile)) return [];
  const raw = app.metadataCache.getFileCache(f)?.frontmatter?.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim());
}

async function addTagToRegistry(app: App, tag: string) {
  let f = app.vault.getAbstractFileByPath(TAGS_FILE);
  if (!(f instanceof TFile)) f = await app.vault.create(TAGS_FILE, '---\ntags: []\n---\n');
  await app.fileManager.processFrontMatter(f as TFile, (fm) => {
    const cur = Array.isArray(fm.tags)
      ? fm.tags.filter((t: unknown): t is string => typeof t === 'string')
      : [];
    if (!cur.includes(tag)) fm.tags = [...cur, tag].sort();
  });
}

async function createTask(
  app: App,
  tasks: TaskItem[],
  fields: {
    title: string;
    status: string;
    priority: string | null;
    project: string;
    size: string | null;
    tags: string[];
    assignee: string;
  }
): Promise<TFile> {
  const id = nextId(tasks);
  const today = todayStr();
  const lines = [
    '---',
    `id: ${id}`,
    'type: task',
    `status: ${fields.status}`,
    `priority: ${fields.priority ?? ''}`,
    `project: ${fields.project}`,
    `size: ${fields.size ?? ''}`,
    `tags: [${fields.tags.join(', ')}]`,
    `assignee: ${fields.assignee}`,
    'origin: human',
    'due:',
    `created: ${today}`,
    `started: ${fields.status === 'today' ? today : ''}`,
    `completed: ${fields.status === 'done' ? today : ''}`,
    '---',
    '',
  ];
  const path = normalizePath(`${taskFolderFor(fields.status)}/${id} ${sanitizeName(fields.title)}.md`);
  return app.vault.create(path, lines.join('\n'));
}

function priorityRank(p: string | null): number {
  return p ? PRIORITIES.indexOf(p as (typeof PRIORITIES)[number]) : PRIORITIES.length;
}

const AVATAR_COLORS = ['--lb-indigo', '--lb-blue', '--lb-orange', '--lb-red', '--lb-yellow', '--lb-gray'];

function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `var(${AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]})`;
}

/* ---------------- prompts & menus ---------------- */

class TextPromptModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; placeholder: string; slug?: boolean },
    private onSubmit: (value: string) => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.opts.title);
    const input = this.contentEl.createEl('input', {
      type: 'text',
      placeholder: this.opts.placeholder,
    });
    input.style.width = '100%';
    const submit = () => {
      let v = input.value.trim();
      if (this.opts.slug) v = v.toLowerCase().replace(/\s+/g, '-');
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

function projectMenu(
  app: App,
  allProjects: string[],
  current: string | null,
  onPick: (project: string) => void,
  e: React.MouseEvent
) {
  e.stopPropagation();
  const menu = new Menu();
  for (const p of allProjects) {
    menu.addItem((i) => i.setTitle(p).setChecked(current === p).onClick(() => onPick(p)));
  }
  if (allProjects.length) menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle('New project…').setIcon('plus').onClick(() => {
      new TextPromptModal(app, { title: 'New project', placeholder: 'e.g. citadel, personal', slug: true }, (slug) => {
        void createProject(app, slug).then(() => onPick(slug));
      }).open();
    })
  );
  menu.showAtMouseEvent(e.nativeEvent);
}

// Toggles one tag per open; reopen to toggle more.
function tagsMenu(
  app: App,
  allTags: string[],
  current: string[],
  onChange: (tags: string[]) => void,
  e: React.MouseEvent
) {
  e.stopPropagation();
  const toggle = (tag: string) =>
    onChange(current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]);
  const menu = new Menu();
  for (const tag of allTags) {
    menu.addItem((i) => i.setTitle(tag).setChecked(current.includes(tag)).onClick(() => toggle(tag)));
  }
  if (allTags.length) menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle('New tag…').setIcon('plus').onClick(() => {
      new TextPromptModal(app, { title: 'New tag', placeholder: 'e.g. bug, idea', slug: true }, (t) => {
        void addTagToRegistry(app, t);
        if (!current.includes(t)) onChange([...current, t]);
      }).open();
    })
  );
  menu.showAtMouseEvent(e.nativeEvent);
}

function sizeMenu(current: string | null, onPick: (size: string | null) => void, e: React.MouseEvent) {
  e.stopPropagation();
  const menu = new Menu();
  for (const s of [...SIZES, null]) {
    menu.addItem((i) =>
      i.setTitle(s ?? 'No size').setChecked(current === s).onClick(() => onPick(s))
    );
  }
  menu.showAtMouseEvent(e.nativeEvent);
}

function assigneeMenu(
  app: App,
  allAssignees: string[],
  current: string,
  onPick: (assignee: string) => void,
  e: React.MouseEvent
) {
  e.stopPropagation();
  const menu = new Menu();
  for (const a of allAssignees) {
    menu.addItem((i) => i.setTitle(a).setChecked(current === a).onClick(() => onPick(a)));
  }
  if (allAssignees.length) menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle('Someone else…').setIcon('plus').onClick(() => {
      new TextPromptModal(app, { title: 'Assignee', placeholder: 'e.g. harald, claude', slug: true }, onPick).open();
    })
  );
  menu.showAtMouseEvent(e.nativeEvent);
}

/* ---------------- React UI ---------------- */

function Card({
  app,
  task,
  allProjects,
  allTags,
  allAssignees,
  refresh,
}: {
  app: App;
  task: TaskItem;
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
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
            await moveTask(app, task, s);
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
      <div className="lb-card-top">
        <span className="lb-id">{task.id}</span>
        <span
          className={`lb-project${task.project ? '' : ' lb-project-empty'}`}
          onClick={(e) =>
            projectMenu(app, allProjects, task.project, async (p) => {
              await setProp(app, task, 'project', p);
              refresh();
            }, e)
          }
          title="Set project"
        >
          {task.project ?? 'no project'}
        </span>
        {task.origin === 'ai' && (
          <span className="lb-origin-ai" title="Created by AI">
            ai
          </span>
        )}
        <span
          className="lb-avatar"
          style={{ background: avatarColor(task.assignee) }}
          onClick={(e) =>
            assigneeMenu(app, allAssignees, task.assignee, async (a) => {
              await setProp(app, task, 'assignee', a);
              refresh();
            }, e)
          }
          title={`Assignee: ${task.assignee}`}
        >
          {task.assignee.charAt(0).toUpperCase()}
        </span>
      </div>
      <div className="lb-title">{task.title}</div>
      <div className="lb-meta">
        <span
          className={`lb-priority lb-priority-${(task.priority ?? 'none').toLowerCase()}`}
          onClick={priorityMenu}
          title={task.priority ? `${task.priority} · ${PRIORITY_LABELS[task.priority]}` : 'Set priority'}
        >
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={`lb-bar${task.priority && n <= PRIORITY_LEVEL[task.priority] ? ' lb-bar-on' : ''}`}
            />
          ))}
        </span>
        <span
          className={`lb-size${task.size ? '' : ' lb-fade-in'}`}
          onClick={(e) =>
            sizeMenu(task.size, async (s) => {
              await setProp(app, task, 'size', s);
              refresh();
            }, e)
          }
          title={task.size ? `Size: ${task.size}` : 'Set size'}
        >
          {task.size ?? '◇'}
        </span>
        {task.tags.map((tag) => (
          <span
            key={tag}
            className="lb-tag"
            onClick={(e) =>
              tagsMenu(app, allTags, task.tags, async (tags) => {
                await setTags(app, task, tags);
                refresh();
              }, e)
            }
          >
            {tag}
          </span>
        ))}
        <span
          className="lb-tag lb-fade-in"
          onClick={(e) =>
            tagsMenu(app, allTags, task.tags, async (tags) => {
              await setTags(app, task, tags);
              refresh();
            }, e)
          }
          title="Add tag"
        >
          +
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
  allProjects,
  allTags,
  allAssignees,
  refresh,
}: {
  app: App;
  status: string;
  tasks: TaskItem[];
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
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
          await moveTask(app, task, status);
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
          <Card
            key={t.path}
            app={app}
            task={t}
            allProjects={allProjects}
            allTags={allTags}
            allAssignees={allAssignees}
            refresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function QuickAdd({
  app,
  tasks,
  allProjects,
  allTags,
  allAssignees,
  onClose,
  refresh,
}: {
  app: App;
  tasks: TaskItem[];
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
  onClose: () => void;
  refresh: () => void;
}) {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('today');
  const [priority, setPriority] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [tags, setTagsState] = useState<string[]>([]);
  const [assignee, setAssignee] = useState(DEFAULT_ASSIGNEE);
  const [missingProject, setMissingProject] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    if (!project) {
      setMissingProject(true);
      new Notice('Pick a project — every task needs one');
      return;
    }
    await createTask(app, tasks, { title: title.trim(), status, priority, project, size, tags, assignee });
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
          <button
            className={`lb-pill${missingProject && !project ? ' lb-pill-required' : ''}`}
            onClick={(e) =>
              projectMenu(app, allProjects, project, (p) => {
                setProject(p);
                setMissingProject(false);
              }, e)
            }
          >
            {project ?? 'Project *'}
          </button>
          <button className="lb-pill" onClick={statusPill}>
            <span className={`lb-dot lb-dot-${status}`} /> {COLUMN_LABELS[status]}
          </button>
          <button className="lb-pill" onClick={priorityPill}>
            {priority ? `${priority} · ${PRIORITY_LABELS[priority]}` : 'Priority'}
          </button>
          <button className="lb-pill" onClick={(e) => sizeMenu(size, setSize, e)}>
            {size ?? 'Size'}
          </button>
          <button className="lb-pill" onClick={(e) => tagsMenu(app, allTags, tags, setTagsState, e)}>
            {tags.length ? tags.join(', ') : 'Tags'}
          </button>
          <button className="lb-pill" onClick={(e) => assigneeMenu(app, allAssignees, assignee, setAssignee, e)}>
            @{assignee}
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

function BoardApp({ app, plugin }: { app: App; plugin: LinearBoardPlugin }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [conditions, setConditions] = useState<Conditions>({});
  const [activeView, setActiveView] = useState('All');
  const [views, setViews] = useState<SavedView[]>(plugin.settings.views);
  const [filterOpen, setFilterOpen] = useState(false);

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
  // Canonical sources (project folders, tags.md) unioned with values in use,
  // so legacy values stay pickable/filterable.
  const allProjects = useMemo(
    () =>
      [
        ...new Set([
          ...listProjects(app),
          ...tasks.map((t) => t.project).filter((p): p is string => !!p),
        ]),
      ].sort(),
    [app, tick, tasks]
  );
  const allTags = useMemo(
    () => [...new Set([...loadTagRegistry(app), ...tasks.flatMap((t) => t.tags)])].sort(),
    [app, tick, tasks]
  );
  const allAssignees = useMemo(
    () => [...new Set([DEFAULT_ASSIGNEE, ...tasks.map((t) => t.assignee)])].sort(),
    [tasks]
  );

  const fieldValues: Record<FilterField, string[]> = useMemo(
    () => ({
      project: [...allProjects, ...(tasks.some((t) => !t.project) ? ['none'] : [])],
      tags: allTags,
      priority: [...PRIORITIES, ...(tasks.some((t) => !t.priority) ? ['none'] : [])],
      size: [...SIZES, ...(tasks.some((t) => !t.size) ? ['none'] : [])],
      status: [...COLUMNS],
      assignee: allAssignees,
      origin: ['human', 'ai'],
    }),
    [tasks, allProjects, allTags, allAssignees]
  );

  const persistViews = (next: SavedView[]) => {
    setViews(next);
    void plugin.saveViews(next);
  };

  const applyView = (v: SavedView) => {
    setConditions(JSON.parse(JSON.stringify(v.conditions)));
    setActiveView(v.name);
  };

  const toggleCond = (field: FilterField, value: string) => {
    setConditions((prev) => {
      const cur = prev[field] ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [field]: next };
    });
    setActiveView('');
  };

  const clearCond = (field: FilterField) => {
    setConditions((prev) => ({ ...prev, [field]: [] }));
    setActiveView('');
  };

  const clearAll = () => {
    setConditions({});
    setActiveView('All');
    setFilterOpen(false);
  };

  const saveViewPrompt = () => {
    new TextPromptModal(app, { title: 'Save view as…', placeholder: 'e.g. Citadel P0/P1' }, (name) => {
      persistViews([...views.filter((v) => v.name !== name), { name, conditions }]);
      setActiveView(name);
    }).open();
  };

  const deleteView = (name: string) => {
    persistViews(views.filter((v) => v.name !== name));
    if (activeView === name) clearAll();
  };

  const visible = tasks.filter((t) => matchesConditions(t, conditions));
  const columns = COLUMNS.filter((c) => showClosed || !CLOSED.includes(c));
  const filtered = hasConditions(conditions);
  const valueLabel = (field: FilterField, v: string) =>
    field === 'status' ? COLUMN_LABELS[v] ?? v : v;

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header">
          <span className="lb-brand">Tasks</span>
          <div className="lb-pills">
            <button
              className={`lb-pill lb-filter-pill${activeView === 'All' ? ' lb-pill-active' : ''}`}
              onClick={clearAll}
            >
              All
            </button>
            {views.map((v) => (
              <button
                key={v.name}
                className={`lb-pill lb-filter-pill${activeView === v.name ? ' lb-pill-active' : ''}`}
                onClick={() => applyView(v)}
              >
                {v.name}
                <span
                  className="lb-view-x"
                  title="Delete view"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteView(v.name);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <button
            className={`lb-pill${filterOpen ? ' lb-pill-active' : ''}`}
            onClick={() => setFilterOpen((o) => !o)}
          >
            Filter{filtered ? ' •' : ''}
          </button>
          <label className="lb-toggle">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            Closed
          </label>
          <button className="mod-cta lb-new" onClick={() => setAdding(true)}>
            + New
          </button>
        </div>
        {filterOpen && (
          <div className="lb-filter-panel">
            {FILTER_FIELDS.map((f) => (
              <div key={f.key} className="lb-filter-field">
                <div className="lb-filter-field-name">{f.label}</div>
                {fieldValues[f.key].length === 0 && <div className="lb-filter-none">—</div>}
                {fieldValues[f.key].map((v) => (
                  <label key={v} className="lb-filter-option">
                    <input
                      type="checkbox"
                      checked={(conditions[f.key] ?? []).includes(v)}
                      onChange={() => toggleCond(f.key, v)}
                    />
                    {f.key === 'status' && <span className={`lb-dot lb-dot-${v}`} />}
                    {valueLabel(f.key, v)}
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
        {filtered && (
          <div className="lb-cond-row">
            {FILTER_FIELDS.filter((f) => (conditions[f.key]?.length ?? 0) > 0).map((f) => (
              <span key={f.key} className="lb-cond">
                <b>{f.label}</b>&nbsp;is {conditions[f.key]!.map((v) => valueLabel(f.key, v)).join(' or ')}
                <span className="lb-cond-x" onClick={() => clearCond(f.key)}>
                  ×
                </span>
              </span>
            ))}
            <button className="lb-pill" onClick={saveViewPrompt}>
              Save view
            </button>
            <button className="lb-pill" onClick={clearAll}>
              Clear
            </button>
          </div>
        )}
        <div className="lb-board">
          {columns.map((c) => (
            <Column
              key={c}
              app={app}
              status={c}
              allProjects={allProjects}
              allTags={allTags}
              allAssignees={allAssignees}
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
            allProjects={allProjects}
            allTags={allTags}
            allAssignees={allAssignees}
            onClose={() => setAdding(false)}
            refresh={refresh}
          />
        )}
      </div>
    </StrictMode>
  );
}

/* ---------------- Obsidian plumbing ---------------- */

interface LinearBoardSettings {
  views: SavedView[];
  openOnLaunch: 'never' | 'mobile' | 'always';
}

const DEFAULT_SETTINGS: LinearBoardSettings = { views: [], openOnLaunch: 'mobile' };

class LinearBoardSettingTab extends PluginSettingTab {
  plugin: LinearBoardPlugin;

  constructor(app: App, plugin: LinearBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('Open board on launch')
      .setDesc('Open the task board automatically when Obsidian starts.')
      .addDropdown((d) =>
        d
          .addOptions({ never: 'Never', mobile: 'On mobile only', always: 'Always' })
          .setValue(this.plugin.settings.openOnLaunch)
          .onChange(async (v) => {
            this.plugin.settings.openOnLaunch = v as LinearBoardSettings['openOnLaunch'];
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
}

class LinearBoardView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: LinearBoardPlugin) {
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
    this.root.render(<BoardApp app={this.app} plugin={this.plugin} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}

export default class LinearBoardPlugin extends Plugin {
  settings: LinearBoardSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new LinearBoardView(leaf, this));
    this.addSettingTab(new LinearBoardSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const mode = this.settings.openOnLaunch;
      if (mode === 'always' || (mode === 'mobile' && Platform.isMobile)) {
        void this.activateView();
      }
    });

    this.addRibbonIcon('kanban-square', 'Open task board', () => void this.activateView());

    this.addCommand({
      id: 'open-board',
      name: 'Open task board',
      callback: () => void this.activateView(),
    });
  }

  async saveViews(views: SavedView[]) {
    this.settings.views = views;
    await this.saveData(this.settings);
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
