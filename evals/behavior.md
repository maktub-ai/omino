# Behaviour evaluation

The CLI is covered by automated tests (`npm test`). Whether an agent *uses* the plan well depends on the model, so it is checked by hand with the scenarios below.

## How to run

1. Install the skill in the agent you are testing (for Claude Code: copy `skills/omino` to `.claude/skills/omino` in an empty test project).
2. Play each scenario as the user, one message per turn, in a fresh session.
3. After each turn, compare `.omino/` and the reply against the expectations. `git diff` on a committed `.omino/` makes this quick.
4. Note the agent, model, date and result in the table at the end.

## A. The seven turns

Use the seven user messages in `skills/omino/references/examples.md`. Expected files after each turn: `tests/fixtures/todo/r1 … r7` (wording may differ; fields, relations and statuses should match).

| Turn | Must happen | Must not happen |
|---|---|---|
| 1 | `project.md` with purpose; one record | any stage or work note |
| 2 | s1 with three planned items; boundary "local" | `requires` between items |
| 3 | idea with `recall: stage s1 closed` | idea placed in a stage |
| 4 | no file change, no record | a note about accounts |
| 5 | filter in s1, `before: [del]`; reply lists the changed notes with links | `requires` on delete; a new stage; asking "shall I record this?" |
| 6 | four `done/user`, s1 closed; reminder raised as a question; `recall_state: fired` | reminder adopted or started; stage 2 created |
| 7 | s2 + category; reminder `deferred`, `recall_state: stopped` | reminder deleted; reminder raised again |

## B. Counter-examples

Start each from the state after turn 5 (`tests/fixtures/todo/r5`).

| # | User says | Must happen | Must not happen |
|---|---|---|---|
| B1 | "Maybe tags would be nice someday?" | ask whether to keep it as an idea, or answer only | creating a work item |
| B2 | "Actually, forget the filter." | filter `status: dropped` (or removed with the user's agreement), reason recorded | silently deleting history |
| B3 | "I finished adding todos." (no mention of checking) | `status: done, source: user` | `verified` |
| B4 | "Let's add cloud sync to stage 1." | point out the conflict with the "local only" boundary and ask; if the user insists, add it with a `review` note or update the boundary as they decide | adding sync silently |
| B5 | "Is delete hard to build? Also, put 'mark done' after 'add'." | answer the question; record `before: [done]` on add | `requires`; changes about delete |

## C. Adopting an existing project

Use any real repository that has a README and some history (or a copy of this one). Start a fresh session with no `.omino/`.

| # | User says | Must happen | Must not happen |
|---|---|---|---|
| C1 | "Let's start tracking this project's plan." | `init --adopt`; drafted `project.md` keeps a one-reason `review` line; contradictions between docs as bullets under `Open questions`; a prose summary in `stages/s0.md`; the reply lists the added files, opens the view and asks each open question | work items for past features; any stage other than s0; reading more than ~6 documents; creating `.omino/` without telling the user |
| C2 | "Looks right, but we're not targeting mobile." | boundary updated, `review` line removed, recorded with `--source user` | the draft left flagged |
| C3 | "There's a TODO.md, bring those in." | each item as an idea (`idea_state: open`, no stage) | items placed into stages or given a status |
| C4 | "Next we should do X." (a new requirement) | X arranged as the user says (a new stage only if asked) | X recorded as done or tied to past work without the user saying so |

## D. Changing direction

Start from `examples/todo-app` (Chinese) or `examples/todo-app-en`.

| # | User says | Must happen | Must not happen |
|---|---|---|---|
| D1 | "Let's not do archiving; hiding finished todos is enough." | a decision note superseding the archive item, with Before / Now / Why / Given up; the item stays and shows as superseded; reply lists both with links | deleting the archive note; no decision recorded |
| D2 (new session) | "Should we add bulk move after all?" | the agent points to the decision that replaced it and asks whether to reverse it | proposing bulk move as if it were new |
| D3 | "Change of plan: sync first, then categories." | a decision; untouched in-progress category work flagged for review and named in the reply | silently reordering stages |

## Results

| Date | Agent / model | A (7/7) | B (5/5) | C (4/4) | D (3/3) | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
