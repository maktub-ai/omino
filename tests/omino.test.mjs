import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseNote, loadPlan, validate, cmdInit, cmdRecord, cmdCheck, cmdRecall, cmdReview, cmdView, readChanges, OminoError, omRoot
} from '../skills/omino/scripts/omino.mjs';
import { buildRound, applyRound, note, write } from './scenario.mjs';
// tests must not depend on the agent that runs them
for (const k of Object.keys(process.env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_PROJECT_DIR|GEMINI_|KIMI_|CODEX_|DSH_SESSION_ID)/.test(k)) delete process.env[k];

// every plan goes to a throwaway home; history commits are tested on their own
process.env.OMINO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omino-home-'));
process.env.OMINO_NO_HISTORY = '1';
process.env.OMINO_NO_SERVE = '1';   // no background page service; tests start it in-process where they need it
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omino-user-'));  // no real agent configs leak into the tests
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'omino', 'scripts', 'omino.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omino-'));
const errorsOf = (dir) => validate(loadPlan(dir)).errors.map((e) => `${e.file}: ${e.msg}`).join('\n');
const snapshot = (dir) => {
  const root = omRoot(dir);
  const out = {};
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.md')) out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
};

// ---------------------------------------------------------------- A1: check finds format errors

test('A1 parser accepts the frontmatter subset', () => {
  const { fm, body } = parseNote('---\nid: a\nkind: work\norder: 3\nrequires: [b, c]\nempty: []\n---\n\n## Why\nx\n');
  assert.deepEqual(fm, { id: 'a', kind: 'work', order: 3, requires: ['b', 'c'], empty: [] });
  assert.match(body, /## Why/);
});

test('A1 parser rejects syntax outside the subset', () => {
  assert.throws(() => parseNote('---\nid: a\n  nested: 1\n---\n'), OminoError);
  assert.throws(() => parseNote('---\nid: a\nnote: |\n---\n'), OminoError);
  assert.throws(() => parseNote('---\nid: a\nid: b\n---\n'), OminoError);
  assert.throws(() => parseNote('no frontmatter'), OminoError);
});

test('A1 check reports missing fields, bad enums, id mismatch, unknown refs and cycles', () => {
  const dir = tmp();
  buildRound(dir, 2);
  write(dir, 'work/x.md', note({ id: 'wrong', kind: 'work', title: 'X', stage: 'nope', status: 'finished' }, { Why: '.' }));
  write(dir, 'work/a.md', note({ id: 'a', kind: 'work', title: 'A', stage: 's1', status: 'planned', requires: ['b'] }, { Why: '.' }));
  write(dir, 'work/b.md', note({ id: 'b', kind: 'work', title: 'B', stage: 's1', status: 'planned', requires: ['a'], refs: ['ghost'] }, { Why: '.' }));
  write(dir, 'work/c.md', note({ id: 'c', kind: 'work', status: 'verified', stage: 's1', source: 'agent' }, { Why: '.' }));
  write(dir, 'stages/s9.md', '---\nid: s9\nkind: stage\ntitle: S\nlevel: x\nstatus: open\n---\n');
  const msgs = errorsOf(dir);
  assert.match(msgs, /does not match file name/);
  assert.match(msgs, /stage points to unknown note "nope"/);
  assert.match(msgs, /invalid status "finished"/);
  assert.match(msgs, /requires forms a cycle: (a → b → a|b → a → b)/);
  assert.match(msgs, /refs points to unknown note "ghost"/);
  assert.match(msgs, /missing required field "title"/);
  assert.match(msgs, /verified" requires source "tool"/);
  assert.match(msgs, /non-integer "level"/);
  assert.match(msgs, /invalid status "open"/);
});

test('A1 check reports duplicate ids and a missing project.md', () => {
  const dir = tmp();
  buildRound(dir, 2);
  write(dir, 'ideas/add.md', note({ id: 'add', kind: 'idea', title: 'dup', idea_state: 'open' }, {}));
  fs.rmSync(path.join(omRoot(dir), 'project.md'));
  const msgs = errorsOf(dir);
  assert.match(msgs, /duplicate id "add"/);
  assert.match(msgs, /project.md: missing/);
});

// ---------------------------------------------------------------- A2: unrecorded edits

test('A2 check finds direct edits and --fix records them with source "file"', () => {
  const dir = tmp();
  buildRound(dir, 3);
  assert.equal(cmdCheck(dir).ok, true);
  const p = path.join(omRoot(dir), 'work', 'add.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('快速写下来', '很快写下来'));
  const before = cmdCheck(dir);
  assert.equal(before.ok, false);
  assert.deepEqual(before.unrecorded, [{ id: 'add', op: 'modified' }]);
  const fixed = cmdCheck(dir, { fix: true });
  assert.equal(fixed.ok, true);
  const last = readChanges(loadPlan(dir)).at(-1);
  assert.equal(last.source, 'file');
  assert.deepEqual(last.notes, [{ id: 'add', op: 'modified' }]);
  assert.equal(cmdCheck(dir).ok, true);
});

// ---------------------------------------------------------------- A3: record

test('A3 record writes nothing when nothing changed', () => {
  const dir = tmp();
  buildRound(dir, 3);
  const n = readChanges(loadPlan(dir)).length;
  assert.equal(cmdRecord(dir, 'nothing', 'user').recorded, false);
  assert.equal(readChanges(loadPlan(dir)).length, n);
});

test('A3 record stamps a basis on completion and refuses verified without a tool source', () => {
  const dir = tmp();
  buildRound(dir, 6);
  const filter = loadPlan(dir).notes.get('filter');
  assert.match(String(filter.fm.basis), /^[0-9a-f]{8}\.[0-9a-f]{8}$/);
  const p = path.join(omRoot(dir), 'work', 'add.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('status: done', 'status: verified').replace('source: user', 'source: tool'));
  assert.throws(() => cmdRecord(dir, 'tests pass', 'agent'), /verified needs --source tool/);
  assert.equal(cmdRecord(dir, 'tests pass', 'tool').recorded, true);
});

test('A3 record refuses invalid plans', () => {
  const dir = tmp();
  buildRound(dir, 2);
  write(dir, 'work/bad.md', note({ id: 'bad', kind: 'work', title: 'B', stage: 'zzz', status: 'planned' }, {}));
  assert.throws(() => cmdRecord(dir, 'x', 'user'), /fix these first/);
});

// ---------------------------------------------------------------- A4: recall across the seven rounds

test('A4 recall is silent in rounds 3-5, due in round 6, then never repeats', () => {
  for (const r of [3, 4, 5]) {
    const dir = tmp();
    buildRound(dir, r);
    assert.deepEqual(cmdRecall(dir).due, [], `round ${r}`);
  }
  const dir = tmp();
  const r6 = buildRound(dir, 6);
  assert.deepEqual(r6.recall.due.map((d) => d.id), ['remind']);
  assert.deepEqual(cmdRecall(dir).due, [], 'after --mark-fired');
  assert.deepEqual(cmdReview(dir).items.filter((i) => i.type === 'recalled').map((i) => i.id), ['remind']);
  applyRound(dir, 7);
  assert.deepEqual(cmdRecall(dir).due, [], 'round 7');
  assert.deepEqual(cmdReview(dir).items.filter((i) => i.type === 'recalled'), [], 'deferred idea no longer waits for a decision');
  assert.equal(loadPlan(dir).notes.get('remind').fm.recall_state, 'stopped');
});

test('A4 manual recall conditions are listed for judgement, not as due', () => {
  const dir = tmp();
  buildRound(dir, 2);
  write(dir, 'ideas/tags.md', note({ id: 'tags', kind: 'idea', title: '标签', idea_state: 'open', recall: 'manual 当用户开始抱怨分类不够用', recall_state: 'waiting' }, {}));
  const r = cmdRecall(dir);
  assert.deepEqual(r.due, []);
  assert.equal(r.manual[0].id, 'tags');
});

// ---------------------------------------------------------------- A5: review

test('A5 review reports drift, flags, agent-reported done, waiting and recalled items', () => {
  const dir = tmp();
  buildRound(dir, 7);
  assert.deepEqual(cmdReview(dir).items, [], 'round 7 needs no decision');

  // drift: requirements of a completed item change
  const fp = path.join(omRoot(dir), 'work', 'filter.md');
  fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace('只显示未完成的待办。', '只显示未完成的待办，并且可以按分类筛选。'));
  // drift through a prerequisite: x requires add; add's requirements change later
  write(dir, 'work/x.md', note({ id: 'x', kind: 'work', title: '导出', stage: 's2', status: 'done', source: 'user', requires: ['add'] }, { Requirements: '- 导出全部待办。' }));
  cmdRecord(dir, 'setup', 'user');
  const ap = path.join(omRoot(dir), 'work', 'add.md');
  fs.writeFileSync(ap, fs.readFileSync(ap, 'utf8').replace('输入一句话即可新增一条待办。', '输入一句话即可新增一条待办，并选择分类。'));
  // flagged stage, agent-reported done, waiting
  write(dir, 'stages/s3.md', note({ id: 's3', kind: 'stage', title: '同步', level: 3, status: 'planned', review: '与“本地使用”的边界冲突，需要用户决定' }, {}));
  write(dir, 'work/migrate.md', note({ id: 'migrate', kind: 'work', title: '旧数据迁移', stage: 's2', status: 'done', source: 'agent' }, { Requirements: '- 旧待办归入“生活”。' }));
  write(dir, 'work/cat-filter.md', note({ id: 'cat-filter', kind: 'work', title: '按分类筛选', stage: 's2', status: 'planned', requires: ['category', 'filter'] }, {}));
  cmdRecord(dir, 'more', 'user');

  const items = cmdReview(dir).items;
  const by = (t) => items.filter((i) => i.type === t).map((i) => i.id).sort();
  assert.deepEqual(by('flagged'), ['s3']);
  assert.deepEqual(by('drift'), ['add', 'filter', 'x']);
  assert.match(items.find((i) => i.id === 'x').reason, /prerequisite/);
  assert.match(items.find((i) => i.id === 'filter').reason, /its Requirements changed/);
  assert.deepEqual(by('unconfirmed'), ['migrate']);
  assert.deepEqual(by('waiting'), ['cat-filter']);
  assert.match(items.find((i) => i.id === 'cat-filter').reason, /category/);

  // confirming refreshes the basis; the old completion is kept, not reset
  cmdRecord(dir, 'user confirmed filter still holds', 'user', { confirm: ['filter'] });
  assert.ok(!cmdReview(dir).items.some((i) => i.id === 'filter'));
  assert.equal(loadPlan(dir).notes.get('filter').fm.status, 'done');
});

// ---------------------------------------------------------------- A6: view

test('A6 view writes one self-contained HTML file', () => {
  const dir = tmp();
  buildRound(dir, 7);
  const { written } = cmdView(dir);
  const html = fs.readFileSync(written, 'utf8');
  assert.ok(!html.includes('/*__OMINO_DATA__*/'), 'data was inlined');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+href="https?:/.test(html), 'no external stylesheets');
  assert.ok(!html.includes('"live":'), 'a static file is never in live mode');
  assert.ok(!/fetch\(['"]https?:/.test(html) && !/EventSource\(['"]https?:/.test(html), 'no requests to other hosts');
  for (const id of ['project', 's1', 's2', 'add', 'done', 'del', 'filter', 'category', 'remind']) assert.ok(html.includes(`"id":"${id}"`), id);
  assert.ok(!html.includes('</script><'), 'note text cannot break out of the data script');
});

// ---------------------------------------------------------------- A7: every round is valid; round 4 changes nothing

test('A7 every round passes check, and round 4 is identical to round 3', () => {
  for (let r = 1; r <= 7; r++) {
    const dir = tmp();
    buildRound(dir, r);
    const res = cmdCheck(dir);
    assert.deepEqual(res.errors, [], `round ${r}`);
    assert.equal(res.ok, true, `round ${r}`);
  }
  const d3 = tmp(); buildRound(d3, 3);
  const d4 = tmp(); const r4 = buildRound(d4, 4);
  assert.equal(r4.record.recorded, false);
  assert.deepEqual(snapshot(d4), snapshot(d3));
  assert.equal(readChanges(loadPlan(d4)).length, readChanges(loadPlan(d3)).length);
});

test('A7 round 5 adds an arrangement, not a dependency', () => {
  const dir = tmp();
  buildRound(dir, 5);
  const plan = loadPlan(dir);
  assert.deepEqual(plan.notes.get('filter').fm.before, ['del']);
  assert.equal(plan.notes.get('del').fm.requires, undefined);
  assert.equal(plan.notes.get('filter').fm.stage, 's1');
});

test('A7 closing stage 1 does not open stage 2', () => {
  const dir = tmp();
  buildRound(dir, 6);
  assert.equal(loadPlan(dir).notes.has('s2'), false);
});

// ---------------------------------------------------------------- CLI

test('CLI: init, check --json and exit codes', () => {
  const dir = tmp();
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--dir', dir], { encoding: 'utf8' });
  assert.equal(run('init').status, 0);
  assert.equal(run('init').status, 2);
  const pending = run('check', '--json');
  assert.equal(pending.status, 1);
  assert.deepEqual(JSON.parse(pending.stdout).unrecorded, [{ id: 'project', op: 'created' }]);
  assert.equal(run('record', 'Set', 'intent', '--source', 'user').status, 0);
  assert.equal(run('check').stdout.trim(), 'OK');
  assert.equal(run('review').stdout.trim(), 'Nothing needs a decision.');
  assert.equal(run('bogus').status, 2);
});

// ---------------------------------------------------------------- A8: adopting an existing project

test('A8 init --adopt drafts an unconfirmed intent and a closed "before" stage, nothing else', () => {
  const dir = tmp();
  cmdInit(dir, { adopt: true });
  const plan = loadPlan(dir);
  assert.deepEqual(validate(plan).errors, []);
  assert.deepEqual([...plan.notes.keys()].sort(), ['project', 's0']);
  const s0 = plan.notes.get('s0');
  assert.equal(s0.fm.level, 0);
  assert.equal(s0.fm.status, 'closed');
  assert.equal(s0.fm.source, 'agent');
  assert.equal([...plan.notes.values()].filter((n) => n.kind === 'work').length, 0, 'no back-filled work items');
  assert.equal(cmdRecord(dir, 'Adopt existing project', 'agent').recorded, true);
  const items = cmdReview(dir).items;
  assert.deepEqual(items.map((i) => [i.type, i.id]), [['flagged', 'project']], 'the drafted intent waits for confirmation');
});

test('A8 confirming the drafted intent clears it from review', () => {
  const dir = tmp();
  cmdInit(dir, { adopt: true });
  cmdRecord(dir, 'Adopt existing project', 'agent');
  const p = path.join(omRoot(dir), 'project.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^review: .*\n/m, ''));
  cmdRecord(dir, 'User confirmed the drafted intent', 'user');
  assert.deepEqual(cmdReview(dir).items, []);
});

test('A8 the viewer shows level 0 stages', () => {
  const dir = tmp();
  cmdInit(dir, { adopt: true });
  cmdRecord(dir, 'Adopt', 'agent');
  const html = fs.readFileSync(cmdView(dir).written, 'utf8');
  assert.ok(html.includes('"id":"s0"'));
});

test('A6 the viewer offers graph, board and list views', () => {
  const dir = tmp();
  buildRound(dir, 7);
  const html = fs.readFileSync(cmdView(dir).written, 'utf8');
  for (const v of ['graph', 'board', 'list']) assert.ok(html.includes(`'${v}'`), v);
  assert.ok(html.includes('function renderBoard') && html.includes('function renderList'));
});

test('A9 open questions show up as items needing a decision, and disappear when removed', () => {
  const dir = tmp();
  cmdInit(dir, { adopt: true });
  const p = path.join(omRoot(dir), 'project.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('<!-- One bullet', '- README and roadmap disagree on supported CLIs. Which is current?\n<!-- One bullet'));
  cmdRecord(dir, 'Adopt', 'agent');
  const qs = cmdReview(dir).items.filter((i) => i.type === 'question');
  assert.deepEqual(qs.map((q) => q.reason), ['README and roadmap disagree on supported CLIs. Which is current?']);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^- README and roadmap.*\n/m, '').replace(/^review: .*\n/m, ''));
  cmdRecord(dir, 'User answered', 'user');
  assert.deepEqual(cmdReview(dir).items, []);
});

test('A9 init reports the files it created', () => {
  const dir = tmp();
  const r = cmdInit(dir, { adopt: true });
  assert.ok(r.files.includes(path.join(omRoot(dir), 'project.md')) && r.files.includes(path.join(omRoot(dir), 'stages', 's0.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.omino')), 'nothing is written inside the project but its id');
});

test('A10 record keeps the user\'s words, refreshes the page and links each changed note', () => {
  const dir = tmp();
  buildRound(dir, 4);
  write(dir, 'work/filter.md', note({ id: 'filter', kind: 'work', title: 'F', stage: 's1', status: 'planned', before: ['del'] }, { Why: '.' }));
  const r = cmdRecord(dir, 'Add filter', 'user', { said: '再加一个只看未完成待办的筛选。这个先做' });
  assert.equal(readChanges(loadPlan(dir)).at(-1).said, '再加一个只看未完成待办的筛选。这个先做');
  assert.deepEqual(r.links.map((l) => [l.id, l.op]), [['filter', 'created']]);
  assert.match(r.links[0].url, /^file:\/\/.*\/projects\/[^/]+\/view\.html#filter$/);
  assert.ok(fs.existsSync(path.join(omRoot(dir), 'view.html')));
});

test('A10 the page opens the note named in the link and shows no diff markers', () => {
  const dir = tmp();
  buildRound(dir, 7);
  const html = fs.readFileSync(cmdView(dir).written, 'utf8');
  assert.ok(html.includes('location.hash') && html.includes('hashchange'));
  assert.ok(!html.includes('omino-seen') && !html.includes('newb'));
});

// ---------------------------------------------------------------- A11: decisions and provenance

import { gitContext, displayStatus, review as reviewItems } from '../skills/omino/scripts/omino.mjs';
import { execFileSync } from 'node:child_process';

test('A11 a decision supersedes an arrangement and flags affected work for review', () => {
  const dir = tmp();
  buildRound(dir, 7);
  write(dir, 'stages/s3.md', note({ id: 's3', kind: 'stage', title: '多端同步', level: 3, status: 'active' }, { Scope: '先做同步。' }));
  write(dir, 'decisions/d-sync-first.md', note({ id: 'd-sync-first', kind: 'decision', title: '改为先做同步', date: '2026-11-20', source: 'user', supersedes: ['s2'], affects: ['s2', 'category', 'filter', 's3'] }, {
    Before: '第二阶段先做分类。', Now: '先做多端同步。', Why: '用户在两台设备之间切换。'
  }));
  const r = cmdRecord(dir, '改为先做同步', 'user', { said: '分类先放一放，先做同步' });
  assert.deepEqual(r.flagged.sort(), ['filter'], 'untouched done work is flagged; planned work, the superseded stage and the stage written with the decision are not');
  const plan = loadPlan(dir);
  assert.match(String(plan.notes.get('filter').fm.review), /d-sync-first/);
  const items = reviewItems(plan);
  assert.equal(displayStatus(plan, plan.notes.get('s2'), items), 'superseded');
  assert.equal(displayStatus(plan, plan.notes.get('d-sync-first'), items), 'decision');
  assert.ok(!items.some((i) => i.id === 's2'), 'a superseded note needs no decision');
  // editing the decision again does not re-flag what the user has already confirmed
  const fp = path.join(omRoot(dir), 'work', 'filter.md');
  fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace(/^review: .*\n/m, ''));
  cmdRecord(dir, 'filter still fits', 'user');
  assert.equal(cmdRecord(dir, 'nothing', 'user').recorded, false);
  assert.equal(loadPlan(dir).notes.get('filter').fm.review, undefined);
});

test('A11 decisions are validated', () => {
  const dir = tmp();
  buildRound(dir, 2);
  write(dir, 'decisions/d1.md', note({ id: 'd1', kind: 'decision', title: 'x', supersedes: ['nope', 'd1'] }, {}));
  const msgs = errorsOf(dir);
  assert.match(msgs, /invalid "date"/);
  assert.match(msgs, /supersedes points to unknown note "nope"/);
  assert.match(msgs, /cannot point to itself/);
});

test('A11 record captures git branch, commit and session', () => {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'feature-x'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  assert.equal(gitContext(dir).branch, 'feature-x');
  buildRound(dir, 1);
  write(dir, 'stages/s1.md', note({ id: 's1', kind: 'stage', title: 'S', level: 1, status: 'active' }, {}));
  cmdRecord(dir, 'stage', 'user', { session: 'sess-123' });
  const last = readChanges(loadPlan(dir)).at(-1);
  assert.equal(last.session, 'sess-123');
  assert.equal(last.git.branch, 'feature-x');
  assert.match(last.git.commit, /^[0-9a-f]{7,}$/);
  assert.equal(last.git.worktree, undefined, 'main checkout is not a linked worktree');
  const wt = path.join(tmp(), 'wt');
  g('worktree', 'add', '-q', '-b', 'item-filter', wt);
  assert.deepEqual([gitContext(wt).branch, gitContext(wt).worktree], ['item-filter', 'wt']);
});

test('A11 outside git, entries simply have no git field', () => {
  const dir = tmp();
  buildRound(dir, 1);
  assert.equal(readChanges(loadPlan(dir)).at(-1).git, undefined);
});

// ---------------------------------------------------------------- A12: the page service — edits and comments on the page

import { startService, serviceInfo, pageEdit, pageComment, pageConfirm, noteSource, comments, addCommentTo, migrateInbox, setField, review as reviewOf } from '../skills/omino/scripts/omino.mjs';
import http from 'node:http';

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const planIdOf = (dir) => path.basename(omRoot(dir));

test('A12 a comment is a "> [!omino]" block under ## Comments, kept out of Requirements', () => {
  const body = '## Why\n\nx\n\n## Requirements\n\n- one\n';
  const once = addCommentTo(body, 'first\nsecond line', 'Answer to "q"');
  assert.match(once, /## Requirements\n\n- one\n\n## Comments\n\n> \[!omino\] Answer to "q"\n> first\n> second line\n$/);
  const twice = addCommentTo(once, 'again');
  assert.match(twice, /> second line\n\n> \[!omino\]\n> again\n$/);
  // a Comments section in the middle keeps the sections after it
  const mid = addCommentTo('## Comments\n\n> [!omino]\n> a\n\n## Progress\n\np\n', 'b');
  assert.match(mid, /> a\n\n> \[!omino\]\n> b\n\n## Progress\n\np\n$/);

  const dir = tmp();
  buildRound(dir, 6);
  const before = reviewOf(loadPlan(dir)).filter((i) => i.type === 'drift').length;
  pageComment(dir, 'add', { text: 'Can it take a due date?', lang: 'en' });
  const plan = loadPlan(dir);
  assert.equal(reviewOf(plan).filter((i) => i.type === 'drift').length, before, 'requirements unchanged: finished work does not drift');
  assert.deepEqual(comments(plan).map((c) => [c.id, c.text]), [['add', 'Can it take a due date?']]);
  assert.equal(validate(plan).errors.length, 0);
  const last = readChanges(plan).at(-1);
  assert.equal(last.source, 'user'); assert.equal(last.via, 'page'); assert.equal(last.page, 'comment'); assert.equal(last.said, 'Can it take a due date?');
  assert.equal(last.git, undefined, 'a page change has no code branch or commit');
});

test('A12 editing on the page: the user\'s change only, checked against edits made meanwhile, never an invalid plan', () => {
  const dir = tmp();
  buildRound(dir, 3);
  const src = noteSource(dir, 'add');
  assert.match(src.text, /^---\nid: add\n/);
  // an agent edits another note and has not recorded it yet
  fs.appendFileSync(path.join(omRoot(dir), 'work', 'del.md'), '\nagent draft\n');
  const r = pageEdit(dir, 'add', { text: src.text.replace('快速写下来', '随手写下来'), base: src.hash, lang: 'zh' });
  assert.equal(r.changed, true);
  const plan = loadPlan(dir);
  const last = readChanges(plan).at(-1);
  assert.deepEqual(last.notes.map((n) => n.id), ['add'], 'only the user\'s note is in the entry');
  assert.equal(last.summary, '在页面上修改了「添加待办」');
  assert.deepEqual(unrecordedIds(dir), ['del'], 'the agent\'s edit is still waiting for the agent');
  // the page was opened before someone else changed the note
  assert.throws(() => pageEdit(dir, 'add', { text: src.text, base: src.hash }), (e) => e.code === 5 && /changed after you opened it/.test(e.message) && e.current.text.includes('随手'));
  assert.equal(pageEdit(dir, 'add', { text: src.text, base: src.hash, force: true }).changed, true, 'force overwrites');
  // id and kind stay; the plan stays valid; nothing is written otherwise
  const cur = noteSource(dir, 'add');
  assert.throws(() => pageEdit(dir, 'add', { text: cur.text.replace('id: add', 'id: add2') }), /id must stay "add"/);
  assert.throws(() => pageEdit(dir, 'add', { text: cur.text.replace('kind: work', 'kind: idea') }), /kind must stay/);
  assert.throws(() => pageEdit(dir, 'add', { text: cur.text.replace('stage: s1', 'stage: nope') }), /would not be valid[\s\S]*unknown note "nope"/);
  assert.throws(() => pageEdit(dir, 'add', { text: 'no frontmatter' }), /frontmatter/);
  assert.equal(noteSource(dir, 'add').text, cur.text, 'a refused edit leaves the file as it was');
  assert.equal(pageEdit(dir, 'add', { text: cur.text }).changed, false);
});
const unrecordedIds = (dir) => cmdCheck(dir).unrecorded.map((u) => u.id);

test('A12 confirming on the page settles a draft, work an agent reported done, and work whose requirements changed', () => {
  const dir = tmp();
  buildRound(dir, 6);
  const root = omRoot(dir);
  setField(path.join(root, 'work', 'add.md'), 'review', 'Drafted by an agent');
  setField(path.join(root, 'work', 'done.md'), 'source', 'agent');
  fs.writeFileSync(path.join(root, 'work', 'del.md'), fs.readFileSync(path.join(root, 'work', 'del.md'), 'utf8').replace('可以删除单条待办。', '可以删除单条或多条待办。'));
  cmdRecord(dir, 'agent changes', 'agent', { view: false });
  const types = () => reviewOf(loadPlan(dir)).filter((i) => ['flagged', 'unconfirmed', 'drift'].includes(i.type)).map((i) => `${i.type}:${i.id}`).sort();
  assert.deepEqual(types(), ['drift:del', 'flagged:add', 'unconfirmed:done']);
  pageConfirm(dir, 'add', { about: 'flagged' });
  pageConfirm(dir, 'done', { about: 'unconfirmed' });
  pageConfirm(dir, 'del', { about: 'drift' });
  assert.deepEqual(types(), []);
  const plan = loadPlan(dir);
  assert.equal(plan.notes.get('add').fm.review, undefined);
  assert.equal(plan.notes.get('done').fm.source, 'user');
  assert.ok(readChanges(plan).slice(-3).every((c) => c.source === 'user' && c.page === 'confirm'));
  assert.throws(() => pageConfirm(dir, 'add', {}), /nothing on this note is waiting/);
});

test('A12 a closed plan cannot be changed from the page', async () => {
  const { cmdClose } = await import('../skills/omino/scripts/omino.mjs');
  const dir = tmp();
  buildRound(dir, 3);
  cmdClose(dir);
  assert.throws(() => pageComment(dir, 'add', { text: 'x' }), /closed/);
  assert.throws(() => pageEdit(dir, 'add', { text: noteSource(dir, 'add').text + 'x' }), /closed/);
});

test('A12 answers queued on the page by Omino 0.5 become comments, once', () => {
  const dir = tmp();
  buildRound(dir, 3);
  const root = omRoot(dir);
  const ev = (o) => JSON.stringify({ event: true, ts: '2026-11-19T00:00:00Z', ...o });
  fs.writeFileSync(path.join(root, 'inbox.jsonl'), [
    ev({ id: 'e1', type: 'answer', note: 'project', question: 'Which list?', text: 'README' }),
    ev({ id: 'e2', type: 'comment', note: 'del', text: '没问题' }),
    ev({ id: 'e3', type: 'comment', note: 'add', text: 'handled already' }), JSON.stringify({ reply: 'e3', status: 'done' }),
    ev({ id: 'e4', type: 'comment', note: 'gone', text: 'note no longer exists' })].join('\n') + '\n');
  fs.writeFileSync(path.join(root, '.serve.json'), '{}');
  assert.equal(migrateInbox(dir), 2);
  const cs = comments(loadPlan(dir));
  assert.deepEqual(cs.map((c) => [c.id, c.text]), [['project', 'Answer to "Which list?"\nREADME'], ['del', '没问题']]);
  assert.ok(!fs.existsSync(path.join(root, 'inbox.jsonl')) && fs.existsSync(path.join(root, 'inbox.migrated.jsonl')));
  assert.ok(!fs.existsSync(path.join(root, '.serve.json')));
  assert.equal(migrateInbox(dir), 0);
});

test('A12 the page service: every plan at /p/<id>, pages without a token, the API only with it, host checked', async () => {
  const dir = tmp();
  buildRound(dir, 3);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Hello');
  fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git', 'config'), 'secret');
  const id = planIdOf(dir);
  const srv = await startService({ port: 0 });
  try {
    assert.deepEqual({ port: serviceInfo().port, pid: serviceInfo().pid }, { port: srv.port, pid: process.pid }, 'server.json says where it runs');
    const page = await req(srv.port, 'GET', `/p/${id}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(`"service":{"token":"${srv.token}","id":"${id}"}`), 'the served page can write');
    assert.equal((await req(srv.port, 'GET', `/p/${id}`, null, { host: 'evil.example:80' })).status, 403, 'host checked');
    assert.equal((await req(srv.port, 'GET', '/p/nope')).status, 404);
    assert.ok((await req(srv.port, 'GET', '/')).body.includes(`"href":"/p/${id}"`), 'the overview links each plan');
    // the API
    assert.equal((await req(srv.port, 'GET', `/api/plans/${id}/notes/add`)).status, 403, 'token required');
    assert.equal(JSON.parse((await req(srv.port, 'GET', '/api/hello')).body).omino, true, 'hello needs none');
    const tok = { 'x-omino-token': srv.token };
    const src = JSON.parse((await req(srv.port, 'GET', `/api/plans/${id}/notes/add`, null, tok)).body);
    assert.equal(src.id, 'add');
    const put = await req(srv.port, 'PUT', `/api/plans/${id}/notes/add`, { text: src.text.replace('快速', '马上'), base: src.hash }, tok);
    assert.equal(put.status, 200, put.body);
    assert.equal((await req(srv.port, 'PUT', `/api/plans/${id}/notes/add`, { text: src.text, base: src.hash }, tok)).status, 409, 'stale base');
    assert.equal((await req(srv.port, 'POST', `/api/plans/${id}/notes/add/comment`, { text: 'hi' }, tok)).status, 200);
    assert.equal((await req(srv.port, 'POST', `/api/plans/${id}/notes/nope/comment`, { text: 'hi' }, tok)).status, 404);
    assert.equal((await req(srv.port, 'POST', `/api/plans/${id}/notes/add/comment`, { text: 'hi' })).status, 403, 'no token, no write');
    assert.equal(JSON.parse((await req(srv.port, 'GET', `/api/plans/${id}/summary?t=${srv.token}`)).body).comments, 1);
    const pre = await req(srv.port, 'OPTIONS', `/api/plans/${id}/notes/add/comment`, null, { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' });
    assert.equal(pre.status, 204);
    // files linked from notes: the project's (f=) and the plan folder's (p=), nothing else
    const f = (q) => req(srv.port, 'GET', `/p/${id}/file?${q}`);
    const ok = await f('f=README.md');
    assert.equal(ok.status, 200); assert.equal(ok.body, '# Hello');
    assert.equal((await f('f=' + encodeURIComponent('../etc/passwd'))).status, 403);
    assert.equal((await f('f=' + encodeURIComponent('.git/config'))).status, 403);
    assert.equal((await f('p=project.md')).status, 200);
    assert.equal((await f('p=' + encodeURIComponent('../x'))).status, 403);
    assert.equal((await f('p=.hooks.json')).status, 403);
  } finally { srv.close(); await srv.closed; }
  assert.equal(serviceInfo(), null, 'server.json is removed when it stops');
});

test('A12 an open page hears when its plan changes', async () => {
  const dir = tmp();
  buildRound(dir, 3);
  const id = planIdOf(dir);
  const srv = await startService({ port: 0 });
  try {
    const heard = await new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: srv.port, path: `/api/plans/${id}/events?t=${srv.token}`, headers: { host: `127.0.0.1:${srv.port}` } }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; const m = /data: (\{.*\})/.exec(buf); if (m) { r.destroy(); resolve(JSON.parse(m[1])); } });
      });
      r.on('error', () => {});
      setTimeout(() => { fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nmore\n'); cmdRecord(dir, 'touch', 'agent', { view: false }); }, 300);
      setTimeout(() => reject(new Error('no change event')), 5000);
    });
    assert.equal(heard.type, 'changed');
  } finally { srv.close(); await srv.closed; }
});

test('A12 the fixed port: another Omino on it is reported; anything else there and the service takes another port', async () => {
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  process.env.OMINO_PORT = String(taken);
  try {
    const srv = await startService();
    try {
      assert.notEqual(srv.port, taken);
      // a second service while this one runs and the port is taken: told where the first one is
      process.env.OMINO_PORT = String(srv.port);
      await assert.rejects(startService(), /already runs at/);
    } finally { srv.close(); await srv.closed; }
  } finally { delete process.env.OMINO_PORT; blocker.close(); }
});

test('A12 the login item: a launchd agent, a Startup script or an XDG entry that runs this copy\'s service', async () => {
  const { autostartFile, autostartContent, autostartStatus, cmdServiceInstall, cmdServiceUninstall } = await import('../skills/omino/scripts/omino.mjs');
  const home = tmp();
  assert.equal(autostartFile({ platform: 'darwin', home }), path.join(home, 'Library', 'LaunchAgents', 'ai.maktub.omino.plist'));
  assert.match(autostartFile({ platform: 'win32', home, env: { APPDATA: 'C:\\A' } }), /Startup[\\/]omino-service\.vbs$/);
  assert.equal(autostartFile({ platform: 'linux', home, env: {} }), path.join(home, '.config', 'autostart', 'omino-service.desktop'));
  const mac = autostartContent({ platform: 'darwin', node: '/n/node', script: '/s/omino.mjs', env: { OMINO_HOME: '/h' } });
  assert.match(mac, /<string>\/n\/node<\/string><string>\/s\/omino\.mjs<\/string><string>service<\/string><string>run<\/string>/);
  assert.match(mac, /<key>RunAtLoad<\/key><true\/>/); assert.match(mac, /<key>OMINO_HOME<\/key><string>\/h<\/string>/);
  assert.match(autostartContent({ platform: 'win32', node: 'C:\\node.exe', script: 'C:\\o\\omino.mjs' }), /Run """C:\\node\.exe"" ""C:\\o\\omino\.mjs"" service run", 0, False/);
  assert.match(autostartContent({ platform: 'linux', node: '/n/node', script: '/s/omino.mjs' }), /^Exec="\/n\/node" "\/s\/omino\.mjs" service run$/m);
  const opts = { platform: 'linux', home, env: {} };
  assert.equal(autostartStatus(opts).installed, false);
  cmdServiceInstall(opts);
  const st = autostartStatus(opts);
  assert.ok(st.installed && st.current); assert.match(st.script, /omino\.mjs$/);
  assert.equal(cmdServiceUninstall(opts).removed, true);
  assert.equal(autostartStatus(opts).installed, false);
});

test('A13 the viewer renders links, lists, quotes, code and tables', () => {
  const dir = tmp();
  buildRound(dir, 2);
  const html = fs.readFileSync(cmdView(dir).written, 'utf8');
  for (const fn of ['function mdList', 'function renderList', 'function linkTo', 'function copyText', '<blockquote>', '<pre><code>', 'class="tbl"']) assert.ok(html.includes(fn), fn);
});

// ---------------------------------------------------------------- A14: v0.4 — format, find, brief, hooks, doctor

import { FORMAT, cmdFind, cmdBrief, runHook, cmdHooksInstall, hooksStatus, cmdDoctor, orphans } from '../skills/omino/scripts/omino.mjs';

const gitRepo = () => {
  const dir = tmp();
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n'); g('add', '.'); g('commit', '-qm', 'init');
  return dir;
};

test('A14 a plan written by a newer format is not changed by an older Omino', () => {
  const dir = tmp();
  buildRound(dir, 2);
  const st = path.join(omRoot(dir), 'state.json');
  const s = JSON.parse(fs.readFileSync(st, 'utf8'));
  assert.equal(s.version, FORMAT);
  fs.writeFileSync(st, JSON.stringify({ ...s, version: FORMAT + 1 }));
  fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nmore\n');
  assert.throws(() => cmdRecord(dir, 'x', 'user'), /newer Omino/);
  assert.equal(cmdCheck(dir).ok, false);
});

test('A14 find ranks title matches first', () => {
  const dir = tmp();
  buildRound(dir, 7);
  const r = cmdFind(dir, '分类');
  assert.ok(r.hits.length > 0);
  assert.match(r.hits[0].title, /分类/);
  assert.throws(() => cmdFind(dir, '  '), /needs some words/);
});

test('A14 unlinked ideas and decisions are reported; a decision can affect the project', () => {
  const dir = tmp();
  cmdInit(dir);
  write(dir, 'decisions/d-a.md', note({ id: 'd-a', kind: 'decision', title: 'A', date: '2026-11-17', source: 'user' }, '## Now\nx'));
  write(dir, 'decisions/d-b.md', note({ id: 'd-b', kind: 'decision', title: 'B', date: '2026-11-17', source: 'user', affects: '[project]' }, '## Now\nx'));
  assert.equal(errorsOf(dir), '');
  assert.deepEqual(orphans(loadPlan(dir)).map((o) => o.id), ['d-a']);
  const r = cmdRecord(dir, 'two decisions', 'user', { view: false });
  assert.deepEqual(r.orphans.map((o) => o.id), ['d-a']);
  assert.ok(cmdCheck(dir).warnings.some((w) => w.orphan && w.file === 'decisions/d-a.md'));
});

test('A14 brief summarises the active stage, open questions and page answers', () => {
  const dir = tmp();
  buildRound(dir, 7);
  const b = cmdBrief(dir);
  assert.match(b.lines[0], /^Omino plan: /);
  assert.ok(b.lines.some((l) => l.startsWith('Next in the plan:')), b.text);
  assert.ok(b.lines.length <= 12, b.text);
  assert.match(b.text, /omino find/);
});

test('A14 hooks: brief at start, page comments and edits once, one reminder when files changed unrecorded', async () => {
  process.env.OMINO_NO_SERVE = '1';
  try {
    const dir = gitRepo();
    buildRound(dir, 3);
    assert.deepEqual(runHook('session-start', { session_id: 's', cwd: tmp() }), {}, 'no plan: nothing');
    assert.match(runHook('session-start', { session_id: 's', cwd: path.join(dir) }).stdout, /^Omino plan:/);
    // the first message that could hand over work: register it in the plan before starting, once a session
    assert.match(runHook('prompt', { session_id: 's', cwd: dir, prompt: 'Please add CSV export to the todo list, with a download button' }).stdout, /register it in the plan before you start/);
    assert.deepEqual(runHook('prompt', { session_id: 's2', cwd: dir, prompt: 'hi' }), {}, 'a short greeting is not handing over work');
    // nothing changed during the turn: no reminder
    assert.deepEqual(runHook('stop', { session_id: 's', cwd: dir }), {});
    // a small edit, not recorded: no reminder (most changes need no plan update)
    runHook('prompt', { session_id: 's', cwd: dir });
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v2\n');
    assert.deepEqual(runHook('stop', { session_id: 's', cwd: dir }), {});
    // a substantial edit, not recorded: one reminder
    runHook('prompt', { session_id: 's', cwd: dir });
    fs.writeFileSync(path.join(dir, 'app.txt'), Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n') + '\n');
    const s1 = runHook('stop', { session_id: 's', cwd: dir });
    assert.equal(JSON.parse(s1.stdout).decision, 'block');
    assert.match(JSON.parse(s1.stdout).reason, /Most changes need no plan update/);
    assert.deepEqual(runHook('stop', { session_id: 's', cwd: dir, stop_hook_active: true }), {});
    // a new file appearing during the turn counts as substantial
    runHook('prompt', { session_id: 's', cwd: dir });
    fs.writeFileSync(path.join(dir, 'new.txt'), 'a\n');
    assert.equal(JSON.parse(runHook('stop', { session_id: 's', cwd: dir }).stdout).decision, 'block');
    // code changed and the plan was recorded: no reminder
    runHook('prompt', { session_id: 's', cwd: dir });
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v3\n');
    fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nnote\n');
    cmdRecord(dir, 'update', 'agent', { view: false });
    assert.deepEqual(runHook('stop', { session_id: 's', cwd: dir }), {});
    // comments and edits from the page are handed over once
    const { pageComment: comment, pageEdit: edit, noteSource: source } = await import('../skills/omino/scripts/omino.mjs');
    comment(dir, 'del', { text: 'looks good' });
    const p1 = runHook('prompt', { session_id: 's', cwd: dir });
    assert.match(p1.stdout, /Comments the user left[\s\S]*- del \(删除待办\): looks good/);
    assert.deepEqual(runHook('prompt', { session_id: 's', cwd: dir }), {}, 'not twice');
    const src = source(dir, 'add');
    edit(dir, 'add', { text: src.text.replace('快速', '马上'), base: src.hash });
    assert.match(runHook('prompt', { session_id: 's', cwd: dir }).stdout, /changed the plan on the plan page[\s\S]*Edited "添加待办" on the page \(add\)/);
    assert.deepEqual(runHook('prompt', { session_id: 's', cwd: dir }), {});
    // a new session hears about waiting comments in its brief, not again with its first message
    assert.match(runHook('session-start', { session_id: 't', cwd: dir }).stdout, /Comments the user left[\s\S]*looks good/);
    assert.ok(!/Comments the user left/.test(runHook('prompt', { session_id: 't', cwd: dir }).stdout || ''));
    assert.match(fs.readFileSync(path.join(omRoot(dir), '.gitignore'), 'utf8'), /\.hooks\.json/);
  } finally { process.env.OMINO_NO_SERVE = '1'; }
});

test('A14 hooks install merges into settings, keeps other hooks, and can be removed', () => {
  const dir = tmp();
  const file = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }));
  cmdHooksInstall(dir, { scope: 'project', script: '/opt/omino/omino.mjs' });
  cmdHooksInstall(dir, { scope: 'project', script: '/opt/omino/omino.mjs' });
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.model, 'x');
  assert.equal(cfg.hooks.Stop.length, 2, 'installed once, other hook kept');
  assert.equal(cfg.hooks.SessionStart[0].hooks[0].command, 'node "/opt/omino/omino.mjs" hook session-start');
  assert.deepEqual(hooksStatus(dir, { home: tmp() }).settings[0].events.sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  cmdHooksInstall(dir, { scope: 'project', remove: true });
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] });
});

test('A14 doctor reports without changing anything', () => {
  const dir = tmp();
  buildRound(dir, 2);
  const before = snapshot(dir);
  const home = tmp(); fs.mkdirSync(path.join(home, '.codex'));
  const r = cmdDoctor(dir, { home });
  assert.ok(r.checks.find((c) => c.name === 'node' && c.status === 'ok'));
  assert.ok(r.checks.find((c) => c.name === 'codex hooks' && c.status === 'warn'));
  assert.ok(r.checks.find((c) => c.name === 'agent note' && c.status === 'warn'));
  assert.deepEqual(snapshot(dir), before);
});

test('A14 --help on a command prints help and does nothing', () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, [CLI, 'init', '--help', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.equal(omRoot(dir), null);
});

test('A14 the plugin manifest, marketplace and hooks file point at the CLI', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(plugin.name, 'omino'); assert.equal(plugin.version, pkg.version); assert.equal(plugin.license, 'MIT');
  assert.equal(market.plugins[0].source, './');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) assert.match(hooks.hooks[ev][0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/omino\/scripts\/omino\.mjs" hook /);
});

test('A14 linking decisions to the project does not flag the intent', () => {
  const dir = tmp();
  cmdInit(dir);
  cmdRecord(dir, 'start', 'user', { view: false });
  for (const id of ['d-a', 'd-b']) write(dir, `decisions/${id}.md`, note({ id, kind: 'decision', title: id, date: '2026-11-17', source: 'user', affects: '[project]' }, '## Now\nx'));
  const r = cmdRecord(dir, 'two project-wide decisions', 'user', { view: false });
  assert.deepEqual(r.flagged, []);
  assert.equal(loadPlan(dir).notes.get('project').fm.review, undefined);
});

test('A15 the session hook starts the page service; the brief and record link to the plan there; the login item is offered once', async () => {
  const { ensureService, cmdServiceStop, runHook: hook, serviceInfo: info } = await import('../skills/omino/scripts/omino.mjs');
  const dir = gitRepo();
  buildRound(dir, 3);
  const id = path.basename(omRoot(dir));
  delete process.env.OMINO_NO_SERVE;
  process.env.OMINO_PORT = '0';
  try {
    const out = hook('session-start', { session_id: 'x', cwd: dir }).stdout;
    const svc = info();
    assert.ok(svc, 'started in the background');
    assert.ok(out.includes(`Plan page: ${svc.url}/p/${id}`), out);
    assert.match(out, /start when they log in[\s\S]*omino service install/);
    assert.ok(!/start when they log in/.test(hook('session-start', { session_id: 'y', cwd: dir }).stdout), 'asked once per machine');
    assert.equal(ensureService().pid, svc.pid, 'reused');
    fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nmore\n');
    const rec = cmdRecord(dir, 'touch', 'agent');
    assert.equal(rec.links[0].url, `${svc.url}/p/${id}#project`);
    const page = await req(svc.port, 'GET', `/p/${id}`);
    assert.equal(page.status, 200);
  } finally {
    process.env.OMINO_NO_SERVE = '1';
    delete process.env.OMINO_PORT;
    await cmdServiceStop();
  }
  assert.equal(info(), null);
});

test('A15 a service from an older Omino is replaced; a newer one is left running', async () => {
  const { ensureService, serviceInfo: info } = await import('../skills/omino/scripts/omino.mjs');
  const { spawn } = await import('node:child_process');
  const f = path.join(process.env.OMINO_HOME, 'server.json');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(f, JSON.stringify({ port: 1, token: 'x', pid: sleeper.pid, version: '999.0.0' }));
    delete process.env.OMINO_NO_SERVE;
    assert.equal(ensureService({ wait: 50 }).version, '999.0.0', 'newer: kept');
    fs.writeFileSync(f, JSON.stringify({ port: 1, token: 'x', pid: sleeper.pid, version: '0.0.1' }));
    process.env.OMINO_PORT = '0';
    const svc = ensureService({ wait: 4000 });
    assert.ok(svc && svc.pid !== sleeper.pid && svc.version !== '0.0.1', 'older: replaced');
    process.kill(svc.pid, 'SIGTERM');
  } finally {
    process.env.OMINO_NO_SERVE = '1'; delete process.env.OMINO_PORT;
    try { sleeper.kill(); } catch {}
    for (let i = 0; i < 80 && info(); i++) await new Promise((r) => setTimeout(r, 25));
    try { fs.rmSync(f); } catch {}
  }
});

test('A15 record points out finished items whose requirements just changed', () => {
  const dir = tmp();
  buildRound(dir, 7);
  const done = [...loadPlan(dir).notes.values()].find((n) => n.kind === 'work' && n.fm.status === 'done' && n.fm.basis);
  const f = path.join(omRoot(dir), done.file);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## Requirements', '## Requirements\n- One more rule.'));
  const r = cmdRecord(dir, 'tighten', 'user', { view: false });
  assert.deepEqual(r.recheck, [done.id]);
  cmdRecord(dir, 'tests pass', 'tool', { view: false, confirm: [done.id] });
  assert.ok(!cmdReview(dir).items.some((i) => i.type === 'drift' && i.id === done.id));
});

test('A15 check warns when the intent turns into a progress log', () => {
  const dir = tmp();
  cmdInit(dir);
  fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\n## Sources\n\n2026-11-17：drafted from README.\n');
  assert.ok(!cmdCheck(dir).warnings.some((w) => w.progress), 'dated lines under Sources are fine');
  fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\n## Progress\n\n2026-11-18：fixed the send stall; 3532 tests pass.\n');
  assert.ok(cmdCheck(dir).warnings.some((w) => w.progress));
});

// ---------------------------------------------------------------- A16: v0.5 — one plan per project, outside the working tree

const gsh = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
const repoAt = (remote) => {
  const dir = tmp();
  gsh(dir, 'init', '-q', '-b', 'main');
  if (remote) gsh(dir, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  gsh(dir, 'add', '.'); gsh(dir, 'commit', '-qm', 'init');
  return dir;
};

test('A16 every worktree and every clone of a repository share one plan outside the working tree', () => {
  const dir = repoAt('git@github.com:acme/Todo-App.git');
  const r = cmdInit(dir);
  assert.equal(r.id, 'acme-todo-app');
  assert.equal(r.created, path.join(process.env.OMINO_HOME, 'projects', 'acme-todo-app'));
  assert.equal(gsh(dir, 'status', '--porcelain').stdout, '', 'by default the link stays on this machine: nothing is added to the repository');
  const wt = path.join(tmp(), 'feature');  // made before .omino.json is committed: the git binding finds the plan
  gsh(dir, 'worktree', 'add', '-q', '-b', 'feature', wt);
  assert.equal(omRoot(wt), r.created, 'a linked worktree resolves to the same plan');
  fs.mkdirSync(path.join(wt, 'src'));
  const run = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });
  assert.equal(run(path.join(wt, 'src'), 'where').stdout.trim(), r.created, 'found from a subfolder of the worktree');
  const clone = tmp();
  gsh(clone, 'clone', '-q', dir, '.'); gsh(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/todo-app');
  const c = cmdInit(clone);
  assert.equal(c.attached, r.created, 'another clone attaches instead of starting over');
  assert.throws(() => cmdInit(dir), /already has a plan/);
});

test('A16 a folder outside git gets .omino.json; ids never collide', () => {
  const a = path.join(tmp(), 'notes'), b = path.join(tmp(), 'notes');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const ra = cmdInit(a), rb = cmdInit(b);
  assert.notEqual(ra.id, rb.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b, '.omino.json'), 'utf8')).project, rb.id);
});

test('A16 the plan folder keeps its own history, one commit per record', () => {
  delete process.env.OMINO_NO_HISTORY;
  try {
    const dir = repoAt();
    cmdInit(dir);
    fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nmore\n');
    cmdRecord(dir, 'Say more', 'user');
    const log = gsh(omRoot(dir), 'log', '--format=%s').stdout.trim().split('\n');
    assert.deepEqual(log, ['Say more', 'Start the plan']);
    assert.equal(gsh(dir, 'log', '--format=%s').stdout.trim(), 'init', 'the project history is untouched');
  } finally { process.env.OMINO_NO_HISTORY = '1'; }
});

test('A16 migrate moves a plan kept in .omino/; until then commands say so', () => {
  const dir = repoAt('https://github.com/acme/old-plan.git');
  const old = path.join(dir, '.omino');
  fs.mkdirSync(path.join(old, 'work'), { recursive: true });
  fs.writeFileSync(path.join(old, 'project.md'), '---\nid: project\nkind: intent\ntitle: Old\n---\n');
  fs.writeFileSync(path.join(old, 'changes.jsonl'), '');
  fs.writeFileSync(path.join(old, 'state.json'), '{"version":1,"notes":{}}\n');
  fs.writeFileSync(path.join(old, '.serve.json'), '{}');
  assert.throws(() => loadPlan(dir), /omino setup/);
  assert.throws(() => cmdInit(dir), /omino migrate/);
  const r = spawnSync(process.execPath, [CLI, 'migrate', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.id, 'acme-old-plan');
  assert.equal(loadPlan(dir).notes.get('project').fm.title, 'Old');
  assert.ok(!fs.existsSync(path.join(m.root, '.serve.json')), 'machine state is not carried over');
});

test('A16 allow lets Claude Code and Codex write to the plan folder, once', async () => {
  const { cmdAllow, allowStatus, ominoHome } = await import('../skills/omino/scripts/omino.mjs');
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'x', permissions: { allow: ['Bagsh(ls)'] } }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/data"]\n\n[other]\na = 1\n');
  assert.deepEqual(allowStatus({ home }).map((a) => a.allowed), [false, false]);
  cmdAllow({ home });
  const cs = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(cs.permissions, { allow: ['Bagsh(ls)'], additionalDirectories: [ominoHome()] });
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, new RegExp(`writable_roots = \\["/data", ${JSON.stringify(ominoHome()).replace(/[\\/]/g, '\\$&')}\\]`));
  assert.match(toml, /\[other\]\na = 1/);
  assert.ok(cmdAllow({ home }).done.every((d) => !d.changed), 'running it again changes nothing');
  assert.deepEqual(allowStatus({ home }).map((a) => a.allowed), [true, true]);
  const fresh = tmp();
  fs.mkdirSync(path.join(fresh, '.codex'));
  cmdAllow({ home: fresh, agent: 'codex' });
  assert.equal(fs.readFileSync(path.join(fresh, '.codex', 'config.toml'), 'utf8'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(ominoHome())}]\n`);
});

test('A17 a plan knows its repositories; a clone with another remote is told, not silently shared', async () => {
  const { identity, cmdLink, cmdProjects, normRemote } = await import('../skills/omino/scripts/omino.mjs');
  assert.equal(normRemote('git@github.com:Acme/App.git'), 'github.com/acme/app');
  assert.equal(normRemote('https://tok@github.com/acme/app/'), 'github.com/acme/app');
  assert.equal(normRemote('ssh://git@host:2222/acme/app.git'), 'host:2222/acme/app');
  const a = repoAt('git@github.com:acme/shop.git');
  cmdInit(a);
  assert.deepEqual(identity(a).repos, ['github.com/acme/shop']);
  // a fork whose committed .omino.json still names the original plan
  const fork = repoAt('https://github.com/someone/shop.git');
  fs.writeFileSync(path.join(fork, '.omino.json'), JSON.stringify({ project: 'acme-shop' }));
  assert.equal(identity(fork).mismatch, true);
  assert.match(spawnSync(process.execPath, [CLI, 'brief'], { cwd: fork, encoding: 'utf8' }).stdout, /Check with the user before changing this plan: plan "acme-shop" was made for github\.com\/acme\/shop/);
  const j = JSON.parse(spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd: fork, encoding: 'utf8' }).stdout);
  assert.deepEqual(j.project, { id: 'acme-shop', via: 'config', root: identity(a).root, mismatch: true }, 'every JSON answer names its plan');
  // the user says it is the same project: link it, and both repositories belong to the plan
  cmdLink(fork, 'acme-shop');
  assert.equal(identity(fork).mismatch, false);
  assert.deepEqual(identity(a).repos, ['github.com/acme/shop', 'github.com/someone/shop']);
  // a second repository joins the same plan (one plan, two repos)
  const service = repoAt('git@github.com:acme/shop-service.git');
  const r = cmdLink(service, 'acme-shop');
  assert.equal(r.previous, null);
  assert.equal(omRoot(service), omRoot(a));
  assert.throws(() => cmdLink(service, 'nope'), /no plan "nope"/);
  const list = cmdProjects(service).projects.find((p) => p.id === 'acme-shop');
  assert.ok(list.current && list.folders.length === 3, JSON.stringify(list));
  fs.writeFileSync(path.join(service, '.omino.json'), '{"project": "Bad Name"}');
  assert.throws(() => loadPlan(service), /must be a plan id/, 'a broken link fails loudly instead of guessing');
});

test('A17 monorepo: the nearest .omino.json wins', () => {
  const dir = repoAt('git@github.com:acme/mono.git');
  cmdInit(dir);
  const web = path.join(dir, 'apps', 'web');
  fs.mkdirSync(web, { recursive: true });
  cmdInit(web);
  const where = (cwd) => spawnSync(process.execPath, [CLI, 'where'], { cwd, encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(web, 'src'));
  assert.notEqual(where(path.join(web, 'src')), where(dir));
  assert.equal(where(path.join(dir, 'apps')), where(dir));
});

test('A17 migrate after the in-repo plan was already removed restores it from git history', () => {
  const dir = repoAt('git@github.com:acme/pulled.git');
  fs.mkdirSync(path.join(dir, '.omino', 'work'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.omino', 'project.md'), '---\nid: project\nkind: intent\ntitle: Kept\n---\n');
  fs.writeFileSync(path.join(dir, '.omino', 'work', 'a.md'), '---\nid: a\nkind: work\ntitle: A\nstatus: planned\n---\n');
  fs.writeFileSync(path.join(dir, '.omino', 'changes.jsonl'), '');
  fs.writeFileSync(path.join(dir, '.omino', 'state.json'), '{"version":1,"notes":{}}\n');
  gsh(dir, 'add', '.'); gsh(dir, 'commit', '-qm', 'plan');
  gsh(dir, 'rm', '-rq', '.omino'); fs.writeFileSync(path.join(dir, '.omino.json'), '{"project": "acme-pulled"}\n');
  gsh(dir, 'add', '.'); gsh(dir, 'commit', '-qm', 'move the plan out');
  assert.throws(() => loadPlan(dir), /omino setup/);
  const out = spawnSync(process.execPath, [CLI, 'hook', 'session-start'], { cwd: dir, input: JSON.stringify({ cwd: dir }), encoding: 'utf8' }).stdout;
  assert.match(out, /move the plan from git history/);
  const r = spawnSync(process.execPath, [CLI, 'migrate'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restored from commit/);
  const plan = loadPlan(dir);
  assert.equal(plan.notes.get('project').fm.title, 'Kept');
  assert.ok(plan.notes.has('a'));
});

test('A18 setup does the whole upgrade in one approved step, and the session brief asks for it', async () => {
  const { setupSteps, cmdSetup, VERSION } = await import('../skills/omino/scripts/omino.mjs');
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.codex', 'skills', 'omino', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'skills', 'omino', 'scripts', 'omino.mjs'), "export const VERSION = '0.4.1';\n");
  const dir = repoAt('git@github.com:acme/legacy.git');
  fs.mkdirSync(path.join(dir, '.omino'));
  fs.writeFileSync(path.join(dir, '.omino', 'project.md'), '---\nid: project\nkind: intent\ntitle: Legacy\n---\n');
  fs.writeFileSync(path.join(dir, '.omino', 'changes.jsonl'), '');
  fs.writeFileSync(path.join(dir, '.omino', 'state.json'), '{"version":1,"notes":{}}\n');
  assert.deepEqual(setupSteps(dir, { home }).map((x) => x.step), ['update-skill', 'migrate', 'hooks', 'hooks', 'allow', 'allow']);
  const hook = spawnSync(process.execPath, [CLI, 'hook', 'session-start'], { cwd: dir, input: '{}', encoding: 'utf8', env: { ...process.env, HOME: home } }).stdout;
  assert.match(hook, /one-time setup[\s\S]*move the plan in \.omino\/[\s\S]*run "omino setup" yourself/);
  assert.deepEqual(cmdSetup(dir, { home, dryRun: true }).done, [], 'dry run changes nothing');
  assert.ok(fs.existsSync(path.join(dir, '.omino', 'project.md')) && !fs.existsSync(path.join(dir, '.omino.json')));
  cmdSetup(dir, { home });
  assert.equal(loadPlan(dir).notes.get('project').fm.title, 'Legacy');
  assert.match(fs.readFileSync(path.join(home, '.codex', 'skills', 'omino', 'scripts', 'omino.mjs'), 'utf8'), new RegExp(`VERSION = '${VERSION}'`));
  assert.ok(fs.existsSync(path.join(home, '.codex', 'skills', 'omino', 'SKILL.md')));
  assert.deepEqual(setupSteps(dir, { home }), [], 'nothing left to do');
});

test('A19 the same hooks serve Claude Code and Codex; setup adds them where missing, and brief asks for it', async () => {
  const { cmdHooksInstall, hooksStatus, setupSteps, cmdSetup, cmdBrief, runHook } = await import('../skills/omino/scripts/omino.mjs');
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex')); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const dir = repoAt('git@github.com:acme/hooks.git');
  cmdInit(dir);
  assert.deepEqual(setupSteps(dir, { home }).filter((x) => x.step === 'hooks').map((x) => x.agent), ['claude', 'codex']);
  cmdSetup(dir, { home });
  const codex = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(codex.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(codex.hooks.Stop[0].hooks[0].command, 'echo mine', 'other hooks are kept');
  assert.match(codex.hooks.SessionStart[0].hooks[0].command, /^PATH="\$PATH:\/opt\/homebrew\/bin:\/usr\/local\/bin" node ".*omino\.mjs" hook session-start$/);
  const hs = hooksStatus(dir, { home });
  assert.equal(hs.agents.codex.hooks[0].scope, 'user');
  assert.equal(hs.agents.claude.hooks[0].scope, 'user');
  assert.equal(setupSteps(dir, { home }).filter((x) => x.step === 'hooks').length, 0, 'nothing left');
  cmdHooksInstall(dir, { agent: 'codex', scope: 'user', home });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8')).hooks.SessionStart.length, 1, 'installing again does not duplicate');
  // the Codex hook payload works the same way: a session-start brief, and Stop stays silent when nothing needs saying
  const env = process.env.HOME; process.env.HOME = home;
  try {
    assert.match(runHook('session-start', { session_id: 'c1', cwd: dir, hook_event_name: 'SessionStart', source: 'startup', model: 'gpt' }).stdout, /^Omino plan:/);
    assert.equal(runHook('stop', { session_id: 'c1', cwd: dir, stop_hook_active: false }).stdout, undefined);
  } finally { process.env.HOME = env; }
  // an agent without hooks that follows AGENTS.md runs brief, and brief carries the setup request
  const bare = tmp();
  fs.mkdirSync(path.join(bare, '.codex'));
  const env2 = process.env.HOME; process.env.HOME = bare;
  try { assert.match(cmdBrief(dir).text, /one-time setup[\s\S]*add Omino's hooks to Codex[\s\S]*approve them once with \/hooks/); }
  finally { process.env.HOME = env2; }
});

test('A19 the Codex plugin manifest matches the Claude Code one', () => {
  const root = path.join(path.dirname(CLI), '..', '..', '..');
  const cx = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const cc = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(cx.name, 'omino'); assert.equal(cx.version, cc.version); assert.equal(cx.skills, './skills/');
  assert.ok(!('hooks' in cx), 'Codex loads hooks/hooks.json by default; the field is rejected by some validators');
  assert.match(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'), /CLAUDE_PLUGIN_ROOT/, 'Codex sets CLAUDE_PLUGIN_ROOT for plugin hooks too');
});

test('A20 --share writes .omino.json; --name names the plan after what it is for', () => {
  const dir = repoAt('git@github.com:acme/billing-service.git');
  const r = cmdInit(dir, { name: 'invoice-export' });
  assert.equal(r.id, 'invoice-export');
  assert.equal(gsh(dir, 'status', '--porcelain').stdout, '');
  assert.throws(() => cmdInit(repoAt(), { name: 'Invoice export!' }), /--name must be an id/);
  const own = repoAt('git@github.com:me/tool.git');
  cmdInit(own, { share: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(own, '.omino.json'), 'utf8')), { project: 'me-tool' });
});

test('A20 lanes stand for repositories: the brief names this folder\'s lane, the page shows each lane\'s repository', async () => {
  const { cmdLane, cmdLink, cmdBrief, buildModel } = await import('../skills/omino/scripts/omino.mjs');
  const app = repoAt('git@github.com:acme/shop.git');
  cmdInit(app, { name: 'shop' });
  const svc = repoAt('git@github.com:acme/shop-api.git');
  cmdLink(svc, 'shop');
  assert.match(cmdBrief(svc).text, /no lane yet: ask the user once which lane it is \(suggest "shop-api"\)/);
  cmdLane(svc, '官方服务');
  cmdLane(app, 'App');
  assert.match(cmdBrief(svc).text, /This folder is the "官方服务" lane/);
  assert.deepEqual(cmdLane(app).lane, 'App');
  assert.deepEqual(buildModel(app).laneRepos, { '官方服务': ['shop-api'], App: ['shop'] });
  cmdLane(svc, '');
  assert.equal(cmdLane(svc).lane, null);
});

test('A20 a workspace folder holding several repositories can carry the plan for all of them', () => {
  const ws = path.join(tmp(), 'shop-workspace');
  fs.mkdirSync(ws);
  cmdInit(ws, { name: 'shop-ws' });
  const inner = path.join(ws, 'service');
  fs.mkdirSync(inner);
  gsh(inner, 'init', '-q');
  fs.mkdirSync(path.join(inner, 'src'));
  const where = spawnSync(process.execPath, [CLI, 'where'], { cwd: path.join(inner, 'src'), encoding: 'utf8' }).stdout.trim();
  assert.equal(where, omRoot(ws));
  // a repository with its own plan keeps it
  const own = path.join(ws, 'app'); fs.mkdirSync(own); gsh(own, 'init', '-q');
  cmdInit(own, { name: 'app-only' });
  assert.equal(spawnSync(process.execPath, [CLI, 'where'], { cwd: own, encoding: 'utf8' }).stdout.trim(), omRoot(own));
});

test('A20 a finished plan is closed: read-only, and the next piece of work in the folder gets its own plan', async () => {
  const { cmdClose, cmdBrief, cmdProjects } = await import('../skills/omino/scripts/omino.mjs');
  const dir = repoAt('git@github.com:acme/pipeline.git');
  cmdInit(dir, { name: 'invoice-export' });
  fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nInvoice export.\n');
  cmdRecord(dir, 'goal', 'user');
  cmdClose(dir);
  assert.match(cmdBrief(dir).text, /This plan is closed/);
  fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\nmore\n');
  assert.throws(() => cmdRecord(dir, 'x', 'user'), /is closed/);
  assert.throws(() => cmdInit(dir), /give the new plan a name/);
  const r = cmdInit(dir, { name: 'cost-report' });
  assert.equal(r.id, 'cost-report');
  assert.equal(path.basename(omRoot(dir)), 'cost-report');
  const ps = cmdProjects(dir).projects;
  assert.equal(ps.find((p) => p.id === 'invoice-export').status, 'closed');
  assert.ok(ps.find((p) => p.id === 'cost-report').current);
  cmdClose(dir); cmdClose(dir, { reopen: true });
  assert.ok(!/closed/.test(cmdBrief(dir).text.split('\n')[1] || ''));
});

test('A20 the overview page lists every plan with its goal, progress and repositories', async () => {
  const { cmdOverview } = await import('../skills/omino/scripts/omino.mjs');
  const dir = repoAt('git@github.com:acme/overview.git');
  cmdInit(dir, { name: 'overview-demo' });
  fs.writeFileSync(path.join(omRoot(dir), 'project.md'), '---\nid: project\nkind: intent\ntitle: 概览演示\n---\n\n## Purpose\n让人一眼看到所有计划。\n');
  cmdRecord(dir, 'goal', 'user');
  const out = path.join(tmp(), 'index.html');
  const r = cmdOverview(dir, { out });
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(r.plans >= 1);
  assert.match(html, /概览演示/);
  assert.match(html, /让人一眼看到所有计划/);
  assert.match(html, /acme\/overview/);
  assert.match(html, /"href":"file:\/\/[^"]*overview-demo\/view\.html"/);
  assert.match(html, /"goal":"让人一眼看到所有计划。"/);
  assert.match(html, /class="brand"/, 'the same top bar as the plan pages');
});

test('A21 one writer at a time: parallel records queue, a crashed writer\'s lock is taken over, a busy plan says so', async () => {
  const { withLock } = await import('../skills/omino/scripts/omino.mjs');
  delete process.env.OMINO_NO_HISTORY;
  try {
    const dir = repoAt('git@github.com:acme/busy.git');
    cmdInit(dir, { name: 'busy-plan' });
    const root = omRoot(dir);
    // two processes record different notes at the same moment
    for (const id of ['a', 'b']) fs.writeFileSync(path.join(root, 'ideas', `${id}.md`), `---\nid: ${id}\nkind: idea\ntitle: ${id}\nidea_state: open\nrecall: manual later\nrecall_state: waiting\n---\n\n## Idea\n${id}\n`);
    const { spawn } = await import('node:child_process');
    const run = () => new Promise((resolve) => { const c = spawn(process.execPath, [CLI, 'record', 'parallel', '--source', 'user'], { cwd: dir, env: process.env }); let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => resolve({ code, err })); });
    const rs = await Promise.all([run(), run()]);
    assert.deepEqual(rs.map((r) => r.code), [0, 0], rs.map((r) => r.err).join('\n'));
    assert.ok(!fs.existsSync(path.join(root, '.lock')), 'the lock is released');
    assert.equal(gsh(root, 'status', '--porcelain').stdout, '', 'the plan history is clean');
    assert.equal(readChanges(loadPlan(dir)).filter((c) => c.summary === 'parallel').length, 1, 'the second writer found nothing left to record');
    // a lock left by a process that is gone
    fs.mkdirSync(path.join(root, '.lock'));
    fs.writeFileSync(path.join(root, '.lock', 'owner'), JSON.stringify({ pid: 2147483646, at: Date.now() }));
    assert.equal(withLock(root, () => 'ran'), 'ran');
    // a lock held by a live process: wait, then give up with a clear message
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    fs.mkdirSync(path.join(root, '.lock'));
    fs.writeFileSync(path.join(root, '.lock', 'owner'), JSON.stringify({ pid: holder.pid, at: Date.now() }));
    try { assert.throws(() => withLock(root, () => 'never', { timeoutMs: 300 }), /the plan is busy/); }
    finally { holder.kill(); fs.rmSync(path.join(root, '.lock'), { recursive: true, force: true }); }
  } finally { process.env.OMINO_NO_HISTORY = '1'; }
});

test('A22 install puts the skill where each agent looks, updates old copies, and uninstall removes them', async () => {
  const { cmdInstall, VERSION } = await import('../skills/omino/scripts/omino.mjs');
  const home = tmp();
  for (const d of ['.claude', '.codex', '.gemini', '.kimi-code']) fs.mkdirSync(path.join(home, d));
  fs.mkdirSync(path.join(home, '.codex', 'skills', 'omino', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'skills', 'omino', 'SKILL.md'), 'old');
  fs.writeFileSync(path.join(home, '.codex', 'skills', 'omino', 'scripts', 'omino.mjs'), "export const VERSION = '0.4.1';\n");
  const dry = cmdInstall({ home, dryRun: true });
  assert.ok(!fs.existsSync(path.join(home, '.agents')), 'a dry run writes nothing');
  assert.deepEqual(dry.agents.map((a) => a.agent), ['Claude Code', 'Codex', 'Gemini CLI', 'Kimi Code CLI']);
  const r = cmdInstall({ home });
  const shared = r.done.find((d) => d.path === path.join(home, '.agents', 'skills', 'omino'));
  assert.deepEqual(shared.for.sort(), ['Codex', 'Gemini CLI', 'Kimi Code CLI', 'other agents that read ~/.agents/skills'].sort());
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'omino', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(home, '.codex', 'skills', 'omino', 'scripts', 'omino.mjs'), 'utf8'), new RegExp(`VERSION = '${VERSION}'`), 'old copy updated');
  // with the Claude Code plugin installed, no extra copy for Claude Code
  const h2 = tmp(); fs.mkdirSync(path.join(h2, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(h2, '.claude', 'plugins', 'installed_plugins.json'), '{"plugins":{"omino@maktub-ai":{}}}');
  const r2 = cmdInstall({ home: h2 });
  assert.equal(r2.agents[0].skip, 'the Omino plugin brings the skill');
  assert.ok(!fs.existsSync(path.join(h2, '.claude', 'skills', 'omino')));
  // each command becomes its own skill next to the copy: /omino-plan in Claude Code, $omino-plan in Codex
  for (const base of ['.claude', '.agents']) for (const c of ['plan', 'next', 'ghost', 'lock', 'hold', 'clear']) {
    const t = fs.readFileSync(path.join(home, base, 'skills', `omino-${c}`, 'SKILL.md'), 'utf8');
    assert.match(t, new RegExp(`^---\\nname: omino-${c}\\n`)); assert.match(t, /disable-model-invocation: true/);
    assert.doesNotMatch(t, /the Omino `\w+` command/, 'the command is named as the user types it');
  }
  assert.match(fs.readFileSync(path.join(home, '.agents', 'skills', 'omino-hold', 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  // a skill of the user's own with the same name is left alone
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'omino-next', 'SKILL.md'), 'mine');
  cmdInstall({ home });
  assert.equal(fs.readFileSync(path.join(home, '.agents', 'skills', 'omino-next', 'SKILL.md'), 'utf8'), 'mine');
  const u = cmdInstall({ home, remove: true });
  assert.equal(u.done.filter((d) => !/omino-\w+$/.test(d.path)).length, 3);
  assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'omino')));
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'omino-plan')), 'uninstall removes the command skills');
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'omino-next')), 'but not a skill of the user\'s own');
});

test('A22 the six commands exist once and the Claude Code plugin reads them there', async () => {
  const { COMMANDS } = await import('../skills/omino/scripts/omino.mjs');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(COMMANDS, ['plan', 'next', 'ghost', 'lock', 'hold', 'clear']);
  for (const c of COMMANDS) {
    const t = fs.readFileSync(path.join(root, 'skills', 'omino', 'commands', `${c}.md`), 'utf8');
    assert.match(t, /^---\ndescription: .+\n/); assert.match(t, /\$ARGUMENTS/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).commands, './skills/omino/commands/');
});

test('A22 the page lists the other plans to switch to; the overview gathers what waits for the user across plans', async () => {
  const { cmdOverview, buildModel } = await import('../skills/omino/scripts/omino.mjs');
  const a = repoAt('git@github.com:acme/alpha.git'); cmdInit(a, { name: 'alpha' });
  fs.writeFileSync(path.join(omRoot(a), 'project.md'), '---\nid: project\nkind: intent\ntitle: Alpha\nreview: Drafted by an agent\n---\n\n## Purpose\nA.\n');
  cmdRecord(a, 'goal', 'agent'); cmdView(a);
  const b = repoAt('git@github.com:acme/beta.git'); cmdInit(b, { name: 'beta' });
  cmdRecord(b, 'start', 'user');
  const m = buildModel(b);
  const alpha = m.plans.find((p) => p.id === 'alpha');
  assert.ok(alpha && alpha.title === 'Alpha' && /view\.html$/.test(alpha.view));
  assert.ok(!m.plans.some((p) => p.id === 'beta'), 'not the current plan');
  const out = path.join(tmp(), 'index.html');
  cmdOverview(b, { out });
  const html = fs.readFileSync(out, 'utf8');
  const data = JSON.parse(html.match(/var DATA = (\{.*?\});\n/)[1]);
  const al = data.plans.find((p) => p.id === 'alpha');
  assert.deepEqual(al.waiting.map((w) => [w.type, w.title]), [['flagged', 'Alpha']], 'what waits for the user, in the plan\'s card');
  const srv = await startService({ port: 0 });
  try {
    const ok = await req(srv.port, 'GET', '/p/alpha');
    assert.equal(ok.status, 200); assert.match(ok.body, /Alpha/);
    assert.equal((await req(srv.port, 'GET', '/p/nope')).status, 404);
  } finally { srv.close(); await srv.closed; }
});

test('A23 Gemini CLI and Kimi Code CLI: hooks go where each reads them and answer in its own shape', () => {
  process.env.OMINO_NO_SERVE = '1';
  const home = tmp(), dir = gitRepo();
  buildRound(dir, 3);
  fs.mkdirSync(path.join(home, '.gemini')); fs.mkdirSync(path.join(home, '.kimi-code'));
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'x' }));
  fs.writeFileSync(path.join(home, '.kimi-code', 'config.toml'), 'model = "k2"\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo mine"\n');
  const g = cmdHooksInstall(dir, { scope: 'user', agent: 'gemini', home, script: '/x/omino.mjs' });
  const gs = JSON.parse(fs.readFileSync(g.file, 'utf8'));
  assert.equal(gs.theme, 'x');
  assert.deepEqual(Object.keys(gs.hooks).sort(), ['AfterAgent', 'BeforeAgent', 'SessionEnd', 'SessionStart']);
  assert.match(gs.hooks.BeforeAgent[0].hooks[0].command, /hook prompt --agent gemini$/);
  assert.equal(gs.hooks.BeforeAgent[0].hooks[0].timeout, 10000);
  cmdHooksInstall(dir, { scope: 'user', agent: 'kimi', home, script: '/x/omino.mjs' });
  cmdHooksInstall(dir, { scope: 'user', agent: 'kimi', home, script: '/x/omino.mjs' });
  const kt = fs.readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf8');
  assert.equal((kt.match(/omino\.mjs\\" hook/g) || []).length, 4, 'installed once, not twice');
  assert.match(kt, /model = "k2"/); assert.match(kt, /echo mine/);
  assert.ok(!/matcher|name =/.test(kt.split('echo mine')[1]), 'only the fields Kimi accepts');
  const st = hooksStatus(dir, { home }).agents;
  assert.equal(st.gemini.hooks.length, 1); assert.equal(st.kimi.hooks[0].events.length, 4);
  cmdHooksInstall(dir, { scope: 'user', agent: 'kimi', home, remove: true });
  const kr = fs.readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf8');
  assert.ok(!/omino/.test(kr) && /echo mine/.test(kr));
  // Gemini: JSON only on stdout
  const gss = runHook('session-start', { session_id: 'g', cwd: dir }, { agent: 'gemini' });
  assert.match(JSON.parse(gss.stdout).hookSpecificOutput.additionalContext, /^Omino plan:/);
  assert.match(JSON.parse(runHook('prompt', { session_id: 'g', cwd: dir }, { agent: 'gemini' }).stdout).hookSpecificOutput.additionalContext, /register it in the plan/);
  assert.deepEqual(JSON.parse(runHook('prompt', { session_id: 'g', cwd: dir }, { agent: 'gemini' }).stdout), {}, 'once a session');
  fs.writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 30 }, (_, i) => 'l' + i).join('\n'));
  assert.equal(JSON.parse(runHook('stop', { session_id: 'g', cwd: dir }, { agent: 'gemini' }).stdout).decision, 'block');
  // Kimi: the brief rides along with the first message; a reminder is exit 2 with the reason on stderr
  assert.deepEqual(runHook('session-start', { session_id: 'k', cwd: dir }, { agent: 'kimi' }), {});
  assert.match(runHook('prompt', { session_id: 'k', cwd: dir }, { agent: 'kimi' }).stdout, /^Omino plan:/);
  assert.deepEqual(runHook('prompt', { session_id: 'k', cwd: dir }, { agent: 'kimi' }), {}, 'only once');
  fs.writeFileSync(path.join(dir, 'big2.txt'), 'new\n');
  const ks = runHook('stop', { session_id: 'k', cwd: dir }, { agent: 'kimi' });
  assert.equal(ks.exitCode, 2); assert.match(ks.stderr, /plan/);
});

test('A24 summary.json beside view.html tells other apps where the plan stands without running Omino', async () => {
  const { SUMMARY } = await import('../skills/omino/scripts/omino.mjs');
  const dir = gitRepo(); buildRound(dir, 3); cmdView(dir);
  const s = JSON.parse(fs.readFileSync(path.join(omRoot(dir), SUMMARY), 'utf8'));
  assert.equal(s.format, 'omino-summary'); assert.equal(s.version, 1);
  assert.ok(s.title && s.work.total >= s.work.done && Array.isArray(s.waiting));
  assert.equal(s.view, 'view.html'); assert.equal(s.comments, 0);
  assert.match(fs.readFileSync(path.join(omRoot(dir), '.gitignore'), 'utf8'), /summary\.json/);
});

test('A25 setup offers hooks only for the agent in use: Codex users are not asked about Gemini or Kimi', async () => {
  const { setupSteps, currentAgent } = await import('../skills/omino/scripts/omino.mjs');
  assert.equal(currentAgent({ CODEX_THREAD_ID: 'x' }), 'codex');
  assert.equal(currentAgent({ CLAUDECODE: '1' }), 'claude');
  assert.equal(currentAgent({ GEMINI_CLI: '1' }), 'gemini');
  assert.equal(currentAgent({}), null);
  const home = tmp(), dir = gitRepo(); buildRound(dir, 1);
  for (const d of ['.claude', '.codex', '.gemini', '.kimi-code']) fs.mkdirSync(path.join(home, d));
  const hooksFor = (agent) => setupSteps(dir, { home, agent }).filter((x) => x.step === 'hooks').map((x) => x.agent);
  assert.deepEqual(hooksFor('codex'), ['codex']);
  assert.deepEqual(hooksFor('kimi'), ['kimi']);
  assert.deepEqual(hooksFor(null), ['claude', 'codex'], 'unknown agent: only the two that share one hook file format, never Gemini or Kimi unasked');
  assert.ok(!setupSteps(dir, { home, agent: 'codex' }).some((x) => x.step === 'allow' && x.agent === 'claude'));
});

test('A26 view.html on disk is read-only; it looks for the page service and links the plan\'s page there', async () => {
  const dir = gitRepo(); buildRound(dir, 1);
  cmdView(dir);
  const html = fs.readFileSync(path.join(omRoot(dir), 'view.html'), 'utf8');
  assert.ok(html.includes('"probe":{"port":4870}'), 'the default port when no service runs');
  assert.ok(!html.includes('"service":'), 'no token on disk');
  assert.ok(html.includes(`"id":"${path.basename(omRoot(dir))}"`));
  const srv = await startService({ port: 0 });
  try {
    cmdView(dir);
    assert.ok(fs.readFileSync(path.join(omRoot(dir), 'view.html'), 'utf8').includes(`"probe":{"port":${srv.port}}`), 'the running service\'s port');
    const hello = await req(srv.port, 'GET', '/api/hello', null, { origin: 'null' });
    assert.equal(hello.status, 200); assert.equal(JSON.parse(hello.body).omino, true);
  } finally { srv.close(); await srv.closed; }
});

test('A27 no plan: silent, until a turn changes the project substantially; then the agent asks the user once, never again', () => {
  const dir = gitRepo();
  const run = (ev, sid = 'n') => runHook(ev, { session_id: sid, cwd: dir, prompt: 'build the feature' });
  assert.deepEqual(runHook('session-start', { session_id: 'n', cwd: dir }), {}, 'nothing at the start');
  run('prompt'); fs.writeFileSync(path.join(dir, 'app.txt'), 'small\n');
  assert.deepEqual(run('stop'), {}, 'a small change: nothing');
  run('prompt'); fs.writeFileSync(path.join(dir, 'feature.js'), Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'));
  const r = JSON.parse(run('stop').stdout);
  assert.equal(r.decision, 'block'); assert.match(r.reason, /has no plan/); assert.match(r.reason, /will not ask again/);
  run('prompt', 'm'); fs.writeFileSync(path.join(dir, 'more.js'), Array.from({ length: 40 }, (_, i) => 'x' + i).join('\n'));
  assert.deepEqual(run('stop', 'm'), {}, 'asked once for this project, never again');
});

test('A28 on the service every plan is a page, even one no folder on this machine uses; every page links to the overview', async () => {
  const a = repoAt('git@github.com:acme/alpha.git'); cmdInit(a, { name: 'alpha' }); cmdView(a);
  const b = repoAt('git@github.com:acme/beta.git'); cmdInit(b, { name: 'beta' }); cmdView(b);
  assert.ok(fs.existsSync(path.join(process.env.OMINO_HOME, 'index.html')), 'view keeps the overview page there to link to');
  fs.rmSync(b, { recursive: true, force: true });
  const srv = await startService({ port: 0 });
  try {
    const beta = await req(srv.port, 'GET', '/p/beta');
    assert.equal(beta.status, 200, 'its folder is gone; the plan folder stands in');
    assert.ok(beta.body.includes(`"service":{"token":"${srv.token}","id":"beta"}`));
    const ov = await req(srv.port, 'GET', '/');
    assert.equal(ov.status, 200); assert.ok(ov.body.includes('"href":"/p/beta"') && ov.body.includes('"href":"/p/alpha"'));
    assert.ok(beta.body.includes('class="brand" href="') || /overviewHref/.test(beta.body), 'the logo leads back to the overview');
    // the page records changes made there without a project folder: no git context, no folder noted
    const tok = { 'x-omino-token': srv.token };
    assert.equal((await req(srv.port, 'POST', '/api/plans/beta/notes/project/comment', { text: 'still here' }, tok)).status, 200);
    const root = path.join(process.env.OMINO_HOME, 'projects', 'beta');
    const last = JSON.parse(fs.readFileSync(path.join(root, 'changes.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(last.via, 'page'); assert.equal(last.git, undefined);
    assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, '.paths.json'), 'utf8'))).includes(root), 'the plan folder is not noted as a folder using it');
  } finally { srv.close(); await srv.closed; }
});

test('DSH delivers the shared plan on the first human prompt and handles page replies and disposal', async () => {
  const { apply } = await import('../skills/omino/scripts/dsh.mjs');
  const dir = tmp();
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  assert.equal(spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline', '--allow-empty']).status, 0);
  cmdInit(dir, { name: 'dsh-lifecycle' });
  const previous = process.env.OMINO_NO_SERVE;
  process.env.OMINO_NO_SERVE = '1';
  const events = new Map();
  apply({ on: (event, listener) => events.set(event, listener) });
  const steered = [];
  const agent = { session: { header: { id: 'dsh-root', cwd: dir } }, steer: (message) => steered.push(message) };
  const human = { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the work requested for this project.' }] };
  const step = (messages, target = agent) => events.get('agent/pre-step')(
    { agent: target, messages }, async () => ({ kind: 'enter', messages }));
  const state = () => JSON.parse(fs.readFileSync(path.join(omRoot(dir), '.hooks.json'), 'utf8')).sessions;
  try {
    assert.equal((await step([human], { session: { header: { id: 'child', cwd: dir, parentSession: 'dsh-root' } } })).messages.length, 1);
    assert.equal((await step([])).messages.length, 0);
    const first = await step([human]);
    assert.match(first.messages[0].content[0].text, /Omino plan:[\s\S]*register it in the plan/);
    assert.equal(first.messages[0].source.kind, 'omino');
    assert.equal(first.messages[1], human);
    assert.deepEqual((await step([human])).messages, [human]);
    fs.appendFileSync(path.join(omRoot(dir), 'project.md'), '\n## Comments\n\n> [!omino] A plan comment\n> Keep DSH support.\n');
    assert.match((await step([human])).messages[0].content[0].text, /Keep DSH support/);
    fs.writeFileSync(path.join(dir, 'changed.txt'), 'an added file');
    events.get('agent/turn-stopping')({ agent });
    events.get('agent/turn-stopping')({ agent });
    assert.equal(steered.length, 1);
    assert.match(steered[0].content[0].text, /the plan was not recorded/);
    assert.ok(state()['dsh-root']);
    events.get('agent/disposed')({ agent });
    assert.equal(state()['dsh-root'], undefined);
  } finally {
    if (previous === undefined) delete process.env.OMINO_NO_SERVE;
    else process.env.OMINO_NO_SERVE = previous;
  }
});
