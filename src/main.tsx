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

const VIEW_TYPE = 'task-board-view';
const PROJECTS_VIEW_TYPE = 'task-board-projects-view';
const PROJECT_VIEW_TYPE = 'task-board-project-view';
const SPACES_VIEW_TYPE = 'task-board-spaces-view';
const TAGS_VIEW_TYPE = 'task-board-tags-view';

// Overview tabs stay docked leftmost in this order; other tabs flow right.
const PINNED_VIEW_ORDER = [SPACES_VIEW_TYPE, PROJECTS_VIEW_TYPE, VIEW_TYPE, TAGS_VIEW_TYPE];
// Vault layout + identity — configurable in Settings; applyConfig() derives
// every path from the root folder so they can never drift apart.
let TASKS_FOLDER = 'pm/tasks';
let TASKS_ACTIVE = 'pm/tasks/active';
let TASKS_INACTIVE = 'pm/tasks/inactive';
let PROJECTS_ACTIVE = 'pm/projects/active';
let PROJECTS_INACTIVE = 'pm/projects/inactive';
let SPACES_FOLDER = 'pm/spaces';
let TAGS_FILE = 'pm/tags.md';
let ATTACH_FOLDER = 'pm/attachments';
let DEFAULT_ASSIGNEE = 'me';
let ID_PREFIX = 'T';

function applyConfig(s: { rootFolder: string; idPrefix: string; defaultAssignee: string }) {
  const root = normalizePath((s.rootFolder || 'pm').replace(/\/+$/, ''));
  TASKS_FOLDER = `${root}/tasks`;
  TASKS_ACTIVE = `${root}/tasks/active`;
  TASKS_INACTIVE = `${root}/tasks/inactive`;
  PROJECTS_ACTIVE = `${root}/projects/active`;
  PROJECTS_INACTIVE = `${root}/projects/inactive`;
  SPACES_FOLDER = `${root}/spaces`;
  TAGS_FILE = `${root}/tags.md`;
  ATTACH_FOLDER = `${root}/attachments`;
  ID_PREFIX = (s.idPrefix || 'T').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'T';
  DEFAULT_ASSIGNEE = slugify(s.defaultAssignee || 'me') || 'me';
}

const COLUMNS = ['agent-inbox', 'backlog', 'this-week', 'today', 'waiting', 'done', 'cancelled'] as const;
const CLOSED = ['done', 'cancelled'];
// Soft-delete: status 'deleted' + archived to inactive/. Never a board lane;
// recoverable by giving the note a live status again (e.g. via its banner).
const DELETED_STATUS = 'deleted';
const COLUMN_LABELS: Record<string, string> = {
  'agent-inbox': 'Inbox',
  backlog: 'Backlog',
  'this-week': 'This week',
  today: 'Today',
  waiting: 'Waiting',
  done: 'Done',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
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
  created: string | null;
  started: string | null;
  completed: string | null;
  assignee: string;
  origin: 'human' | 'ai';
  space: string | null; // derived: the task's project's space
}

/* ---------------- filters ---------------- */

const FILTER_FIELDS = [
  { key: 'space', label: 'Space' },
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
  const projectInfos = loadProjectInfos(app);
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(TASKS_FOLDER + '/')) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== 'task') continue;
    const id = typeof fm.id === 'string' ? fm.id : file.basename.split(' ')[0];
    const project = parseProject(fm.project);
    tasks.push({
      file,
      path: file.path,
      id,
      title: file.basename.replace(new RegExp(`^${ID_PREFIX}-\\d+\\s*`), ''),
      status: typeof fm.status === 'string' && fm.status ? fm.status : 'backlog',
      priority: typeof fm.priority === 'string' && fm.priority ? fm.priority : null,
      project,
      space: project ? projectInfos.get(project)?.space ?? null : null,
      tags: parseTags(fm),
      size:
        typeof fm.size === 'string' && SIZES.includes(fm.size.toUpperCase() as (typeof SIZES)[number])
          ? fm.size.toUpperCase()
          : null,
      due: fm.due ? String(fm.due) : null,
      created: fm.created ? String(fm.created) : null,
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
    const m = t.id.match(new RegExp(`^${ID_PREFIX}-(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${ID_PREFIX}-` + String(max + 1).padStart(3, '0');
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
  return CLOSED.includes(status) || status === DELETED_STATUS ? TASKS_INACTIVE : TASKS_ACTIVE;
}

const softDeleteTask = (app: App, task: TaskItem) => moveTask(app, task, DELETED_STATUS);

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
  return loadProjects(app)
    .filter((p) => p.status === 'active')
    .map((p) => p.slug)
    .sort();
}

interface ProjectInfo {
  icon: string | null;
  color: string | null;
  space: string | null;
}

/* ---------------- spaces ---------------- */

interface Space {
  slug: string;
  file: TFile;
  description: string;
  icon: string | null;
  color: string | null;
}

function loadSpaces(app: App): Space[] {
  const out: Space[] = [];
  const folder = app.vault.getAbstractFileByPath(SPACES_FOLDER);
  if (!(folder instanceof TFolder)) return out;
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== 'md') continue;
    const fm = app.metadataCache.getFileCache(child)?.frontmatter;
    if (fm?.type !== 'space') continue;
    out.push({
      slug: child.basename,
      file: child,
      description: typeof fm.description === 'string' ? fm.description : '',
      icon: typeof fm.icon === 'string' && fm.icon.trim() ? fm.icon.trim() : null,
      color: typeof fm.color === 'string' && fm.color.trim() ? fm.color.trim() : null,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// Creating a space also creates its project folder and a catch-all project,
// so the space is immediately usable.
async function writeSpaceNote(
  app: App,
  slug: string,
  fields: { description: string; icon: string | null; color: string | null }
): Promise<TFile> {
  await ensureFolder(app, SPACES_FOLDER);
  const notePath = normalizePath(`${SPACES_FOLDER}/${slug}.md`);
  const existing = app.vault.getAbstractFileByPath(notePath);
  let file: TFile;
  if (existing instanceof TFile) {
    await app.fileManager.processFrontMatter(existing, (fm) => {
      fm.type = 'space';
      fm.description = fields.description;
      fm.icon = fields.icon ?? '';
      fm.color = fields.color ?? '';
      if (!fm.created) fm.created = todayStr();
    });
    file = existing;
  } else {
    file = await app.vault.create(
      notePath,
      [
        '---',
        'type: space',
        `description: ${fields.description}`,
        `icon: ${fields.icon ?? ''}`,
        `color: "${fields.color ?? ''}"`,
        `created: ${todayStr()}`,
        '---',
        '',
      ].join('\n')
    );
    await ensureFolder(app, `${PROJECTS_ACTIVE}/${slug}`);
    await writeProjectNote(
      app,
      `${slug}-general`,
      { description: 'Catch-all — peel real projects out of here', icon: null, color: fields.color },
      `${PROJECTS_ACTIVE}/${slug}`
    );
  }
  return file;
}

// Rename space note + its folder under active/inactive. Project slugs are
// unchanged, so tasks need no re-pointing.
async function renameSpace(app: App, oldSlug: string, newSlug: string) {
  const note = app.vault.getAbstractFileByPath(`${SPACES_FOLDER}/${oldSlug}.md`);
  if (note instanceof TFile) {
    await app.fileManager.renameFile(note, normalizePath(`${SPACES_FOLDER}/${newSlug}.md`));
  }
  for (const root of [PROJECTS_ACTIVE, PROJECTS_INACTIVE]) {
    const dir = app.vault.getAbstractFileByPath(`${root}/${oldSlug}`);
    if (dir instanceof TFolder) {
      await app.fileManager.renameFile(dir, normalizePath(`${root}/${newSlug}`));
    }
  }
}

interface Project {
  slug: string;
  space: string | null; // parent space folder; null = unspaced (legacy/transition)
  status: 'active' | 'inactive';
  file: TFile | null; // null = folder exists but folder note is missing (malformed)
  description: string;
  icon: string | null;
  color: string | null;
  created: string | null;
}

// Directory CONTAINING the project folder (status root + optional space).
function projectBase(p: Project): string {
  const root = p.status === 'active' ? PROJECTS_ACTIVE : PROJECTS_INACTIVE;
  return p.space ? `${root}/${p.space}` : root;
}

// Projects live at <root>/<space>/<project>/. A folder directly under the
// root that has its own folder note is treated as an unspaced project
// (transition state); otherwise a depth-1 folder is a space folder.
function loadProjects(app: App): Project[] {
  const out: Project[] = [];
  const spaceSlugs = new Set(loadSpaces(app).map((s) => s.slug));
  const pushProject = (base: string, name: string, space: string | null, status: 'active' | 'inactive') => {
    const note = app.vault.getAbstractFileByPath(`${base}/${name}/${name}.md`);
    if (note instanceof TFile) {
      const fm = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
      out.push({
        slug: name,
        space,
        status,
        file: note,
        description: typeof fm.description === 'string' ? fm.description : '',
        icon: typeof fm.icon === 'string' && fm.icon.trim() ? fm.icon.trim() : null,
        color: typeof fm.color === 'string' && fm.color.trim() ? fm.color.trim() : null,
        created: fm.created ? String(fm.created) : null,
      });
    } else {
      out.push({ slug: name, space, status, file: null, description: '', icon: null, color: null, created: null });
    }
  };
  const scan = (root: string, status: 'active' | 'inactive') => {
    const folder = app.vault.getAbstractFileByPath(root);
    if (!(folder instanceof TFolder)) return;
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const ownNote = app.vault.getAbstractFileByPath(`${root}/${child.name}/${child.name}.md`);
      if (!spaceSlugs.has(child.name) && ownNote instanceof TFile) {
        pushProject(root, child.name, null, status);
      } else {
        for (const sub of child.children) {
          if (sub instanceof TFolder) pushProject(`${root}/${child.name}`, sub.name, child.name, status);
        }
      }
    }
  };
  scan(PROJECTS_ACTIVE, 'active');
  scan(PROJECTS_INACTIVE, 'inactive');
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function moveProjectToSpace(app: App, p: Project, space: string | null) {
  const root = p.status === 'active' ? PROJECTS_ACTIVE : PROJECTS_INACTIVE;
  const toDir = space ? `${root}/${space}` : root;
  await ensureFolder(app, toDir);
  const dir = app.vault.getAbstractFileByPath(`${projectBase(p)}/${p.slug}`);
  if (dir instanceof TFolder) {
    await app.fileManager.renameFile(dir, normalizePath(`${toDir}/${p.slug}`));
  }
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

// Archive/restore moves the project folder between status roots, preserving
// its space subfolder.
async function setProjectStatus(app: App, p: Project, status: 'active' | 'inactive') {
  if (p.status === status) return;
  const root = status === 'active' ? PROJECTS_ACTIVE : PROJECTS_INACTIVE;
  const toDir = p.space ? `${root}/${p.space}` : root;
  await ensureFolder(app, toDir);
  const dir = app.vault.getAbstractFileByPath(`${projectBase(p)}/${p.slug}`);
  if (dir instanceof TFolder) {
    await app.fileManager.renameFile(dir, normalizePath(`${toDir}/${p.slug}`));
  }
}

// icon/color come from the project folder note's frontmatter (icon: lucide
// name, color: any CSS color). Includes archived projects so cards keep
// their styling.
function loadProjectInfos(app: App): Map<string, ProjectInfo> {
  const map = new Map<string, ProjectInfo>();
  for (const p of loadProjects(app)) {
    map.set(p.slug, { icon: p.icon, color: p.color, space: p.space });
  }
  return map;
}


interface TagDef {
  name: string;
  icon: string | null;
  color: string | null;
}

// Registry lives in pm/tags.md frontmatter under `registry:` as a list of
// {name, icon, color}. Legacy plain-string `tags:` lists are read as defs.
function loadTagRegistry(app: App): TagDef[] {
  const f = app.vault.getAbstractFileByPath(TAGS_FILE);
  if (!(f instanceof TFile)) return [];
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  const raw = fm?.registry ?? fm?.tags;
  const list = Array.isArray(raw) ? raw : [];
  const out: TagDef[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ name: item.trim(), icon: null, color: null });
    } else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      const o = item as { name: string; icon?: unknown; color?: unknown };
      out.push({
        name: o.name.trim(),
        icon: typeof o.icon === 'string' && o.icon.trim() ? o.icon.trim() : null,
        color: typeof o.color === 'string' && o.color.trim() ? o.color.trim() : null,
      });
    }
  }
  return out;
}

function registryNames(app: App): string[] {
  return loadTagRegistry(app).map((d) => d.name);
}

async function saveTagRegistry(app: App, defs: TagDef[]) {
  let f = app.vault.getAbstractFileByPath(TAGS_FILE);
  if (!(f instanceof TFile)) f = await app.vault.create(TAGS_FILE, '---\nregistry: []\n---\n');
  await app.fileManager.processFrontMatter(f as TFile, (fm) => {
    fm.registry = [...defs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ name: d.name, icon: d.icon ?? '', color: d.color ?? '' }));
    delete fm.tags;
  });
}

async function addTagToRegistry(app: App, tag: string) {
  const defs = loadTagRegistry(app);
  if (!defs.some((d) => d.name === tag)) {
    await saveTagRegistry(app, [...defs, { name: tag, icon: null, color: null }]);
  }
}

async function upsertTagDef(app: App, def: TagDef) {
  const defs = loadTagRegistry(app);
  const rest = defs.filter((d) => d.name !== def.name);
  await saveTagRegistry(app, [...rest, def]);
}

async function removeTagFromRegistry(app: App, tag: string) {
  await saveTagRegistry(app, loadTagRegistry(app).filter((d) => d.name !== tag));
}

async function renameTagEverywhere(app: App, oldTag: string, newTag: string) {
  const defs = loadTagRegistry(app);
  const old = defs.find((d) => d.name === oldTag);
  await saveTagRegistry(app, [
    ...defs.filter((d) => d.name !== oldTag && d.name !== newTag),
    { name: newTag, icon: old?.icon ?? null, color: old?.color ?? null },
  ]);
  for (const t of loadTasks(app)) {
    if (t.tags.includes(oldTag)) {
      await setTags(app, t, [...new Set(t.tags.map((x) => (x === oldTag ? newTag : x)))]);
    }
  }
}

async function deleteTagEverywhere(app: App, tag: string) {
  await removeTagFromRegistry(app, tag);
  for (const t of loadTasks(app)) {
    if (t.tags.includes(tag)) await setTags(app, t, t.tags.filter((x) => x !== tag));
  }
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

// Focus an existing tab showing this file instead of opening a duplicate.
async function openFileReuse(app: App, file: TFile) {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
      app.workspace.revealLeaf(leaf);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      return;
    }
  }
  await app.workspace.getLeaf('tab').openFile(file);
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

function slugify(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\\/:|#^\[\]"*?<>]/g, '');
}

// Create/edit a space: typed note in pm/spaces/ plus (on create) its project
// folder and catch-all project.
class SpaceModal extends Modal {
  private name: string;
  private description: string;
  private icon: string | null;
  private color: string | null;

  constructor(app: App, private existing: Space | null, private onDone: () => void) {
    super(app);
    this.name = existing?.slug ?? '';
    this.description = existing?.description ?? '';
    this.icon = existing?.icon ?? null;
    this.color = existing?.color ?? null;
  }

  onOpen() {
    this.modalEl.addClass('lb-edit-modal');
    this.titleEl.setText(this.existing ? `Edit space: ${this.existing.slug}` : 'New space');

    const name = this.contentEl.createEl('input', { type: 'text', placeholder: 'Space name (e.g. work, personal)…' });
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
    for (const c of PROJECT_COLORS) {
      const b = swatchRow.createEl('button', { cls: 'lb-swatch', attr: { 'aria-label': c } });
      b.style.background = c;
      b.addEventListener('click', () => {
        this.color = this.color === c ? null : c;
        for (const [cc, el] of swatches) el.toggleClass('lb-swatch-selected', this.color === cc);
      });
      swatches.set(c, b);
      b.toggleClass('lb-swatch-selected', this.color === c);
    }

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const save = actions.createEl('button', { text: this.existing ? 'Save' : 'Create space', cls: 'mod-cta' });
    save.addEventListener('click', () => void this.save());
  }

  async save() {
    const slug = slugify(this.name);
    if (!slug) {
      new Notice('Space needs a name');
      return;
    }
    if (this.existing) {
      if (slug !== this.existing.slug) await renameSpace(this.app, this.existing.slug, slug);
    } else if (this.app.vault.getAbstractFileByPath(`${SPACES_FOLDER}/${slug}.md`)) {
      new Notice(`Space "${slug}" already exists`);
      return;
    }
    await writeSpaceNote(this.app, slug, {
      description: this.description.trim(),
      icon: this.icon,
      color: this.color,
    });
    new Notice(this.existing ? `${slug} updated` : `Space ${slug} created`);
    this.onDone();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Create/edit a project through code so the folder + folder note structure is
// always correct. Renaming re-points all tasks; changing space moves the folder.
class ProjectModal extends Modal {
  private name: string;
  private description: string;
  private icon: string | null;
  private color: string | null;
  private space: string | null;

  constructor(
    app: App,
    private existing: Project | null,
    private onDone: (slug: string) => void,
    defaultSpace: string | null = null
  ) {
    super(app);
    this.name = existing?.slug ?? '';
    this.description = existing?.description ?? '';
    this.icon = existing?.icon ?? null;
    this.color = existing?.color ?? null;
    this.space = existing ? existing.space : defaultSpace;
  }

  onOpen() {
    this.modalEl.addClass('lb-edit-modal');
    this.titleEl.setText(this.existing ? `Edit project: ${this.existing.slug}` : 'New project');

    const name = this.contentEl.createEl('input', { type: 'text', placeholder: 'Project name (becomes folder slug)…' });
    name.style.width = '100%';
    name.value = this.name;
    name.addEventListener('input', () => (this.name = name.value));

    const spaceRow = this.contentEl.createDiv({ cls: 'lb-modal-row' });
    const spacePill = spaceRow.createEl('button', { cls: 'lb-pill' });
    const paintSpace = () => spacePill.setText(this.space ? `Space: ${this.space}` : 'Space: none');
    paintSpace();
    spacePill.addEventListener('click', (evt) => {
      const menu = new Menu();
      for (const s of loadSpaces(this.app)) {
        menu.addItem((i) =>
          i.setTitle(s.slug).setChecked(this.space === s.slug).onClick(() => {
            this.space = s.slug;
            paintSpace();
          })
        );
      }
      menu.addItem((i) =>
        i.setTitle('No space').setChecked(this.space === null).onClick(() => {
          this.space = null;
          paintSpace();
        })
      );
      menu.showAtMouseEvent(evt);
    });

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
    const slug = slugify(this.name);
    if (!slug) {
      new Notice('Project needs a name');
      return;
    }
    const statusRoot = this.existing?.status === 'inactive' ? PROJECTS_INACTIVE : PROJECTS_ACTIVE;
    const base = this.space ? `${statusRoot}/${this.space}` : statusRoot;
    if (this.existing) {
      if (this.space !== this.existing.space) {
        await moveProjectToSpace(this.app, this.existing, this.space);
      }
      if (slug !== this.existing.slug) {
        await renameProject(this.app, this.existing.slug, slug, base);
      }
    } else if (loadProjects(this.app).some((p) => p.slug === slug)) {
      new Notice(`Project "${slug}" already exists`);
      return;
    }
    await writeProjectNote(this.app, slug, {
      description: this.description.trim(),
      icon: this.icon,
      color: this.color,
    }, base);
    new Notice(this.existing ? `${slug} updated` : `Project ${slug} created`);
    this.onDone(slug);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DueDateModal extends Modal {
  constructor(app: App, private task: TaskItem, private onDone: () => void) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('lb-edit-modal');
    this.titleEl.setText(`Due date (${this.task.id})`);
    const row = this.contentEl.createDiv({ cls: 'lb-edit-due' });
    row.createSpan({ text: 'Due' });
    const input = row.createEl('input', { type: 'date' });
    input.value = this.task.due ?? '';
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const clear = actions.createEl('button', { text: 'Clear' });
    clear.addEventListener('click', async () => {
      await setProp(this.app, this.task, 'due', null);
      this.onDone();
      this.close();
    });
    const save = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      await setProp(this.app, this.task, 'due', input.value || null);
      this.onDone();
      this.close();
    });
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
      new ProjectModal(app, null, (slug) => onPick(slug)).open();
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
      new TextPromptModal(app, { title: 'Assignee', placeholder: 'e.g. anna, claude', slug: true }, onPick).open();
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
  tagDefs,
  refresh,
}: {
  app: App;
  task: TaskItem;
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
  projects: Map<string, ProjectInfo>;
  tagDefs: Map<string, TagDef>;
  refresh: () => void;
}) {
  const openNote = () => void openFileReuse(app, task.file);

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
        await softDeleteTask(app, task);
        new Notice(`${task.id} deleted — kept in ${TASKS_INACTIVE}`);
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
        <EntityChip
          icon={task.project ? projects.get(task.project)?.icon : null}
          color={
            task.project
              ? projects.get(task.project)?.color ?? 'var(--lb-indigo)'
              : 'var(--lb-orange)'
          }
          label={task.project ?? 'no project'}
          onClick={(e) =>
            projectMenu(app, allProjects, task.project, async (p) => {
              await setProp(app, task, 'project', p);
              refresh();
            }, e)
          }
          title="Set project"
        />
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
        {task.tags.map((tag) => {
          const def = tagDefs.get(tag);
          return (
            <EntityChip
              key={tag}
              icon={def?.icon}
              color={def?.color}
              label={tag}
              onClick={(e) =>
                tagsMenu(app, allTags, task.tags, async (tags) => {
                  await setTags(app, task, tags);
                  refresh();
                }, e)
              }
            />
          );
        })}
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
  tagDefs,
  refresh,
}: {
  app: App;
  status: string;
  tasks: TaskItem[];
  allProjects: string[];
  allTags: string[];
  allAssignees: string[];
  projects: Map<string, ProjectInfo>;
  tagDefs: Map<string, TagDef>;
  refresh: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-status={status}
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
            tagDefs={tagDefs}
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

// Active space is shared across all plugin views; changes broadcast via a
// workspace event so every mounted view updates.
function useActiveSpace(app: App, plugin: TaskBoardPlugin): string {
  const [space, setSpace] = useState(plugin.settings.activeSpace ?? '');
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = (app.workspace as any).on('task-board:space-changed', () =>
      setSpace(plugin.settings.activeSpace ?? '')
    );
    return () => app.workspace.offref(ref);
  }, [app, plugin]);
  return space;
}

function SpaceSwitcher({ app, plugin, space }: { app: App; plugin: TaskBoardPlugin; space: string }) {
  const spaces = loadSpaces(app);
  const current = spaces.find((s) => s.slug === space);
  const openMenu = (e: React.MouseEvent) => {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('All spaces').setChecked(!space).onClick(() => plugin.setActiveSpace(''))
    );
    for (const s of spaces) {
      menu.addItem((i) => {
        i.setTitle(s.slug).setChecked(space === s.slug).onClick(() => plugin.setActiveSpace(s.slug));
        if (s.icon) i.setIcon(s.icon);
      });
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('New space…').setIcon('plus').onClick(() => new SpaceModal(app, null, () => {}).open())
    );
    if (current) {
      menu.addItem((i) =>
        i.setTitle(`Edit ${current.slug}…`).setIcon('pencil').onClick(() => new SpaceModal(app, current, () => {}).open())
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };
  return (
    <button
      className="lb-space-sw"
      style={current?.color ? ({ '--space-color': current.color } as React.CSSProperties) : undefined}
      onClick={openMenu}
      title="Switch space"
    >
      <span className="lb-dot lb-space-dot" />
      {current?.icon && <LucideIcon name={current.icon} />}
      {current?.slug ?? 'All spaces'}
      <span className="lb-chev">▾</span>
    </button>
  );
}

function NavSeg({
  plugin,
  active,
}: {
  plugin: TaskBoardPlugin;
  active: 'spaces' | 'projects' | 'tasks' | 'tags';
}) {
  return (
    <>
      <div className="lb-seg">
        <button className={active === 'spaces' ? 'lb-seg-active' : ''} onClick={() => void plugin.openSpacesView()}>
          <LucideIcon name="layers" />
          Spaces
        </button>
        <button
          className={active === 'projects' ? 'lb-seg-active' : ''}
          onClick={() => void plugin.openProjectsView()}
        >
          <LucideIcon name="package" />
          Projects
        </button>
        <button className={active === 'tasks' ? 'lb-seg-active' : ''} onClick={() => void plugin.activateView()}>
          <LucideIcon name="kanban-square" />
          Tasks
        </button>
      </div>
      <button
        className={`lb-pill${active === 'tags' ? ' lb-pill-active' : ''}`}
        onClick={() => void plugin.openTagsView()}
      >
        <LucideIcon name="tag" />
        Tags
      </button>
    </>
  );
}

function pickerLists(app: App, tasks: TaskItem[]): PickerLists {
  return {
    allProjects: [
      ...new Set([...listProjects(app), ...tasks.map((t) => t.project).filter((p): p is string => !!p)]),
    ].sort(),
    allTags: [...new Set([...registryNames(app), ...tasks.flatMap((t) => t.tags)])].sort(),
    allAssignees: [...new Set([DEFAULT_ASSIGNEE, ...tasks.map((t) => t.assignee)])].sort(),
  };
}

// The one chip for spaces, projects, and tags: colored border + wash + icon.
function EntityChip({
  icon,
  color,
  label,
  size,
  dashed,
  onClick,
  title,
  children,
}: {
  icon?: string | null;
  color?: string | null;
  label: string;
  size?: 'row' | 'lg';
  dashed?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      className={`lb-chip${size === 'lg' ? ' lb-chip-lg' : ''}${size === 'row' ? ' lb-chip-row' : ''}${
        onClick ? ' lb-chip-click' : ''
      }${dashed ? ' lb-chip-dashed' : ''}`}
      style={color ? ({ '--chip-color': color } as React.CSSProperties) : undefined}
      onClick={onClick}
      title={title}
    >
      {icon && <LucideIcon name={icon} />}
      <span className="lb-chip-name">{label}</span>
      {children}
    </span>
  );
}

function ProjectChip({ project, size }: { project: Project; size?: 'lg' }) {
  return (
    <EntityChip
      icon={project.icon}
      color={project.color ?? 'var(--lb-indigo)'}
      label={project.slug}
      size={size === 'lg' ? 'lg' : 'row'}
    />
  );
}

// Rendered above a task note's content, replacing the raw Properties list:
// navigation back to board/project plus live-editing pills for every field.
function NoteBanner({ app, plugin, file }: { app: App; plugin: TaskBoardPlugin; file: TFile }) {
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
      <div className="lb-header lb-header-top">
      <NavSeg plugin={plugin} active="tasks" />
      <span className="lb-breadcrumb">
        {task.space && (
          <>
            <LucideIcon name="chevron-right" />
            <span
              className="lb-crumb-space"
              onClick={() => plugin.setActiveSpace(task.space!)}
              title="Scope board to this space"
            >
              {task.space}
            </span>
          </>
        )}
        {task.project && (
          <>
            <LucideIcon name="chevron-right" />
            <span
              className="lb-crumb-space lb-crumb-proj"
              style={proj?.color ? ({ '--proj-color': proj.color } as React.CSSProperties) : undefined}
              onClick={() => void plugin.openProject(task.project!)}
              title={`Open project: ${task.project}`}
            >
              {proj?.icon && <LucideIcon name={proj.icon} />}
              {task.project}
            </span>
          </>
        )}
        <LucideIcon name="chevron-right" />
        {task.id}
      </span>
      </div>
      <div className="lb-header">
      <EntityChip
        icon={proj?.icon}
        color={task.project ? proj?.color ?? 'var(--lb-indigo)' : 'var(--lb-orange)'}
        label={task.project ?? 'no project'}
        onClick={(e) =>
          projectMenu(app, lists.allProjects, task.project, async (p) => {
            await setProp(app, task, 'project', p);
            refresh();
          }, e)
        }
        title="Change project"
      >
        <span className="lb-chev">▾</span>
      </EntityChip>
      <button className="lb-pill" onClick={statusMenu} title="Status">
        <span className={`lb-dot lb-dot-${task.status}`} /> {COLUMN_LABELS[task.status]}
        <span className="lb-chev">▾</span>
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
      {task.tags.map((tag) => {
        const def = loadTagRegistry(app).find((d) => d.name === tag);
        return <EntityChip key={tag} icon={def?.icon} color={def?.color} label={tag} onClick={changeTags} />;
      })}
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
        <span className="lb-chev">▾</span>
      </button>
      <button
        className="lb-pill"
        onClick={() => new DueDateModal(app, task, refresh).open()}
        title="Set due date"
      >
        <LucideIcon name="calendar" />
        {task.due ? `Due ${task.due}` : 'Due'}
        <span className="lb-chev">▾</span>
      </button>
      <span className="lb-banner-spacer" />
      {task.created && (
        <span className="lb-date-ro" title="Created — set automatically">
          Created {task.created}
        </span>
      )}
      {task.started && (
        <span className="lb-date-ro" title="Started — stamped on first move to Today">
          Started {task.started}
        </span>
      )}
      {task.completed && (
        <span className="lb-date-ro" title="Completed — stamped when moved to Done">
          Done {task.completed}
        </span>
      )}
      </div>
    </>
  );
}

// Shared task row for list renderings (board list mode + project detail).
function TaskRow({
  app,
  task,
  lists,
  projects,
  showProject,
  refresh,
}: {
  app: App;
  task: TaskItem;
  lists: PickerLists;
  projects: Map<string, ProjectInfo>;
  showProject: boolean;
  refresh: () => void;
}) {
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const m = new Menu();
    m.addItem((i) => i.setTitle('Edit…').setIcon('pencil').onClick(() => new TaskEditModal(app, task, lists).open()));
    m.addSeparator();
    m.addItem((i) =>
      i.setTitle('Delete').setIcon('trash').onClick(async () => {
        await softDeleteTask(app, task);
        new Notice(`${task.id} deleted — kept in ${TASKS_INACTIVE}`);
        refresh();
      })
    );
    m.showAtMouseEvent(e.nativeEvent);
  };
  const proj = task.project ? projects.get(task.project) : undefined;
  return (
    <div className="lb-taskrow" onClick={() => void openFileReuse(app, task.file)} onContextMenu={menu}>
      <span className="lb-id">{task.id}</span>
      {showProject && task.project && (
        <EntityChip icon={proj?.icon} color={proj?.color ?? 'var(--lb-indigo)'} label={task.project} />
      )}
      <span className="lb-taskrow-title">{task.title}</span>
      {task.priority && (
        <span className={`lb-priority lb-priority-${task.priority.toLowerCase()}`}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={`lb-bar${n <= PRIORITY_LEVEL[task.priority!] ? ' lb-bar-on' : ''}`} />
          ))}
        </span>
      )}
      {task.size && <span className="lb-size">{task.size}</span>}
      {task.due && <span className="lb-due">{task.due}</span>}
      {task.assignee !== DEFAULT_ASSIGNEE && (
        <span className="lb-avatar" style={{ background: avatarColor(task.assignee) }}>
          {task.assignee.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

// Edit a tag's name, icon, and color; renaming propagates to every task.
class TagEditModal extends Modal {
  private name: string;
  private icon: string | null;
  private color: string | null;

  constructor(app: App, private existing: TagDef | null, private onDone: () => void) {
    super(app);
    this.name = existing?.name ?? '';
    this.icon = existing?.icon ?? null;
    this.color = existing?.color ?? null;
  }

  onOpen() {
    this.modalEl.addClass('lb-edit-modal');
    this.titleEl.setText(this.existing ? `Edit tag: ${this.existing.name}` : 'New tag');

    const name = this.contentEl.createEl('input', { type: 'text', placeholder: 'Tag name (e.g. bug, idea)…' });
    name.style.width = '100%';
    name.value = this.name;
    name.addEventListener('input', () => (this.name = name.value));

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
    for (const c of PROJECT_COLORS) {
      const b = swatchRow.createEl('button', { cls: 'lb-swatch', attr: { 'aria-label': c } });
      b.style.background = c;
      b.toggleClass('lb-swatch-selected', this.color === c);
      b.addEventListener('click', () => {
        this.color = this.color === c ? null : c;
        for (const el of Array.from(swatchRow.children)) {
          (el as HTMLElement).toggleClass('lb-swatch-selected', el.getAttribute('aria-label') === this.color);
        }
      });
    }

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const save = actions.createEl('button', { text: this.existing ? 'Save' : 'Create tag', cls: 'mod-cta' });
    save.addEventListener('click', () => void this.save());
  }

  async save() {
    const tag = slugify(this.name);
    if (!tag) {
      new Notice('Tag needs a name');
      return;
    }
    if (this.existing && tag !== this.existing.name) {
      await renameTagEverywhere(this.app, this.existing.name, tag);
    }
    await upsertTagDef(this.app, { name: tag, icon: this.icon, color: this.color });
    new Notice(this.existing ? `Tag ${tag} updated` : `Tag ${tag} created`);
    this.onDone();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Tags overview: registry ∪ in-use tags with counts, icons, colors and
// cross-vault rename/delete.
function TagsApp({ app, plugin }: { app: App; plugin: TaskBoardPlugin }) {
  const [tick, refresh] = useVaultTick(app);
  const tasks = useMemo(() => loadTasks(app), [app, tick]);
  const defs = useMemo(() => loadTagRegistry(app), [app, tick]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) for (const tag of t.tags) m.set(tag, (m.get(tag) ?? 0) + 1);
    return m;
  }, [tasks]);
  const allTags = [...new Set([...defs.map((d) => d.name), ...tagCounts.keys()])].sort();

  const rowMenu = (tag: string, def: TagDef | undefined, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('Edit…').setIcon('pencil').onClick(() =>
        new TagEditModal(app, def ?? { name: tag, icon: null, color: null }, refresh).open()
      )
    );
    if (!def) {
      menu.addItem((i) =>
        i.setTitle('Add to registry').setIcon('plus').onClick(() => void addTagToRegistry(app, tag).then(refresh))
      );
    } else if (!tagCounts.get(tag)) {
      menu.addItem((i) =>
        i.setTitle('Remove from registry').setIcon('x').onClick(() => void removeTagFromRegistry(app, tag).then(refresh))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('Delete everywhere').setIcon('trash').onClick(() => void deleteTagEverywhere(app, tag).then(refresh))
    );
    menu.showAtMouseEvent(e.nativeEvent);
  };

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header lb-header-top">
          <NavSeg plugin={plugin} active="tags" />
          <button
            className="mod-cta lb-new"
            onClick={() => new TagEditModal(app, null, refresh).open()}
          >
            + New<span className="lb-new-suffix">tag</span>
          </button>
        </div>
        <div className="lb-header" />
        <div className="lb-projects">
          <div className="lb-projrow lb-projrow-head">
            <span className="lb-projname-col">Name</span>
            <span className="lb-projdesc"></span>
            <span className="lb-projcount lb-projcount-wide">Tasks</span>
          </div>
          {allTags.map((tag) => {
            const def = defs.find((d) => d.name === tag);
            return (
              <div
                key={tag}
                className="lb-projrow"
                onClick={() => new TagEditModal(app, def ?? { name: tag, icon: null, color: null }, refresh).open()}
                onContextMenu={(e) => rowMenu(tag, def, e)}
                title="Click to edit · right-click for actions"
              >
                <span className="lb-projname-col">
                  <EntityChip icon={def?.icon} color={def?.color} label={tag} size="row" dashed={!def} />
                </span>
                <span className="lb-projdesc">
                  {def ? '' : 'Used on tasks but not in the registry'}
                </span>
                <span className="lb-projcount lb-projcount-wide">{tagCounts.get(tag) ?? 0} tasks</span>
              </div>
            );
          })}
          {allTags.length === 0 && <div className="lb-empty">No tags yet — create the first one.</div>}
        </div>
      </div>
    </StrictMode>
  );
}

// Simple overview: every space with its counts.
function SpacesApp({ app, plugin }: { app: App; plugin: TaskBoardPlugin }) {
  const [tick, refresh] = useVaultTick(app);
  const spaces = useMemo(() => loadSpaces(app), [app, tick]);
  const projects = useMemo(() => loadProjects(app), [app, tick]);
  const tasks = useMemo(() => loadTasks(app), [app, tick]);

  const spaceRowMenu = (s: Space, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Edit…').setIcon('pencil').onClick(() => new SpaceModal(app, s, refresh).open()));
    menu.addItem((i) => i.setTitle('Open note').setIcon('file-text').onClick(() => void openFileReuse(app, s.file)));
    menu.addItem((i) =>
      i.setTitle('New project here…').setIcon('plus').onClick(() => new ProjectModal(app, null, refresh, s.slug).open())
    );
    menu.showAtMouseEvent(e.nativeEvent);
  };

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header lb-header-top">
          <NavSeg plugin={plugin} active="spaces" />
          <button className="mod-cta lb-new" onClick={() => new SpaceModal(app, null, refresh).open()}>
            + New<span className="lb-new-suffix">space</span>
          </button>
        </div>
        <div className="lb-header" />
        <div className="lb-projects">
          <div className="lb-projrow lb-projrow-head">
            <span className="lb-projname-col">Name</span>
            <span className="lb-projdesc">Description</span>
            <span className="lb-projcount lb-projcount-wide">Projects</span>
            <span className="lb-projcount lb-projcount-wide">Open</span>
          </div>
          {spaces.map((s) => {
            const projs = projects.filter((p) => p.space === s.slug && p.status === 'active');
            const open = tasks.filter(
              (t) => t.space === s.slug && !CLOSED.includes(t.status) && t.status !== DELETED_STATUS
            ).length;
            return (
              <div
                key={s.slug}
                className="lb-projrow"
                onClick={() => {
                  plugin.setActiveSpace(s.slug);
                  void plugin.openProjectsView();
                }}
                onContextMenu={(e) => spaceRowMenu(s, e)}
                title="Click to open projects in this space · right-click for actions"
              >
                <span className="lb-projname-col">
                  <EntityChip icon={s.icon} color={s.color} label={s.slug} size="row" />
                </span>
                <span className="lb-projdesc">{s.description}</span>
                <span className="lb-projcount lb-projcount-wide">{projs.length} project{projs.length === 1 ? '' : 's'}</span>
                <span className="lb-projcount lb-projcount-wide">{open} open</span>
              </div>
            );
          })}
          {spaces.length === 0 && <div className="lb-empty">No spaces yet — create your first one (e.g. work, personal).</div>}
        </div>
      </div>
    </StrictMode>
  );
}

function ProjectsApp({ app, plugin }: { app: App; plugin: TaskBoardPlugin }) {
  const [tick, refresh] = useVaultTick(app);
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const activeSpace = useActiveSpace(app, plugin);
  const spaces = useMemo(() => loadSpaces(app), [app, tick]);
  const allProjects = useMemo(() => loadProjects(app), [app, tick]);
  const projects = allProjects.filter(
    (p) => (statusFilter === 'all' || p.status === statusFilter) && (!activeSpace || p.space === activeSpace)
  );
  const tasks = useMemo(() => loadTasks(app), [app, tick]);

  const counts = (slug: string) => {
    const mine = tasks.filter((t) => t.project === slug && t.status !== DELETED_STATUS);
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
        if (p.file) void openFileReuse(app, p.file);
      })
    );
    menu.addSeparator();
    if (p.status === 'active') {
      menu.addItem((i) =>
        i.setTitle('Archive').setIcon('archive').onClick(async () => {
          await setProjectStatus(app, p, 'inactive');
          new Notice(`${p.slug} archived`);
          refresh();
        })
      );
    } else {
      menu.addItem((i) =>
        i.setTitle('Restore').setIcon('archive-restore').onClick(async () => {
          await setProjectStatus(app, p, 'active');
          new Notice(`${p.slug} restored`);
          refresh();
        })
      );
    }
    menu.showAtMouseEvent(e.nativeEvent);
  };

  // Grouped by space when unscoped; flat when a space is selected. `label`
  // undefined means "render rows without a group header".
  const groupedProjects: { label?: string; color?: string | null; items: Project[] }[] = activeSpace
    ? [{ items: projects }]
    : [
        ...spaces.map((s) => ({
          label: s.slug,
          color: s.color,
          items: projects.filter((p) => p.space === s.slug),
        })),
        { label: 'unspaced', color: null, items: projects.filter((p) => !p.space || !spaces.some((s) => s.slug === p.space)) },
      ].filter((g) => g.items.length > 0);

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
          <NavSeg plugin={plugin} active="projects" />
          <button
            className="mod-cta lb-new"
            onClick={() => new ProjectModal(app, null, refresh, activeSpace || null).open()}
          >
            + New<span className="lb-new-suffix">project</span>
          </button>
        </div>
        <div className="lb-header">
          <SpaceSwitcher app={app} plugin={plugin} space={activeSpace} />
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
          {groupedProjects.map(({ label, color, items }) => (
            <div key={label ?? '(unspaced)'}>
              {label !== undefined && (
                <div
                  className="lb-space-group lb-space-group-clickable"
                  onClick={() => {
                    if (spaces.some((s) => s.slug === label)) plugin.setActiveSpace(label);
                  }}
                  onContextMenu={(e) => {
                    const space = spaces.find((s) => s.slug === label);
                    if (!space) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const menu = new Menu();
                    menu.addItem((i) =>
                      i.setTitle('Edit space…').setIcon('pencil').onClick(() => new SpaceModal(app, space, refresh).open())
                    );
                    menu.addItem((i) =>
                      i.setTitle('Open space note').setIcon('file-text').onClick(() => void openFileReuse(app, space.file))
                    );
                    menu.addItem((i) =>
                      i.setTitle('New project here…').setIcon('plus').onClick(() =>
                        new ProjectModal(app, null, refresh, space.slug).open()
                      )
                    );
                    menu.showAtMouseEvent(e.nativeEvent);
                  }}
                  title="Click to scope · right-click for actions"
                >
                  <span className="lb-dot" style={{ background: color ?? 'var(--lb-gray)' }} />
                  {label}
                  <span className="lb-count">{items.length}</span>
                </div>
              )}
              {items.map((p) => {
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
            </div>
          ))}
          {projects.length === 0 && (
            <div className="lb-empty">No projects yet — create the first one.</div>
          )}
        </div>
      </div>
    </StrictMode>
  );
}

function ProjectApp({ app, plugin, slug }: { app: App; plugin: TaskBoardPlugin; slug: string }) {
  const [tick, refresh] = useVaultTick(app);
  const [adding, setAdding] = useState(false);
  const activeSpace = useActiveSpace(app, plugin);
  const allTasks = useMemo(() => loadTasks(app), [app, tick]);
  const projects = useMemo(() => loadProjects(app), [app, tick]);
  const spaces = useMemo(() => loadSpaces(app), [app, tick]);
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

  const sections = COLUMNS.map((c) => ({ status: c, items: mine.filter((t) => t.status === c) })).filter(
    (s) => s.items.length > 0
  );
  const projectInfos = loadProjectInfos(app);

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header lb-header-top">
          <NavSeg plugin={plugin} active="projects" />
          <span className="lb-breadcrumb">
            {project.space && (
              <>
                <LucideIcon name="chevron-right" />
                <span
                  className="lb-crumb-space"
                  onClick={() => plugin.setActiveSpace(project.space!)}
                  title="Scope to this space"
                >
                  {project.space}
                </span>
              </>
            )}
            <LucideIcon name="chevron-right" />
            {slug}
          </span>
        </div>
        <div className="lb-proj-head">
          <div className="lb-proj-title-row">
            <ProjectChip project={project} size="lg" />
            <div className="lb-proj-actions">
              <button className="lb-pill" onClick={() => new ProjectModal(app, project, refresh).open()}>
                Edit
              </button>
              <button
                className="lb-pill"
                onClick={() => project.file && void openFileReuse(app, project.file)}
              >
                Open note
              </button>
              <button
                className="lb-pill"
                onClick={(e) => {
                  const menu = new Menu();
                  for (const s of spaces) {
                    menu.addItem((i) =>
                      i.setTitle(s.slug).setChecked(project.space === s.slug).onClick(async () => {
                        await moveProjectToSpace(app, project, s.slug);
                        new Notice(`${slug} moved to ${s.slug}`);
                        refresh();
                      })
                    );
                  }
                  menu.addItem((i) =>
                    i.setTitle('No space').setChecked(project.space === null).onClick(async () => {
                      await moveProjectToSpace(app, project, null);
                      refresh();
                    })
                  );
                  menu.showAtMouseEvent(e.nativeEvent);
                }}
              >
                Move to space…
              </button>
              <button
                className="lb-pill"
                onClick={async () => {
                  await setProjectStatus(app, project, project.status === 'active' ? 'inactive' : 'active');
                  new Notice(project.status === 'active' ? `${slug} archived` : `${slug} restored`);
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
                <TaskRow
                  key={t.path}
                  app={app}
                  task={t}
                  lists={lists}
                  projects={projectInfos}
                  showProject={false}
                  refresh={refresh}
                />
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

function BoardApp({ app, plugin }: { app: App; plugin: TaskBoardPlugin }) {
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [conditions, setConditions] = useState<Conditions>({});
  const [activeView, setActiveView] = useState('All');
  const [views, setViews] = useState<SavedView[]>(plugin.settings.views);
  const [filterOpen, setFilterOpen] = useState(false);
  const [mode, setModeState] = useState<'board' | 'list'>(plugin.settings.boardMode ?? 'board');
  const setMode = (m: 'board' | 'list') => {
    setModeState(m);
    plugin.settings.boardMode = m;
    void plugin.saveData(plugin.settings);
  };

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refs = [
      app.metadataCache.on('changed', refresh),
      app.vault.on('delete', refresh),
      app.vault.on('rename', refresh),
      app.vault.on('create', refresh),
    ];
    return () => refs.forEach((r) => app.metadataCache.offref(r));
  }, [app, refresh]);

  // Mobile: land on the Today lane instead of the leftmost column.
  useEffect(() => {
    if (!Platform.isMobile || mode !== 'board') return;
    boardRef.current
      ?.querySelector('[data-status="today"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [mode]);

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
    () => [...new Set([...registryNames(app), ...tasks.flatMap((t) => t.tags)])].sort(),
    [app, tick, tasks]
  );
  const allAssignees = useMemo(
    () => [...new Set([DEFAULT_ASSIGNEE, ...tasks.map((t) => t.assignee)])].sort(),
    [tasks]
  );
  const projectInfos = useMemo(() => loadProjectInfos(app), [app, tick]);
  const tagDefs = useMemo(
    () => new Map(loadTagRegistry(app).map((d) => [d.name, d] as const)),
    [app, tick]
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
      space: [...loadSpaces(app).map((s) => s.slug), ...(tasks.some((t) => !t.space) ? ['none'] : [])],
    }),
    [app, tick, tasks, allProjects, allTags, allAssignees]
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

  const activeSpace = useActiveSpace(app, plugin);
  const visible = tasks.filter(
    (t) => (!activeSpace || t.space === activeSpace) && matchesConditions(t, conditions)
  );
  const columns = COLUMNS.filter((c) => showClosed || !CLOSED.includes(c));
  const filtered = hasConditions(conditions);
  const valueLabel = (field: FilterField, v: string) =>
    field === 'status' ? COLUMN_LABELS[v] ?? v : v;

  const closedCount = visible.filter((t) => CLOSED.includes(t.status)).length;

  return (
    <StrictMode>
      <div className="lb-root">
        <div className="lb-header lb-header-top">
          <NavSeg plugin={plugin} active="tasks" />
          <button className="mod-cta lb-new" onClick={() => setAdding(true)}>
            + New<span className="lb-new-suffix">task</span>
          </button>
        </div>
        <div className="lb-header">
          <SpaceSwitcher app={app} plugin={plugin} space={activeSpace} />
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
          <button
            className={`lb-pill lb-closed-toggle${showClosed ? ' lb-pill-active' : ''}`}
            onClick={() => setShowClosed((v) => !v)}
            title="Show or hide the Done and Cancelled lanes"
          >
            <LucideIcon name={showClosed ? 'eye' : 'eye-off'} />
            Closed
            <span className="lb-count">{closedCount}</span>
          </button>
          <div className="lb-seg lb-mode-seg">
            <button
              className={mode === 'list' ? 'lb-seg-active' : ''}
              onClick={() => setMode('list')}
              title="List"
            >
              <LucideIcon name="list" />
            </button>
            <button
              className={mode === 'board' ? 'lb-seg-active' : ''}
              onClick={() => setMode('board')}
              title="Board"
            >
              <LucideIcon name="kanban-square" />
            </button>
          </div>
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
        {mode === 'board' ? (
          <div className="lb-board" ref={boardRef}>
            {columns.map((c) => (
              <Column
                key={c}
                app={app}
                status={c}
                allProjects={allProjects}
                allTags={allTags}
                allAssignees={allAssignees}
                projects={projectInfos}
                tagDefs={tagDefs}
                refresh={refresh}
                tasks={visible
                  .filter((t) => t.status === c)
                  .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id.localeCompare(b.id))}
              />
            ))}
          </div>
        ) : (
          <div className="lb-proj-body">
            {columns
              .map((c) => ({
                status: c,
                items: visible
                  .filter((t) => t.status === c)
                  .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id.localeCompare(b.id)),
              }))
              .filter((s) => s.items.length > 0)
              .map((s) => (
                <div key={s.status}>
                  <div className="lb-section-title">
                    <span className={`lb-dot lb-dot-${s.status}`} />
                    {COLUMN_LABELS[s.status]}
                    <span className="lb-count">{s.items.length}</span>
                  </div>
                  {s.items.map((t) => (
                    <TaskRow
                      key={t.path}
                      app={app}
                      task={t}
                      lists={{ allProjects, allTags, allAssignees }}
                      projects={projectInfos}
                      showProject
                      refresh={refresh}
                    />
                  ))}
                </div>
              ))}
          </div>
        )}
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

interface TaskBoardSettings {
  views: SavedView[];
  openOnLaunch: 'never' | 'mobile' | 'always';
  activeSpace: string; // '' = all spaces
  boardMode: 'board' | 'list';
  rootFolder: string;
  idPrefix: string;
  defaultAssignee: string;
}

const DEFAULT_SETTINGS: TaskBoardSettings = {
  views: [],
  openOnLaunch: 'mobile',
  activeSpace: '',
  boardMode: 'board',
  rootFolder: 'pm',
  idPrefix: 'T',
  defaultAssignee: 'me',
};

class TaskBoardSettingTab extends PluginSettingTab {
  plugin: TaskBoardPlugin;

  constructor(app: App, plugin: TaskBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName('Root folder')
      .setDesc(
        'Vault folder holding the task system (tasks/, projects/, spaces/, tags.md, attachments/ live under it). Reopen the board after changing.'
      )
      .addText((t) =>
        t
          .setPlaceholder('pm')
          .setValue(this.plugin.settings.rootFolder)
          .onChange(async (v) => {
            this.plugin.settings.rootFolder = v.trim() || 'pm';
            await this.plugin.saveData(this.plugin.settings);
            applyConfig(this.plugin.settings);
          })
      );

    new Setting(this.containerEl)
      .setName('Task ID prefix')
      .setDesc('New tasks are numbered PREFIX-001, PREFIX-002, … Existing tasks are not renamed.')
      .addText((t) =>
        t
          .setPlaceholder('T')
          .setValue(this.plugin.settings.idPrefix)
          .onChange(async (v) => {
            this.plugin.settings.idPrefix = v.trim() || 'T';
            await this.plugin.saveData(this.plugin.settings);
            applyConfig(this.plugin.settings);
          })
      );

    new Setting(this.containerEl)
      .setName('Default assignee')
      .setDesc('Assignee for new tasks. Cards only show an avatar when a task is assigned to someone else.')
      .addText((t) =>
        t
          .setPlaceholder('me')
          .setValue(this.plugin.settings.defaultAssignee)
          .onChange(async (v) => {
            this.plugin.settings.defaultAssignee = v.trim() || 'me';
            await this.plugin.saveData(this.plugin.settings);
            applyConfig(this.plugin.settings);
          })
      );

    new Setting(this.containerEl)
      .setName('Open board on launch')
      .setDesc('Open the task board automatically when Obsidian starts.')
      .addDropdown((d) =>
        d
          .addOptions({ never: 'Never', mobile: 'On mobile only', always: 'Always' })
          .setValue(this.plugin.settings.openOnLaunch)
          .onChange(async (v) => {
            this.plugin.settings.openOnLaunch = v as TaskBoardSettings['openOnLaunch'];
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
}

class TaskBoardView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TaskBoardPlugin) {
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

  constructor(leaf: WorkspaceLeaf, private plugin: TaskBoardPlugin) {
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

class SpacesListView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TaskBoardPlugin) {
    super(leaf);
  }

  getViewType() {
    return SPACES_VIEW_TYPE;
  }
  getDisplayText() {
    return 'Spaces';
  }
  getIcon() {
    return 'layers';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('lb-view');
    this.root = createRoot(this.contentEl);
    this.root.render(<SpacesApp app={this.app} plugin={this.plugin} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}

class TagsListView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TaskBoardPlugin) {
    super(leaf);
  }

  getViewType() {
    return TAGS_VIEW_TYPE;
  }
  getDisplayText() {
    return 'Tags';
  }
  getIcon() {
    return 'tag';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('lb-view');
    this.root = createRoot(this.contentEl);
    this.root.render(<TagsApp app={this.app} plugin={this.plugin} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}

class ProjectDetailView extends ItemView {
  root: Root | null = null;
  slug = '';

  constructor(leaf: WorkspaceLeaf, private plugin: TaskBoardPlugin) {
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

export default class TaskBoardPlugin extends Plugin {
  settings: TaskBoardSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    applyConfig(this.settings);

    this.registerView(VIEW_TYPE, (leaf) => new TaskBoardView(leaf, this));
    this.registerView(PROJECTS_VIEW_TYPE, (leaf) => new ProjectsListView(leaf, this));
    this.registerView(PROJECT_VIEW_TYPE, (leaf) => new ProjectDetailView(leaf, this));
    this.registerView(SPACES_VIEW_TYPE, (leaf) => new SpacesListView(leaf, this));
    this.registerView(TAGS_VIEW_TYPE, (leaf) => new TagsListView(leaf, this));
    this.addSettingTab(new TaskBoardSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const mode = this.settings.openOnLaunch;
      if (mode === 'always' || (mode === 'mobile' && Platform.isMobile)) {
        void this.activateView();
      }
      this.decorateMarkdownLeaves();
      this.dockOverviewTabs();
    });

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.decorateMarkdownLeaves();
        this.dockOverviewTabs();
      })
    );
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
      id: 'open-spaces',
      name: 'Open spaces',
      callback: () => void this.openSpacesView(),
    });

    this.addCommand({
      id: 'open-tags',
      name: 'Open tags',
      callback: () => void this.openTagsView(),
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
            allTags: [...new Set([...registryNames(this.app), ...tasks.flatMap((t) => t.tags)])].sort(),
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

  setActiveSpace(space: string) {
    this.settings.activeSpace = space;
    void this.saveData(this.settings);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.app.workspace as any).trigger('task-board:space-changed');
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

  private docking = false;

  // Keep the overview tabs (Spaces/Projects/Tasks/Tags) leftmost in their tab
  // group, in canonical order, so other tabs always open to their right.
  // Uses workspace internals (tab-container children) — no public API exists.
  dockOverviewTabs() {
    if (this.docking) return;
    type TabGroup = {
      children: WorkspaceLeaf[];
      currentTab: number;
      recomputeChildrenDimensions?: () => void;
    };
    const rank = (l: WorkspaceLeaf) => {
      const r = PINNED_VIEW_ORDER.indexOf(l.view?.getViewType?.() ?? '');
      return r === -1 ? Number.MAX_SAFE_INTEGER : r;
    };
    const groups = new Set<TabGroup>();
    for (const t of PINNED_VIEW_ORDER) {
      for (const leaf of this.app.workspace.getLeavesOfType(t)) {
        const parent = (leaf as unknown as { parent?: TabGroup }).parent;
        if (parent?.children) groups.add(parent);
      }
    }
    for (const parent of groups) {
      const children = parent.children;
      const sorted = [...children].sort((a, b) => rank(a) - rank(b)); // stable: non-plugin order preserved
      if (sorted.every((c, i) => c === children[i])) continue;
      this.docking = true;
      try {
        const active = children[parent.currentTab];
        children.length = 0;
        children.push(...sorted);
        const idx = sorted.indexOf(active);
        if (idx >= 0) parent.currentTab = idx;
        parent.recomputeChildrenDimensions?.();
      } finally {
        this.docking = false;
      }
    }
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
      if (!(leaf.view instanceof MarkdownView)) continue;
      const content = leaf.view.contentEl;
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

  async openSpacesView() {
    const existing = this.app.workspace.getLeavesOfType(SPACES_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: SPACES_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openTagsView() {
    const existing = this.app.workspace.getLeavesOfType(TAGS_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: TAGS_VIEW_TYPE, active: true });
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
