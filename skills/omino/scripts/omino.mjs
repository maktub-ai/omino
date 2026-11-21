#!/usr/bin/env node
// Omino — a plan made of pieces, readable by humans and agents.
// Zero-dependency CLI: init, record, check, find, brief, recall, review, view, service, hook, doctor.
// Node >= 18. Run `node omino.mjs help` for usage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

export const VERSION = '1.0.0';
/** Version of the .omino/ file format, kept in state.json. Bump only for changes older versions cannot read. */
export const FORMAT = 1;

const KINDS = ['intent', 'stage', 'work', 'idea', 'decision'];
const KIND_DIR = { stage: 'stages', work: 'work', idea: 'ideas', decision: 'decisions' };
const WORK_STATUS = ['planned', 'doing', 'done', 'verified', 'dropped'];
const STAGE_STATUS = ['planned', 'active', 'closed'];
const SOURCES = ['user', 'agent', 'tool', 'file'];
const IDEA_STATES = ['open', 'deferred', 'adopted', 'dropped'];
const RECALL_STATES = ['waiting', 'fired', 'stopped'];
const DONE = ['done', 'verified'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const KNOWN_FIELDS = {
  intent: ['id', 'kind', 'title', 'review'],
  stage: ['id', 'kind', 'title', 'level', 'status', 'source', 'review'],
  work: ['id', 'kind', 'title', 'stage', 'lane', 'order', 'status', 'source', 'requires', 'before', 'refs', 'parent', 'branch', 'basis', 'review'],
  idea: ['id', 'kind', 'title', 'idea_state', 'recall', 'recall_state', 'refs', 'review'],
  decision: ['id', 'kind', 'title', 'date', 'source', 'supersedes', 'affects', 'refs', 'review']
};
const LIST_FIELDS = ['requires', 'before', 'refs', 'supersedes', 'affects'];

// ---------------------------------------------------------------- utilities

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => s.replace(/\r\n?/g, '\n');

export class OminoError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

function parseValue(raw, where) {
  const v = raw.trim();
  if (v === '') return '';
  if (/^[|>{]/.test(v)) throw new OminoError(`${where}: multi-line values and maps are not supported`);
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new OminoError(`${where}: unterminated list`);
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Parse a note: strict frontmatter subset + markdown body. */
export function parseNote(text, file = 'note') {
  const src = norm(text);
  if (!src.startsWith('---\n')) throw new OminoError(`${file}: missing frontmatter (must start with ---)`);
  const end = src.indexOf('\n---', 4);
  if (end < 0) throw new OminoError(`${file}: frontmatter is not closed with ---`);
  const after = src.slice(end + 4);
  if (after && !after.startsWith('\n')) throw new OminoError(`${file}: frontmatter must be closed by a line containing only ---`);
  const fm = {};
  src.slice(4, end).split('\n').forEach((line, i) => {
    const where = `${file}:${i + 2}`;
    if (line.trim() === '') return;
    const m = /^([a-z_]+):(.*)$/.exec(line);
    if (!m) throw new OminoError(`${where}: unsupported frontmatter syntax (use "key: value")`);
    if (m[1] in fm) throw new OminoError(`${where}: duplicate key "${m[1]}"`);
    fm[m[1]] = parseValue(m[2], where);
  });
  return { fm, body: after.replace(/^\n/, '') };
}

/** Split a markdown body into "## Heading" sections (keys lower-cased). */
export function sections(body) {
  const out = {};
  let cur = null;
  for (const line of norm(body).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { cur = m[1].toLowerCase(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

const reqHash = (note) => sha((note && sections(note.body).requirements) || '').slice(0, 8);

/** Set (or remove, with value null) one frontmatter field, leaving everything else untouched. */
export function setField(file, key, value) {
  const src = norm(fs.readFileSync(file, 'utf8'));
  const end = src.indexOf('\n---', 4);
  const lines = src.slice(4, end).split('\n');
  const idx = lines.findIndex((l) => l.startsWith(key + ':'));
  const fmt = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
  if (value === null) { if (idx >= 0) lines.splice(idx, 1); }
  else if (idx >= 0) lines[idx] = `${key}: ${fmt(value)}`;
  else lines.push(`${key}: ${fmt(value)}`);
  fs.writeFileSync(file, '---\n' + lines.join('\n') + src.slice(end));
}

// ---------------------------------------------------------------- loading

// ---------------------------------------------------------------- where the plan lives
//
// The plan is not kept in the working tree: every worktree and clone of a project on this machine
// shares one copy in ~/.omino/projects/<id>/, which is its own git repository (one commit per record).
// The project id comes from .omino.json in the project folder ({"project": "<id>"}), or else from a
// binding file in the git common directory, so linked worktrees resolve to the same id.

const CONFIG = '.omino.json';
const BINDING = 'omino-project';
const LEGACY = '.omino';

/** The folder that holds every plan on this machine (OMINO_HOME, default ~/.omino). */
export function ominoHome() { return process.env.OMINO_HOME ? path.resolve(process.env.OMINO_HOME) : path.join(os.homedir(), '.omino'); }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80) || 'project';

function gitCommonDir(dir) {
  if (process.env.OMINO_NO_GIT) return null;
  const c = git(dir, ['rev-parse', '--git-common-dir']);
  return c ? path.resolve(dir, c) : null;
}
function gitTop(dir) { return process.env.OMINO_NO_GIT ? null : git(dir, ['rev-parse', '--show-toplevel']); }

const idCache = new Map();
/** The project id of dir (a project folder or worktree root), or null if it has none yet. */
export function projectId(dir) {
  dir = path.resolve(dir);
  // a plan folder stands for its own plan (the page service opens plans no folder on this machine uses)
  if (isPlanFolder(dir)) return { id: path.basename(dir), via: 'store' };
  let id = null, via = null;
  const cfg = path.join(dir, CONFIG);
  if (fs.existsSync(cfg)) {
    let c;
    try { c = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { throw new OminoError(`${cfg} is not valid JSON; it should be {"project": "<id>"}`); }
    if (!c || typeof c.project !== 'string' || slug(c.project) !== c.project) throw new OminoError(`${cfg}: "project" must be a plan id (lowercase letters, digits, . _ -)`);
    id = c.project; via = 'config';
  }
  if (!id) {
    // the repository binding speaks for the worktree root only; a subfolder is its own project only through its own .omino.json
    if (!idCache.has(dir)) {
      let b = null;
      const top = gitTop(dir);
      if (top && path.resolve(top) === dir) { const common = gitCommonDir(dir); try { b = slug(fs.readFileSync(path.join(common, BINDING), 'utf8').trim()) || null; } catch {} }
      if (b) idCache.set(dir, b);
      else return null;
    }
    id = idCache.get(dir); via = 'git';
  }
  return { id, via };
}

function isPlanFolder(dir) { return path.dirname(path.resolve(dir)) === path.join(ominoHome(), 'projects'); }

/** Where the plan of dir lives, or null if dir has no project id yet. */
export function omRoot(dir) { const p = projectId(dir); return p ? path.join(ominoHome(), 'projects', p.id) : null; }

/** An id for a new project: owner-repo from the origin remote, else the folder name; never one already taken by another folder. */
function newId(dir) {
  const url = process.env.OMINO_NO_GIT ? null : (git(dir, ['remote', 'get-url', 'origin']) || (git(dir, ['remote']) || '').split('\n').filter(Boolean).map((r) => git(dir, ['remote', 'get-url', r])).find(Boolean));
  if (url) {
    const m = url.replace(/\.git\/?$/, '').replace(/\/+$/, '').match(/([^/:]+)[/:]([^/:]+)$/);
    // another clone of the same repository shares the plan; a package in a monorepo adds its path
    const top = gitTop(dir), sub = top ? path.relative(path.resolve(top), path.resolve(dir)) : '';
    return { id: slug(`${m ? `${m[1]}-${m[2]}` : path.basename(url)}${sub ? '-' + sub.split(path.sep).join('-') : ''}`), shared: true };
  }
  const common = gitCommonDir(dir);
  const base = slug(path.basename(common && path.basename(common) === '.git' ? path.dirname(common) : dir));
  let id = base;
  for (let i = 2; fs.existsSync(path.join(ominoHome(), 'projects', id)); i++) id = `${base}-${i}`;
  return { id, shared: false };
}

/**
 * Point dir at plan id. At a git worktree root the link lives in the repository's .git (this clone only, never
 * committed); with share, or outside git, or in a monorepo package, it is also written to .omino.json, which is
 * meant to be committed so other clones and machines find the same plan. Only share in the user's own repository:
 * a team repository or a fork should not carry someone's personal plan.
 */
function writeBinding(dir, id, { share = false } = {}) {
  const top = gitTop(dir);
  const atTop = !!top && path.resolve(top) === path.resolve(dir);
  if (atTop) { try { fs.writeFileSync(path.join(gitCommonDir(dir), BINDING), id + '\n'); } catch {} }
  if (share || !atTop) fs.writeFileSync(path.join(dir, CONFIG), JSON.stringify({ project: id }, null, 2) + '\n');
  idCache.delete(path.resolve(dir));
}

/** A free plan id from a name the user gave the plan (what it is for), or derived from the repository. */
function idFromName(name) {
  const id = slug(name);
  if (id !== String(name).trim().toLowerCase().replace(/\s+/g, '-')) throw new OminoError(`--name must be an id made of lowercase letters, digits, . _ - (for example invoice-export); got "${name}"`);
  return id;
}

/** Give dir a project id if it has none. */
function bindProject(dir, { share = false, name } = {}) {
  const have = projectId(dir);
  writeBinding(dir, have ? have.id : name ? idFromName(name) : newId(dir).id, { share });
  return projectId(dir);
}


// ---------------------------------------------------------------- one writer at a time

// Two agents may record into the same plan at the same moment (two worktrees, two CLIs). Every command that changes
// the plan takes this lock: a directory created atomically in the plan folder, released when the command ends.
// A lock whose owner process is gone (a crash) is taken over, so a plan is never locked for good.
const LOCK = '.lock';
const heldLocks = new Set();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function withLock(root, fn, { timeoutMs = Number(process.env.OMINO_LOCK_TIMEOUT_MS) || 10000 } = {}) {
  if (!root || !fs.existsSync(root) || heldLocks.has(root)) return fn();
  const lock = path.join(root, LOCK), started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch {}
      // no owner file yet: someone is taking it right now, unless the directory is old (a crash between the two steps)
      const stale = owner ? !pidAlive(owner.pid) || Date.now() - owner.at > 60000 : (() => { try { return Date.now() - fs.statSync(lock).mtimeMs > 5000; } catch { return false; } })();
      if (stale) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() - started > timeoutMs) throw new OminoError(`the plan is busy: another Omino command${owner ? ` (pid ${owner.pid})` : ''} is changing it; try again in a moment`, 1);
      sleepSync(40 + Math.floor(Math.random() * 80));
    }
  }
  heldLocks.add(root);
  try { return fn(); } finally { heldLocks.delete(root); try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------- which repositories a plan belongs to

const META = 'omino.json';      // in the plan folder: id and the repositories it belongs to (part of its history)
const PATHS = '.paths.json';    // in the plan folder: folders on this machine that used it (not in history)

/** A remote URL without protocol, user and .git: github.com/owner/repo. */
export function normRemote(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:(?!\d)/, '/');
  return u.toLowerCase() || null;
}
function remotesOf(dir) {
  if (process.env.OMINO_NO_GIT) return [];
  const out = (git(dir, ['remote', '-v']) || '').split('\n').map((l) => l.split(/\s+/)[1]).map(normRemote).filter(Boolean);
  return [...new Set(out)];
}
function readMeta(root) { try { return JSON.parse(fs.readFileSync(path.join(root, META), 'utf8')); } catch { return {}; } }
/** Remember that dir uses the plan at root: its remotes (shared) and its path (this machine only). */
function noteUse(root, dir, id) {
  if (isPlanFolder(dir)) return;
  const meta = readMeta(root);
  const repos = [...new Set([...(meta.repos || []), ...remotesOf(dir)])];
  if (meta.id !== id || repos.length !== (meta.repos || []).length) fs.writeFileSync(path.join(root, META), JSON.stringify({ ...meta, id, repos }, null, 2) + '\n');
  try {
    let p = {}; try { p = JSON.parse(fs.readFileSync(path.join(root, PATHS), 'utf8')); } catch {}
    p[path.resolve(dir)] = new Date().toISOString();
    ensureIgnored(root, [PATHS]);
    fs.writeFileSync(path.join(root, PATHS), JSON.stringify(p, null, 2) + '\n');
  } catch {}
}

/** How a folder is known in a plan: its origin remote, or its path when it has none. */
function folderKey(dir) {
  const o = process.env.OMINO_NO_GIT ? null : normRemote(git(dir, ['remote', 'get-url', 'origin']));
  return o || remotesOf(dir)[0] || 'path:' + path.resolve(dir);
}
const keyLabel = (k) => k.startsWith('path:') ? path.basename(k.slice(5)) : k.split('/').pop();

/** Set (or, with no name, read) the lane this folder's work goes into: one lane per repository or service. */
export function cmdLane(dir, name) { return withLock(omRoot(dir), () => laneUnlocked(dir, name)); }
function laneUnlocked(dir, name) {
  loadPlan(dir);
  const root = omRoot(dir), key = folderKey(dir), meta = readMeta(root);
  if (name === undefined) return { key, lane: (meta.lanes || {})[key] || null, lanes: meta.lanes || {} };
  const lanes = { ...(meta.lanes || {}) };
  if (name.trim()) lanes[key] = name.trim(); else delete lanes[key];
  fs.writeFileSync(path.join(root, META), JSON.stringify({ ...meta, lanes }, null, 2) + '\n');
  commitHistory(root, name.trim() ? `Lane "${name.trim()}" is ${keyLabel(key)}` : `${keyLabel(key)} has no lane`);
  return { key, lane: lanes[key] || null, lanes };
}

/** Which plan dir uses, how that was decided, and whether the plan was made for a different repository. */
export function identity(dir) {
  const p = projectId(dir);
  if (!p) return null;
  const root = omRoot(dir);
  const meta = readMeta(root);
  const remotes = remotesOf(dir);
  const repos = meta.repos || [];
  const mismatch = repos.length > 0 && remotes.length > 0 && !remotes.some((r) => repos.includes(r));
  const lane = (meta.lanes || {})[folderKey(dir)] || null;
  return { id: p.id, via: p.via, root, exists: fs.existsSync(root), repos, remotes, mismatch, lane, lanes: meta.lanes || {} };
}
const mismatchText = (idn) => `plan "${idn.id}" was made for ${idn.repos.join(', ')}, but this folder's remote is ${idn.remotes.join(', ')}. If this is the same project (a renamed remote, a fork you want to share the plan with), run "omino link ${idn.id}"; otherwise "omino init" in a folder whose .omino.json you remove, or "omino link <other id>".`;

const isClosed = (root) => readMeta(root).status === 'closed';

/** Mark the plan finished (read-only from then on), or reopen it. */
export function cmdClose(dir, opts = {}) { return withLock(omRoot(dir), () => closeUnlocked(dir, opts)); }
function closeUnlocked(dir, { reopen = false } = {}) {
  loadPlan(dir);
  const root = omRoot(dir), meta = readMeta(root);
  const next = reopen ? { ...meta, status: 'active' } : { ...meta, status: 'closed', closedAt: new Date().toISOString() };
  if (reopen) delete next.closedAt;
  fs.writeFileSync(path.join(root, META), JSON.stringify(next, null, 2) + '\n');
  commitHistory(root, reopen ? 'Reopen the plan' : 'Close the plan');
  return { id: projectId(dir).id, status: next.status, closedAt: next.closedAt || null };
}

/** Every plan on this machine, with the repositories and folders that use it. */
export function cmdProjects(dir) {
  const base = path.join(ominoHome(), 'projects');
  const here = (() => { try { return projectId(dir); } catch { return null; } })();
  const out = [];
  for (const id of fs.existsSync(base) ? fs.readdirSync(base).sort() : []) {
    const root = path.join(base, id);
    if (!fs.statSync(root).isDirectory()) continue;
    let title = null; try { title = parseNote(fs.readFileSync(path.join(root, 'project.md'), 'utf8')).fm.title || null; } catch {}
    let paths = {}; try { paths = JSON.parse(fs.readFileSync(path.join(root, PATHS), 'utf8')); } catch {}
    let last = null; try { const l = fs.readFileSync(path.join(root, 'changes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).at(-1); if (l) last = JSON.parse(l).ts || null; } catch {}
    out.push({ id, title, root, status: readMeta(root).status || 'active', repos: readMeta(root).repos || [], folders: Object.keys(paths).filter((f) => fs.existsSync(f)), last, current: !!here && here.id === id });
  }
  return { home: base, projects: out };
}

/** Point this project folder at an existing plan (sharing one plan between repositories, or fixing a wrong match). */
export function cmdLink(dir, id, opts = {}) { return withLock(id && slug(id) === id ? path.join(ominoHome(), 'projects', id) : null, () => linkUnlocked(dir, id, opts)); }
function linkUnlocked(dir, id, { share = false } = {}) {
  if (!id || slug(id) !== id) throw new OminoError('link needs a plan id (see "omino projects")');
  const root = path.join(ominoHome(), 'projects', id);
  if (!fs.existsSync(root)) {
    const known = cmdProjects(dir).projects.map((p) => p.id);
    throw new OminoError(`no plan "${id}" on this machine${known.length ? `; known: ${known.join(', ')}` : ''}`);
  }
  let previous = null; try { previous = (projectId(dir) || {}).id || null; } catch {}
  writeBinding(dir, id, { share });
  noteUse(root, dir, id);
  commitHistory(root, `Link ${path.basename(dir)}`);
  return { id, root, previous };
}

const hasLegacy = (dir) => fs.existsSync(path.join(dir, LEGACY, 'project.md'));

/** The last commit whose tree still had an in-repo plan (.omino/project.md), when the working tree no longer has it. */
function legacyRev(dir) {
  if (process.env.OMINO_NO_GIT || !gitTop(dir)) return null;
  const rel = path.relative(path.resolve(gitTop(dir)), path.resolve(dir));
  const file = [rel, LEGACY, 'project.md'].filter(Boolean).join('/');
  const last = git(dir, ['log', '-1', '--format=%H', '--', ':/' + file]);
  if (!last) return null;
  for (const rev of [last, last + '^']) if (git(dir, ['cat-file', '-e', `${rev}:${file}`]) !== null) return { rev: git(dir, ['rev-parse', rev]), prefix: file.slice(0, -'project.md'.length) };
  return null;
}

/** Commit the plan folder to its own history. Best effort: a failure never stops a command. */
export function commitHistory(root, message, files = null) {
  if (process.env.OMINO_NO_HISTORY) return false;
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root } });
  try {
    if (!fs.existsSync(path.join(root, '.git'))) run(['init', '-q']);
    ensureIgnored(root, [LOCK]);
    run(files ? ['add', '-A', '--', ...files] : ['add', '-A']);
    run(['-c', 'user.name=Omino', '-c', 'user.email=omino@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', String(message).slice(0, 500)]);
    return true;
  } catch { return false; }
}

/** Move a plan kept inside the working tree (.omino/, Omino 0.4 and earlier) to the shared folder. */
export function cmdMigrate(dir, { share = false } = {}) {
  dir = path.resolve(dir);
  // already removed from the working tree (pulled before migrating): take it from the last commit that had it
  const fromGit = hasLegacy(dir) ? null : legacyRev(dir);
  if (!hasLegacy(dir) && !fromGit) throw new OminoError(`no ${LEGACY}/ plan inside ${dir}, nor in its git history`);
  const p = bindProject(dir, { share });
  const root = omRoot(dir);
  if (fs.existsSync(root)) throw new OminoError(`${root} already holds a plan for "${p.id}"; compare the two and remove ${LEGACY}/ from the project by hand`);
  if (fromGit) {
    for (const f of (git(dir, ['ls-tree', '-r', '--name-only', fromGit.rev, '--', ':/' + fromGit.prefix]) || '').split('\n').filter(Boolean)) {
      const out = path.join(root, f.slice(fromGit.prefix.length));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, execFileSync('git', ['-C', dir, 'show', `${fromGit.rev}:${f}`]));
    }
  } else fs.cpSync(path.join(dir, LEGACY), root, { recursive: true });
  for (const f of [...OLD_LOCAL, HOOKSTATE, 'view.html']) { try { fs.rmSync(path.join(root, f)); } catch {} }
  ensureIgnored(root, LOCAL_FILES);
  noteUse(root, dir, p.id);
  commitHistory(root, `Move the plan out of ${path.basename(dir)}${fromGit ? ` (from commit ${fromGit.rev.slice(0, 7)})` : ''}`);
  const tracked = !fromGit && !!gitTop(dir) && !!git(dir, ['ls-files', LEGACY]);
  return { id: p.id, root, legacy: fromGit ? null : path.join(dir, LEGACY), fromCommit: fromGit ? fromGit.rev.slice(0, 7) : null, tracked };
}

/** Load every note. Parse errors are collected, not thrown. */
export function loadPlan(dir) {
  const root = omRoot(dir);
  if (!root || !fs.existsSync(root)) {
    if (hasLegacy(dir)) throw new OminoError(`the plan of ${dir} is still inside the project (${LEGACY}/); run "omino setup" (after the user agrees) to move it to ${path.join(ominoHome(), 'projects')}`);
    if (root && legacyRev(dir)) throw new OminoError(`this project's plan ("${projectId(dir).id}") is not on this machine yet, but its git history has the old in-repo copy; run "omino setup" (after the user agrees) to restore it to ${root}`);
    if (root) throw new OminoError(`this project uses plan "${projectId(dir).id}", which is not on this machine (${root}); copy it from where it lives, or run "omino projects" and "omino link <id>"`);
    throw new OminoError(`no Omino plan for ${dir} (run "omino init")`);
  }
  const files = [];
  if (fs.existsSync(path.join(root, 'project.md'))) files.push('project.md');
  for (const d of Object.values(KIND_DIR)) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p).sort()) if (f.endsWith('.md')) files.push(`${d}/${f}`);
  }
  const notes = new Map();
  const errors = [];
  const all = [];
  for (const rel of files) {
    const raw = norm(fs.readFileSync(path.join(root, rel), 'utf8'));
    const hash = sha(raw).slice(0, 16);
    try {
      const { fm, body } = parseNote(raw, rel);
      const note = { id: fm.id, kind: fm.kind, fm, body, file: rel, hash };
      all.push(note);
      if (typeof fm.id === 'string' && !notes.has(fm.id)) notes.set(fm.id, note);
    } catch (e) {
      errors.push({ file: rel, msg: e.message.replace(`${rel}: `, '').replace(new RegExp(`^${rel}:\\d+: `), '') });
      all.push({ id: null, file: rel, hash, broken: true });
    }
  }
  return { dir, root, notes, all, errors };
}

export function readState(plan) {
  const p = path.join(plan.root, 'state.json');
  if (!fs.existsSync(p)) return { version: FORMAT, notes: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Refuse to write a plan made by a newer Omino: an older version could damage fields it does not know. */
export function assertFormat(plan) {
  const v = Number(readState(plan).version || 1);
  if (v > FORMAT) throw new OminoError(`this plan uses format ${v}, written by a newer Omino; this copy (${VERSION}) reads format ${FORMAT}. Update Omino before changing the plan.`, 3);
  return v;
}

/** Ideas and decisions with no relation in or out: they are not tied to anything in the plan. */
export function orphans(plan) {
  const linked = new Set();
  const out = (n) => {
    const ids = [];
    for (const f of LIST_FIELDS) if (Array.isArray(n.fm[f])) ids.push(...n.fm[f]);
    for (const f of ['stage', 'parent']) if (n.fm[f]) ids.push(n.fm[f]);
    if (n.kind === 'idea' && n.fm.recall) { const r = parseRecall(String(n.fm.recall)); if (r && r.id) ids.push(r.id); }
    return ids;
  };
  for (const n of plan.notes.values()) { const ids = out(n); if (ids.length) { linked.add(n.id); ids.forEach((id) => linked.add(id)); } }
  return [...plan.notes.values()].filter((n) => (n.kind === 'idea' || n.kind === 'decision') && !linked.has(n.id)).map((n) => ({ id: n.id, kind: n.kind, title: n.fm.title, file: n.file }));
}

export function readChanges(plan) {
  const p = path.join(plan.root, 'changes.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- check

export function parseRecall(s) {
  let m;
  if ((m = /^stage ([a-z0-9-]+) closed$/.exec(s))) return { type: 'stage', id: m[1] };
  if ((m = /^work ([a-z0-9-]+) done$/.exec(s))) return { type: 'work', id: m[1] };
  if ((m = /^manual (.+)$/.exec(s))) return { type: 'manual', text: m[1] };
  return null;
}

/** Validate format and references. Returns { errors, warnings }. */
export function validate(plan) {
  const errors = plan.errors.map((e) => ({ ...e }));
  const warnings = [];
  const err = (n, msg) => errors.push({ file: n.file, msg });
  const seen = new Map();
  if (!plan.all.some((n) => n.file === 'project.md')) errors.push({ file: 'project.md', msg: 'missing (every plan needs an intent note)' });

  for (const n of plan.all) {
    if (n.broken) continue;
    const { fm } = n;
    for (const f of ['id', 'kind', 'title']) if (fm[f] === undefined || fm[f] === '') err(n, `missing required field "${f}"`);
    if (fm.id !== undefined) {
      if (typeof fm.id !== 'string' || !ID_RE.test(fm.id)) err(n, `invalid id "${fm.id}" (use lowercase letters, digits and -)`);
      if (seen.has(fm.id)) err(n, `duplicate id "${fm.id}" (also in ${seen.get(fm.id)})`);
      else seen.set(fm.id, n.file);
      const stem = path.basename(n.file, '.md');
      if (stem !== fm.id) err(n, `id "${fm.id}" does not match file name "${stem}"`);
    }
    if (fm.kind === undefined) continue;
    if (!KINDS.includes(fm.kind)) { err(n, `unknown kind "${fm.kind}"`); continue; }
    const expectedDir = fm.kind === 'intent' ? '' : KIND_DIR[fm.kind];
    const actualDir = path.dirname(n.file) === '.' ? '' : path.dirname(n.file);
    if (expectedDir !== actualDir) err(n, `kind "${fm.kind}" must live in ${expectedDir ? expectedDir + '/' : 'the plan folder root'}`);
    if (fm.kind === 'intent' && fm.id !== 'project') err(n, 'the intent note must have id "project"');
    for (const k of Object.keys(fm)) if (!KNOWN_FIELDS[fm.kind].includes(k)) warnings.push({ file: n.file, msg: `unknown field "${k}" (ignored)` });

    const enumCheck = (f, allowed, required) => {
      if (fm[f] === undefined || fm[f] === '') { if (required) err(n, `missing required field "${f}"`); return; }
      if (!allowed.includes(fm[f])) err(n, `invalid ${f} "${fm[f]}" (allowed: ${allowed.join(', ')})`);
    };
    const ref = (f, id, kinds) => {
      const t = plan.notes.get(id);
      if (!t) err(n, `${f} points to unknown note "${id}"`);
      else if (kinds && !kinds.includes(t.kind)) err(n, `${f} "${id}" must be a ${kinds.join(' or ')} note, not ${t.kind}`);
    };

    if (fm.kind === 'stage') {
      if (!Number.isInteger(fm.level)) err(n, 'missing or non-integer "level"');
      enumCheck('status', STAGE_STATUS, true);
      enumCheck('source', SOURCES, false);
    }
    if (fm.kind === 'work') {
      if (!fm.stage) err(n, 'missing required field "stage"');
      else ref('stage', fm.stage, ['stage']);
      enumCheck('status', WORK_STATUS, true);
      enumCheck('source', SOURCES, false);
      if (fm.status === 'verified' && fm.source !== 'tool') err(n, 'status "verified" requires source "tool"');
      if (fm.order !== undefined && !Number.isInteger(fm.order)) err(n, '"order" must be an integer');
      if (fm.parent !== undefined) ref('parent', fm.parent, ['work']);
      if (fm.branch !== undefined && (typeof fm.branch !== 'string' || !fm.branch)) err(n, '"branch" must be a branch name');
    }
    if (fm.kind === 'decision') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fm.date || ''))) err(n, 'missing or invalid "date" (use YYYY-MM-DD)');
      enumCheck('source', SOURCES, false);
    }
    if (fm.kind === 'idea') {
      enumCheck('idea_state', IDEA_STATES, true);
      if (fm.recall !== undefined) {
        const r = parseRecall(String(fm.recall));
        if (!r) err(n, `unsupported recall condition "${fm.recall}" (use "stage <id> closed", "work <id> done" or "manual <text>")`);
        else if (r.type !== 'manual') ref('recall', r.id, [r.type]);
        enumCheck('recall_state', RECALL_STATES, true);
      } else if (fm.recall_state !== undefined) err(n, '"recall_state" given without "recall"');
    }
    for (const f of LIST_FIELDS) {
      if (fm[f] === undefined) continue;
      if (!Array.isArray(fm[f])) { err(n, `"${f}" must be a list like [a, b]`); continue; }
      const kinds = f === 'refs' ? null : f === 'supersedes' ? ['stage', 'work', 'idea', 'decision'] : f === 'affects' ? ['intent', 'stage', 'work', 'idea', 'decision'] : ['work'];
      for (const id of fm[f]) { ref(f, id, kinds); if (id === fm.id) err(n, `${f} cannot point to itself`); }
    }
  }

  // requires must be acyclic
  const color = new Map();
  const visit = (id, trail) => {
    const n = plan.notes.get(id);
    if (!n || n.kind !== 'work') return;
    if (color.get(id) === 2) return;
    if (color.get(id) === 1) {
      const cyc = trail.slice(trail.indexOf(id)).concat(id);
      errors.push({ file: n.file, msg: `requires forms a cycle: ${cyc.join(' → ')}` });
      return;
    }
    color.set(id, 1);
    for (const r of Array.isArray(n.fm.requires) ? n.fm.requires : []) visit(r, trail.concat(id));
    color.set(id, 2);
  };
  for (const n of plan.notes.values()) visit(n.id, []);
  return { errors, warnings };
}

/** Notes whose content differs from what was last recorded. */
export function unrecorded(plan, state) {
  const out = [];
  const cur = new Map();
  for (const n of plan.all) if (!n.broken && n.id) cur.set(n.id, n);
  for (const [id, n] of cur) {
    const s = state.notes[id];
    if (!s) out.push({ id, op: 'created' });
    else if (s.hash !== n.hash) out.push({ id, op: 'modified' });
  }
  for (const id of Object.keys(state.notes)) if (!cur.has(id)) out.push({ id, op: 'deleted' });
  return out;
}

// ---------------------------------------------------------------- derived state

function basisOf(plan, note) {
  const ups = (Array.isArray(note.fm.requires) ? note.fm.requires : []).slice().sort();
  const upHash = sha(ups.map((id) => id + ':' + reqHash(plan.notes.get(id))).join('|')).slice(0, 8);
  return `${reqHash(note)}.${upHash}`;
}

const isDone = (n) => n && DONE.includes(n.fm.status);

/** Bullets under "## Open questions": things only the user can settle. */
export function openQuestions(note) {
  const sec = sections(note.body)['open questions'] || '';
  return sec.replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => /^\s*[-*]\s+(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
}

/** Everything that needs a human decision, derived from current state. */
export function review(plan) {
  const items = [];
  const add = (type, n, reason, data) => items.push({ type, id: n.id, kind: n.kind, title: n.fm.title, reason, ...(data ? { data } : {}) });
  const superseded = new Set([...plan.notes.values()].filter((d) => d.kind === 'decision').flatMap((d) => (Array.isArray(d.fm.supersedes) ? d.fm.supersedes : [])));
  const notes = [...plan.notes.values()].filter((n) => !superseded.has(n.id));
  for (const n of notes) if (n.fm.review) add('flagged', n, String(n.fm.review));
  for (const n of notes) {
    if (n.kind !== 'work' || !isDone(n)) continue;
    if (!n.fm.basis) { add('drift', n, 'completed but never recorded, so there is no basis to compare against', { missing: true }); continue; }
    const [own, up] = String(n.fm.basis).split('.');
    const [cOwn, cUp] = basisOf(plan, n).split('.');
    const why = [];
    if (own !== cOwn) why.push('its Requirements changed after it was completed');
    if (up !== cUp) why.push('the Requirements of a prerequisite changed after it was completed');
    if (why.length) add('drift', n, why.join('; '), { own: own !== cOwn, upstream: up !== cUp });
  }
  for (const n of notes) if (n.kind === 'work' && n.fm.status === 'done' && n.fm.source === 'agent') add('unconfirmed', n, 'reported done by an agent; not yet confirmed by the user or a tool');
  for (const n of notes) if (n.kind === 'idea' && n.fm.recall_state === 'fired' && ['open', 'deferred'].includes(n.fm.idea_state)) add('recalled', n, 'brought back for discussion; waiting for the user to decide');
  for (const n of notes) {
    for (const q of openQuestions(n)) add('question', n, q);
  }
  for (const n of notes) {
    if (n.kind !== 'work' || n.fm.status !== 'planned') continue;
    const open = (Array.isArray(n.fm.requires) ? n.fm.requires : []).filter((id) => !isDone(plan.notes.get(id)));
    if (open.length) add('waiting', n, `waiting for ${open.join(', ')}`, { open });
  }
  return items;
}

/** Ideas whose recall condition is met and that have not been raised yet. */
export function recall(plan) {
  const due = [];
  const manual = [];
  for (const n of plan.notes.values()) {
    // a deferred idea with a recall condition is the usual "later" case: it comes back too
    if (n.kind !== 'idea' || n.fm.recall_state !== 'waiting' || !['open', 'deferred'].includes(n.fm.idea_state)) continue;
    const r = parseRecall(String(n.fm.recall || ''));
    if (!r) continue;
    if (r.type === 'manual') { manual.push({ id: n.id, title: n.fm.title, condition: r.text }); continue; }
    const t = plan.notes.get(r.id);
    const met = r.type === 'stage' ? t && t.fm.status === 'closed' : isDone(t);
    if (met) due.push({ id: n.id, title: n.fm.title, condition: n.fm.recall });
  }
  return { due, manual };
}

/** Status shown to people: stored facts plus derived conditions. */
export function supersededBy(plan, id) {
  return [...plan.notes.values()].filter((d) => d.kind === 'decision' && Array.isArray(d.fm.supersedes) && d.fm.supersedes.includes(id)).map((d) => d.id);
}

export function displayStatus(plan, n, reviewItems) {
  if (n.kind === 'decision') return reviewItems.some((r) => r.id === n.id && r.type === 'flagged') ? 'review' : 'decision';
  if (supersededBy(plan, n.id).length) return 'superseded';
  const flagged = reviewItems.some((r) => r.id === n.id && (r.type === 'flagged' || r.type === 'drift'));
  if (n.kind === 'work') {
    if (flagged) return 'review';
    if (reviewItems.some((r) => r.id === n.id && r.type === 'waiting')) return 'blocked';
    return n.fm.status;
  }
  if (n.kind === 'stage') return flagged ? 'review' : n.fm.status;
  if (n.kind === 'idea') {
    if (n.fm.recall_state === 'fired' && ['open', 'deferred'].includes(n.fm.idea_state)) return 'recalled';
    if (n.fm.idea_state === 'open') return 'idea';
    return n.fm.idea_state;
  }
  return 'intent';
}

// ---------------------------------------------------------------- git context

function git(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** Branch, commit and (for linked worktrees) worktree name of dir, or null outside git. */
export function gitContext(dir) {
  if (process.env.OMINO_NO_GIT || isPlanFolder(dir)) return null;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const out = {};
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') out.branch = branch;
  const commit = git(dir, ['rev-parse', '--short', 'HEAD']);
  if (commit) out.commit = commit;
  const gd = git(dir, ['rev-parse', '--absolute-git-dir']);
  const common = git(dir, ['rev-parse', '--git-common-dir']);
  if (gd && common && path.resolve(dir, common) !== gd) out.worktree = path.basename(top);
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- comments the user leaves on the page

const HOOKSTATE = '.hooks.json';
export const SUMMARY = 'summary.json';
// files Omino 0.5 kept in a plan folder for its per-plan page server and the answers queued on it
const OLD_INBOX = 'inbox.jsonl';
const OLD_LOCAL = ['.serve.json', '.live.json'];
const LOCAL_FILES = ['view.html', SUMMARY, HOOKSTATE, '.paths.json', '.lock'];

function ensureIgnored(root, names) {
  const p = path.join(root, '.gitignore');
  const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim()) : [];
  const add = names.filter((n) => !have.includes(n));
  if (add.length) fs.appendFileSync(p, (have.length && have[have.length - 1] !== '' ? '\n' : '') + add.join('\n') + '\n');
}

/**
 * A comment is a "> [!omino]" block under a note's "## Comments" heading: something the user asks of the agent,
 * written on the page (or by hand in the file). It stays there until the agent has dealt with it and removes it.
 * Its own section keeps it out of Requirements, so a comment never makes finished work look out of date.
 */
const COMMENT_HEAD = /^>\s*\[!omino\]\s?(.*)$/i;
export function comments(plan) {
  const out = [];
  for (const n of plan.notes.values()) {
    const sec = sections(n.body).comments;
    if (!sec) continue;
    let cur = null;
    for (const line of sec.split('\n')) {
      const m = COMMENT_HEAD.exec(line);
      if (m) { cur = { lines: m[1].trim() ? [m[1].trim()] : [] }; out.push(Object.assign(cur, { id: n.id, title: n.fm.title, file: n.file })); continue; }
      if (cur && /^\s*>/.test(line)) { cur.lines.push(line.replace(/^\s*>\s?/, '')); continue; }
      cur = null;
    }
  }
  return out.map((c) => { const text = c.lines.join('\n').trim(); return { id: c.id, title: c.title, file: c.file, text, key: `${c.id}:${sha(text).slice(0, 10)}` }; });
}

/** body with a comment block added at the end of its "## Comments" section (made when missing). */
export function addCommentTo(body, text, label) {
  const block = [`> [!omino]${label ? ' ' + label : ''}`, ...String(text).trim().split('\n').map((l) => (l.trim() ? '> ' + l : '>'))].join('\n');
  const lines = norm(body).replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => /^##\s+comments\s*$/i.test(l));
  if (at < 0) return (lines.join('\n') ? lines.join('\n') + '\n\n' : '') + '## Comments\n\n' + block + '\n';
  let end = at + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  let k = end;
  while (k > at + 1 && !lines[k - 1].trim()) k--;
  lines.splice(k, 0, '', ...block.split('\n'), ...(end < lines.length ? [''] : []));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

const FM_END = (src) => src.indexOf('\n---', 4) + 4;
const rawOf = (root, file) => norm(fs.readFileSync(path.join(root, file), 'utf8'));
const hashOf = (raw) => sha(norm(raw)).slice(0, 16);
const isZh = (lang) => String(lang || '').toLowerCase().startsWith('zh');

/** The note as it is on disk, for the page's editor: its text and a hash to detect edits made meanwhile. */
export function noteSource(dir, id) {
  const plan = loadPlan(dir);
  const n = plan.notes.get(id);
  if (!n) throw new OminoError(`unknown note "${id}"`, 4);
  const text = rawOf(plan.root, n.file);
  return { id, file: n.file, text, hash: hashOf(text) };
}

function pageGuard(plan) {
  if (isClosed(plan.root)) throw new OminoError('this plan is closed: it can be read, not changed', 1);
  assertFormat(plan);
}

/**
 * The user changed a note on the page. The new text must keep the note's id and kind and leave the plan valid;
 * if the file changed since the page loaded it (base), nothing is written unless force. Recorded at once as the
 * user's change, with only this note (and what record itself touches) in the entry, so edits an agent has not
 * recorded yet are never put down to the user.
 */
export function pageEdit(dir, id, { text, base, force = false, lang } = {}) { return withLock(omRoot(dir), () => {
  const plan = loadPlan(dir);
  pageGuard(plan);
  const n = plan.notes.get(id);
  if (!n) throw new OminoError(`unknown note "${id}"`, 4);
  const cur = rawOf(plan.root, n.file);
  if (!force && base && hashOf(cur) !== base) { const e = new OminoError('this note changed after you opened it', 5); e.current = { text: cur, hash: hashOf(cur) }; throw e; }
  let next = norm(String(text || ''));
  if (!next.endsWith('\n')) next += '\n';
  if (next.length > 512 * 1024) throw new OminoError('the note is too long');
  let fm;
  try { fm = parseNote(next, n.file).fm; } catch (e) { throw new OminoError(e.message); }
  if (fm.id !== id) throw new OminoError(`the id must stay "${id}" (rename notes in the conversation)`);
  if (fm.kind !== n.kind) throw new OminoError(`the kind must stay "${n.kind}"`);
  if (next === cur) return { changed: false, hash: hashOf(cur) };
  const file = path.join(plan.root, n.file);
  fs.writeFileSync(file, next);
  const { errors } = validate(loadPlan(dir));
  if (errors.length) { fs.writeFileSync(file, cur); throw new OminoError('not saved, the plan would not be valid:\n' + errors.map((e) => `${e.file}: ${e.msg}`).join('\n')); }
  const r = cmdRecord(dir, isZh(lang) ? `在页面上修改了「${n.fm.title}」` : `Edited "${n.fm.title}" on the page`, 'user', { only: [id], via: 'page', page: 'edit' });
  return { changed: true, hash: hashOf(rawOf(plan.root, n.file)), recorded: r.recorded };
}); }

/** The user left a comment for the agent on a note (an answer, an objection, a decision on an idea, a remark). */
export function pageComment(dir, id, { text, label, lang } = {}) { return withLock(omRoot(dir), () => {
  const plan = loadPlan(dir);
  pageGuard(plan);
  const n = plan.notes.get(id);
  if (!n) throw new OminoError(`unknown note "${id}"`, 4);
  const t = String(text || '').trim(), l = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t && !l) throw new OminoError('text is required');
  if (t.length > 4000) throw new OminoError('text is too long');
  const cur = rawOf(plan.root, n.file), cut = FM_END(cur);
  fs.writeFileSync(path.join(plan.root, n.file), cur.slice(0, cut) + '\n\n' + addCommentTo(cur.slice(cut).replace(/^\n+/, ''), t, l).replace(/^\n+/, ''));
  const said = [l, t].filter(Boolean).join(': ');
  cmdRecord(dir, isZh(lang) ? `在页面上给「${n.fm.title}」留言` : `Comment on "${n.fm.title}" from the page`, 'user', { only: [id], via: 'page', page: 'comment', said });
  return { ok: true, comments: comments(loadPlan(dir)).filter((c) => c.id === id) };
}); }

/**
 * The user confirmed, on the page, what was waiting for them: a draft or flagged note (its review line goes),
 * work an agent reported done (it becomes the user's), or finished work whose requirements changed (re-checked).
 */
export function pageConfirm(dir, id, { about, lang } = {}) { return withLock(omRoot(dir), () => {
  const plan = loadPlan(dir);
  pageGuard(plan);
  const n = plan.notes.get(id);
  if (!n) throw new OminoError(`unknown note "${id}"`, 4);
  const items = review(plan).filter((i) => i.id === id && ['flagged', 'drift', 'unconfirmed'].includes(i.type));
  const it = items.find((i) => i.type === about) || items[0];
  if (!it) throw new OminoError('nothing on this note is waiting for a confirmation');
  const file = path.join(plan.root, n.file);
  if (it.type === 'flagged') setField(file, 'review', null);
  if (it.type === 'unconfirmed') setField(file, 'source', 'user');
  const summary = isZh(lang) ? `在页面上确认了「${n.fm.title}」` : `Confirmed "${n.fm.title}" on the page`;
  const r = cmdRecord(dir, summary, 'user', { only: [id], via: 'page', page: 'confirm', ...(it.type === 'drift' ? { confirm: [id] } : {}) });
  return { ok: true, confirmed: it.type, recorded: r.recorded };
}); }

/** Answers queued on the page by Omino 0.5 that no agent picked up become comments, so none is lost. */
export function migrateInbox(dir) {
  let root; try { root = omRoot(dir); } catch { return 0; }
  const f = root && path.join(root, OLD_INBOX);
  if (!f || !fs.existsSync(f)) return 0;
  const byId = new Map();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.event) byId.set(r.id, r); else if (r.reply) byId.delete(r.reply);
  }
  let moved = 0;
  try {
    const plan = loadPlan(dir);
    if (!isClosed(plan.root)) {
      for (const e of byId.values()) {
        if (!plan.notes.has(e.note)) continue;
        const zh = /[㐀-鿿]/.test((e.text || '') + (e.question || '') + (e.title || ''));
        const label = e.type === 'answer' ? (zh ? `回答「${e.question || ''}」` : `Answer to "${e.question || ''}"`)
          : e.type === 'confirm' ? (zh ? '确认无误' : 'Looks right')
          : e.type === 'dispute' ? (zh ? '有问题' : 'Something is off')
          : e.type === 'decide' ? (zh ? `想法：${{ adopt: '采纳', defer: '暂缓', drop: '放弃' }[e.choice] || e.choice}` : `Idea: ${e.choice}`) : '';
        pageComment(dir, e.note, { text: e.text || '', label, lang: zh ? 'zh' : 'en' });
        moved++;
      }
    }
  } catch { return 0; }
  try { fs.renameSync(f, path.join(root, 'inbox.migrated.jsonl')); } catch {}
  for (const x of OLD_LOCAL) { try { fs.rmSync(path.join(root, x)); } catch {} }
  return moved;
}

// ---------------------------------------------------------------- the page service: one local server for every plan
//
// One server on 127.0.0.1, on a fixed port (4870, or OMINO_PORT; another one only when that is taken), serving the page
// of every plan on this machine at /p/<id>. Hooks start it when a session opens and it keeps running; "omino service
// install" also starts it at login. Pages need no token (only this machine reaches 127.0.0.1, the Host header is checked,
// and other sites cannot read the answers); everything under /api/ needs the token in ~/.omino/server.json, which the
// served page carries and other apps (a Mandala tab) read from that file. Agents never depend on the service: hooks and
// commands read and write the files directly.

export const DEFAULT_PORT = 4870;
const SERVICE_FILE = 'server.json';
const servicePath = () => path.join(ominoHome(), SERVICE_FILE);
const PLAN_ID = /^[a-z0-9][a-z0-9._-]*$/;

function serviceToken() {
  const f = path.join(ominoHome(), 'token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[a-f0-9]{32}$/.test(t)) return t; } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(ominoHome(), { recursive: true });
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}

/** The running page service ({ port, token, pid, version, url }), or null. */
export function serviceInfo() {
  let c; try { c = JSON.parse(fs.readFileSync(servicePath(), 'utf8')); } catch { return null; }
  if (!c || !Number.isInteger(c.port) || !c.pid) return null;
  try { process.kill(c.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
  return { ...c, url: `http://127.0.0.1:${c.port}` };
}
const planUrl = (svc, id) => `${svc.url}/p/${encodeURIComponent(id)}`;

/** A folder to open plan id with: one that uses it on this machine, else the plan folder itself. */
export function planFolder(id) {
  if (!PLAN_ID.test(String(id || ''))) return null;
  const root = path.join(ominoHome(), 'projects', id);
  if (!fs.existsSync(path.join(root, 'project.md'))) return null;
  let paths = {}; try { paths = JSON.parse(fs.readFileSync(path.join(root, PATHS), 'utf8')); } catch {}
  const f = Object.keys(paths).find((p) => { try { return fs.existsSync(p) && (projectId(p) || {}).id === id; } catch { return false; } });
  return f || root;
}

/** Something that changes whenever a note, the history or the plan's metadata does. */
function planSignature(root) {
  const parts = [];
  const add = (f) => { try { const s = fs.statSync(f); parts.push(`${f}:${s.size}:${s.mtimeMs}`); } catch {} };
  ['project.md', 'changes.jsonl', 'state.json', META].forEach((f) => add(path.join(root, f)));
  for (const d of Object.values(KIND_DIR)) { const p = path.join(root, d); try { for (const f of fs.readdirSync(p)) add(path.join(p, f)); } catch {} }
  return sha(parts.join('|'));
}

function readBody(req, limit = 600 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new OminoError('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new OminoError('invalid JSON')); } });
    req.on('error', reject);
  });
}

/** Run the page service in this process. Resolves once it listens: { port, url, token, close, closed }. */
export function startService({ port } = {}) {
  const want = port !== undefined ? port : Number(process.env.OMINO_PORT) || DEFAULT_PORT;
  const token = serviceToken();
  const watchers = new Map(); // plan id -> { clients, sig }
  let onClose = () => {};
  const json = (res, code, obj) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN' }); res.end(body); };
  const svcFor = () => ({ port: server.address().port, token });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = server.address().port;
    // a page from another site reaching 127.0.0.1 through a rebound host name is refused
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${p}$`).test(req.headers.host || '')) return json(res, 403, { error: 'bad host' });
    const api = url.pathname.startsWith('/api/');
    if (api) {
      // apps that embed the page (or view.html opened from disk) call the API from their own origin, with the token
      res.setHeader('access-control-allow-origin', req.headers.origin || '*');
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      if (!api) return json(res, 405, { error: 'method not allowed' });
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT', 'access-control-allow-headers': 'content-type, x-omino-token', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600' });
      return res.end();
    }
    try {
      if (url.pathname === '/api/hello') return json(res, 200, { ok: true, omino: true, version: VERSION });
      if (api && (req.headers['x-omino-token'] || url.searchParams.get('t')) !== token) return json(res, 403, { error: 'bad token' });
      let m;
      if (!api) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        if (url.pathname === '/' || url.pathname === '/overview') return html(res, cmdOverview(null, { link: (x) => `/p/${encodeURIComponent(x.id)}`, refresh: false, write: false }).html);
        if ((m = /^\/p\/([^/]+)\/?$/.exec(url.pathname))) {
          const id = decodeURIComponent(m[1]), dir = planFolder(id);
          if (!dir) return json(res, 404, { error: 'unknown plan' });
          return html(res, renderHtml(dir, { service: { ...svcFor(), id } }));
        }
        if ((m = /^\/p\/([^/]+)\/file$/.exec(url.pathname))) {
          // read-only view of a file in the project (f=, relative to the project folder) or in the plan folder (p=), for links inside notes
          const id = decodeURIComponent(m[1]), dir = planFolder(id);
          if (!dir) return json(res, 404, { error: 'unknown plan' });
          const root = path.join(ominoHome(), 'projects', id);
          const inProject = url.searchParams.has('f');
          if (inProject && path.resolve(dir) === path.resolve(root)) return json(res, 404, { error: 'no project folder for this plan on this machine' });
          const base = inProject ? path.resolve(dir) : root;
          const target = path.resolve(base, url.searchParams.get(inProject ? 'f' : 'p') || '');
          const rel = path.relative(base, target);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((seg) => seg === '.git') || (!inProject && [HOOKSTATE, '.paths.json', OLD_INBOX, 'inbox.migrated.jsonl'].includes(path.basename(target)))) return json(res, 403, { error: 'not allowed' });
          let st; try { st = fs.statSync(target); } catch { return json(res, 404, { error: 'not found' }); }
          if (!st.isFile() || st.size > 2 * 1024 * 1024) return json(res, 404, { error: 'not a readable file' });
          const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(target).toLowerCase()] || 'text/plain; charset=utf-8';
          res.writeHead(200, { 'content-type': type, 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
          return res.end(fs.readFileSync(target));
        }
        return json(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/plans') return json(res, 200, { plans: cmdProjects(null).projects.map((x) => ({ id: x.id, title: x.title, status: x.status, last: x.last, repos: x.repos, url: `/p/${encodeURIComponent(x.id)}` })) });
      if (req.method === 'POST' && url.pathname === '/api/shutdown') { json(res, 200, { ok: true }); setImmediate(close); return; }
      if (!(m = /^\/api\/plans\/([^/]+)(\/.*)?$/.exec(url.pathname))) return json(res, 404, { error: 'not found' });
      const id = decodeURIComponent(m[1]), rest = m[2] || '', dir = planFolder(id);
      if (!dir) return json(res, 404, { error: 'unknown plan' });
      if (req.method === 'GET' && rest === '/summary') return json(res, 200, planSummary(dir));
      if (req.method === 'GET' && rest === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        const root = path.join(ominoHome(), 'projects', id);
        if (!watchers.has(id)) watchers.set(id, { clients: new Set(), root, sig: planSignature(root) });
        const w = watchers.get(id);
        w.clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); w.clients.delete(res); if (!w.clients.size) watchers.delete(id); });
        return;
      }
      const nm = /^\/notes\/([^/]+)(\/comment|\/confirm)?$/.exec(rest);
      if (!nm) return json(res, 404, { error: 'not found' });
      const note = decodeURIComponent(nm[1]);
      if (req.method === 'GET' && !nm[2]) return json(res, 200, noteSource(dir, note));
      if (req.method === 'PUT' && !nm[2]) { const b = await readBody(req); return json(res, 200, pageEdit(dir, note, b)); }
      if (req.method === 'POST' && nm[2] === '/comment') { const b = await readBody(req); return json(res, 200, pageComment(dir, note, b)); }
      if (req.method === 'POST' && nm[2] === '/confirm') { const b = await readBody(req); return json(res, 200, pageConfirm(dir, note, b)); }
      return json(res, 405, { error: 'method not allowed' });
    } catch (e) {
      if (e instanceof OminoError) return json(res, e.code === 5 ? 409 : e.code === 4 ? 404 : 400, { error: e.message, ...(e.current ? { current: e.current } : {}) });
      return json(res, 500, { error: e.message });
    }
  });

  // pages that are open hear when their plan changes (an agent recorded, a file was edited), and refresh
  const tick = setInterval(() => {
    for (const w of watchers.values()) {
      const s = planSignature(w.root);
      if (s === w.sig) continue;
      w.sig = s;
      for (const c of w.clients) c.write(`data: ${JSON.stringify({ type: 'changed' })}\n\n`);
    }
  }, 800);
  tick.unref();

  function close() {
    clearInterval(tick);
    for (const w of watchers.values()) for (const c of w.clients) { try { c.end(); } catch {} }
    watchers.clear();
    server.close();
    try { const cur = JSON.parse(fs.readFileSync(servicePath(), 'utf8')); if (cur.pid === process.pid) fs.rmSync(servicePath()); } catch {}
    onClose();
  }
  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      // the fixed port is taken: by a running Omino (use that one), or by something else (take any free port)
      if (e.code === 'EADDRINUSE' && port === undefined && server.listening === false && want !== 0) {
        const other = serviceInfo();
        if (other) return reject(new OminoError(`the Omino page service already runs at ${other.url}`, 1));
        server.listen(0, '127.0.0.1');
      } else reject(e);
    });
    server.listen(want, '127.0.0.1');
    server.on('listening', () => {
      const p = server.address().port;
      fs.mkdirSync(ominoHome(), { recursive: true });
      fs.writeFileSync(servicePath(), JSON.stringify({ port: p, token, pid: process.pid, version: VERSION, script: fileURLToPath(import.meta.url), startedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
      resolve({ port: p, token, url: `http://127.0.0.1:${p}`, close, closed: new Promise((r) => { onClose = r; }) });
    });
  });
}

const waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Make sure the page service runs, starting it in the background when it does not. A service from an older Omino is
 * replaced by this one (and a login item pointing at it is updated); a newer one is left alone.
 * OMINO_NO_SERVE turns this off (tests, or people who do not want it).
 */
export function ensureService({ wait = 2000 } = {}) {
  if (process.env.OMINO_NO_SERVE) return null;
  const cur = serviceInfo();
  if (cur && !older(cur.version || '0', VERSION)) return cur;
  if (cur) {
    try { process.kill(cur.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 40 && serviceInfo(); i++) waitSync(25);
  }
  // a login item for an older copy follows this one; one for a newer copy is left alone
  try { const a = autostartStatus(); if (a.installed && !a.current) { const v = scriptVersion(a.script); if (!v || older(v, VERSION)) cmdServiceInstall(); } } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'service', 'run'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (const until = Date.now() + wait; Date.now() < until;) { const c = serviceInfo(); if (c && c.pid === child.pid) return c; waitSync(40); }
  return serviceInfo();
}

export async function cmdServiceStop() {
  const cur = serviceInfo();
  if (!cur) return { stopped: false };
  try { process.kill(cur.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 80 && serviceInfo(); i++) await new Promise((r) => setTimeout(r, 25));
  return { stopped: true, port: cur.port };
}

// ---------------------------------------------------------------- starting the service at login

/** Where the login item lives on this system: a launchd agent (macOS), a Startup script (Windows), an XDG autostart entry (Linux). */
export function autostartFile({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', 'ai.maktub.omino.plist');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'omino-service.vbs');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'omino-service.desktop');
}

/** The login item's text: runs this copy of Omino's service with the node running now. */
export function autostartContent({ platform = process.platform, node = process.execPath, script = fileURLToPath(import.meta.url), env = process.env } = {}) {
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (platform === 'darwin') {
    const vars = ['OMINO_HOME', 'OMINO_PORT'].filter((k) => env[k]).map((k) => `<key>${k}</key><string>${xml(env[k])}</string>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.maktub.omino</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>service</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  ${vars ? `<key>EnvironmentVariables</key><dict>${vars}</dict>` : ''}
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
  }
  if (platform === 'win32') return `' Omino: the plan page service, started at login\r\nCreateObject("WScript.Shell").Run """${node}"" ""${script}"" service run", 0, False\r\n`;
  const q = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
  return `[Desktop Entry]\nType=Application\nName=Omino page service\nComment=Serves the Omino plan pages on 127.0.0.1\nExec=${q(node)} ${q(script)} service run\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`;
}

const scriptVersion = (f) => { try { return (fs.readFileSync(f, 'utf8').match(/export const VERSION = '([^']+)'/) || [])[1] || null; } catch { return null; } };

export function autostartStatus(opts = {}) {
  const file = autostartFile(opts);
  let text = null; try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const script = text && (text.match(/([^"<>\n]*omino\.mjs)/) || [])[1];
  return { file, installed: text !== null, current: text !== null && text === autostartContent(opts), script: script || null };
}

/** Start the service at login from now on (and now). */
export function cmdServiceInstall(opts = {}) {
  const file = autostartFile(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, autostartContent(opts));
  return { file, installed: true };
}
export function cmdServiceUninstall(opts = {}) {
  const file = autostartFile(opts);
  const had = fs.existsSync(file);
  try { fs.rmSync(file); } catch {}
  return { file, removed: had };
}

// ---------------------------------------------------------------- commands

const PROJECT_TEMPLATE = `---
id: project
kind: intent
title: Untitled project
---

## Purpose

## Principles

## Boundaries
`;

const ADOPT_PROJECT = `---
id: project
kind: intent
title: Untitled project
review: Drafted by an agent from existing docs; the user has not confirmed it yet
---

## Purpose

## Principles

## Boundaries

## Open questions
<!-- One bullet per question only the user can settle, e.g. where two documents disagree. -->

## Sources
<!-- Which files this draft was based on, e.g. README.md, docs/ -->
`;

const ADOPT_STAGE = `---
id: s0
kind: stage
title: Before Omino
level: 0
status: closed
source: agent
---

## Existing capabilities
<!-- A short prose summary of what the project already does. Not a list of completed work items:
     past work has no recorded requirements, so it cannot be checked or re-checked. -->

## Sources
<!-- Which files or conversations this summary is based on. -->
`;

export function cmdInit(dir, { adopt = false, share = false, name } = {}) {
  dir = path.resolve(dir);
  if (hasLegacy(dir)) throw new OminoError(`this project still keeps its plan in ${LEGACY}/; run "omino migrate" instead`);
  let had = projectId(dir);
  if (had && isClosed(omRoot(dir))) {
    // the previous plan here is finished: the next piece of work gets its own plan
    if (!name) throw new OminoError(`the plan here ("${had.id}") is closed; give the new plan a name: omino init --name <id>`);
    if (idFromName(name) === had.id) throw new OminoError(`"${had.id}" is the closed plan; choose another name, or reopen it with "omino close --reopen"`);
    writeBinding(dir, idFromName(name), { share: share || fs.existsSync(path.join(dir, CONFIG)) });
    had = null;
  }
  const p = bindProject(dir, { share, name });
  const root = omRoot(dir);
  if (fs.existsSync(root)) {
    if (had) throw new OminoError(`this project already has a plan at ${root}`);
    noteUse(root, dir, p.id);
    commitHistory(root, `Attach ${path.basename(dir)}`);
    return { created: null, attached: root, id: p.id, adopt: false, files: [] };
  }
  for (const d of Object.values(KIND_DIR)) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'project.md'), adopt ? ADOPT_PROJECT : PROJECT_TEMPLATE);
  if (adopt) fs.writeFileSync(path.join(root, 'stages', 's0.md'), ADOPT_STAGE);
  fs.writeFileSync(path.join(root, 'changes.jsonl'), '');
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: FORMAT, notes: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, '.gitignore'), LOCAL_FILES.join('\n') + '\n');
  const files = ['project.md', ...(adopt ? ['stages/s0.md'] : []), 'changes.jsonl', 'state.json', '.gitignore'].map((f) => path.join(root, f));
  noteUse(root, dir, p.id);
  commitHistory(root, 'Start the plan');
  return { created: root, id: p.id, adopt, files };
}

/** Record every unrecorded change as one entry. */
export function cmdRecord(dir, summary, source, opts = {}) { let root = null; try { root = omRoot(dir); } catch {} return withLock(root, () => recordUnlocked(dir, summary, source, opts)); }
/**
 * only: record just these notes (and what recording them touches), leaving other unrecorded edits for whoever made them.
 * The page records the user's own change this way, so an agent's edits in progress are never put down to the user.
 * via/page say where the change was made (the page service) and what it was (edit, comment, confirm).
 */
function recordUnlocked(dir, summary, source, { confirm = [], ts, said, session, view = true, only, via, page } = {}) {
  if (!summary || !summary.trim()) throw new OminoError('record needs a one-line summary');
  if (!SOURCES.includes(source)) throw new OminoError(`--source must be one of ${SOURCES.join(', ')}`);
  let plan = loadPlan(dir);
  if (isClosed(plan.root)) throw new OminoError(`plan "${(projectId(dir) || {}).id}" is closed. If the user is starting new work here, ask what it is for and run "omino init --name <id>"; to change this plan again, "omino close --reopen" first`, 1);
  const { errors } = validate(plan);
  if (errors.length) throw new OminoError('fix these first:\n' + errors.map((e) => `  ${e.file}: ${e.msg}`).join('\n'), 1);
  assertFormat(plan);
  const state = readState(plan);
  const scope = only ? new Set(only) : null;
  const inScope = (id) => !scope || scope.has(id);

  // stamp completion basis for work that just became done/verified (or was explicitly confirmed)
  const stamped = [];
  for (const n of plan.notes.values()) {
    if (n.kind !== 'work' || !isDone(n) || !inScope(n.id)) continue;
    const prev = state.notes[n.id];
    const wasDone = prev && DONE.includes(prev.status);
    if (n.fm.status === 'verified' && (!prev || prev.status !== 'verified') && source !== 'tool') {
      throw new OminoError(`${n.file}: became "verified" but this record's source is "${source}"; verified needs --source tool`, 1);
    }
    if (!wasDone || !n.fm.basis || confirm.includes(n.id)) {
      const b = basisOf(plan, n);
      if (n.fm.basis !== b) { setField(path.join(plan.root, n.file), 'basis', b); stamped.push(n.id); }
    }
  }
  for (const id of confirm) if (!plan.notes.has(id)) throw new OminoError(`--confirm: unknown note "${id}"`);

  // a new or changed decision asks for a second look at what it affects (work already under way, stages already arranged)
  const flagged = [];
  for (const d of plan.notes.values()) {
    if (d.kind !== 'decision' || !inScope(d.id) || (state.notes[d.id] && state.notes[d.id].hash === d.hash)) continue;
    for (const id of Array.isArray(d.fm.affects) ? d.fm.affects : []) {
      const t = plan.notes.get(id);
      // a decision about the whole project links to it; the intent itself is only changed when the user says so
      if (!t || t.kind === 'intent' || flagged.includes(id) || t.fm.review || (Array.isArray(d.fm.supersedes) && d.fm.supersedes.includes(id))) continue;
      // changed together with the decision: it has already been re-arranged on purpose
      if (!state.notes[id] || state.notes[id].hash !== t.hash) continue;
      const settled = (t.kind === 'work' && ['planned', 'dropped'].includes(t.fm.status)) || (t.kind === 'stage' && t.fm.status === 'planned') || t.kind === 'idea';
      if (settled) continue;
      setField(path.join(plan.root, t.file), 'review', `Affected by decision "${d.fm.title}" (${d.id}); check it still fits`);
      flagged.push(id);
    }
  }
  if (stamped.length || flagged.length) plan = loadPlan(dir);
  if (scope) flagged.forEach((id) => scope.add(id));

  const diff = unrecorded(plan, state).filter((d) => inScope(d.id));
  ensureIgnored(plan.root, LOCAL_FILES);
  if (!diff.length) return { recorded: false, notes: [] };
  const sess = session || process.env.OMINO_SESSION;
  // a change made on the page has nothing to do with the code's branch or commit
  const g = via ? null : gitContext(dir);
  const entry = { ts: ts || new Date().toISOString(), source, summary: summary.trim(), ...(said && said.trim() ? { said: said.trim() } : {}), ...(sess ? { session: String(sess) } : {}), ...(g ? { git: g } : {}), ...(via ? { via } : {}), ...(page ? { page } : {}), notes: diff };
  fs.appendFileSync(path.join(plan.root, 'changes.jsonl'), JSON.stringify(entry) + '\n');
  const next = { version: FORMAT, notes: scope ? { ...state.notes } : {} };
  for (const n of plan.notes.values()) if (inScope(n.id)) next.notes[n.id] = { hash: n.hash, file: n.file, status: n.fm.status || n.fm.idea_state || null };
  if (scope) for (const d of diff) if (d.op === 'deleted') delete next.notes[d.id];
  fs.writeFileSync(path.join(plan.root, 'state.json'), JSON.stringify(next, null, 2) + '\n');
  let links = [];
  if (view) {
    try {
      const { written } = cmdView(dir);
      const svc = serviceInfo(), id = (projectId(dir) || {}).id;
      const base = svc && id ? planUrl(svc, id) : pathToFileURL(written).href;
      links = diff.filter((d) => d.op !== 'deleted').map((d) => ({ id: d.id, op: d.op, title: plan.notes.get(d.id)?.fm.title, url: `${base}#${encodeURIComponent(d.id)}` }));
    } catch { /* the record itself succeeded; the page can be regenerated with view */ }
  }
  const created = new Set(diff.filter((d) => d.op === 'created').map((d) => d.id));
  const lonely = orphans(plan).filter((o) => created.has(o.id));
  const touched = new Set(diff.map((d) => d.id));
  const recheck = review(plan).filter((i) => i.type === 'drift' && touched.has(i.id)).map((i) => i.id);
  noteUse(plan.root, dir, (projectId(dir) || {}).id);
  commitHistory(plan.root, summary.trim(), scope ? ['changes.jsonl', 'state.json', ...diff.map((d) => (plan.notes.get(d.id) || state.notes[d.id] || {}).file).filter(Boolean)] : null);
  return { recorded: true, notes: diff, stamped, flagged, links, orphans: lonely, recheck };
}

export function cmdCheck(dir, { fix = false, ts } = {}) {
  const plan = loadPlan(dir);
  const { errors, warnings } = validate(plan);
  const fmt = Number(readState(plan).version || 1);
  if (fmt > FORMAT) errors.push({ file: 'state.json', msg: `format ${fmt} is newer than this Omino supports (${FORMAT}); update Omino` });
  const intent = plan.notes.get('project');
  if (intent) {
    const secs = sections(intent.body);
    const dated = Object.entries(secs).filter(([k]) => k !== 'sources').map(([, v]) => v).join('\n').split('\n').filter((l) => /^\s*(?:[-*]\s*)?\d{4}-\d{2}-\d{2}\s*[：:]/.test(l)).length;
    if (dated) warnings.push({ file: intent.file, msg: `the intent holds ${dated} dated progress entr${dated > 1 ? 'ies' : 'y'}; the intent says why the project exists — move progress into work items (unplanned fixes go in a maintenance stage)`, progress: true });
  }
  if (!errors.length) for (const o of orphans(plan)) warnings.push({ file: o.file, msg: `not linked to anything (add refs${o.kind === 'decision' ? ', affects or supersedes; a project-wide decision can affect [project]' : ' or a recall condition'})`, orphan: true });
  const pending = errors.length ? [] : unrecorded(plan, readState(plan));
  let fixed = null;
  if (fix && pending.length) fixed = cmdRecord(dir, 'Files were edited directly (recorded by check --fix)', 'file', { ts });
  return { ok: errors.length === 0 && (pending.length === 0 || !!fixed), errors, warnings, unrecorded: pending, fixed, comments: errors.length ? [] : comments(plan) };
}

export function cmdRecall(dir, { markFired = [], stop = [] } = {}) {
  const plan = loadPlan(dir);
  const set = (id, value) => {
    const n = plan.notes.get(id);
    if (!n || n.kind !== 'idea' || n.fm.recall === undefined) throw new OminoError(`"${id}" is not an idea with a recall condition`);
    setField(path.join(plan.root, n.file), 'recall_state', value);
  };
  markFired.forEach((id) => set(id, 'fired'));
  stop.forEach((id) => set(id, 'stopped'));
  const touched = markFired.length + stop.length > 0;
  return { ...recall(touched ? loadPlan(dir) : plan), updated: [...markFired, ...stop] };
}

export function cmdReview(dir) {
  const plan = loadPlan(dir);
  const { errors } = validate(plan);
  if (errors.length) throw new OminoError('fix these first (run "omino check"):\n' + errors.map((e) => `  ${e.file}: ${e.msg}`).join('\n'), 1);
  return { items: review(plan), comments: comments(plan) };
}

/** Build the data model the viewer renders. */
export function buildModel(dir) {
  const plan = loadPlan(dir);
  const { errors } = validate(plan);
  if (errors.length) throw new OminoError('fix these first (run "omino check"):\n' + errors.map((e) => `  ${e.file}: ${e.msg}`).join('\n'), 1);
  const items = review(plan);
  const changes = readChanges(plan);
  const notes = [...plan.notes.values()].map((n) => ({
    id: n.id, kind: n.kind, file: n.file, title: n.fm.title, fm: n.fm, body: n.body,
    display: displayStatus(plan, n, items)
  }));
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    notes,
    attention: items,
    recall: recall(plan),
    changes: changes.slice().reverse(),
    unrecorded: unrecorded(plan, readState(plan)),
    id: (projectId(dir) || {}).id || null,
    // which repository or folder each lane stands for
    planStatus: readMeta(plan.root).status || 'active',
    plans: (() => { try { return otherPlans(dir); } catch { return []; } })(),
    overviewUrl: pathToFileURL(path.join(ominoHome(), 'index.html')).href,
    laneRepos: Object.entries(readMeta(plan.root).lanes || {}).reduce((m, [k, l]) => { (m[l] = m[l] || []).push(keyLabel(k)); return m; }, {}),
    // links to project files resolve against the project folder, not the plan folder
    projectUrl: pathToFileURL(path.resolve(dir) + path.sep).href
  };
}

export function openInBrowser(file) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : ['xdg-open', [file]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

export function renderHtml(dir, { service } = {}) {
  const model = buildModel(dir);
  // served: edits and comments go to the service; other plans and the overview are its routes.
  // On disk: the page looks for the service and offers to open the plan there.
  if (service) model.service = { token: service.token, id: service.id };
  else { const svc = serviceInfo(); model.probe = { port: svc ? svc.port : Number(process.env.OMINO_PORT) || DEFAULT_PORT }; }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tpl = fs.readFileSync(path.join(here, '..', 'viewer', 'template.html'), 'utf8');
  const json = JSON.stringify(model).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
  const marker = '/*__OMINO_DATA__*/null';
  if (!tpl.includes(marker)) throw new OminoError('viewer template is missing its data marker');
  return tpl.replace(marker, () => json);
}

/**
 * summary.json, beside view.html: a small, stable answer for other apps (a Mandala tab, a status bar)
 * that show the plan without running Omino — its title, where it stands, what waits for the user.
 */
export function planSummary(dir) {
  const m = buildModel(dir);
  const intent = m.notes.find((n) => n.kind === 'intent');
  const work = m.notes.filter((n) => n.kind === 'work');
  const doneish = (n) => ['done', 'verified'].includes(n.fm.status);
  const stage = m.notes.filter((n) => n.kind === 'stage' && n.fm.status === 'active').sort((a, b) => (a.fm.level || 0) - (b.fm.level || 0))[0];
  const inStage = stage ? work.filter((n) => n.fm.stage === stage.id) : [];
  return {
    format: 'omino-summary', version: 1, omino: VERSION, generatedAt: m.generatedAt,
    id: (() => { try { return projectId(dir).id; } catch { return null; } })(),
    title: intent ? intent.title : null, status: m.planStatus,
    stage: stage ? { id: stage.id, title: stage.title, done: inStage.filter(doneish).length, total: inStage.length } : null,
    work: { done: work.filter(doneish).length, total: work.length },
    waiting: m.attention.filter((a) => a.type !== 'waiting').map((a) => { const n = m.notes.find((x) => x.id === a.id); return { id: a.id, title: n ? n.title : a.id, type: a.type, reason: a.reason || '' }; }),
    // comments the user left that an agent has not dealt with yet
    comments: comments(loadPlan(dir)).length,
    view: 'view.html'
  };
}

export function cmdView(dir, { out, overview = true } = {}) {
  // the overview page first, so this page can link to it ("all plans") from the start
  if (!out && overview) { try { cmdOverview(dir, { refresh: false }); } catch {} }
  const html = renderHtml(dir);
  const target = out ? path.resolve(out) : path.join(omRoot(dir), 'view.html');
  fs.writeFileSync(target, html);
  if (!out) { try { const root = omRoot(dir); ensureIgnored(root, [SUMMARY]); fs.writeFileSync(path.join(root, SUMMARY), JSON.stringify(planSummary(dir), null, 2) + '\n'); } catch {} }
  return { written: target, notes: loadPlan(dir).notes.size };
}

// ---------------------------------------------------------------- overview of every plan on this machine


/** The other plans on this machine, most recently changed first, for the page's plan switcher. */
function otherPlans(dir) {
  let here = null; try { here = (projectId(dir) || {}).id; } catch {}
  return cmdProjects(dir).projects.filter((p) => p.id !== here).map((p) => {
    const view = path.join(p.root, 'view.html');
    return { id: p.id, title: p.title || p.id, status: p.status, last: p.last, view: fs.existsSync(view) ? pathToFileURL(view).href : null, hasFolder: p.folders.length > 0 };
  }).sort((a, b) => String(b.last || '').localeCompare(String(a.last || ''))).slice(0, 12);
}

/** One page listing every plan on this machine: goal, state, where it stands, what waits for the user, its repositories. */
/**
 * The page listing every plan. link(p) gives each plan's address: its view.html on disk by default, or a route on a
 * running server when the overview is served (file:// links do not open from an http page). With refresh, each plan's
 * view.html is rewritten first; without it (refreshing after one plan's record), existing pages are linked as they are.
 */
export function cmdOverview(dir, { out, link, refresh = true, write = true, home } = {}) {
  const { home: base, projects } = cmdProjects(dir);
  // a line of plain text from Markdown: link text instead of links, no code marks or emphasis
  const plain = (t) => String(t || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]+/g, '').replace(/\s+/g, ' ').trim();
  const target = out ? path.resolve(out) : path.join(ominoHome(), 'index.html');
  const plans = projects.map((p) => {
    const folder = p.folders[0], open = folder || p.root;
    let m = null, view = null, cs = 0;
    try { m = buildModel(open); cs = comments(loadPlan(open)).length; const f = refresh ? cmdView(open, { overview: false }).written : path.join(p.root, 'view.html'); view = link ? link(p) : fs.existsSync(f) ? pathToFileURL(f).href : null; } catch {}
    const stages = m ? m.notes.filter((n) => n.kind === 'stage') : [];
    const active = stages.filter((n) => n.display === 'active').sort((a, b) => (a.fm.level || 0) - (b.fm.level || 0))[0];
    const work = m ? m.notes.filter((n) => n.kind === 'work') : [];
    const intent = m ? m.notes.find((n) => n.kind === 'intent') : null;
    const goal = intent ? (sections(intent.body).purpose || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim()).find(Boolean) : '';
    const waiting = m ? m.attention.filter((a) => a.type !== 'waiting').map((a) => { const n = m.notes.find((x) => x.id === a.id); return { id: a.id, title: n ? n.title : a.id, type: a.type, reason: plain(a.reason).slice(0, 240), ...(a.data ? { data: a.data } : {}) }; }) : [];
    return {
      id: p.id, title: p.title || p.id, status: p.status, current: p.current, href: view, last: p.last,
      goal: plain(goal), stages: stages.length, stage: active ? { level: active.fm.level, title: active.title } : null,
      done: work.filter((n) => ['done', 'verified'].includes(n.display)).length, total: work.filter((n) => n.display !== 'dropped' && n.display !== 'superseded').length,
      repos: p.repos, folder: folder ? path.basename(folder) : null, waiting, comments: cs
    };
  });
  const model = { plans, where: base, home: home || (link ? '/' : pathToFileURL(target).href), generatedAt: new Date().toISOString() };
  const tpl = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'overview.html'), 'utf8');
  const json = JSON.stringify(model).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
  const html = tpl.replace('/*__OMINO_DATA__*/null', () => json);
  if (!write) return { html };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
  return { written: target, plans: projects.length };
}

// ---------------------------------------------------------------- find

/** Search titles and bodies, so an agent can link to an existing note instead of creating a duplicate. */
export function cmdFind(dir, query, { limit = 8 } = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) throw new OminoError('find needs some words to look for');
  const terms = q.split(/\s+/).filter(Boolean);
  const plan = loadPlan(dir);
  const hits = [];
  for (const n of plan.notes.values()) {
    const title = String(n.fm.title || '').toLowerCase();
    const body = String(n.body || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      if (n.id.includes(t)) score += 2;
      const c = body.split(t).length - 1;
      score += Math.min(c, 3);
    }
    if (title.includes(q) && terms.length > 1) score += 3;
    if (!score) continue;
    const at = body.indexOf(terms[0]);
    const flat = (n.body || '').replace(/<!--[\s\S]*?-->/g, '').replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
    const i = at >= 0 ? Math.max(0, flat.toLowerCase().indexOf(terms[0]) - 30) : 0;
    hits.push({ id: n.id, kind: n.kind, title: n.fm.title, file: n.file, score, status: n.fm.status || n.fm.idea_state || null, snippet: flat.slice(i, i + 110) });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { query: q, hits: hits.slice(0, limit) };
}

// ---------------------------------------------------------------- brief (start of a session)

const COMMENTS_TODO = 'Comments the user left on the plan (in each note\'s "## Comments"). Treat each like a message from the user: do what it asks in the plan, or answer it in the conversation; then delete that "> [!omino]" block (and the heading, once empty) and record with --source user --said "<their words>":';
const commentLine = (c) => { const t = c.text.replace(/\s+/g, ' '); return `- ${c.id} (${c.title}): ${t.length > 300 ? t.slice(0, 299) + '…' : t}`; };

/** A short summary for the start of a session: where the plan stands and what is waiting for the user. */
export function cmdBrief(dir, opts) {
  const plan = loadPlan(dir);
  const { errors } = validate(plan);
  const lines = [];
  const title = plan.notes.get('project')?.fm.title || 'Untitled project';
  lines.push(`Omino plan: ${title} — notes in ${plan.root} (project "${(projectId(dir) || {}).id}", shared by all its worktrees; edit them there, then record)`);
  const idn = identity(dir);
  if (idn && isClosed(idn.root)) lines.push(`This plan is closed${readMeta(idn.root).closedAt ? ` (since ${String(readMeta(idn.root).closedAt).slice(0, 10)})` : ''}: read it for context, do not change it. If the user starts new work here, ask what it is for and run omino init --name <id>.`);
  if (idn && idn.mismatch) lines.push(`Check with the user before changing this plan: ${mismatchText(idn)}`);
  if (idn && idn.lane) lines.push(`This folder is the "${idn.lane}" lane of the plan: new work items from here go in that lane (lane: ${idn.lane}) unless the user says otherwise.`);
  else if (idn && (idn.repos.length > 1 || Object.keys(idn.lanes).length)) lines.push(`This plan spans several repositories and this folder has no lane yet: ask the user once which lane it is (suggest "${keyLabel(folderKey(dir))}"), then run omino lane "<name>".`);
  if (errors.length) {
    lines.push(`The plan has ${errors.length} format error(s); run "omino check" and fix them first.`);
    return { lines, text: lines.join('\n') };
  }
  const notes = [...plan.notes.values()];
  const work = notes.filter((n) => n.kind === 'work');
  for (const st of notes.filter((n) => n.kind === 'stage' && n.fm.status === 'active').sort((a, b) => a.fm.level - b.fm.level)) {
    const ws = work.filter((w) => w.fm.stage === st.id && w.fm.status !== 'dropped');
    lines.push(`Active stage: L${st.fm.level} ${st.fm.title} — ${ws.filter(isDone).length}/${ws.length} done`);
  }
  const doing = work.filter((w) => w.fm.status === 'doing');
  if (doing.length) lines.push(`In progress: ${doing.slice(0, 5).map((w) => `${w.fm.title} (${w.id})`).join('; ')}${doing.length > 5 ? `; +${doing.length - 5} more` : ''}`);
  const active = new Set(notes.filter((n) => n.kind === 'stage' && n.fm.status === 'active').map((n) => n.id));
  const next = work.filter((w) => w.fm.status === 'planned' && active.has(w.fm.stage)).sort((a, b) => (a.fm.order || 999) - (b.fm.order || 999)).slice(0, 3);
  if (next.length) lines.push(`Next in the plan: ${next.map((w) => { const arr = (sections(w.body).arrangement || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean).slice(-2).join(' / '); return `${w.fm.title} (${w.id})${arr ? ` — note: ${arr.length > 120 ? '…' + arr.slice(-119) : arr}` : ''}`; }).join('; ')}`);
  const items = review(plan);
  const qs = items.filter((i) => i.type === 'question');
  if (qs.length) lines.push(`Open questions for the user (${qs.length}): ${qs.slice(0, 3).map((q) => `"${q.reason}" (${q.id})`).join('; ')}${qs.length > 3 ? '; …' : ''}`);
  const confirm = items.filter((i) => ['flagged', 'drift', 'unconfirmed'].includes(i.type));
  if (confirm.length) lines.push(`To confirm with the user (${confirm.length}): ${confirm.slice(0, 4).map((i) => `${i.title} (${i.id})`).join('; ')}`);
  const fired = items.filter((i) => i.type === 'recalled');
  const due = recall(plan).due;
  if (fired.length || due.length) lines.push(`Ideas to bring back: ${[...fired.map((i) => i.id), ...due.map((d) => d.id + ' (due)')].join(', ')}`);
  const cs = comments(plan);
  if (cs.length) lines.push(`${COMMENTS_TODO}\n${cs.slice(0, 5).map(commentLine).join('\n')}${cs.length > 5 ? `\n- … ${cs.length - 5} more ("omino review" lists them)` : ''}`);
  const pend = unrecorded(plan, readState(plan));
  if (pend.length) lines.push(`Edited but not recorded: ${pend.map((p) => p.id).join(', ')}`);
  const svc = serviceInfo(), pid = (projectId(dir) || {}).id;
  if (svc && pid) lines.push(`Plan page: ${planUrl(svc, pid)} — give the user this link when they want to see the plan; there they can read it, edit notes and leave comments. Their edits are recorded as theirs; their comments reach you with their next message.`);
  lines.push('Follow the omino skill: when the user hands you a piece of work, find its work item ("omino find") or add one in their words before you start, and record it; record decisions, direction changes and finished work as they happen; mention open questions once.');
  const notice = setupNotice(dir, opts);
  if (notice) lines.push(notice);
  return { lines, text: lines.join('\n') };
}

// ---------------------------------------------------------------- hooks (Claude Code)

export const HOOK_EVENTS = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', stop: 'Stop', 'session-end': 'SessionEnd' };

/** The project folder for start: the nearest folder with .omino.json or an old in-tree plan, else the git worktree root if its repository has a plan. */
export function findProject(start) {
  const s = path.resolve(start || '.');
  const top = gitTop(s);
  for (let d = s; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, CONFIG)) || hasLegacy(d)) return d;
    if ((top && d === path.resolve(top)) || path.dirname(d) === d) break;
  }
  if (top) {
    let bound = null; try { bound = projectId(top); } catch {}
    if (bound) return path.resolve(top);
    // a workspace folder above the repository (a Codex project or editor workspace holding several repositories)
    const home = path.resolve(os.homedir());
    for (let d = path.dirname(path.resolve(top)); d !== path.dirname(d) && d !== home; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, CONFIG))) return d;
    }
  }
  return null;
}

function readHookState(dir) { try { return JSON.parse(fs.readFileSync(path.join(omRoot(dir), HOOKSTATE), 'utf8')); } catch { return { sessions: {} }; } }
function writeHookState(dir, st) {
  const now = Date.now();
  for (const [k, v] of Object.entries(st.sessions || {})) if (now - (v.at || 0) > 7 * 864e5) delete st.sessions[k];
  ensureIgnored(omRoot(dir), [HOOKSTATE]);
  fs.writeFileSync(path.join(omRoot(dir), HOOKSTATE), JSON.stringify(st) + '\n');
}

/** Fingerprint of the working tree outside .omino/, or null outside git. */
function workFingerprint(dir) {
  if (process.env.OMINO_NO_GIT) return null;
  const st = git(dir, ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude).omino']);
  if (st === null) return null;
  const diff = git(dir, ['diff', 'HEAD', '--', '.', ':(exclude).omino']) || '';
  // new files git does not track yet: their size and modification time stand in for their content
  const fresh = (git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).omino']) || '').split('\n').filter(Boolean).slice(0, 2000)
    .map((f) => { try { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join('\n');
  return sha(st + '\n' + diff + '\n' + fresh).slice(0, 16);
}

/** How much the working tree differs from HEAD (outside .omino/): changed lines and untracked files. */
function workStats(dir) {
  if (process.env.OMINO_NO_GIT) return null;
  const num = git(dir, ['diff', 'HEAD', '--numstat', '--', '.', ':(exclude).omino']);
  if (num === null) return null;
  let lines = 0;
  for (const l of num.split('\n')) { const m = /^(\d+)\t(\d+)\t/.exec(l); if (m) lines += Number(m[1]) + Number(m[2]); }
  const untracked = (git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).omino']) || '').split('\n').filter(Boolean).slice(0, 2000);
  for (const f of untracked) { try { const st = fs.statSync(path.join(dir, f)); if (st.size < 1e6) lines += fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length; } catch {} }
  return { lines, untracked };
}
const SUBSTANTIAL_LINES = 20;

function changesSize(dir) { try { return fs.statSync(path.join(omRoot(dir), 'changes.jsonl')).size; } catch { return 0; } }

/**
 * Handle one Claude Code hook event. Returns { stdout } for the hook to print (or nothing).
 * Never throws: a broken plan must not break the user's session.
 */
/**
 * Run one hook event for an agent and shape the answer the way that agent reads it:
 * Claude Code and Codex take plain text (and JSON for a Stop block); Gemini CLI takes JSON only
 * (additionalContext; decision block on AfterAgent); Kimi Code CLI drops SessionStart output, so the brief
 * is kept and handed over with the first message, and a Stop block is exit code 2 with the reason on stderr.
 */
export function runHook(event, input = {}, { agent = 'claude' } = {}) {
  if (agent === 'kimi') {
    const key = path.join(os.tmpdir(), `omino-brief-${crypto.createHash('sha1').update(String(input.session_id || 'default')).digest('hex').slice(0, 16)}.txt`);
    if (event === 'session-start') { const r = runHookCore(event, input); if (r.stdout) { try { fs.writeFileSync(key, r.stdout); } catch {} } return r.stderr ? { stderr: r.stderr } : {}; }
    if (event === 'prompt') {
      let brief = ''; try { brief = fs.readFileSync(key, 'utf8'); fs.rmSync(key); } catch {}
      const r = runHookCore(event, input);
      const text = [brief, r.stdout].filter(Boolean).join('\n\n');
      return { ...(text ? { stdout: text } : {}), ...(r.stderr ? { stderr: r.stderr } : {}) };
    }
    if (event === 'stop') {
      const r = runHookCore(event, input);
      try { const j = r.stdout ? JSON.parse(r.stdout) : null; if (j && j.decision === 'block') return { stderr: j.reason, exitCode: 2 }; } catch {}
      return {};
    }
    if (event === 'session-end') { try { fs.rmSync(key); } catch {} }
    return runHookCore(event, input);
  }
  const r = runHookCore(event, input, agent === 'dsh' ? { agent } : undefined);
  if (agent !== 'gemini') return r;
  const out = (o) => ({ stdout: JSON.stringify(o), ...(r.stderr ? { stderr: r.stderr } : {}) });
  if (event === 'session-start' || event === 'prompt') return out(r.stdout ? { hookSpecificOutput: { hookEventName: event === 'prompt' ? 'BeforeAgent' : 'SessionStart', additionalContext: r.stdout } } : {});
  if (event === 'stop' && r.stdout) return { stdout: r.stdout };
  return out({});
}

/** The text of the user's message in a prompt hook, in whatever field the agent uses; null when it sends none. */
const promptText = (input) => { for (const k of ['prompt', 'user_prompt', 'message', 'input']) if (typeof input[k] === 'string') return input[k]; return null; };

const AUTOSTART_KEY = 'service-autostart';
const lastPageTs = (plan) => { const c = readChanges(plan).filter((x) => x.via === 'page'); return c.length ? String(c[c.length - 1].ts) : ''; };

// Projects without a plan where Omino already offered one: asked once, never again (~/.omino/offered.json).
const OFFERED = 'offered.json';
function offered() { try { return JSON.parse(fs.readFileSync(path.join(ominoHome(), OFFERED), 'utf8')); } catch { return {}; } }
function markOffered(key) {
  const o = offered(); o[key] = new Date().toISOString();
  fs.mkdirSync(ominoHome(), { recursive: true });
  fs.writeFileSync(path.join(ominoHome(), OFFERED), JSON.stringify(o, null, 2) + '\n');
}

/**
 * A git project with no plan: say nothing, unless a turn changes it substantially. Then, once per project and
 * never again, ask the agent to ask the user whether to keep a plan here. Turn state lives in the temp folder.
 */
function noPlanHook(event, input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const top = gitTop(cwd);
  if (!top) return {};
  const dir = path.resolve(top), key = folderKey(dir);
  if (offered()[key]) return {};
  const f = path.join(os.tmpdir(), `omino-np-${sha(String(input.session_id || 'default') + dir).slice(0, 16)}.json`);
  if (event === 'prompt') { try { fs.writeFileSync(f, JSON.stringify({ work: workFingerprint(dir), stats: workStats(dir) })); } catch {} return {}; }
  if (event === 'session-end') { try { fs.rmSync(f); } catch {} return {}; }
  if (event !== 'stop' || input.stop_hook_active) return {};
  let turn; try { turn = JSON.parse(fs.readFileSync(f, 'utf8')); fs.rmSync(f); } catch { return {}; }
  if (turn.work === null || workFingerprint(dir) === turn.work) return {};
  const stats = workStats(dir), before = turn.stats || { lines: 0, untracked: [] };
  const added = stats ? stats.untracked.filter((x) => !before.untracked.includes(x)) : [];
  const delta = stats ? Math.abs(stats.lines - before.lines) : 0;
  if (!added.length && delta < SUBSTANTIAL_LINES) return {};
  markOffered(key);
  return { stdout: JSON.stringify({ decision: 'block', reason: `Omino: this project (${path.basename(dir)}) has no plan, and this turn changed it substantially. Ask the user once, in one sentence, whether to keep a plan for this project with Omino, so goals, decisions and progress stay written down across sessions and agents. If they agree, follow the omino skill to start one (omino init; it starts with what they said and the work just done). If not, drop it: Omino will not ask again here.` }) };
}

function runHookCore(event, input = {}, opts) {
  try {
    const dir = findProject(input.cwd || process.cwd());
    if (!dir) return noPlanHook(event, input);
    let plan;
    try { plan = loadPlan(dir); } catch (e) { const t = event === 'session-start' ? setupNotice(dir, opts) : ''; return t ? { stdout: t } : {}; }
    if (Number(readState(plan).version || 1) > FORMAT) return event === 'session-start' ? { stdout: `Omino: this plan was written by a newer Omino (format ${readState(plan).version}); update the omino plugin before changing it.` } : {};
    const sid = String(input.session_id || 'default');
    const st = readHookState(dir);
    st.sessions = st.sessions || {};
    const me = st.sessions[sid] || (st.sessions[sid] = { announced: [] });
    me.at = Date.now();

    if (event === 'session-start') {
      migrateInbox(dir);
      const svc = ensureService({ wait: 1500 });
      const p2 = loadPlan(dir);
      // the brief lists the comments waiting; later prompts hand over only new ones
      me.announced = comments(p2).map((c) => c.key);
      me.pageSeen = lastPageTs(p2);
      writeHookState(dir, st);
      const out = [cmdBrief(dir, opts).text];
      // once per machine: the page is nicer when it is always there
      if (svc && !offered()[AUTOSTART_KEY] && !autostartStatus().installed) {
        markOffered(AUTOSTART_KEY);
        out.push(`Omino: the plan page runs at ${svc.url} while this machine is on and a session has started it. Ask the user once, in one sentence, whether it should also start when they log in, so the page is always there. If yes, run "omino service install". Either way, Omino will not ask again.`);
      }
      return { stdout: out.join('\n') };
    }
    if (event === 'prompt') {
      migrateInbox(dir);
      plan = loadPlan(dir);
      const now = comments(plan);
      const fresh = now.filter((c) => !(me.announced || []).includes(c.key));
      me.announced = now.map((c) => c.key);
      // what the user changed on the page since this session last looked (already recorded as theirs)
      const seen = me.pageSeen || '';
      const edits = readChanges(plan).filter((c) => c.via === 'page' && c.page !== 'comment' && String(c.ts) > seen);
      me.pageSeen = lastPageTs(plan) || seen;
      me.turn = { work: workFingerprint(dir), changes: changesSize(dir), stats: workStats(dir) };
      // once a session, at the first message that could hand over work: register it in the plan before starting
      const text = promptText(input);
      const nudge = !me.nudged && !isClosed(plan.root) && (text === null || text.trim().length >= 30);
      if (nudge) me.nudged = true;
      writeHookState(dir, st);
      const out = [];
      if (fresh.length) out.push(['Omino: ' + COMMENTS_TODO, ...fresh.map(commentLine)].join('\n'));
      if (edits.length) out.push(['Omino: the user changed the plan on the plan page (already recorded as theirs). Read those notes again before relying on what you knew; if a change affects other notes, update them and record:', ...edits.slice(-8).map((c) => `- ${c.summary} (${c.notes.map((x) => x.id).join(', ')})`)].join('\n'));
      if (nudge) out.push('Omino: if this message hands you a piece of work, register it in the plan before you start: find its work item ("omino find") or add one in the user\'s words, in this folder\'s lane, mark it doing, and record. Do not break it down or plan it further unless the user asks. When it is done, update its Progress and record.');
      return out.length ? { stdout: out.join('\n\n') } : {};
    }
    if (event === 'stop' && isClosed(plan.root)) return {};
    if (event === 'stop') {
      if (input.stop_hook_active || !me.turn) return {};
      const turn = me.turn; delete me.turn;
      writeHookState(dir, st);
      if (changesSize(dir) !== turn.changes) return {};
      if (turn.work === null) return {};
      const now = workFingerprint(dir);
      if (now === null || now === turn.work) return {};
      const stats = workStats(dir), before = turn.stats || { lines: 0, untracked: [] };
      const added = stats ? stats.untracked.filter((f) => !before.untracked.includes(f)) : [];
      const delta = stats ? Math.abs(stats.lines - before.lines) : 0;
      if (!added.length && delta < SUBSTANTIAL_LINES) return {};
      return { stdout: JSON.stringify({ decision: 'block', reason: `Omino: this turn changed the project substantially (${added.length ? added.length + ' new file(s), ' : ''}about ${delta} lines) and the plan was not recorded. Most changes need no plan update. Update the plan only if the user decided something, the direction changed, or a planned item was finished. Otherwise finish without mentioning the plan; do not record or flag anything just because of this reminder.` }) };
    }
    if (event === 'session-end') {
      delete st.sessions[sid];
      writeHookState(dir, st);
      return {};
    }
    return {};
  } catch (e) {
    return { stderr: `omino hook ${event}: ${e.message}` };
  }
}

function readStdin() {
  try { if (process.stdin.isTTY) return ''; return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Claude Code and Codex read the same hook format ({hooks: {Event: [{hooks: [{type, command, timeout}]}]}}) and send the same input.
const HOOK_AGENTS = ['claude', 'codex', 'gemini', 'kimi'];
const kimiHome = (home) => process.env.KIMI_CODE_HOME && home === os.homedir() ? path.resolve(process.env.KIMI_CODE_HOME) : path.join(home, '.kimi-code');
const hookFile = (agent, scope, dir, home) => {
  const base = scope === 'user' ? home : dir;
  if (agent === 'codex') return path.join(base, '.codex', 'hooks.json');
  if (agent === 'gemini') return path.join(base, '.gemini', 'settings.json');
  if (agent === 'kimi') return path.join(kimiHome(home), 'config.toml');
  return path.join(base, '.claude', 'settings.json');
};
const agentDir = (agent, home) => agent === 'kimi' ? kimiHome(home) : path.join(home, '.' + agent);
// each agent's names for the four moments Omino uses
const AGENT_EVENTS = {
  gemini: { 'session-start': 'SessionStart', prompt: 'BeforeAgent', stop: 'AfterAgent', 'session-end': 'SessionEnd' },
};
const agentEvent = (agent, ev) => (AGENT_EVENTS[agent] || HOOK_EVENTS)[ev];
// desktop apps may start hooks with a PATH that lacks Homebrew's node
// (not on Windows, where cmd.exe would read the prefix as the command)
const hookCommand = (script, ev, agent = 'claude') => `${agent === 'claude' || process.platform === 'win32' ? '' : 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" '}node "${script}" hook ${ev}${agent === 'gemini' || agent === 'kimi' ? ` --agent ${agent}` : ''}`;
const isOurHook = (h) => typeof (h && h.command) === 'string' && /omino\.mjs\\?"? hook /.test(h.command);

/** The installed copy of the skill hooks should point at: a stable one in the agent's skills folder if there is one, else this file. */
function stableScript(agent, home) {
  for (const rel of agent === 'claude' ? ['.claude/skills/omino'] : agent === 'codex' ? ['.codex/skills/omino', '.agents/skills/omino'] : ['.agents/skills/omino']) {
    const f = path.join(home, rel, 'scripts', 'omino.mjs');
    if (fs.existsSync(f)) return f;
  }
  return fileURLToPath(import.meta.url);
}

/** Add (or remove) the Omino hooks in Claude Code settings or Codex hooks.json, at project or user scope. */
export function cmdHooksInstall(dir, { scope = 'project', agent = 'claude', remove = false, home = os.homedir(), script } = {}) {
  if (!['project', 'user'].includes(scope)) throw new OminoError('--scope must be project or user');
  if (!HOOK_AGENTS.includes(agent)) throw new OminoError(`--agent must be one of ${HOOK_AGENTS.join(', ')}`);
  script = script || stableScript(agent, home);
  const file = hookFile(agent, scope, dir, home);
  if (agent === 'kimi') {
    // Kimi Code CLI: user-level [[hooks]] tables in config.toml, fields event / command / timeout only
    let t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    t = removeKimiHooks(t);
    if (!remove) t = t.replace(/\n*$/, t ? '\n\n' : '') + Object.keys(HOOK_EVENTS).map((ev) => `[[hooks]]\nevent = ${JSON.stringify(HOOK_EVENTS[ev])}\ncommand = ${JSON.stringify(hookCommand(script, ev, 'kimi'))}\ntimeout = 10\n`).join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t);
    return { file, agent, scope: 'user', removed: remove, events: Object.values(HOOK_EVENTS) };
  }
  let cfg = {};
  if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new OminoError(`${file} is not valid JSON; fix it first`); } }
  cfg.hooks = cfg.hooks || {};
  const changed = [];
  for (const ev of Object.keys(HOOK_EVENTS)) {
    const name = agentEvent(agent, ev);
    const groups = (cfg.hooks[name] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) })).filter((g) => g.hooks.length);
    // Gemini counts timeouts in milliseconds and names its hooks
    if (!remove) groups.push({ hooks: [agent === 'gemini' ? { name: `omino-${ev}`, type: 'command', command: hookCommand(script, ev, agent), timeout: 10000 } : { type: 'command', command: hookCommand(script, ev, agent), timeout: 10 }] });
    if (groups.length) cfg.hooks[name] = groups; else delete cfg.hooks[name];
    changed.push(name);
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { file, agent, scope, removed: remove, events: changed, ...(agent === 'codex' && !remove ? { trust: 'Codex runs new hooks only after the user approves them once with /hooks' } : {}) };
}

/** config.toml without the [[hooks]] tables that run Omino. */
function removeKimiHooks(t) {
  const parts = t.split(/(?=^\[)/m);
  return parts.filter((p) => !(/^\[\[hooks\]\]/.test(p) && /omino\.mjs\\?"? hook /.test(p))).join('').replace(/\n{3,}/g, '\n\n');
}

/** Whether an Omino plugin is installed for the agent (it brings its own hooks). */
function pluginInstalled(agent, home) {
  try {
    if (agent === 'claude') return /"omino@/.test(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    if (agent === 'gemini') return fs.existsSync(path.join(home, '.gemini', 'extensions', 'omino'));
    if (agent === 'kimi') return false;
    const cache = path.join(home, '.codex', 'plugins', 'cache');
    return fs.readdirSync(cache).some((m) => fs.existsSync(path.join(cache, m, 'omino')));
  } catch { return false; }
}

/** Where the Omino hooks are configured, per agent. */
export function hooksStatus(dir, { home = os.homedir() } = {}) {
  const out = [];
  const files = [['claude', 'project', path.join(dir, '.claude', 'settings.json')], ['claude', 'project-local', path.join(dir, '.claude', 'settings.local.json')], ['claude', 'user', path.join(home, '.claude', 'settings.json')],
    ['codex', 'project', path.join(dir, '.codex', 'hooks.json')], ['codex', 'user', path.join(home, '.codex', 'hooks.json')],
    ['gemini', 'project', path.join(dir, '.gemini', 'settings.json')], ['gemini', 'user', path.join(home, '.gemini', 'settings.json')]];
  for (const [agent, scope, file] of files) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const evs = Object.entries(cfg.hooks || {}).filter(([, gs]) => (gs || []).some((g) => (g.hooks || []).some(isOurHook))).map(([k]) => k);
      if (evs.length) out.push({ agent, scope, file, events: evs });
    } catch {}
  }
  try {
    const kf = hookFile('kimi', 'user', dir, home), kt = fs.readFileSync(kf, 'utf8');
    const evs = kt.split(/(?=^\[)/m).filter((p) => /^\[\[hooks\]\]/.test(p) && /omino\.mjs\\?"? hook /.test(p)).map((p) => (p.match(/event\s*=\s*"([^"]+)"/) || [])[1]).filter(Boolean);
    if (evs.length) out.push({ agent: 'kimi', scope: 'user', file: kf, events: evs });
  } catch {}
  const plugin = /[\\/]plugins[\\/]/.test(fileURLToPath(import.meta.url));
  const agents = {};
  for (const a of HOOK_AGENTS) agents[a] = { present: fs.existsSync(agentDir(a, home)), plugin: pluginInstalled(a, home), hooks: out.filter((x) => x.agent === a) };
  return { settings: out.filter((x) => x.agent === 'claude'), plugin, agents };
}

/** Check that this copy of Omino can work here. Changes nothing; says what to run. */
export function cmdDoctor(dir, { home = os.homedir() } = {}) {
  const checks = [];
  const add = (status, name, detail, fix) => checks.push({ status, name, detail, ...(fix ? { fix } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18 ? 'ok' : 'error', 'node', `Node ${process.versions.node}`, major >= 18 ? null : 'install Node 18 or newer');
  add('ok', 'omino', `version ${VERSION}, file format ${FORMAT}`);
  const proj = findProject(dir);
  add('ok', 'store', `plans are kept in ${path.join(ominoHome(), 'projects')}`);
  if (!proj) add('info', 'plan', 'no Omino plan for this folder', 'ask the user before running "omino init" (or "init --adopt" for an existing project)');
  else if (!omRoot(proj) && hasLegacy(proj)) add('warn', 'plan', `the plan is still inside the project (${LEGACY}/)`, 'with the user\'s consent, run "omino migrate"');
  else {
    const idn = identity(proj);
    add('ok', 'plan', `project "${idn.id}" (from ${idn.via === 'git' ? 'the git repository binding' : CONFIG}) at ${idn.root}`);
    if (idn.via === 'git') add('info', 'binding', `the link to the plan is kept on this machine only (in .git), so other clones and machines do not see it`, `if this is the user's own repository and they want to share the plan: "omino link ${idn.id} --share", then commit ${CONFIG}`);
    else if (gitTop(proj) && !git(proj, ['ls-files', CONFIG])) add('info', 'binding', `${CONFIG} is not committed yet`, 'commit it so other clones and machines find the same plan');
    if (idn.mismatch) add('warn', 'repository', mismatchText(idn));
    if (hasLegacy(proj)) add('warn', 'leftover', `an old ${LEGACY}/ copy is still inside the project`, `after checking the shared plan, remove it: git rm -r ${LEGACY}`);
    const plan = loadPlan(proj);
    const v = Number(readState(plan).version || 1);
    if (v > FORMAT) add('error', 'format', `plan format ${v} is newer than this Omino (${FORMAT})`, 'update Omino');
    else add('ok', 'format', `plan format ${v}`);
    const { errors } = validate(plan);
    add(errors.length ? 'error' : 'ok', 'notes', errors.length ? `${errors.length} format error(s)` : `${plan.notes.size} notes, no errors`, errors.length ? 'run "omino check"' : null);
    const gi = path.join(plan.root, '.gitignore');
    const have = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8').split('\n').map((l) => l.trim()) : [];
    const miss = LOCAL_FILES.filter((n) => !have.includes(n));
    add(miss.length ? 'warn' : 'ok', 'gitignore', miss.length ? `the plan's .gitignore is missing ${miss.join(', ')}` : 'local files are kept out of the plan history', miss.length ? 'any record or serve adds them' : null);
    const agents = ['AGENTS.md', 'CLAUDE.md'].map((f) => path.join(proj, f)).filter((f) => fs.existsSync(f));
    const mentions = agents.some((f) => /omino/i.test(fs.readFileSync(f, 'utf8')));
    add(mentions ? 'ok' : 'warn', 'agent note', mentions ? 'AGENTS.md / CLAUDE.md mentions Omino' : 'no AGENTS.md or CLAUDE.md line points agents to Omino',
      mentions ? null : 'with the user\'s consent, add: "This project keeps its plan with Omino (run `omino where`); follow the omino skill when decisions are made or work is finished."');
  }
  const hs = hooksStatus(proj || dir, { home });
  for (const ag of HOOK_AGENTS) {
    const st = hs.agents[ag], name = ag === 'codex' ? 'Codex' : 'Claude Code';
    if (!st.present && !st.hooks.length) continue;
    const viaPlugin = st.plugin || (ag === 'claude' && hs.plugin);
    if (viaPlugin) add('ok', `${ag} hooks`, `the ${name} plugin brings its own hooks`);
    else if (st.hooks.length) add('ok', `${ag} hooks`, st.hooks.map((x) => `${x.scope}: ${x.events.join(', ')}`).join('; '));
    else add('warn', `${ag} hooks`, `no Omino hooks for ${name}; it only sees the plan when it reads AGENTS.md`, 'with the user\'s consent, run "omino setup"');
    if (viaPlugin && st.hooks.length) add('warn', `${ag} hooks`, `hooks are configured twice (plugin and ${st.hooks[0].file})`, `run "omino hooks remove --agent ${ag} --scope ${st.hooks[0].scope}"`);
    if (st.hooks.length > 1) add('warn', `${ag} hooks`, `hooks are configured in ${st.hooks.length} places (${st.hooks.map((x) => x.scope).join(', ')}); each event runs more than once`, 'keep the user scope and remove the others');
  }
  const svc = serviceInfo(), auto = autostartStatus({ home });
  add(svc ? 'ok' : 'info', 'page', svc ? `the page service runs at ${svc.url} (version ${svc.version})${auto.installed ? ', and starts at login' : ''}` : 'the page service is not running; the next session starts it', svc ? null : (auto.installed ? null : 'or "omino service start"'));
  for (const a of allowStatus({ home })) {
    if (a.present) add(a.allowed ? 'ok' : 'warn', `${a.agent} access`, a.allowed ? `${a.agent} may write to ${ominoHome()}` : `${a.agent} will ask before each edit of the plan (or, for Codex, its sandbox blocks it)`, a.allowed ? null : `with the user's consent, run "omino allow --agent ${a.agent}"`);
  }
  return { ok: !checks.some((c) => c.status === 'error'), checks };
}

// ---------------------------------------------------------------- setup: everything a machine needs, in one step the user approves once

const SKILL_COPIES = ['.codex/skills/omino', '.claude/skills/omino', '.agents/skills/omino'];
const versionOf = (dir) => { try { return (fs.readFileSync(path.join(dir, 'scripts', 'omino.mjs'), 'utf8').match(/export const VERSION = '([^']+)'/) || [])[1] || null; } catch { return null; } };
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

// ---------------------------------------------------------------- install (npx omino install)

/**
 * Put the skill where the agents on this machine look for skills. ~/.agents/skills is read by Codex, Gemini CLI,
 * Kimi Code CLI and Copilot CLI; Claude Code reads ~/.claude/skills (skipped when the Omino plugin brings the skill).
 * Copies that already exist elsewhere are brought up to this version. Hooks and permissions are not touched here:
 * the first session that reads a plan offers them through setup.
 */
export function cmdInstall({ home = os.homedir(), dryRun = false, remove = false } = {}) {
  const self = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const agents = [
    { name: 'Claude Code', dir: '.claude', target: '.claude/skills/omino', skip: pluginInstalled('claude', home) ? 'the Omino plugin brings the skill' : null },
    { name: 'Codex', dir: '.codex', target: '.agents/skills/omino' },
    { name: 'Gemini CLI', dir: '.gemini', target: '.agents/skills/omino' },
    { name: 'Kimi Code CLI', dir: '.kimi-code', target: '.agents/skills/omino' },
  ];
  const targets = new Map();
  targets.set(path.join(home, '.agents/skills/omino'), new Set(['other agents that read ~/.agents/skills']));
  const found = [];
  for (const a of agents) {
    if (!fs.existsSync(path.join(home, a.dir))) continue;
    found.push({ agent: a.name, ...(a.skip ? { skip: a.skip } : {}) });
    if (a.skip) continue;
    const t = path.join(home, a.target);
    if (!targets.has(t)) targets.set(t, new Set());
    targets.get(t).add(a.name);
  }
  for (const rel of SKILL_COPIES) { const t = path.join(home, rel); if (fs.existsSync(path.join(t, 'SKILL.md')) && !targets.has(t)) targets.set(t, new Set(['an existing copy'])); }
  const done = [];
  for (const [t, who] of targets) {
    if (path.resolve(t) === self) continue;
    const before = versionOf(t);
    if (remove) {
      if (!before) continue;
      if (!dryRun) fs.rmSync(t, { recursive: true, force: true });
      done.push({ path: t, removed: true });
      continue;
    }
    if (!dryRun) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.rmSync(t, { recursive: true, force: true }); fs.cpSync(self, t, { recursive: true }); }
    const commands = commandSkills(self, path.dirname(t), { dryRun });
    done.push({ path: t, for: [...who], from: before, to: VERSION, commands });
  }
  if (remove) for (const [t] of targets) for (const c of removeCommandSkills(path.dirname(t), { dryRun })) done.push({ path: c, removed: true });
  return { version: VERSION, agents: found, done, dryRun };
}

// The user's commands (/omino-plan, /omino-next, ...) live once in skills/omino/commands/*.md. The Claude Code plugin
// reads them there as /omino:plan and so on (plugins always add their name and a colon). Next to an installed copy
// of the skill, each becomes its own small skill named omino-<command>, which Claude Code offers as /omino-plan and
// Codex as $omino-plan. Only the user can call these: they never trigger on their own.
const COMMAND_MARK = '<!-- written by omino install; changes are overwritten -->';
export const COMMANDS = ['plan', 'next', 'ghost', 'lock', 'hold', 'clear'];
function readCommand(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = {}; if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1'); }
  return { description: fm.description || '', hint: fm['argument-hint'] || '', body: m ? m[2] : t };
}
export function commandSkillText(name, cmd) {
  const desc = `${cmd.description} Only when the user types /omino-${name} or $omino-${name}.`.replace(/"/g, "'");
  const body = cmd.body.replace(/the Omino `(\w+)` command/g, (_, c) => `\`/omino-${c}\``);
  return `---\nname: omino-${name}\ndescription: "${desc}"\n${cmd.hint ? `argument-hint: "${cmd.hint.replace(/"/g, "'")}"\n` : ''}disable-model-invocation: true\n---\n${COMMAND_MARK}\n\nThis command belongs to the omino skill, installed next to this folder (../omino/SKILL.md). Read that skill first if it is not already loaded.\n\n${body.trim()}\n`;
}
function commandSkills(self, skillsDir, { dryRun }) {
  const src = path.join(self, 'commands');
  if (!fs.existsSync(src)) return [];
  const out = [];
  for (const name of COMMANDS) {
    const f = path.join(src, `${name}.md`);
    if (!fs.existsSync(f)) continue;
    const dir = path.join(skillsDir, `omino-${name}`);
    const mine = !fs.existsSync(path.join(dir, 'SKILL.md')) || fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes(COMMAND_MARK);
    if (!mine) continue; // a skill of the user's own with that name: leave it alone
    if (!dryRun) {
      fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), commandSkillText(name, readCommand(f)));
      fs.writeFileSync(path.join(dir, 'agents', 'openai.yaml'), `# ${COMMAND_MARK}\ninterface:\n  display_name: "Omino ${name[0].toUpperCase() + name.slice(1)}"\npolicy:\n  allow_implicit_invocation: false\n`);
    }
    out.push(`omino-${name}`);
  }
  return out;
}
function removeCommandSkills(skillsDir, { dryRun }) {
  const out = [];
  for (const name of COMMANDS) {
    const dir = path.join(skillsDir, `omino-${name}`);
    try { if (!fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes(COMMAND_MARK)) continue; } catch { continue; }
    if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
    out.push(dir);
  }
  return out;
}

/** What setup would do for dir on this machine, each with the files it changes. Changes nothing. */
/** Which agent this process runs under, from the variables each one sets for its commands and hooks; null when unknown. */
export function currentAgent(env = process.env) {
  const k = Object.keys(env);
  if (env.DSH_SESSION_ID) return 'dsh';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PROJECT_DIR) return 'claude';
  if (env.GEMINI_CLI || env.GEMINI_PROJECT_DIR) return 'gemini';
  if (k.some((x) => x.startsWith('KIMI_'))) return 'kimi';
  if (k.some((x) => x.startsWith('CODEX_'))) return 'codex';
  return null;
}

/**
 * Hooks are offered only for the agent the user is working in (or the one named with --agent):
 * someone using Codex should not be asked about Gemini or Kimi. Unknown agent: Claude Code and Codex, as before.
 */
export function setupSteps(dir, { home = os.homedir(), agent = currentAgent() } = {}) {
  dir = path.resolve(dir);
  const steps = [];
  const self = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of SKILL_COPIES) {
    const t = path.join(home, rel), v = versionOf(t);
    if (v && path.resolve(t) !== self && older(v, VERSION)) steps.push({ step: 'update-skill', target: t, detail: `update the omino skill in ${t} from ${v} to ${VERSION}` });
  }
  let pid = null; try { pid = projectId(dir); } catch (e) { steps.push({ step: 'error', detail: e.message }); return steps; }
  const root = pid ? omRoot(dir) : null;
  const planHere = !!root && fs.existsSync(root);
  if (!planHere && (hasLegacy(dir) || legacyRev(dir))) steps.push({ step: 'migrate', detail: `move the plan ${hasLegacy(dir) ? `in ${LEGACY}/` : 'from git history'} to ${path.join(ominoHome(), 'projects')}/ and write ${CONFIG}` });
  if (planHere || steps.some((x) => x.step === 'migrate')) {
    const hs = hooksStatus(dir, { home });
    for (const a of agent ? HOOK_AGENTS.filter((name) => name === agent) : ['claude', 'codex']) {
      const st = hs.agents[a];
      const NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', kimi: 'Kimi Code CLI' };
      if (st.present && !st.plugin && !st.hooks.length && !(a === 'claude' && hs.plugin)) steps.push({ step: 'hooks', agent: a, detail: `add Omino's hooks to ${NAME[a]} for every project (${hookFile(a, 'user', dir, home)})${a === 'codex' ? '; Codex runs them after you approve them once with /hooks' : ''}` });
    }
    for (const a of allowStatus({ home })) if (a.present && !a.allowed && (!agent || a.agent === agent)) steps.push({ step: 'allow', agent: a.agent, detail: `let ${a.agent === 'claude' ? 'Claude Code' : 'Codex'} write to ${ominoHome()} (${a.file})` });
  }
  return steps;
}

/** The setup request for an agent's context, or '' when nothing is needed. */
export function setupNotice(dir, opts) {
  let steps = []; try { steps = setupSteps(dir, opts).filter((x) => x.step !== 'error'); } catch {}
  if (!steps.length) return '';
  return `Omino needs a one-time setup on this machine:\n${steps.map((x) => `- ${x.detail}`).join('\n')}\nAsk the user once, in one sentence naming these changes, whether to do it; if they agree, run "omino setup" yourself and tell them what changed${steps.some((x) => x.agent === 'codex' && x.step === 'hooks') ? ' (for Codex hooks, tell them to approve them once with /hooks)' : ''}. Do not ask them to run anything in a terminal.`;
}

/** Do every step of setupSteps. Run only after the user agreed to the list. */
export function cmdSetup(dir, { home = os.homedir(), dryRun = false, share = false, agent = currentAgent() } = {}) {
  if (agent && agent !== 'dsh' && !HOOK_AGENTS.includes(agent)) throw new OminoError(`--agent must be one of ${HOOK_AGENTS.join(', ')}, dsh`);
  const steps = setupSteps(dir, { home, agent });
  if (dryRun) return { steps, done: [] };
  const err = steps.find((x) => x.step === 'error');
  if (err) throw new OminoError(err.detail);
  const done = [];
  const self = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const st of steps) {
    if (st.step === 'update-skill') fs.cpSync(self, st.target, { recursive: true, force: true });
    else if (st.step === 'migrate') Object.assign(st, { result: cmdMigrate(dir, { share }) });
    else if (st.step === 'allow') cmdAllow({ agent: st.agent, home });
    else if (st.step === 'hooks') Object.assign(st, { result: cmdHooksInstall(dir, { scope: 'user', agent: st.agent, home }) });
    done.push(st);
  }
  return { steps, done };
}

// ---------------------------------------------------------------- letting agents write to the plan folder

const claudeSettings = (home) => path.join(home, '.claude', 'settings.json');
const codexConfig = (home) => path.join(home, '.codex', 'config.toml');
const tomlStr = (s) => JSON.stringify(s);

/** Whether Claude Code and Codex are set up on this machine and may write to the plan folder. */
export function allowStatus({ home = os.homedir() } = {}) {
  const store = ominoHome();
  const out = [];
  const cs = claudeSettings(home);
  let claudeOk = false;
  try { const j = JSON.parse(fs.readFileSync(cs, 'utf8')); claudeOk = ((j.permissions || {}).additionalDirectories || []).some((d) => path.resolve(String(d).replace(/^~(?=\/|$)/, home)) === store); } catch {}
  out.push({ agent: 'claude', present: fs.existsSync(path.join(home, '.claude')), allowed: claudeOk, file: cs });
  const cx = codexConfig(home);
  let codexOk = false;
  try { codexOk = fs.readFileSync(cx, 'utf8').includes(tomlStr(store)); } catch {}
  out.push({ agent: 'codex', present: fs.existsSync(path.join(home, '.codex')), allowed: codexOk, file: cx });
  return out;
}

/** Let Claude Code (additionalDirectories) and Codex (sandbox writable_roots) write to the plan folder without asking each time. */
export function cmdAllow({ agent = 'all', home = os.homedir() } = {}) {
  const store = ominoHome();
  const done = [];
  if (agent === 'all' || agent === 'claude') {
    const f = claudeSettings(home);
    let j = {};
    if (fs.existsSync(f)) { try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new OminoError(`${f} is not valid JSON; add "${store}" to permissions.additionalDirectories by hand`); } }
    j.permissions = j.permissions || {};
    const dirs = j.permissions.additionalDirectories || [];
    if (!dirs.some((d) => path.resolve(String(d).replace(/^~(?=\/|$)/, home)) === store)) {
      j.permissions.additionalDirectories = [...dirs, store];
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
      done.push({ agent: 'claude', file: f, changed: true });
    } else done.push({ agent: 'claude', file: f, changed: false });
  }
  if (agent === 'all' || agent === 'codex') {
    const f = codexConfig(home);
    let t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (t.includes(tomlStr(store))) done.push({ agent: 'codex', file: f, changed: false });
    else {
      const sec = t.match(/^\[sandbox_workspace_write\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
      if (!sec) t = t.replace(/\n*$/, t ? '\n\n' : '') + `[sandbox_workspace_write]\nwritable_roots = [${tomlStr(store)}]\n`;
      else {
        const line = sec[1].match(/^writable_roots\s*=\s*\[([^\]\n]*)\]\s*$/m);
        if (/^writable_roots\s*=/m.test(sec[1]) && !line) throw new OminoError(`${f}: add ${tomlStr(store)} to [sandbox_workspace_write] writable_roots by hand`);
        const start = sec.index + sec[0].length - sec[1].length;
        const body = line ? sec[1].replace(line[0], `writable_roots = [${[line[1].trim(), tomlStr(store)].filter(Boolean).join(', ')}]`) : `writable_roots = [${tomlStr(store)}]\n` + sec[1];
        t = t.slice(0, start) + body + t.slice(start + sec[1].length);
      }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
      done.push({ agent: 'codex', file: f, changed: true });
    }
  }
  if (!done.length) throw new OminoError('--agent must be claude, codex or all');
  return { store, done };
}

// ---------------------------------------------------------------- CLI

const HELP = `omino ${VERSION} — a plan made of pieces, readable by humans and agents

Usage: node omino.mjs <command> [options]

  init [--adopt] [--name <id>] [--share]
                               start a plan for this project with an empty project.md;
                               --name names the plan after what it is for (default: owner-repo);
                               --share also writes .omino.json, to be committed (own repositories only);
                               --adopt also drafts a closed "Before Omino" stage for existing projects.
                               Plans live in ~/.omino/projects/<id>/ (OMINO_HOME), shared by every
                               worktree; the folder is its own git repository, one commit per record
  install [--dry-run]          put the skill where the agents on this machine look for skills
                               (~/.agents/skills, and ~/.claude/skills unless the plugin is
                               installed); update older copies. uninstall removes them
  setup [--dry-run]            everything this machine needs for this project, in one step:
                               move an old in-repo plan out, write .omino.json, let agents write
                               to the plan folder, update older copies of the skill. Agents run it
                               after the user agrees; --dry-run only lists the steps
  where                        print the folder that holds this project's plan
  projects [--open] [--out f]  list every plan on this machine, its repositories and folders;
                               --open shows them on one overview page
  close [--reopen]             mark the plan finished: it stays readable and no longer changes;
                               the next piece of work in the same folder starts with init --name
  lane ["<name>"]              the lane this folder's work goes into (one per repository or
                               service); with no name, print it; with "" remove it
  link <id> [--share]          use an existing plan here: share one plan between
                               repositories, or fix a folder matched to the wrong plan
  migrate                      move a plan kept inside the project (.omino/, Omino 0.4) to that folder
  allow [--agent claude|codex|all]
                               let Claude Code / Codex write to the plan folder without asking each time
  record "<summary>" --source user|agent|tool|file [--said "<user's words>"]
         [--session <id>] [--confirm id,id]
                               record every changed note as one entry, refresh the
                               page and print a link to each changed note;
                               git branch/commit/worktree are captured automatically
  check [--fix]                validate notes and list unlinked ideas and decisions;
                               --fix records direct file edits
  find <words>                 search titles and bodies before creating a note
  brief                        a short summary for the start of a session
  recall [--mark-fired id,id] [--stop id,id]
                               list ideas whose recall condition is met
  review                       list what needs a human decision, and the user's comments
  view [--out file] [--open]   write a self-contained HTML view; --open shows the plan's page on
                               the page service (starting it), or the file when it cannot run
  service status|start|stop|install|uninstall|run
                               the page service: one local server for every plan on this machine,
                               at http://127.0.0.1:4870/p/<id> (OMINO_PORT), where the user reads,
                               edits notes and leaves comments. Hooks start it; install also starts
                               it at login; run serves in the foreground
  hook <session-start|prompt|stop|session-end>
                               run as a Claude Code hook (reads the hook input on stdin)
  hooks install|remove|status [--agent claude|codex] [--scope project|user]
                               add or remove the Omino hooks in Claude Code settings or Codex
                               hooks.json (not needed when Omino is installed as a plugin)
  doctor                       check this setup and say what to fix; changes nothing

Options: --dir <path> (default: current directory), --json`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['json', 'fix', 'adopt', 'open', 'error', 'help', 'dry-run', 'share', 'reopen'].includes(key)) args[key] = true;
      else { args[key] = argv[i + 1]; i++; }
    } else if (a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

let envelopeDir = null;
function print(args, data, text) {
  if (args.json && envelopeDir && data && typeof data === 'object' && !Array.isArray(data) && !('project' in data)) {
    // every JSON answer says which plan it came from, and how that was decided
    try { const idn = identity(envelopeDir); if (idn) data = { project: { id: idn.id, via: idn.via, root: idn.root, ...(idn.mismatch ? { mismatch: true } : {}) }, ...data }; } catch {}
  }
  process.stdout.write(args.json ? JSON.stringify(data, null, 2) + '\n' : text + '\n');
}

const LABEL = { flagged: 'Needs review', drift: 'Basis changed', unconfirmed: 'Unconfirmed done', recalled: 'Recalled', waiting: 'Waiting', question: 'Open question' };

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  const base = path.resolve(args.dir || '.');
  const dir = findProject(base) || (gitTop(base) ? path.resolve(gitTop(base)) : base);
  envelopeDir = dir;
  if (args.help && cmd !== 'hook') { print(args, { help: HELP }, HELP); return 0; }
  try {
    // a preview flag on a command that cannot preview would silently do the real thing
    if (args['dry-run'] && !['setup', 'install', 'uninstall', 'hooks', 'allow'].includes(cmd)) throw new OminoError(`${cmd} has no --dry-run; it would change the plan for real`);
    switch (cmd) {
      case 'where': {
        const root = omRoot(dir);
        const ok = root && fs.existsSync(root);
        const idn = ok ? identity(dir) : null;
        if (!ok) throw new OminoError(hasLegacy(dir) ? `the plan is still inside the project (${LEGACY}/); run "omino migrate"` : `no Omino plan for ${dir} (run "omino init")`);
        print(args, { root, id: idn.id, via: idn.via, folder: dir, repos: idn.repos, mismatch: idn.mismatch }, root + (idn.mismatch ? `\nwarning: ${mismatchText(idn)}` : ''));
        return 0;
      }
      case 'migrate': {
        const r = cmdMigrate(dir, { share: !!args.share });
        print(args, r, `Moved the plan to ${r.root} (project "${r.id}")${r.fromCommit ? `, restored from commit ${r.fromCommit}` : ''}.\nEvery worktree of this project now shares it.${r.legacy ? ` The copy in ${r.legacy} is no longer read: ${r.tracked ? `remove it with "git rm -r ${LEGACY}" and commit` : `delete it`} once the user agrees.` : ''}`);
        return 0;
      }
      case 'close': {
        const r = cmdClose(dir, { reopen: rest[0] === '--reopen' || !!args.reopen });
        print(args, r, r.status === 'closed' ? `Plan "${r.id}" is closed: it stays readable, and no longer changes. A new piece of work here starts with omino init --name <id>.` : `Plan "${r.id}" is open again.`);
        return 0;
      }
      case 'lane': {
        const r = cmdLane(dir, rest.length ? rest.join(' ') : undefined);
        print(args, r, r.lane ? `${keyLabel(r.key)} → lane "${r.lane}"` : `${keyLabel(r.key)} has no lane${Object.keys(r.lanes).length ? ` (lanes: ${Object.entries(r.lanes).map(([k, l]) => `${l} = ${keyLabel(k)}`).join(', ')})` : ''}`);
        return 0;
      }
      case 'projects': {
        if (args.open || args.out) {
          const o = cmdOverview(dir, { out: args.out });
          const opened = args.open ? await openInBrowser(o.written) : false;
          print(args, o, `${o.written}${opened ? ' (opened)' : ''}`);
          return 0;
        }
        const r = cmdProjects(dir);
        print(args, r, r.projects.length ? r.projects.map((p) => `${p.current ? '*' : ' '} ${p.id}${p.title ? ` — ${p.title}` : ''}${p.status === 'closed' ? ' (closed)' : ''}\n    repos: ${p.repos.join(', ') || '-'}\n    folders: ${p.folders.join(', ') || '-'}${p.last ? `\n    last change: ${p.last}` : ''}`).join('\n') : `No plans yet in ${r.home}.`);
        return 0;
      }
      case 'link': {
        const r = cmdLink(dir, rest[0], { share: !!args.share });
        print(args, r, `${dir} now uses plan "${r.id}" (${r.root})${r.previous && r.previous !== r.id ? `, instead of "${r.previous}"` : ''}.${args.share ? `\nCommit ${CONFIG} so other clones use it too.` : ''}`);
        return 0;
      }
      case 'install':
      case 'uninstall': {
        const r = cmdInstall({ dryRun: !!args['dry-run'], remove: cmd === 'uninstall' });
        const lines = r.done.map((d) => d.removed ? `${r.dryRun ? 'would remove' : 'removed'} ${d.path}` : `${r.dryRun ? 'would put' : 'put'} omino ${d.to} in ${d.path}${d.from ? ` (was ${d.from})` : ''} — for ${d.for.join(', ')}${d.commands && d.commands.length ? `\n  with the commands ${d.commands.map((c) => '/' + c).join(' ')}` : ''}`);
        const seen = r.agents.length ? `Agents found: ${r.agents.map((a) => a.agent + (a.skip ? ` (${a.skip})` : '')).join(', ')}.` : 'No known agents found; the skill is in ~/.agents/skills for any agent that reads it.';
        print(args, r, cmd === 'uninstall' ? (lines.join('\n') || 'No installed copies found.') : [seen, ...lines, '', 'Next: open your agent in a project and type /omino-plan (in Codex: $omino-plan; with the Claude Code plugin: /omino:plan).', 'The first time it reads a plan, it offers the rest (hooks, permissions) and asks you once.'].join('\n'));
        return 0;
      }
      case 'setup': {
        const r = cmdSetup(dir, { dryRun: !!args['dry-run'], share: !!args.share, ...(args.agent ? { agent: args.agent } : {}) });
        print(args, r, !r.steps.length ? 'Nothing to set up.' : args['dry-run'] ? `Setup would:\n${r.steps.map((x) => `- ${x.detail}`).join('\n')}` : `Done:\n${r.done.map((x) => `- ${x.detail}`).join('\n')}${args.share && r.done.some((x) => x.step === 'migrate') ? `\n${CONFIG} was written in the project; commit it with the next commit so other clones find the same plan.` : ''}`);
        return 0;
      }
      case 'allow': {
        const r = cmdAllow({ agent: args.agent || 'all' });
        print(args, r, r.done.map((d) => `${d.agent}: ${d.changed ? 'added' : 'already allows'} ${r.store} in ${d.file}`).join('\n'));
        return 0;
      }
      case 'init': {
        // init starts a plan for --dir exactly (a monorepo package), else for the repository root
        const r = cmdInit(args.dir ? base : (gitTop(base) ? path.resolve(gitTop(base)) : base), { adopt: args.adopt, share: !!args.share, name: args.name });
        if (r.attached) { print(args, r, `This project already has a plan at ${r.attached} (shared with another clone or worktree); nothing was created.`); return 0; }
        print(args, r, r.adopt
          ? `Created for an existing project: ${r.files.join(', ')}.\nDraft project.md and stages/s0.md, put unresolved points under "Open questions", record with --source agent, then tell the user what was added and run view --open.`
          : `Created: ${r.files.join(', ')}.\nWrite only what the user said into project.md (drop empty sections), then run: record "<one-line summary in the user's language>" --source user --said "<their words>"`);
        return 0;
      }
      case 'record': {
        const r = cmdRecord(dir, rest.join(' '), args.source, { confirm: list(args.confirm), said: args.said, session: args.session });
        print(args, r, !r.recorded ? 'Nothing to record: no note changed.'
          : [`Recorded ${r.notes.length} change(s) in plan "${(projectId(dir) || {}).id}".` + (r.flagged.length ? ` Flagged for review by a decision: ${r.flagged.join(', ')}.` : ''), ...r.notes.map((n) => { const l = r.links.find((x) => x.id === n.id); return `  ${n.op.padEnd(8)} ${n.id}${l ? `  ${l.url}` : ''}`; }),
            ...(r.orphans && r.orphans.length ? [`Not linked to anything: ${r.orphans.map((o) => o.id).join(', ')} — tie each to what it is about (refs, affects, recall), or say why it stands alone.`] : []),
            ...(r.recheck && r.recheck.length ? [`Finished, but its requirements changed: ${r.recheck.join(', ')}. If you implemented the change and tests pass, confirm now: record "<summary>" --source tool --confirm ${r.recheck.join(',')}. Otherwise tell the user it needs re-checking.`] : [])].join('\n'));
        return 0;
      }
      case 'check': {
        const r = cmdCheck(dir, { fix: args.fix });
        const lines = [];
        r.errors.forEach((e) => lines.push(`error   ${e.file}: ${e.msg}`));
        r.warnings.forEach((w) => lines.push(`warning ${w.file}: ${w.msg}`));
        if (r.comments && r.comments.length) lines.push(`comment ${r.comments.length} comment(s) from the user waiting: ${[...new Set(r.comments.map((c) => c.id))].join(', ')} (see review)`);
        if (r.unrecorded.length) lines.push(r.fixed ? `fixed   recorded direct edits: ${r.unrecorded.map((n) => n.id).join(', ')}` : `pending changed but not recorded: ${r.unrecorded.map((n) => `${n.id} (${n.op})`).join(', ')} — run record, or check --fix if a person edited the files`);
        if (!lines.length) lines.push('OK');
        print(args, r, lines.join('\n'));
        return r.ok ? 0 : 1;
      }
      case 'recall': {
        const r = cmdRecall(dir, { markFired: list(args['mark-fired']), stop: list(args.stop) });
        const lines = [];
        if (r.updated.length) lines.push(`Updated: ${r.updated.join(', ')} — remember to record this change.`);
        r.due.forEach((d) => lines.push(`due     ${d.id}: ${d.title} (condition met: ${d.condition})`));
        r.manual.forEach((d) => lines.push(`judge   ${d.id}: ${d.title} (not checked automatically: ${d.condition})`));
        if (!r.due.length && !r.manual.length) lines.push('No recall is due.');
        print(args, r, lines.join('\n'));
        return 0;
      }
      case 'review': {
        const r = cmdReview(dir);
        const lines = r.items.map((i) => `${LABEL[i.type].padEnd(17)} ${i.id}: ${i.title} — ${i.reason}`);
        r.comments.forEach((c) => lines.push(`${'Comment'.padEnd(17)} ${c.id}: ${c.title} — ${c.text.replace(/\s+/g, ' ')}`));
        print(args, r, lines.length ? lines.join('\n') : 'Nothing needs a decision.');
        return 0;
      }
      case 'view': {
        const r = cmdView(dir, { out: args.out });
        // the served page is the one the user can edit and comment on; the file is the fallback
        const svc = !args.out && (args.open ? ensureService() : serviceInfo());
        const id = (projectId(dir) || {}).id;
        if (svc && id) r.url = planUrl(svc, id);
        if (args.open) r.opened = await openInBrowser(r.url || r.written);
        print(args, r, `Wrote ${r.written} (${r.notes} notes).` + (r.url ? ` The page is at ${r.url}${args.open ? (r.opened ? ' (opened)' : ' (could not open a browser; give the user this address)') : ''}.` : args.open ? (r.opened ? ' Opened it in the browser.' : ' Could not open a browser here; open the file yourself.') : ' Open it in a browser, or run view --open.'));
        return 0;
      }
      case 'service': {
        const sub = rest[0] || 'status';
        if (sub === 'run') {
          const srv = await startService(args.port ? { port: Number(args.port) } : {});
          print(args, { url: srv.url, port: srv.port }, `Omino page service at ${srv.url} (every plan on this machine, at /p/<id>). Ctrl-C stops it.`);
          const bye = () => srv.close();
          process.on('SIGINT', bye); process.on('SIGTERM', bye);
          await srv.closed;
          return 0;
        }
        if (sub === 'start') {
          const prev = process.env.OMINO_NO_SERVE; delete process.env.OMINO_NO_SERVE;
          let svc; try { svc = ensureService({ wait: 4000 }); } finally { if (prev !== undefined) process.env.OMINO_NO_SERVE = prev; }
          if (!svc) throw new OminoError('could not start the page service', 1);
          print(args, svc, `The Omino page service runs at ${svc.url} (version ${svc.version}).`);
          return 0;
        }
        if (sub === 'stop') { const r = await cmdServiceStop(); print(args, r, r.stopped ? 'Stopped the page service.' : 'The page service was not running.'); return 0; }
        if (sub === 'install') {
          const r = cmdServiceInstall();
          const prev = process.env.OMINO_NO_SERVE; delete process.env.OMINO_NO_SERVE;
          try { r.service = ensureService({ wait: 4000 }); } finally { if (prev !== undefined) process.env.OMINO_NO_SERVE = prev; }
          print(args, r, `The page service now starts at login (${r.file})${r.service ? ` and runs at ${r.service.url}` : ''}.`);
          return 0;
        }
        if (sub === 'uninstall') { const r = cmdServiceUninstall(); print(args, r, r.removed ? `The page service no longer starts at login (removed ${r.file}).` : 'The page service was not set to start at login.'); return 0; }
        if (sub === 'status') {
          const svc = serviceInfo(), a = autostartStatus();
          const r = { running: !!svc, ...(svc ? { url: svc.url, port: svc.port, pid: svc.pid, version: svc.version } : {}), autostart: a.installed, autostartFile: a.file };
          print(args, r, `${svc ? `running at ${svc.url} (version ${svc.version}, pid ${svc.pid})` : 'not running'}\nstarts at login: ${a.installed ? `yes (${a.file})` : 'no'}`);
          return 0;
        }
        throw new OminoError('use: service status|start|stop|install|uninstall|run');
      }
      case 'find': {
        const r = cmdFind(dir, rest.join(' '));
        print(args, r, r.hits.length ? r.hits.map((h) => `${h.id.padEnd(16)} ${h.kind.padEnd(8)} ${h.title}${h.status ? ` [${h.status}]` : ''}\n${''.padEnd(26)}${h.snippet}`).join('\n') : `Nothing matches "${r.query}".`);
        return 0;
      }
      case 'brief': {
        const r = cmdBrief(dir);
        print(args, r, r.text);
        return 0;
      }
      case 'hook': {
        const ev = rest[0];
        if (!HOOK_EVENTS[ev]) throw new OminoError(`hook needs one of: ${Object.keys(HOOK_EVENTS).join(', ')}`);
        let input = {};
        try { const raw = readStdin(); if (raw.trim()) input = JSON.parse(raw); } catch {}
        if (args.dir) input.cwd = dir;
        const r = runHook(ev, input, { agent: args.agent || 'claude' });
        if (r.stdout) process.stdout.write(r.stdout + '\n');
        if (r.stderr) process.stderr.write(r.stderr + '\n');
        return r.exitCode || 0;
      }
      case 'hooks': {
        const sub = rest[0] || 'status';
        if (sub === 'status') {
          const r = hooksStatus(dir);
          print(args, r, r.plugin ? 'Running from the Claude Code plugin: its hooks are active.' : r.settings.length ? r.settings.map((x) => `${x.scope}: ${x.events.join(', ')} (${x.file})`).join('\n') : 'No Omino hooks in Claude Code settings.');
          return 0;
        }
        if (sub !== 'install' && sub !== 'remove') throw new OminoError('use: hooks install|remove|status [--scope project|user]');
        const r = cmdHooksInstall(dir, { scope: args.scope || 'project', agent: args.agent || 'claude', remove: sub === 'remove' });
        print(args, r, sub === 'remove' ? `Removed the Omino hooks from ${r.file}.` : `Added the Omino hooks (${r.events.join(', ')}) to ${r.file}. They take effect in the next Claude Code session.`);
        return 0;
      }
      case 'doctor': {
        const r = cmdDoctor(dir);
        const mark = { ok: 'ok   ', info: 'info ', warn: 'warn ', error: 'error' };
        print(args, r, r.checks.map((c) => `${mark[c.status]} ${c.name.padEnd(11)} ${c.detail}${c.fix ? `\n${''.padEnd(18)}→ ${c.fix}` : ''}`).join('\n'));
        return r.ok ? 0 : 1;
      }
      case undefined: case 'help': case '--help':
        print(args, { help: HELP }, HELP);
        return 0;
      default:
        throw new OminoError(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } catch (e) {
    if (!(e instanceof OminoError)) throw e;
    if (args.json) process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    else process.stderr.write(`omino: ${e.message}\n`);
    return e.code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}
