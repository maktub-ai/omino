---
description: Start this project's Omino plan, or work on it as a whole — goal, stages, lanes, order.
argument-hint: "[what the plan is for, or what to arrange]"
---

The user asked for this explicitly with the Omino `plan` command. Follow the omino skill.

- If the project has no plan yet (`omino where` fails), this is the user's go-ahead to start one: `omino init` for a new project, or `omino init --adopt` if code or docs already exist, and follow "Starting a plan" in the skill. Write only what the user said; put your own suggestions under `## Open questions`.
- If it has one, start from `omino brief`, then work through what the user wants to arrange: stages, lanes, order, prerequisites. Ask about open questions or drafts awaiting confirmation once, briefly.

Record every change with the user's words (`--said`) and report it in a few lines with links.

What the user said with the command (may be empty):
$ARGUMENTS
