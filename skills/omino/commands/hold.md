---
description: Park an idea in the Omino plan with a condition for bringing it back. No stage, no commitment.
argument-hint: "<the idea> [when to bring it back]"
---

The user asked to park an idea with the Omino `hold` command. Follow the omino skill.

1. Run `omino find` first: if the idea already exists, update it instead of adding a duplicate.
2. Write it to `ideas/` with `idea_state: open`, no stage, the user's words as Why, and a `recall` condition. Use the condition the user gave ("after saved cards ship", "in March"). If they gave none, ask once what should bring it back; if they don't say, leave it with no condition.
3. Link it to what it is about (`refs`). Record with `--source user --said "<their words>"` and confirm in one line, with the link and the recall condition.

It will come back once, when the condition holds, as a question — never adopted on its own.

What the user said with the command:
$ARGUMENTS
