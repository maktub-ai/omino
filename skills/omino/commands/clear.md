---
description: Wrap up a stage of the Omino plan — confirm what is done, go through what needs review, and close the stage.
argument-hint: "[the stage to clear; default: the active one]"
---

The user asked to clear a stage with the Omino `clear` command. Follow the omino skill.

1. Pick the stage: the one the user named, or the active one. Run `omino review` and read the stage's work items.
2. Show, in a few lines with links:
   - done and confirmed (by the user or a tool),
   - done only by the agent's word, waiting for the user's confirmation,
   - flagged for review (requirements changed), still open, or blocked.
3. Ask the user to confirm the agent-reported items and settle the flagged ones. Do not mark anything done or verified that the user or a tool did not confirm.
4. When nothing is left open, or the user says what to do with the rest (move it to another stage, park it as an idea, drop it with a decision), close the stage and record with `--source user --said "<their words>"`. Closing a stage does not start the next one: ask what comes next.
5. Then run `omino recall`: ideas waiting for this stage may be due.

What the user said with the command (may be empty):
$ARGUMENTS
