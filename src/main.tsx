import {
  App,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  ViewStateResult,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from 'obsidian';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Root, createRoot } from 'react-dom/client';

const VIEW_TYPE = 'linear-board-view';
const PROJECTS_VIEW_TYPE = 'linear-projects-view';
const PROJECT_VIEW_TYPE = 'linear-project-view';
const TASKS_FOLDER = 'pm/tasks';
const TASKS_ACTIVE = 'pm/tasks/active';
const TASKS_INACTIVE = 'pm/tasks/inactive';
const PROJECTS_ACTIVE = 'pm/projects/active';
const PROJECTS_INACTIVE = 'pm/projects/inactive';
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
  icon?: string;
}

// Flat Lucide icons offered for saved-view pills (rendered via Obsidian's setIcon).
const VIEW_ICONS = [
  'flame',
  'bug',
  'star',
  'user',
  'briefcase',
  'home',
  'zap',
  'target',
  'calendar',
  'bookmark',
  'heart',
  'rocket',
];

const PROJECT_ICONS = [...VIEW_ICONS, 'package', 'map', 'music', 'book', 'users', 'wrench', 'globe', 'leaf'];

const PROJECT_COLORS = [
  '#5e6ad2',
  '#4ea7fc',
  '#26b5ce',
  '#27ae60',
  '#f2c94c',
  '#f2994a',
  '#eb5757',
  '#e84393',
  '#9b51e0',
  '#8a8f98',
];

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

interface ProjectInfo {
  icon: string | null;
  color: string | null;
}

interface Project {
  slug: string;
  status: 'active' | 'inactive';
  file: TFile | null; // null = folder exists but folder note is missing (malformed)
  description: string;
  icon: string | null;
  color: string | null;
  created: string | null;
}

function projectBase(p: Project): string {
  return p.status === 'active' ? PROJECTS_ACTIVE : PROJECTS_INACTIVE;
}

function loadProjects(app: App): Project[] {
  const out: Project[] = [];
  const scan = (base: string, status: 'active' | 'inactive') => {
    const folder = app.vault.getAbstractFileByPath(base);
    if (!(folder instanceof TFolder)) return;
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const note = app.vault.getAbstractFileByPath(`${base}/${child.name}/${child.name}.md`);
      if (note instanceof TFile) {
        const fm = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
        out.push({
          slug: child.name,
          status,
          file: note,
          description: typeof fm.description === 'string' ? fm.description : '',
          icon: typeof fm.icon === 'string' && fm.icon.trim() ? fm.icon.trim() : null,
          color: typeof fm.color === 'string' && fm.color.trim() ? fm.color.trim() : null,
          created: fm.created ? String(fm.created) : null,
        });
      } else {
        out.push({ slug: child.name, status, file: null, description: '', icon: null, color: null, created: null });
      }
    }
  };
  scan(PROJECTS_ACTIVE, 'active');
  scan(PROJECTS_INACTIVE, 'inactive');
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// The single writer for project structure: guarantees folder + folder note
// with complete frontmatter, creating or normalizing as needed.
async function writeProjectNote(
  app: App,
  slug: string,
  fields: { description: string; icon: string | null; color: string | null },
  base: string = PROJECTS_ACTIVE
): Promise<TFile> {
  const dir = `${base}/${slug}`;
  await ensureFolder(app, dir);
  const notePath = normalizePath(`${dir}/${slug}.md`);
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    await app.fileManager.processFrontMatter(existing, (fm) => {
      fm.type = 'project';
      fm.description = fields.description;
      fm.icon = fields.icon ?? '';
      fm.color = fields.color ?? '';
      if (!fm.created) fm.created = todayStr();
      if (!fm.origin) fm.origin = 'human';
      if (!fm.tags) fm.tags = [];
    });
    return existing;
  }
  return app.vault.create(
    notePath,
    [
      '---',
      'type: project',
      `description: ${fields.description}`,
      `icon: ${fields.icon ?? ''}`,
      `color: "${fields.color ?? ''}"`,
      `created: ${todayStr()}`,
      'origin: human',
      'tags: []',
      '---',
      '',
    ].join('\n')
  );
}

// Renames folder + folder note and re-points every task's project field.
async function renameProject(app: App, oldSlug: string, newSlug: string, base: string = PROJECTS_ACTIVE) {
  const dir = app.vault.getAbstractFileByPath(`${base}/${oldSlug}`);
  if (!(dir instanceof TFolder)) return;
  await app.fileManager.renameFile(dir, normalizePath(`${base}/${newSlug}`));
  const note = app.vault.getAbstractFileByPath(`${base}/${newSlug}/${oldSlug}.md`);
  if (note instanceof TFile) {
    await app.fileManager.renameFile(note, normalizePath(`${base}/${newSlug}/${newSlug}.md`));
  }
  for (const t of loadTasks(app)) {
    if (t.project === oldSlug) await setProp(app, t, 'project', newSlug);
  }
}

async function moveProject(app: App, slug: string, from: string, to: string) {
  await ensureFolder(app, to);
  const dir = app.vault.getAbstractFileByPath(`${from}/${slug}`);
  if (dir instanceof TFolder) {
    await app.fileManager.renameFile(dir, normalizePath(`${to}/${slug}`));
  }
}

const archiveProject = (app: App, slug: string) => moveProject(app, slug, PROJECTS_ACTIVE, PROJECTS_INACTIVE);
const restoreProject = (app: App, slug: string) => moveProject(app, slug, PROJECTS_INACTIVE, PROJECTS_ACTIVE);

// icon/color come from the project folder note's frontmatter (icon: lucide
// name, color: any CSS color). Includes archived projects so cards keep
// their styling.
function loadProjectInfos(app: App): Map<string, ProjectInfo> {
  const map = new Map<string, ProjectInfo>();
  for (const p of loadProjects(app)) {
    map.set(p.slug, { icon: p.icon, color: p.color });
  }
  return map;
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
      [
        '---',
        'type: project',
        'description:',
        'icon:',
        'color:',
        `created: ${todayStr()}`,
        'origin: human',
        'tags: []',
        '---',
        '',
      ].join('\n')
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

const ATTACH_FOLDER = 'pm/attachments';

// Append description and attachment embeds to a freshly created task note.
async function addBodyToTask(app: App, file: TFile, desc: string, files: File[]) {
  const embeds: string[] = [];
  if (files.length) await ensureFolder(app, ATTACH_FOLDER);
  const id = file.basename.split(' ')[0];
  for (const f of files) {
    const safe = f.name.replace(/[\\/:|#^\[\]"*?<>]/g, '-');
    let path = normalizePath(`${ATTACH_FOLDER}/${id} ${safe}`);
    if (app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${ATTACH_FOLDER}/${id} ${Math.random().toString(36).slice(2, 7)} ${safe}`);
    }
    await app.vault.createBinary(path, await f.arrayBuffer());
    embeds.push(`![[${path}]]`);
  }
  const parts: string[] = [];
  if (desc.trim()) parts.push(desc.trim());
  if (embeds.length) parts.push(embeds.join('\n'));
  if (parts.length) await app.vault.process(file, (data) => data + parts.join('\n\n') + '\n');
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

// Structural superset of React.MouseEvent so imperative modals can call the
// same menu helpers with a plain DOM event.
type ClickEvt = { stopPropagation: () => void; nativeEvent: MouseEvent };

const domEvt = (evt: MouseEvent): ClickEvt => ({ stopPropagation: () => {}, nativeEvent: evt });

class TextPromptModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; placeholder: string; slug?: boolean; initial?: string; cta?: string },
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
    if (this.opts.initial) {
      input.value = this.opts.initial;
      window.setTimeout(() => input.select(), 10);
    }
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
    const btn = row.createEl('button', { text: this.opts.cta ?? 'Add', cls: 'mod-cta' });
    btn.addEventListener('click', submit);
    window.setTimeout(() => input.focus(), 10);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SaveViewModal extends Modal {
  private icon: string | null;

  constructor(
    app: App,
    private opts: { title: string; initialName?: string; initialIcon?: string | null },
    private onSubmit: (name: string, icon: string | null) => void
  ) {
    super(app);
    this.icon = opts.initialIcon ?? null;
  }

  onOpen() {
    this.titleEl.setText(this.opts.title);
    const input = this.contentEl.createEl('input', { type: 'text', placeholder: 'View name…' });
    input.style.width = '100%';
    if (this.opts.initialName) input.value = this.opts.initialName;

    const iconRow = this.contentEl.createDiv({ cls: 'lb-icon-row' });
    const buttons = new Map<string, HTMLElement>();
    const paint = () => {
      for (const [ic, el] of buttons) el.toggleClass('lb-icon-selected', this.icon === ic);
    };
    for (const ic of VIEW_ICONS) {
      const b = iconRow.createEl('button', { cls: 'lb-icon-btn', attr: { 'aria-label': ic } });
      setIcon(b, ic);
      b.addEventListener('click', () => {
        this.icon = this.icon === ic ? null : ic;
        paint();
      });
      buttons.set(ic, b);
    }
    paint();

    const submit = () => {
      const v = input.value.trim();
      if (v) this.onSubmit(v, this.icon);
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const btn = row.createEl('button', { text: 'Save', cls: 'mod-cta' });
    btn.addEventListener('click', submit);
    window.setTimeout(() => input.focus(), 10);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Create/edit a project through code so the folder + folder note structure is
// always correct. Renaming re-points all tasks.
class ProjectModal extends Modal {
  private name: string;
  private description: string;
  private icon: string | null;
  private color: string | null;

  constructor(app: App, private existing: Project | null, private onDone: () => void) {
    super(app);
    this.name = existing?.slug ?? '';
    this.description = existing?.description ?? '';
    this.icon = existing?.icon ?? null;
    this.color = existing?.color ?? null;
  }

  onOpen() {
    this.modalEl.addClass('lb-edit-modal');
    this.titleEl.setText(this.existing ? `Edit project: ${this.existing.slug}` : 'New project');

    const name = this.contentEl.createEl('input', { type: 'text', placeholder: 'Project name (becomes folder slug)…' });
    name.style.width = '100%';
    name.value = this.name;
    name.addEventListener('input', () => (this.name = name.value));

    const desc = this.contentEl.createEl('textarea', {
      cls: 'lb-proj-desc-input',
      attr: { placeholder: 'One-line description…', rows: '2' },
    });
    desc.value = this.description;
    desc.addEventListener('input', () => (this.description = desc.value));

    const iconRow = this.contentEl.createDiv({ cls: 'lb-icon-row' });
    const iconBtns = new Map<string, HTMLElement>();
    const paintIcons = () => {
      for (const [ic, el] of iconBtns) el.toggleClass('lb-icon-selected', this.icon === ic);
    };
    for (const ic of PROJECT_ICONS) {
      const b = iconRow.createEl('button', { cls: 'lb-icon-btn', attr: { 'aria-label': ic } });
      setIcon(b, ic);
      b.addEventListener('click', () => {
        this.icon = this.icon === ic ? null : ic;
        paintIcons();
      });
      iconBtns.set(ic, b);
    }
    paintIcons();

    const swatchRow = this.contentEl.createDiv({ cls: 'lb-swatch-row' });
    const swatches = new Map<string, HTMLElement>();
    const custom = createEl('input', { type: 'text', attr: { placeholder: '#hex' } });
    const paintSwatches = () => {
      for (const [c, el] of swatches) el.toggleClass('lb-swatch-selected', this.color === c);
      if (custom.value !== (this.color ?? '')) custom.value = this.color ?? '';
    };
    for (const c of PROJECT_COLORS) {
      const b = swatchRow.createEl('button', { cls: 'lb-swatch', attr: { 'aria-label': c } });
      b.style.background = c;
      b.addEventListener('click', () => {
        this.color = this.color === c ? null : c;
        paintSwatches();
      });
      swatches.set(c, b);
    }
    custom.addClass('lb-swatch-custom');
    swatchRow.appendChild(custom);
    custom.addEventListener('input', () => {
      this.color = custom.value.trim() || null;
      for (const [c, el] of swatches) el.toggleClass('lb-swatch-selected', this.color === c);
    });
    paintSwatches();

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const save = actions.createEl('button', { text: this.existing ? 'Save' : 'Create project', cls: 'mod-cta' });
    save.addEventListener('click', () => void this.save());
  }

  async save() {
    const slug = this.name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\\/:|#^\[\]"*?<>]/g, '');
    if (!slug) {
      new Notice('Project needs a name');
      return;
    }
    const base = this.existing ? projectBase(this.existing) : PROJECTS_ACTIVE;
    if (this.existing) {
      if (slug !== this.existing.slug) await renameProject(this.app, this.existing.slug, slug, base);
    } else if (
      this.app.vault.getAbstractFileByPath(`${PROJECTS_ACTIVE}/${slug}`) ||
      this.app.vault.getAbstractFileByPath(`${PROJECTS_INACTIVE}/${slug}`)
    ) {
      new Notice(`Project "${slug}" already exists`);
      return;
    }
    await writeProjectNote(this.app, slug, {
      description: this.description.trim(),
      icon: this.icon,
      color: this.color,
    }, base);
    new Notice(this.existing ? `${slug} updated` : `Project ${slug} created`);
    this.onDone();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

interface PickerLists {
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
}

// Full task editor as a native Obsidian modal: works from the board, from a
// command inside the note, and on mobile (renders as a bottom sheet there).
class TaskEditModal extends Modal {
  private title: string;
  private status: string;
  private priority: string | null;
  private project: string | null;
  private size: string | null;
  private tags: string[];
  private assignee: string;
  private due: string;

  constructor(app: App, private task: TaskItem, private lists: PickerLists) {
    super(app);
    this.title = task.title;
    this.status = task.status;
    this.priority = task.priority;
    this.project = task.project;
    this.size = task.size;
    this.tags = [...task.tags];
    this.assignee = task.assignee;
    this.due = task.due ?? '';
  }

  onOpen() {
    this.modalEl.addClass('lb-edit-modal');
    this.titleEl.setText(`Edit ${this.task.id}`);

    const input = this.contentEl.createEl('input', { type: 'text', placeholder: 'Task title…' });
    input.style.width = '100%';
    input.value = this.title;
    input.addEventListener('input', () => (this.title = input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.save();
    });

    const row = this.contentEl.createDiv({ cls: 'lb-modal-row' });
    const pill = (render: () => string, open: (evt: MouseEvent, repaint: () => void) => void) => {
      const b = row.createEl('button', { cls: 'lb-pill' });
      const repaint = () => b.setText(render());
      repaint();
      b.addEventListener('click', (evt) => open(evt, repaint));
    };

    pill(
      () => COLUMN_LABELS[this.status],
      (evt, repaint) => {
        const menu = new Menu();
        for (const s of COLUMNS) {
          menu.addItem((i) =>
            i.setTitle(COLUMN_LABELS[s]).setChecked(this.status === s).onClick(() => {
              this.status = s;
              repaint();
            })
          );
        }
        menu.showAtMouseEvent(evt);
      }
    );
    pill(
      () => (this.priority ? `${this.priority} · ${PRIORITY_LABELS[this.priority]}` : 'Priority'),
      (evt, repaint) => {
        const menu = new Menu();
        for (const p of [...PRIORITIES, null]) {
          menu.addItem((i) =>
            i
              .setTitle(p ? `${p} · ${PRIORITY_LABELS[p]}` : 'No priority')
              .setChecked(this.priority === p)
              .onClick(() => {
                this.priority = p;
                repaint();
              })
          );
        }
        menu.showAtMouseEvent(evt);
      }
    );
    pill(
      () => this.project ?? 'Project *',
      (evt, repaint) =>
        projectMenu(this.app, this.lists.allProjects, this.project, (p) => {
          this.project = p;
          repaint();
        }, domEvt(evt))
    );
    pill(
      () => this.size ?? 'Size',
      (evt, repaint) =>
        sizeMenu(this.size, (s) => {
          this.size = s;
          repaint();
        }, domEvt(evt))
    );
    pill(
      () => (this.tags.length ? this.tags.join(', ') : 'Tags'),
      (evt, repaint) =>
        tagsMenu(this.app, this.lists.allTags, this.tags, (t) => {
          this.tags = t;
          repaint();
        }, domEvt(evt))
    );
    pill(
      () => `@${this.assignee}`,
      (evt, repaint) =>
        assigneeMenu(this.app, this.lists.allAssignees, this.assignee, (a) => {
          this.assignee = a;
          repaint();
        }, domEvt(evt))
    );

    const dueRow = this.contentEl.createDiv({ cls: 'lb-edit-due' });
    dueRow.createSpan({ text: 'Due' });
    const due = dueRow.createEl('input', { type: 'date' });
    due.value = this.due;
    due.addEventListener('input', () => (this.due = due.value));

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const save = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
    save.addEventListener('click', () => void this.save());
  }

  async save() {
    const t = this.task;
    if (!this.project) {
      new Notice('Pick a project — every task needs one');
      return;
    }
    await this.app.fileManager.processFrontMatter(t.file, (fm) => {
      fm.priority = this.priority ?? '';
      fm.project = this.project;
      fm.size = this.size ?? '';
      fm.tags = this.tags;
      delete fm.tag;
      fm.assignee = this.assignee;
      fm.due = this.due || '';
    });
    if (this.status !== t.status) await moveTask(this.app, t, this.status);
    const name = sanitizeName(this.title);
    if (name && name !== t.title) {
      await this.app.fileManager.renameFile(
        t.file,
        normalizePath(`${t.file.parent?.path ?? TASKS_ACTIVE}/${t.id} ${name}.md`)
      );
    }
    new Notice(`${t.id} updated`);
    this.close();
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
  e: ClickEvt
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
  e: ClickEvt
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

function sizeMenu(current: string | null, onPick: (size: string | null) => void, e: ClickEvt) {
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
  e: ClickEvt
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

function LucideIcon({ name }: { name: string }) {
  const ref = useCallback(
    (el: HTMLSpanElement | null) => {
      if (el) {
        el.textContent = '';
        setIcon(el, name);
      }
    },
    [name]
  );
  return <span className="lb-view-icon" ref={ref} />;
}

function Card({
  app,
  task,
  allProjects,
  allTags,
  allAssignees,
  projects,
  refresh,
}: {
  app: App;
  task: TaskItem;
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
  projects: Map<string, ProjectInfo>;
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

  const contextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('Edit…').setIcon('pencil').onClick(() => {
        new TaskEditModal(app, task, { allProjects, allTags, allAssignees }).open();
      })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('Delete').setIcon('trash').onClick(async () => {
        await app.vault.trash(task.file, true);
        new Notice(`${task.id} moved to trash`);
        refresh();
      })
    );
    menu.showAtMouseEvent(e.nativeEvent);
  };

  return (
    <div
      className="lb-card"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-path', task.path)}
      onClick={openNote}
      onContextMenu={contextMenu}
    >
      <div className="lb-card-top">
        <span className="lb-id">{task.id}</span>
        <span
          className={`lb-project${task.project ? '' : ' lb-project-empty'}`}
          style={
            task.project && projects.get(task.project)?.color
              ? ({ '--proj-color': projects.get(task.project)!.color } as React.CSSProperties)
              : undefined
          }
          onClick={(e) =>
            projectMenu(app, allProjects, task.project, async (p) => {
              await setProp(app, task, 'project', p);
              refresh();
            }, e)
          }
          title="Set project"
        >
          {task.project && projects.get(task.project)?.icon && (
            <LucideIcon name={projects.get(task.project)!.icon!} />
          )}
          <span className="lb-project-name">{task.project ?? 'no project'}</span>
        </span>
        {task.origin === 'ai' && (
          <span className="lb-origin-ai" title="Created by AI">
            ai
          </span>
        )}
        {task.assignee !== DEFAULT_ASSIGNEE && (
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
        )}
      </div>
      <div className="lb-title">{task.title}</div>
      <div className="lb-meta">
        <span
          className={`lb-priority lb-priority-${(task.priority ?? 'none').toLowerCase()}`}
          onClick={priorityMenu}
          title={task.priority ? `${task.priority} · ${PRIORITY_LABELS[task.priority]}` : 'Set priority'}
        >
          {task.priority
            ? [1, 2, 3, 4].map((n) => (
                <span key={n} className={`lb-bar${n <= PRIORITY_LEVEL[task.priority!] ? ' lb-bar-on' : ''}`} />
              ))
            : [1, 2, 3].map((n) => <span key={n} className="lb-dash" />)}
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
          className="lb-tag lb-tag-add lb-fade-in"
          onClick={(e) =>
            tagsMenu(app, allTags, task.tags, async (tags) => {
              await setTags(app, task, tags);
              refresh();
            }, e)
          }
          title="Add tag"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </svg>
        </span>
        {task.due && <span className="lb-due">{task.due}</span>}
        <span className="lb-move" onClick={statusMenu} title="Move to…">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m16 3 4 4-4 4" />
            <path d="M20 7H4" />
            <path d="m8 21-4-4 4-4" />
            <path d="M4 17h16" />
          </svg>
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
  projects,
  refresh,
}: {
  app: App;
  status: string;
  tasks: TaskItem[];
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
  projects: Map<string, ProjectInfo>;
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
            projects={projects}
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
  fixedProject,
  onClose,
  refresh,
}: {
  app: App;
  tasks: TaskItem[];
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
  fixedProject?: string;
  onClose: () => void;
  refresh: () => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState('today');
  const [priority, setPriority] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(fixedProject ?? null);
  const [size, setSize] = useState<string | null>(null);
  const [tags, setTagsState] = useState<string[]>([]);
  const [assignee, setAssignee] = useState(DEFAULT_ASSIGNEE);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [missingProject, setMissingProject] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!title.trim()) return;
    if (!project) {
      setMissingProject(true);
      new Notice('Pick a project — every task needs one');
      return;
    }
    const file = await createTask(app, tasks, { title: title.trim(), status, priority, project, size, tags, assignee });
    await addBodyToTask(app, file, desc, attachments);
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
      <div className={`lb-modal${expanded ? ' lb-modal-expanded' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="lb-modal-head">
          <div className="lb-modal-hint">New task</div>
          <button
            className="lb-modal-iconbtn"
            onClick={() => setExpanded((x) => !x)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <LucideIcon name={expanded ? 'minimize-2' : 'maximize-2'} />
          </button>
        </div>
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
        <textarea
          className="lb-modal-desc"
          placeholder="Add description…"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        {attachments.length > 0 && (
          <div className="lb-modal-files">
            {attachments.map((f, i) => (
              <span key={`${f.name}-${i}`} className="lb-tag">
                {f.name}
                <span
                  className="lb-cond-x"
                  onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
        )}
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
          <input
            type="file"
            multiple
            style={{ display: 'none' }}
            ref={fileInput}
            onChange={(e) => {
              setAttachments([...attachments, ...Array.from(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button
            className="lb-pill lb-attach"
            onClick={() => fileInput.current?.click()}
            title="Attach files"
          >
            <LucideIcon name="paperclip" />
          </button>
          <span className="lb-modal-kbd">↵ to create · esc to close</span>
          <button className="mod-cta" onClick={() => void submit()}>
            Create task
          </button>
        </div>
      </div>
    </div>
  );
}

function useVaultTick(app: App): [number, () => void] {
  const [tick, setTick] = useState(0);
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
  return [tick, refresh];
}

function pickerLists(app: App, tasks: TaskItem[]): PickerLists {
  return {
    allProjects: [
      ...new Set([...listProjects(app), ...tasks.map((t) => t.project).filter((p): p is string => !!p)]),
    ].sort(),
    allTags: [...new Set([...loadTagRegistry(app), ...tasks.flatMap((t) => t.tags)])].sort(),
    allAssignees: [...new Set([DEFAULT_ASSIGNEE, ...tasks.map((t) => t.assignee)])].sort(),
  };
}

function ProjectChip({ project, size }: { project: Project; size?: 'lg' }) {
  return (
    <span
      className={`lb-project${size === 'lg' ? ' lb-project-lg' : ''}`}
      style={project.color ? ({ '--proj-color': project.color } as React.CSSProperties) : undefined}
    >
      {project.icon && <LucideIcon name={project.icon} />}
      <span className="lb-project-name">{project.slug}</span>
    </span>
  );
}

// Rendered above a task note's content, replacing the raw Properties list:
// navigation back to board/project plus live-editing pills for every field.
function NoteBanner({ app, plugin, file }: { app: App; plugin: LinearBoardPlugin; file: TFile }) {
  const [tick, refresh] = useVaultTick(app);
  const tasks = useMemo(() => loadTasks(app), [app, tick]);
  const projects = useMemo(() => loadProjectInfos(app), [app, tick]);
  const lists = useMemo(() => pickerLists(app, tasks), [app, tasks]);
  const task = tasks.find((t) => t.path === file.path);
  if (!task) return null;
  const proj = task.project ? projects.get(task.project) : undefined;

  const statusMenu = (e: React.MouseEvent) => {
    const menu = new Menu();
    for (const s of COLUMNS) {
      menu.addItem((i) =>
        i.setTitle(COLUMN_LABELS[s]).setChecked(task.status === s).onClick(async () => {
          await moveTask(app, task, s);
          refresh();
        })
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  const priorityMenu = (e: React.MouseEvent) => {
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

  const changeTags = (e: React.MouseEvent) =>
    tagsMenu(app, lists.allTags, task.tags, async (tags) => {
      await setTags(app, task, tags);
      refresh();
    }, e);

  return (
    <>
      <button className="lb-pill" onClick={() => void plugin.activateView()} title="Open task board">
        <LucideIcon name="kanban-square" />
        Board
      </button>
      {task.project ? (
        <span
          className="lb-project"
          style={proj?.color ? ({ '--proj-color': proj.color } as React.CSSProperties) : undefined}
          onClick={() => void plugin.openProject(task.project!)}
          title="Open project"
        >
          {proj?.icon && <LucideIcon name={proj.icon} />}
          <span className="lb-project-name">{task.project}</span>
        </span>
      ) : (
        <span
          className="lb-project lb-project-empty"
          onClick={(e) =>
            projectMenu(app, lists.allProjects, null, async (p) => {
              await setProp(app, task, 'project', p);
              refresh();
            }, e)
          }
        >
          no project
        </span>
      )}
      <span className="lb-id">{task.id}</span>
      <button className="lb-pill" onClick={statusMenu} title="Status">
        <span className={`lb-dot lb-dot-${task.status}`} /> {COLUMN_LABELS[task.status]}
      </button>
      <span
        className={`lb-priority lb-priority-${(task.priority ?? 'none').toLowerCase()}`}
        onClick={priorityMenu}
        title={task.priority ? `${task.priority} · ${PRIORITY_LABELS[task.priority]}` : 'Set priority'}
      >
        {task.priority
          ? [1, 2, 3, 4].map((n) => (
              <span key={n} className={`lb-bar${n <= PRIORITY_LEVEL[task.priority!] ? ' lb-bar-on' : ''}`} />
            ))
          : [1, 2, 3].map((n) => <span key={n} className="lb-dash" />)}
      </span>
      <span
        className="lb-size"
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
        <span key={tag} className="lb-tag" onClick={changeTags}>
          {tag}
        </span>
      ))}
      <span className="lb-tag lb-tag-add" onClick={changeTags} title="Add tag">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      </span>
      <button
        className="lb-pill"
        onClick={(e) =>
          assigneeMenu(app, lists.allAssignees, task.assignee, async (a) => {
            await setProp(app, task, 'assignee', a);
            refresh();
          }, e)
        }
        title="Assignee"
      >
        @{task.assignee}
      </button>
      {task.due && <span className="lb-due">Due {task.due}</span>}
      <span className="lb-banner-spacer" />
      <button className="lb-pill" onClick={() => new TaskEditModal(app, task, lists).open()}>
        <LucideIcon name="pencil" />
        Edit
      </button>
    </>
  );
}

function ProjectsApp({ app, plugin }: { app: App; plugin: LinearBoardPlugin }) {
  const [tick, refresh] = useVaultTick(app);
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const allProjects = useMemo(() => loadProjects(app), [app, tick]);
  const projects = allProjects.filter((p) => statusFilter === 'all' || p.status === statusFilter);
  const tasks = useMemo(() => loadTasks(app), [app, tick]);

  const counts = (slug: string) => {
    const mine = tasks.filter((t) => t.project === slug);
    const done = mine.filter((t) => t.status === 'done').length;
    const open = mine.filter((t) => !CLOSED.includes(t.status)).length;
    const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
    return { open, done, pct };
  };

  const rowMenu = (p: Project, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('Edit…').setIcon('pencil').onClick(() => new ProjectModal(app, p, refresh).open())
    );
    menu.addItem((i) =>
      i.setTitle('Open note').setIcon('file-text').onClick(() => {
        if (p.file) void app.workspace.getLeaf('tab').openFile(p.file);
      })
    );
    menu.addSeparator();
    if (p.status === 'active') {
      menu.addItem((i) =>
        i.setTitle('Archive').setIcon('archive').onClick(async () => {
          await archiveProject(app, p.slug);
          new Notice(`${p.slug} archived`);
          refresh();
        })
      );
    } else {
      menu.addItem((i) =>
        i.setTitle('Restore').setIcon('archive-restore').onClick(async () => {
          await restoreProject(app, p.slug);
          new Notice(`${p.slug} restored`);
          refresh();
        })
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  const filterPill = (key: 'active' | 'inactive' | 'all', label: string) => (
    <button
      key={key}
      className={`lb-pill lb-filter-pill${statusFilter === key ? ' lb-pill-active' : ''}`}
      onClick={() => setStatusFilter(key)}
    >
      {label}
    </button>
  );

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header lb-header-top">
          <div className="lb-seg">
            <button onClick={() => void plugin.activateView()}>
              <LucideIcon name="kanban-square" />
              Tasks
            </button>
            <button className="lb-seg-active">
              <LucideIcon name="package" />
              Projects
            </button>
          </div>
          <button className="mod-cta lb-new" onClick={() => new ProjectModal(app, null, refresh).open()}>
            + New project
          </button>
        </div>
        <div className="lb-header">
          <div className="lb-pills">
            {filterPill('active', 'Active')}
            {filterPill('inactive', 'Archived')}
            {filterPill('all', 'All')}
          </div>
        </div>
        <div className="lb-projects">
          <div className="lb-projrow lb-projrow-head">
            <span className="lb-projname-col">Name</span>
            <span className="lb-projdesc">Description</span>
            <span className="lb-projcount">Open</span>
            <span className="lb-projcount">Done</span>
            <span className="lb-projcount">%</span>
            <span className="lb-projcount lb-projcreated">Created</span>
          </div>
          {projects.map((p) => {
            const c = counts(p.slug);
            return (
              <div
                key={`${p.status}/${p.slug}`}
                className={`lb-projrow${p.status === 'inactive' ? ' lb-projrow-archived' : ''}`}
                onClick={() => void plugin.openProject(p.slug)}
                onContextMenu={(e) => rowMenu(p, e)}
              >
                <span className="lb-projname-col">
                  <ProjectChip project={p} />
                  {p.status === 'inactive' && <span className="lb-archived-badge">archived</span>}
                </span>
                <span className="lb-projdesc">
                  {p.file === null ? (
                    <button
                      className="lb-pill lb-pill-required"
                      onClick={(e) => {
                        e.stopPropagation();
                        void writeProjectNote(app, p.slug, { description: '', icon: null, color: null }, projectBase(p)).then(refresh);
                      }}
                    >
                      Missing folder note — fix structure
                    </button>
                  ) : (
                    p.description
                  )}
                </span>
                <span className="lb-projcount">{c.open}</span>
                <span className="lb-projcount">{c.done}</span>
                <span className="lb-projcount">{c.pct}%</span>
                <span className="lb-projcount lb-projcreated">{p.created ?? ''}</span>
              </div>
            );
          })}
          {projects.length === 0 && (
            <div className="lb-empty">No projects yet — create the first one.</div>
          )}
        </div>
      </div>
    </StrictMode>
  );
}

function ProjectApp({ app, plugin, slug }: { app: App; plugin: LinearBoardPlugin; slug: string }) {
  const [tick, refresh] = useVaultTick(app);
  const [adding, setAdding] = useState(false);
  const allTasks = useMemo(() => loadTasks(app), [app, tick]);
  const projects = useMemo(() => loadProjects(app), [app, tick]);
  const project = projects.find((p) => p.slug === slug);
  const lists = useMemo(() => pickerLists(app, allTasks), [app, allTasks]);
  const mine = allTasks
    .filter((t) => t.project === slug)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id.localeCompare(b.id));

  if (!slug || !project) {
    return (
      <StrictMode>
        <div className="lb-root">
          <div className="lb-empty">Project "{slug}" not found under {PROJECTS_ACTIVE}/.</div>
        </div>
      </StrictMode>
    );
  }

  const taskRowMenu = (t: TaskItem, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('Edit…').setIcon('pencil').onClick(() => new TaskEditModal(app, t, lists).open())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('Delete').setIcon('trash').onClick(async () => {
        await app.vault.trash(t.file, true);
        refresh();
      })
    );
    menu.showAtMouseEvent(e.nativeEvent);
  };

  const sections = COLUMNS.map((c) => ({ status: c, items: mine.filter((t) => t.status === c) })).filter(
    (s) => s.items.length > 0
  );

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-proj-head">
          <div className="lb-proj-title-row">
            <ProjectChip project={project} size="lg" />
            <div className="lb-proj-actions">
              <button className="lb-pill" onClick={() => new ProjectModal(app, project, refresh).open()}>
                Edit
              </button>
              <button
                className="lb-pill"
                onClick={() => project.file && void app.workspace.getLeaf('tab').openFile(project.file)}
              >
                Open note
              </button>
              <button
                className="lb-pill"
                onClick={async () => {
                  if (project.status === 'active') {
                    await archiveProject(app, slug);
                    new Notice(`${slug} archived`);
                  } else {
                    await restoreProject(app, slug);
                    new Notice(`${slug} restored`);
                  }
                  refresh();
                }}
              >
                {project.status === 'active' ? 'Archive' : 'Restore'}
              </button>
              <button className="mod-cta lb-new" onClick={() => setAdding(true)}>
                + New task
              </button>
            </div>
          </div>
          {project.description && <div className="lb-proj-desc">{project.description}</div>}
        </div>
        <div className="lb-proj-body">
          {sections.map((s) => (
            <div key={s.status}>
              <div className="lb-section-title">
                <span className={`lb-dot lb-dot-${s.status}`} />
                {COLUMN_LABELS[s.status]}
                <span className="lb-count">{s.items.length}</span>
              </div>
              {s.items.map((t) => (
                <div
                  key={t.path}
                  className="lb-taskrow"
                  onClick={() => void app.workspace.getLeaf('tab').openFile(t.file)}
                  onContextMenu={(e) => taskRowMenu(t, e)}
                >
                  <span className="lb-id">{t.id}</span>
                  <span className="lb-taskrow-title">{t.title}</span>
                  {t.priority && (
                    <span className={`lb-priority lb-priority-${t.priority.toLowerCase()}`}>
                      {[1, 2, 3, 4].map((n) => (
                        <span key={n} className={`lb-bar${n <= PRIORITY_LEVEL[t.priority!] ? ' lb-bar-on' : ''}`} />
                      ))}
                    </span>
                  )}
                  {t.size && <span className="lb-size">{t.size}</span>}
                  {t.due && <span className="lb-due">{t.due}</span>}
                  {t.assignee !== DEFAULT_ASSIGNEE && (
                    <span className="lb-avatar" style={{ background: avatarColor(t.assignee) }}>
                      {t.assignee.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          {mine.length === 0 && <div className="lb-empty">No tasks in this project yet.</div>}
        </div>
        {adding && (
          <QuickAdd
            app={app}
            tasks={allTasks}
            allProjects={lists.allProjects}
            allTags={lists.allTags}
            allAssignees={lists.allAssignees}
            fixedProject={slug}
            onClose={() => setAdding(false)}
            refresh={refresh}
          />
        )}
      </div>
    </StrictMode>
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
  const projectInfos = useMemo(() => loadProjectInfos(app), [app, tick]);

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
    new SaveViewModal(app, { title: 'Save view as…' }, (name, icon) => {
      persistViews([...views.filter((v) => v.name !== name), { name, conditions, icon: icon ?? undefined }]);
      setActiveView(name);
    }).open();
  };

  const deleteView = (name: string) => {
    persistViews(views.filter((v) => v.name !== name));
    if (activeView === name) clearAll();
  };

  const updateView = (name: string, patch: Partial<SavedView>) => {
    persistViews(views.map((v) => (v.name === name ? { ...v, ...patch } : v)));
    if (patch.name && activeView === name) setActiveView(patch.name);
  };

  const viewContextMenu = (v: SavedView, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('Edit…').setIcon('pencil').onClick(() => {
        new SaveViewModal(
          app,
          { title: 'Edit view', initialName: v.name, initialIcon: v.icon ?? null },
          (name, icon) => updateView(v.name, { name, icon: icon ?? undefined })
        ).open();
      })
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Delete').setIcon('trash').onClick(() => deleteView(v.name)));
    menu.showAtMouseEvent(e.nativeEvent);
  };

  const visible = tasks.filter((t) => matchesConditions(t, conditions));
  const columns = COLUMNS.filter((c) => showClosed || !CLOSED.includes(c));
  const filtered = hasConditions(conditions);
  const valueLabel = (field: FilterField, v: string) =>
    field === 'status' ? COLUMN_LABELS[v] ?? v : v;

  const displayMenu = (e: React.MouseEvent) => {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle('Show closed columns')
        .setChecked(showClosed)
        .onClick(() => setShowClosed((v) => !v))
    );
    menu.showAtMouseEvent(e.nativeEvent);
  };

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header lb-header-top">
          <div className="lb-seg">
            <button className="lb-seg-active">
              <LucideIcon name="kanban-square" />
              Tasks
            </button>
            <button onClick={() => void plugin.openProjectsView()}>
              <LucideIcon name="package" />
              Projects
            </button>
          </div>
          <button className="mod-cta lb-new" onClick={() => setAdding(true)}>
            + New
          </button>
        </div>
        <div className="lb-header">
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
                onContextMenu={(e) => viewContextMenu(v, e)}
              >
                {v.icon && <LucideIcon name={v.icon} />}
                {v.name}
              </button>
            ))}
          </div>
          <button
            className={`lb-pill lb-filter-btn${filterOpen ? ' lb-pill-active' : ''}`}
            onClick={() => setFilterOpen((o) => !o)}
          >
            <LucideIcon name="plus" />
            Filter{filtered ? ' •' : ''}
          </button>
          <button className="lb-pill lb-display" onClick={displayMenu}>
            <LucideIcon name="sliders-horizontal" />
            Display
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
              projects={projectInfos}
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

class ProjectsListView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: LinearBoardPlugin) {
    super(leaf);
  }

  getViewType() {
    return PROJECTS_VIEW_TYPE;
  }
  getDisplayText() {
    return 'Projects';
  }
  getIcon() {
    return 'package';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('lb-view');
    this.root = createRoot(this.contentEl);
    this.root.render(<ProjectsApp app={this.app} plugin={this.plugin} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}

class ProjectDetailView extends ItemView {
  root: Root | null = null;
  slug = '';

  constructor(leaf: WorkspaceLeaf, private plugin: LinearBoardPlugin) {
    super(leaf);
  }

  getViewType() {
    return PROJECT_VIEW_TYPE;
  }
  getDisplayText() {
    return this.slug || 'Project';
  }
  getIcon() {
    return 'package';
  }

  async setState(state: unknown, result: ViewStateResult) {
    this.slug = (state as { slug?: string } | null)?.slug ?? '';
    this.renderApp();
    await super.setState(state, result);
  }

  getState() {
    return { slug: this.slug };
  }

  renderApp() {
    this.root?.render(<ProjectApp app={this.app} plugin={this.plugin} slug={this.slug} />);
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('lb-view');
    this.root = createRoot(this.contentEl);
    this.renderApp();
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
    this.registerView(PROJECTS_VIEW_TYPE, (leaf) => new ProjectsListView(leaf, this));
    this.registerView(PROJECT_VIEW_TYPE, (leaf) => new ProjectDetailView(leaf, this));
    this.addSettingTab(new LinearBoardSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const mode = this.settings.openOnLaunch;
      if (mode === 'always' || (mode === 'mobile' && Platform.isMobile)) {
        void this.activateView();
      }
      this.decorateMarkdownLeaves();
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => this.decorateMarkdownLeaves()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.decorateMarkdownLeaves()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.decorateMarkdownLeaves()));

    this.addRibbonIcon('kanban-square', 'Open task board', () => void this.activateView());
    this.addRibbonIcon('package', 'Open projects', () => void this.openProjectsView());

    this.addCommand({
      id: 'open-board',
      name: 'Open task board',
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: 'open-projects',
      name: 'Open projects',
      callback: () => void this.openProjectsView(),
    });

    this.addCommand({
      id: 'edit-task',
      name: 'Edit task',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !f.path.startsWith(TASKS_FOLDER + '/')) return false;
        if (this.app.metadataCache.getFileCache(f)?.frontmatter?.type !== 'task') return false;
        if (!checking) {
          const tasks = loadTasks(this.app);
          const task = tasks.find((t) => t.path === f.path);
          if (!task) return;
          new TaskEditModal(this.app, task, {
            allProjects: [
              ...new Set([...listProjects(this.app), ...tasks.map((t) => t.project).filter((p): p is string => !!p)]),
            ].sort(),
            allTags: [...new Set([...loadTagRegistry(this.app), ...tasks.flatMap((t) => t.tags)])].sort(),
            allAssignees: [...new Set([DEFAULT_ASSIGNEE, ...tasks.map((t) => t.assignee)])].sort(),
          }).open();
        }
        return true;
      },
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

  // Task notes get a banner with navigation + field pills instead of the raw
  // Properties list (hidden via the lb-task-note class).
  decorateMarkdownLeaves() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView) this.decorateView(view);
    }
  }

  decorateView(view: MarkdownView) {
    const file = view.file;
    const content = view.contentEl;
    const isTask =
      !!file &&
      file.path.startsWith(TASKS_FOLDER + '/') &&
      this.app.metadataCache.getFileCache(file)?.frontmatter?.type === 'task';
    content.toggleClass('lb-task-note', isTask);
    let banner = content.querySelector(':scope > .lb-note-banner') as
      | (HTMLElement & { __lbRoot?: Root })
      | null;
    if (!isTask) {
      banner?.__lbRoot?.unmount();
      banner?.remove();
      return;
    }
    if (!banner) {
      banner = createDiv({ cls: 'lb-note-banner' }) as HTMLElement & { __lbRoot?: Root };
      content.prepend(banner);
      banner.__lbRoot = createRoot(banner);
    }
    banner.__lbRoot!.render(<NoteBanner app={this.app} plugin={this} file={file!} />);
  }

  removeBanners() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const content = leaf.view?.contentEl;
      if (!content) continue;
      const banner = content.querySelector(':scope > .lb-note-banner') as
        | (HTMLElement & { __lbRoot?: Root })
        | null;
      banner?.__lbRoot?.unmount();
      banner?.remove();
      content.removeClass('lb-task-note');
    }
  }

  async openProjectsView() {
    const existing = this.app.workspace.getLeavesOfType(PROJECTS_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: PROJECTS_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openProject(slug: string) {
    const existing = this.app.workspace
      .getLeavesOfType(PROJECT_VIEW_TYPE)
      .find((l) => (l.view as ProjectDetailView).slug === slug);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: PROJECT_VIEW_TYPE, active: true, state: { slug } });
    this.app.workspace.revealLeaf(leaf);
  }

  onunload() {
    this.removeBanners();
  }
}
