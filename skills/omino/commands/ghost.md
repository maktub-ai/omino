---
description: Show where a new piece of work would go in the Omino plan before it is placed — stage, lane, what it depends on — as a draft for you to confirm.
argument-hint: "<the work, request or idea to place>"
---

The user asked to see where something would land, with the Omino `ghost` command. Follow the omino skill.

1. Run `omino find` with a few key words: if a note already covers it, propose changing or linking that note instead of adding one.
2. Propose a placement: the stage and lane, its `requires` (only real prerequisites) and any preferred order (`before`), and its Why and Requirements in the user's words. Point out any conflict with `project.md` or a recent decision.
3. Write it as a **draft**: the note with a `review` line ("placement proposed by the agent"), `source: agent`. Record with `--source agent --said "<their words>"` and show the placement in a few lines with the link.
4. Ask the user to confirm or adjust. Nothing starts until they do. When they confirm, remove the `review` line and record with `--source user --confirm <id>`.

What the user said with the command:
$ARGUMENTS
