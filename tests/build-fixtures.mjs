// Materialize the sample plans as plain plan folders, the way they look in ~/.omino/projects/<id>/:
// tests/fixtures/todo/r1 … r7 (each round of the seven-turn scenario) and examples/ (with a ready view.html).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.OMINO_NO_GIT = '1';     // samples must not depend on this repository's own git state
process.env.OMINO_NO_HISTORY = '1';
process.env.OMINO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'omino-samples-'));
const { omRoot, cmdView } = await import('../skills/omino/scripts/omino.mjs');
const { buildRound, buildExtended } = await import('./scenario.mjs');
const { buildExampleEn } = await import('./example-en.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const MACHINE = new Set(['.gitignore', '.git', 'inbox.jsonl', '.serve.json', '.hooks.json', '.paths.json', '.lock', 'summary.json', '.live.json']);
/** Build a plan in a scratch project folder, then copy its plan folder (without per-machine files) to out. */
function materialize(out, build, { view = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'omino-sample-'));
  build(project);
  if (view) cmdView(project);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(omRoot(project), out, { recursive: true, filter: (src) => !MACHINE.has(path.basename(src)) || src === omRoot(project) });
  if (!view) fs.rmSync(path.join(out, 'view.html'), { force: true });
  // the page should not point at the scratch folder it was built in
  else { const f = path.join(out, 'view.html'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"projectUrl":"file:[^"]*"/, '"projectUrl":""').replace(/,"probe":\{[^}]*\}/, '')); }
}

const base = path.join(here, 'fixtures', 'todo');
for (let r = 1; r <= 7; r++) materialize(path.join(base, `r${r}`), (d) => buildRound(d, r));
console.log(`Wrote ${base}/r1 … r7`);
for (const [name, build] of [['todo-app', buildExtended], ['todo-app-en', buildExampleEn]]) {
  const out = path.join(here, '..', 'examples', name);
  materialize(out, build, { view: true });
  console.log(`Wrote ${out} (open view.html)`);
}
