# Worked example: a personal Todo App in seven turns

A fictional project. Each turn shows what the user said, what the agent does with the plan, and what must **not** happen. The resulting `.omino/` after every turn is in the repository under `tests/fixtures/todo/r1 … r7`.

## Turn 1 — start

> I want to build a Todo App for myself, to write down what I need to do each day.

- `omino init`; write Purpose ("personal use, record daily tasks") in `project.md`.
- `omino record "Set project intent: personal Todo App" --source user`
- **Not:** adding accounts, sync or reminders; creating any stage.

## Turn 2 — first scope

> Start with a local version: add, mark done, delete. That's enough.

- Boundary in `project.md`: personal, local only.
- `stages/s1.md` (level 1, active); `work/add.md`, `work/done.md`, `work/del.md` in s1, all `planned`.
- `record --source user`.
- **Not:** `requires` between the three items because of the order they were listed in.

## Turn 3 — park an idea

> Later we could add due-date reminders. Remind me to think about it once the basic version is done.

- `ideas/remind.md`: `idea_state: open`, `recall: stage s1 closed`, `recall_state: waiting`.
- `record --source user`.
- **Not:** putting reminders in any stage.

## Turn 4 — a question

> Shouldn't apps like this always have accounts?

- Answer the question using the plan (personal, local: accounts are not needed).
- **Write nothing.** `record` would find no change, and that is correct.

## Turn 5 — add and reorder

> Add a filter to show only open items. Do that first, delete later. All of it is stage 1.

- `work/filter.md` in s1 with `before: [del]`; update the stage's scope and delete's Arrangement.
- `record "Add filter before delete" --source user --said "Add a filter… do that first, delete later."`
- Reply: "Plan updated: added *Show open only* to stage 1, before *Delete*." with the two links `record` printed. No confirmation question — the user decided it.
- **Not:** `requires: [filter]` on delete; a new stage; touching the reminder.

## Turn 6 — completion and recall

> Add, done, filter and delete are all built and checked. The basic version is finished.

- Four items `status: done, source: user`; s1 `status: closed, source: user`. `record --source user` (stamps each basis).
- `omino recall` → `remind` is due. Ask: "You wanted to revisit due-date reminders once the basic version was done — do you want them now?"
- `omino recall --mark-fired remind`; `record "Raised reminders for discussion" --source agent`.
- **Not:** adopting reminders, starting them, or opening stage 2.

## Turn 7 — new stage, keep deferring

> No reminders for now. Stage 2: add categories, I want to separate work and personal todos.

- `remind`: `idea_state: deferred`, add a Decision section; `omino recall --stop remind`.
- `stages/s2.md` (level 2, active); `work/category.md` in s2, `planned`.
- `record --source user`.
- **Not:** deleting the reminder or its history; raising it again later because stage 1 stays closed.
