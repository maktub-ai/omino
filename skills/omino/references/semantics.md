# Semantics

What each concept means, and where the lines are.

## Intent, arrangement, progress

These are lenses, not message types. One turn can change all three or none.

| Lens | Lives in | Changes when |
|---|---|---|
| Intent | `project.md`; the `Why` of each note | The user states a purpose, principle or boundary |
| Arrangement | `stage`, `lane`, `order`, `before`, `requires`, `ideas/` | The user decides scope, stage, order, or parks something |
| Progress | `status` + `source`, the `Progress` section | Something actually happened |

## Decisions vs. discussion

Write only what the user decided. Signals of a decision: imperative or committed phrasing ("add…", "do X first", "this goes in stage 1", "let's not do Y"). Signals of discussion: questions, "maybe", "what if", "is it usual to…", comparisons. Mixed turns are common: record the decision, leave the discussion in the conversation.

When unsure, ask one short question instead of writing.

## Stages (`level`)

A stage is a step of advancement the user chose. It is not a date, an effort estimate, a priority or a status. Stages may hold very different numbers of items. Items can sit in the same stage and still have an order (`before`) or a dependency (`requires`).

- A new requirement goes into the current stage unless the user says otherwise.
- A stage is `closed` only when the user says so (or confirms your summary).
- Closing a stage never opens the next one.

## Decisions

A decision records a change of direction: what was planned before, what is planned now, why, and what was given up. It is the plan's memory of *why we no longer do it that way*. Superseded notes are kept and shown as superseded, never deleted. Items in `affects` that were already under way and were not changed alongside the decision are flagged for review, because a change of direction may invalidate work in progress; items changed in the same step were re-arranged on purpose and are left alone.

## Provenance

Every history entry can be traced three ways: `said` (the user's words, readable by anyone), `git` (branch, commit, worktree — where the work was), and `session` (the conversation id, useful only to whoever has that conversation). None replaces the others. An entry with `via: page` was made by the user on the plan's page: an edit or a confirmation of their own, or a comment that asks the agent to do something.

## Adopted projects

When Omino joins a project that already has history, the plan starts at that moment. `init --adopt` creates a closed level-0 stage, "Before Omino", whose prose summarizes what already exists. Past features are not turned into completed work items: nobody recorded their requirements, so the completion would be a claim with nothing to check it against. The drafted `project.md` carries a `review` line until the user confirms it, because it was inferred from documents rather than said by the user.

## The four relations

| Relation | Field | Blocks? | Example |
|---|---|---|---|
| Belonging | `stage`, `parent` | No | "filter" belongs to stage 1 |
| Prerequisite | `requires` | Yes | "category filter" requires "category field" |
| Preferred order | `before` | No | "filter" before "delete", because the user wants it |
| Context | `refs` | No | "category" refers to the project boundary |

Never let one stand in for another. The user saying "do A first" is a preferred order. A technical need is a prerequisite only when it is known to be one.

Parallel work: two items without `requires` *may* be parallelizable; nobody has checked. Say "no dependency recorded", never "independent" or "can run in parallel", unless that was verified.

## Progress and sources

| Status | Meaning |
|---|---|
| `planned` | Arranged, not started |
| `doing` | Someone is working on it |
| `done` | Reported finished |
| `verified` | A tool confirmed it (tests passed, check ran) — requires `source: tool` |
| `dropped` | Decided against; kept for history |

| Source | Meaning |
|---|---|
| `user` | The user said it in conversation |
| `agent` | An agent reported it about its own work |
| `tool` | A command produced the evidence |
| `file` | Someone edited the files directly (recorded by `check --fix`) |

"Waiting" and "needs review" are derived, never stored as status.

## Recall

An idea with a `recall` condition is a promise to bring it back, not a promise to do it.

- `waiting`: the condition is not met, or met but not yet raised.
- `fired`: raised with the user. It shows under "needs your decision" until the user decides.
- `stopped`: the agreement is over (the user deferred, dropped or adopted the idea). It is never raised again by this condition.

If the user later wants to be reminded again, write a new condition and set `recall_state: waiting`.

`manual <text>` conditions cannot be evaluated by the CLI. When one seems met, ask the user; say it was not checked automatically.

## Re-checking conclusions

Each completed work item stores a `basis`: a fingerprint of its own `Requirements` and of its prerequisites' `Requirements` at the moment it was recorded as done. When either changes, `review` reports "basis changed". This is a prompt to look, not proof that the work is wrong.

Semantic conflicts the fingerprint cannot see (a new stage contradicting the project boundary, a downstream need that changes what "done" means) are flagged by writing `review: <reason>` on the note.

Nothing is reset automatically. The old completion stays in the record; the user decides whether it still holds (`record --confirm <id>`) or the work reopens (`status: doing`).
