// English sample plan for the README (fictional): a personal Todo App, some weeks in.
import path from 'node:path';
import fs from 'node:fs';
import { cmdInit, cmdRecord, cmdRecall, setField, omRoot } from '../skills/omino/scripts/omino.mjs';
import { note, write } from './scenario.mjs';

export function buildExampleEn(dir) {
  fs.mkdirSync(dir, { recursive: true });
  cmdInit(dir);
  const W = (id, title, stage, lane, order, extra, sections) =>
    write(dir, `work/${id}.md`, note({ id, kind: 'work', title, stage, lane, order, status: 'planned', ...extra }, sections));
  const set = (id, fields) => { for (const [k, v] of Object.entries(fields)) setField(path.join(omRoot(dir), 'work', `${id}.md`), k, v); };

  write(dir, 'project.md', note({ id: 'project', kind: 'intent', title: 'Personal Todo App' }, {
    Purpose: 'A todo app for myself, to write down what I need to do each day and check it off.',
    Principles: 'Enough is enough. Nothing gets added just because "apps like this usually have it".',
    Boundaries: 'Personal use, local first: data stays on this machine. No accounts, no sync.'
  }));
  write(dir, 'stages/s1.md', note({ id: 's1', kind: 'stage', title: 'Local basics', level: 1, status: 'active' }, {
    Scope: 'Add, complete, filter and delete todos.',
    Arrangement: 'The user wants the filter before delete. That is a preference, not a dependency.'
  }));
  W('add', 'Add a todo', 's1', 'Capture', 1, {}, { Why: 'Write a task down in one line.', Requirements: '- One line of text creates a todo.' });
  W('done', 'Mark as done', 's1', 'Capture', 2, {}, { Why: 'Check off what is finished.', Requirements: '- A todo can be marked done and undone.' });
  W('del', 'Delete a todo', 's1', 'Capture', 3, {}, { Why: 'Remove what is no longer needed.', Requirements: '- A single todo can be deleted.' });
  W('filter', 'Show open only', 's1', 'Viewing', 1, { before: ['del'] }, { Why: 'See only what is left for today.', Requirements: '- The list can show open todos only.', Arrangement: '"Do this first," said the user: before delete, same stage.' });
  write(dir, 'ideas/remind.md', note({ id: 'remind', kind: 'idea', title: 'Due-date reminders', idea_state: 'open', recall: 'stage s1 closed', recall_state: 'waiting' }, {
    Idea: 'Remind me when a todo is due.', Recall: '"Remind me to think about it once the basics are done." Raising it is not adopting it.'
  }));
  cmdRecord(dir, 'Set intent and stage 1: local basics', 'user', { ts: '2026-11-03T09:00:00Z' });

  for (const id of ['add', 'done', 'del', 'filter']) set(id, { status: 'done', source: 'user' });
  setField(path.join(omRoot(dir), 'stages', 's1.md'), 'status', 'closed');
  setField(path.join(omRoot(dir), 'stages', 's1.md'), 'source', 'user');
  cmdRecord(dir, 'Stage 1 finished (reported by the user)', 'user', { ts: '2026-11-08T17:30:00Z' });
  cmdRecall(dir, { markFired: ['remind'] });
  cmdRecord(dir, 'Raised "due-date reminders" for discussion', 'agent', { ts: '2026-11-08T17:31:00Z' });
  setField(path.join(omRoot(dir), 'ideas', 'remind.md'), 'idea_state', 'deferred');
  cmdRecall(dir, { stop: ['remind'] });

  write(dir, 'stages/s2.md', note({ id: 's2', kind: 'stage', title: 'Categories', level: 2, status: 'active' }, {
    Scope: 'Separate work and personal todos, then make the list easier to tidy.',
    Arrangement: 'Most items wait for the category field. Items without a line between them have no recorded dependency; nobody has checked they can run in parallel.'
  }));
  W('cat-field', 'Category field', 's2', 'Data', 1, {}, { Why: 'Every category feature needs it.', Requirements: '- Todos have a category, default "personal".' });
  W('migrate', 'Migrate old todos', 's2', 'Data', 2, { requires: ['cat-field'] }, { Why: 'Existing todos need a category.', Requirements: '- All existing todos become "personal".' });
  W('export', 'Export JSON', 's2', 'Data', 3, {}, { Why: 'Get all todos out as one file.', Requirements: '- Export every todo with its category.' });
  W('category', 'Work / personal switch', 's2', 'Viewing', 1, { requires: ['cat-field'] }, { Why: 'Keep work and life apart.', Requirements: '- A switch at the top of the list.' });
  W('cat-filter', 'Filter by category', 's2', 'Viewing', 2, { requires: ['category', 'filter'] }, { Why: 'Only see one category.', Requirements: '- Works together with "show open only".' });
  W('archive', 'Archive finished', 's2', 'Viewing', 3, {}, { Why: 'Keep the list short.', Requirements: '- Archived todos are hidden by default.' });
  W('add-cat', 'Pick category on add', 's2', 'Capture', 1, { requires: ['cat-field'], before: ['move'] }, { Why: 'Choose the category while writing.', Requirements: '- New todos can pick a category.' });
  W('move', 'Move in bulk', 's2', 'Capture', 2, {}, { Why: 'Recategorize several todos at once.', Requirements: '- Multi-select and move.' });
  write(dir, 'ideas/nl.md', note({ id: 'nl', kind: 'idea', title: 'Natural-language add', idea_state: 'open', recall: 'stage s2 closed', recall_state: 'waiting' }, { Idea: '"Call mum tomorrow at 3pm" becomes a todo with a date.' }));
  write(dir, 'ideas/theme.md', note({ id: 'theme', kind: 'idea', title: 'Dark theme', idea_state: 'open' }, { Idea: 'Parked, no condition.' }));
  cmdRecord(dir, 'Reminders deferred; stage 2: categories', 'user', { ts: '2026-11-09T10:00:00Z' });

  set('cat-field', { status: 'verified', source: 'tool' });
  cmdRecord(dir, 'Category field: unit tests pass', 'tool', { ts: '2026-11-12T14:20:00Z' });
  set('migrate', { status: 'done', source: 'agent' });
  set('category', { status: 'doing', source: 'agent' });
  set('add-cat', { status: 'doing', source: 'agent' });
  cmdRecord(dir, 'Agent: migration done; switch and picker in progress', 'agent', { ts: '2026-11-12T16:05:00Z' });

  const fp = path.join(omRoot(dir), 'work', 'filter.md');
  fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace('- The list can show open todos only.', '- The list can show open todos only.\n- It can be combined with a category filter.'));
  write(dir, 'stages/s3.md', note({ id: 's3', kind: 'stage', title: 'Sync', level: 3, status: 'planned', review: 'Conflicts with the "local first, no sync" boundary; the user needs to decide' }, {
    Scope: 'Sync todos between devices.', Conflict: 'Kept, flagged, not pursued until the user decides.', 'Open questions': '- Change the boundary to allow sync between my own devices, or drop sync?'
  }));
  write(dir, 'work/sync.md', note({ id: 'sync', kind: 'work', title: 'Multi-device sync', stage: 's3', lane: 'Data', order: 1, status: 'planned', requires: ['export'] }, { Why: 'Same todos on phone and laptop.', Requirements: '- Changes on two devices merge.' }));
  write(dir, 'decisions/d-cat-first.md', note({ id: 'd-cat-first', kind: 'decision', title: 'Categories first, reminders wait', date: '2026-11-09', source: 'user', affects: ['remind'] }, {
    Before: 'Revisit due-date reminders once the basics are done.', Now: 'Stage 2 is categories; reminders stay deferred.', Why: 'Separating work and personal todos matters more right now.', 'Given up': 'No reminders this stage; the idea is kept but no longer recalled.'
  }));
  write(dir, 'decisions/d-drag.md', note({ id: 'd-drag', kind: 'decision', title: 'Drag instead of bulk move', date: '2026-11-14', source: 'user', supersedes: ['move'] }, {
    Before: 'Multi-select todos and move them to another category.', Now: 'Drag a todo onto the category switch.', Why: 'Multi-select felt heavy; usually only one or two todos move at a time.'
  }));
  cmdRecord(dir, 'Stage 3 sync added and flagged; filter requirements extended; two direction decisions', 'user', { ts: '2026-11-14T09:00:00Z', said: 'Drop bulk move, dragging is enough. And add a sync stage.' });
}
