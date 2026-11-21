// The Todo App seven-round scenario from HANDOFF.md, replayed as file edits + omino commands.
// buildRound(dir, n) leaves dir/.omino exactly as it should look after round n.

import fs from 'node:fs';
import path from 'node:path';
import { cmdInit, cmdRecord, cmdRecall, setField, omRoot } from '../skills/omino/scripts/omino.mjs';

export function note(fm, sections) {
  const head = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
    .join('\n');
  const body = Object.entries(sections).map(([h, t]) => `## ${h}\n\n${t}\n`).join('\n');
  return `---\n${head}\n---\n\n${body}`;
}

export function write(dir, rel, text) {
  const p = path.join(omRoot(dir), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const T = (r) => `2026-11-1${r}T09:00:00Z`;

const project = (r) => note({ id: 'project', kind: 'intent', title: '个人 Todo App' }, {
  Purpose: '做一个自己用的 Todo App，把每天要做的事情记下来。使用者只有自己：重要的是事情有处可记、做完能划掉。',
  Principles: '够用就好，不因为“这类 App 通常有”就预先补功能。',
  Boundaries: r < 2
    ? '目前只确认了“个人使用”。账号、同步、提醒都还没有讨论。'
    : '个人使用，先做本地版：数据留在本机，不涉及账号和同步。'
});

const s1 = (r) => note({ id: 's1', kind: 'stage', title: '本地基础版', level: 1, status: r >= 6 ? 'closed' : 'active', source: r >= 6 ? 'user' : undefined }, {
  Scope: r < 5
    ? '添加待办、标记完成、删除待办。用户的原话是“……就行”，范围以够用为界。'
    : '添加待办、标记完成、只看未完成、删除待办。筛选在第 5 轮加入，用户说“都算第一阶段”，阶段没有拆分。',
  Arrangement: r < 5
    ? '按用户列举的顺序记录，列举顺序不代表执行前置。没有记录前置条件，不等于已确认可以安全并行。'
    : '用户要求筛选先做、删除放后面：这是安排先后，不是“删除依赖筛选”。其余各项能否并行尚未核验。',
  ...(r >= 6 ? { Progress: '用户报告四项都已做好并检查过，基础版结束。依据是用户反馈，没有工具验证记录。阶段结束不自动进入下一阶段。' } : {})
});

const work = (id, title, lane, order, why, req, r) => note({
  id, kind: 'work', title, stage: 's1', lane, order,
  status: r >= 6 ? 'done' : 'planned', source: r >= 6 ? 'user' : undefined
}, {
  Why: why,
  Requirements: req,
  ...(r >= 6 ? { Progress: '用户在第 6 轮报告已做好并检查过。' } : {})
});

const items = (r) => {
  const del = { arrangement: '用户要求删除放在筛选之后。这只是先后安排，删除本身不需要筛选。' };
  return {
    add: work('add', '添加待办', '记录待办', 1, '能把一件要做的事快速写下来。', '- 输入一句话即可新增一条待办。', r),
    done: work('done', '标记完成', '记录待办', 2, '做完的事可以划掉，和还没做的区分开。', '- 可以把待办标记为完成，也可以取消标记。', r),
    del: note({ id: 'del', kind: 'work', title: '删除待办', stage: 's1', lane: '记录待办', order: 3, status: r >= 6 ? 'done' : 'planned', source: r >= 6 ? 'user' : undefined }, {
      Why: '去掉不再需要的待办。',
      Requirements: '- 可以删除单条待办。',
      ...(r >= 5 ? { Arrangement: del.arrangement } : {}),
      ...(r >= 6 ? { Progress: '用户在第 6 轮报告已做好并检查过。' } : {})
    })
  };
};

const filter = (r) => note({ id: 'filter', kind: 'work', title: '只看未完成', stage: 's1', lane: '查看与整理', order: 1, status: r >= 6 ? 'done' : 'planned', source: r >= 6 ? 'user' : undefined, before: ['del'] }, {
  Why: '只看还没做完的待办，让当天剩下的事一目了然。',
  Requirements: '- 列表可以切换为只显示未完成的待办。',
  Arrangement: '用户说“这个先做”，在第一阶段内排在删除之前。',
  ...(r >= 6 ? { Progress: '用户在第 6 轮报告已做好并检查过。' } : {})
});

const remind = (r) => note({
  id: 'remind', kind: 'idea', title: '到期提醒',
  idea_state: r >= 7 ? 'deferred' : 'open', recall: 'stage s1 closed', recall_state: 'waiting'
}, {
  Idea: '以后可以给待办加到期提醒。',
  Recall: '用户说“基础版做好后提醒我考虑一下”。第一阶段结束时带回讨论。召回不等于采纳，也没有执行承诺。',
  ...(r >= 7 ? { Decision: '第 7 轮用户决定“提醒先不做”：继续保留、暂缓。旧约定已履行并停止，不再自动提醒。' } : {})
});

export const ROUNDS = [
  null,
  { user: '我想做一个自己用的 Todo App，把每天要做的事情记下来。' },
  { user: '先做本地版，能添加待办、标记完成、删除待办就行。' },
  { user: '以后可以加到期提醒，基础版做好后提醒我考虑一下。' },
  { user: '这种 App 是不是都应该有账号？' },
  { user: '再加一个只看未完成待办的筛选。这个先做，删除功能放后面，都算第一阶段。' },
  { user: '添加、完成、筛选、删除都做好并检查过了，基础版可以结束了。' },
  { user: '提醒先不做。第二阶段先加分类，我想把工作和生活的待办分开。' }
];

/** Apply round r on top of round r-1. Returns what the agent would have reported. */
export function applyRound(dir, r) {
  const out = {};
  if (r === 1) {
    cmdInit(dir);
    write(dir, 'project.md', project(1));
    out.record = cmdRecord(dir, '建立项目意图：个人使用的 Todo App', 'user', { ts: T(1), said: ROUNDS[1].user });
  }
  if (r === 2) {
    write(dir, 'project.md', project(2));
    write(dir, 'stages/s1.md', s1(2));
    for (const [id, text] of Object.entries(items(2))) write(dir, `work/${id}.md`, text);
    out.record = cmdRecord(dir, '第一阶段·本地基础版：添加、完成、删除；补充“本地”边界', 'user', { ts: T(2), said: ROUNDS[2].user });
  }
  if (r === 3) {
    write(dir, 'ideas/remind.md', remind(3));
    out.record = cmdRecord(dir, '暂存“到期提醒”，约定第一阶段结束后召回', 'user', { ts: T(3), said: ROUNDS[3].user });
  }
  if (r === 4) {
    // A question, not a decision: nothing is written.
    out.record = cmdRecord(dir, '讨论账号（不应产生记录）', 'user', { ts: T(4), said: ROUNDS[4].user });
  }
  if (r === 5) {
    write(dir, 'stages/s1.md', s1(5));
    write(dir, 'work/filter.md', filter(5));
    write(dir, 'work/del.md', items(5).del);
    out.record = cmdRecord(dir, '加入“只看未完成”，安排在删除之前；仍是第一阶段', 'user', { ts: T(5), said: ROUNDS[5].user });
  }
  if (r === 6) {
    write(dir, 'stages/s1.md', s1(6));
    for (const [id, text] of Object.entries(items(6))) write(dir, `work/${id}.md`, text);
    write(dir, 'work/filter.md', filter(6));
    out.record = cmdRecord(dir, '四项完成（用户报告），第一阶段结束', 'user', { ts: T(6), said: ROUNDS[6].user });
    out.recall = cmdRecall(dir);
    cmdRecall(dir, { markFired: out.recall.due.map((d) => d.id) });
    out.fired = cmdRecord(dir, '召回“到期提醒”，请用户决定', 'agent', { ts: '2026-11-16T09:01:00Z' });
  }
  if (r === 7) {
    write(dir, 'ideas/remind.md', remind(7));
    cmdRecall(dir, { stop: ['remind'] });
    write(dir, 'stages/s2.md', note({ id: 's2', kind: 'stage', title: '分类', level: 2, status: 'active' }, {
      Scope: '第二阶段先加分类，把工作和生活的待办分开。由用户在第 7 轮主动开启，不是第一阶段结束后自动进入。'
    }));
    write(dir, 'work/category.md', note({ id: 'category', kind: 'work', title: '工作／生活分类', stage: 's2', lane: '查看与整理', order: 1, status: 'planned', refs: ['project'] }, {
      Why: '把工作和生活的待办分开。',
      Requirements: '- 每条待办属于“工作”或“生活”。\n- 列表可以按分类查看。',
      Open: '分类是固定两类还是可以自定义、已有待办归到哪一类，都还没有讨论。'
    }));
    out.record = cmdRecord(dir, '第二阶段先做工作／生活分类；提醒暂缓，召回停止', 'user', { ts: T(7), said: ROUNDS[7].user });
  }
  return out;
}

export function buildRound(dir, n) {
  fs.mkdirSync(dir, { recursive: true });
  let last;
  for (let r = 1; r <= n; r++) last = applyRound(dir, r);
  return last;
}

/** A later, richer state of the same project (fictional), used as the README example and for layout checks. */
export function buildExtended(dir) {
  buildRound(dir, 7);
  const w = (id, title, lane, order, status, source, extra, sections) =>
    write(dir, `work/${id}.md`, note({ id, kind: 'work', title, stage: extra.stage || 's2', lane, order, status, source, requires: extra.requires, before: extra.before, refs: extra.refs, review: extra.review }, sections));
  write(dir, 'stages/s2.md', note({ id: 's2', kind: 'stage', title: '分类与整理', level: 2, status: 'active' }, {
    Scope: '第二阶段从“工作／生活分类”扩展为分类与整理。多数工作都在等“分类字段”这个前置条件。',
    Arrangement: '同一阶段里有并行，也有先后。没有画线的两项只是没有记录依赖，不代表已确认可以安全并行。'
  }));
  w('category', '工作／生活分类', '查看与整理', 1, 'planned', undefined, { requires: ['cat-field'], refs: ['project'] }, { Why: '把工作和生活的待办分开。', Requirements: '- 每条待办属于“工作”或“生活”。\n- 列表顶部可以切换分类。' });
  w('cat-field', '分类字段', '数据与同步', 1, 'planned', undefined, {}, { Why: '分类功能都要先有数据模型里的分类字段。', Requirements: '- 待办数据增加分类字段，默认“生活”。', Progress: '单元测试通过（工具验证）。' });
  w('migrate', '旧数据迁移', '数据与同步', 2, 'planned', undefined, { requires: ['cat-field'] }, { Why: '已有的待办需要归入默认分类。', Requirements: '- 旧待办全部归入“生活”。', Progress: 'agent 报告已完成，尚未经用户确认或测试。' });
  w('export', '导出 JSON', '数据与同步', 3, 'planned', undefined, {}, { Why: '把全部待办导出成一个文件。', Requirements: '- 导出全部待办与分类。' });
  w('add-cat', '添加时选择分类', '记录待办', 1, 'planned', undefined, { requires: ['cat-field'], before: ['move'] }, { Why: '新建待办时直接选分类。', Requirements: '- 新建时可选分类，默认“生活”。' });
  w('move', '批量移动分类', '记录待办', 2, 'planned', undefined, {}, { Why: '一次把多条待办换到另一类。', Requirements: '- 多选后可以移动到另一个分类。', Arrangement: '用户希望在“添加时选择分类”之后再做：安排先后，不是执行前置。' });
  w('rename', '重命名分类', '记录待办', 3, 'planned', undefined, {}, { Why: '允许改分类的名称。', Requirements: '- 可以修改分类名称。' });
  w('cat-filter', '按分类筛选', '查看与整理', 2, 'planned', undefined, { requires: ['category', 'filter'] }, { Why: '只看某个分类下的待办。', Requirements: '- 可以按分类筛选列表，并与“只看未完成”同时使用。' });
  w('count', '分类计数', '查看与整理', 3, 'planned', undefined, {}, { Why: '每个分类显示还没做完的数量。', Requirements: '- 分类旁显示未完成数量。' });
  w('archive', '归档已完成', '查看与整理', 4, 'planned', undefined, {}, { Why: '把做完的事收起来，列表更清爽。', Requirements: '- 已完成的待办可以归档，归档后默认不显示。' });
  cmdRecord(dir, '第二阶段扩展为分类与整理', 'user', { ts: '2026-11-18T09:00:00Z' });
  const set = (id, fields) => { for (const [k, v] of Object.entries(fields)) setField(path.join(omRoot(dir), 'work', `${id}.md`), k, v); };
  set('cat-field', { status: 'verified', source: 'tool' });
  cmdRecord(dir, '分类字段的单元测试通过', 'tool', { ts: '2026-11-18T14:20:00Z' });
  set('migrate', { status: 'done', source: 'agent' });
  set('category', { status: 'doing', source: 'agent' });
  set('add-cat', { status: 'doing', source: 'agent' });
  cmdRecord(dir, 'agent 报告：旧数据迁移完成；分类切换与添加时选择分类进行中', 'agent', { ts: '2026-11-18T16:05:00Z' });
  // later: filter's requirements change because category filtering will reuse it
  const fp = path.join(omRoot(dir), 'work', 'filter.md');
  fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace('- 列表可以切换为只显示未完成的待办。', '- 列表可以切换为只显示未完成的待办。\n- 可以和“按分类筛选”同时使用。'));
  write(dir, 'stages/s3.md', note({ id: 's3', kind: 'stage', title: '同步', level: 3, status: 'planned', review: '与项目意图里“个人使用、本地版、不涉及同步”的边界冲突，需要用户决定保留还是取消' }, {
    Scope: '在多台设备之间同步待办。', Conflict: '这一阶段与项目边界冲突。安排保留，但标记为需要用户重新确认：既不静默删除，也不继续推进。'
  }));
  write(dir, 'work/sync.md', note({ id: 'sync', kind: 'work', title: '多端同步', stage: 's3', lane: '数据与同步', order: 1, status: 'planned', requires: ['export'] }, { Why: '在手机和电脑上看到同一份待办。', Requirements: '- 两台设备上的修改可以合并。' }));
  write(dir, 'ideas/nl.md', note({ id: 'nl', kind: 'idea', title: '自然语言添加', idea_state: 'open', recall: 'stage s2 closed', recall_state: 'waiting' }, { Idea: '用一句话添加待办，比如“明天下午三点给妈妈打电话”。', Recall: '第二阶段完成后再讨论。召回只是带回讨论，不等于采纳。' }));
  write(dir, 'ideas/theme.md', note({ id: 'theme', kind: 'idea', title: '深色主题', idea_state: 'open' }, { Idea: '没有召回条件的想法，只是保留着。' }));
  write(dir, 'decisions/d-cat-first.md', note({ id: 'd-cat-first', kind: 'decision', title: '先做分类，提醒暂缓', date: '2026-11-17', source: 'user', affects: ['remind'] }, {
    Before: '基础版完成后，约定重新考虑到期提醒。', Now: '第二阶段先做工作／生活分类，提醒继续暂缓。', Why: '用户更急于把工作和生活的待办分开。', 'Given up': '本阶段不做提醒；想法保留，不再按旧约定自动召回。'
  }));
  write(dir, 'decisions/d-drag.md', note({ id: 'd-drag', kind: 'decision', title: '用拖拽代替批量移动', date: '2026-11-19', source: 'user', supersedes: ['move'] }, {
    Before: '多选后批量移动到另一个分类。', Now: '直接把待办拖到分类切换栏上。', Why: '用户觉得多选太重，一次通常只移动一两条。'
  }));
  cmdRecord(dir, '新增第三阶段·同步（与边界冲突，已标记复核）；筛选的要求扩展；暂存两个想法；记录两项方向决定', 'user', { ts: '2026-11-19T09:00:00Z', said: '批量移动不要了，拖过去就行；另外加一个同步阶段' });
}
