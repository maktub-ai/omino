# Changelog

## 1.0.0 — 2026-11-21

First public release.

- Six commands the user can type, named after falling-block moves: `/omino-plan`, `/omino-next`, `/omino-ghost`, `/omino-lock`, `/omino-hold`, `/omino-clear`. They live once in `skills/omino/commands/`; the Claude Code plugin offers them as `/omino:<name>`, and `omino install` writes each as its own skill (`/omino-<name>` in Claude Code, `$omino-<name>` in Codex) that never triggers on its own. `uninstall` removes them, and leaves a skill of the user's own with the same name alone.

## 0.6.0 — 2026-11-20

- One page service for every plan on the machine: `http://127.0.0.1:4870/p/<id>` (`OMINO_PORT`), with the overview at `/`. The session hook starts it and it keeps running; `omino service install` also starts it at login (launchd on macOS, XDG autostart on Linux, a Startup script on Windows), offered to the user once. A service from an older Omino is replaced by a newer one, never the other way round.
- Edit notes on the page: the note's Markdown, frontmatter included. Ids and kinds stay; an edit that would leave the plan invalid is refused; an edit made while the file changed underneath asks before overwriting. Saved edits are recorded at once as the user's (`via: page`), with only that note in the entry.
- Confirm on the page settles a draft, an agent-reported "done" or changed requirements right away, recorded as the user's.
- Answers, objections, decisions on ideas and remarks are comments: `> [!omino]` blocks under a note's `## Comments`. Hooks hand new comments and page edits to the agent with the next message; the brief, `review`, `check` and `summary.json` list waiting comments.
- Open pages refresh when the plan changes.
- `view.html` is read-only and links to the editable page when the service runs.
- The overview of all plans has the same look as the plan pages (top bar with the logo, light and dark, filters) and shows what waits for the user inside each plan's card. The logo on every plan page leads to it.
- Removed live mode: `live`, `poll`, `reply`, `inbox`, `stop`, `serve`, `/omino:live`, the per-plan servers (`.serve.json`, `.live.json`). Answers still waiting in a 0.5 `inbox.jsonl` become comments.
- `record` can record only some notes (`only`), so a page edit never attributes an agent's unrecorded edits to the user.

## 0.5.8 — 2026-11-20

- Fix: on a page served by one plan's server, switching to another plan and back did nothing (the way back was a file link, which an http page cannot open). Served pages now switch through the server, and the server's own plan opens its live page.
- "All plans" is always in the plan menu: `view` keeps `~/.omino/index.html` up to date, and served pages have `/overview`.

## 0.5.7 — 2026-11-20

- The prompt hook reminds the agent once a session to register a handed-over task in the plan (as in progress) before starting; no breakdown unless the user asks.
- A git project without a plan: after the first turn that changes it substantially, the stop hook has the agent ask the user once whether to keep a plan; never again for that project (`~/.omino/offered.json`).

## 0.5.6 — 2026-11-20

- When the user hands over a piece of work, the agent puts it in the plan (find or add its work item, mark it doing) before starting; the session brief says so too.

## 0.5.5 — 2026-11-20

- Codex lists the skill as "Omino Plan" (`skills/omino/agents/openai.yaml`), so typing /plan or $plan in its skill picker finds it.

## 0.5.4 — 2026-11-20

- One page: `view.html` on disk (or inside another app) finds the plan's running server on the plan's own port (`.live.json`) and sends answers there; without one it copies, and connects by itself when the agent starts listening. The server answers cross-origin requests that carry the token.

## 0.5.3 — 2026-11-19

- Hooks for Gemini CLI (`~/.gemini/settings.json`) and Kimi Code CLI (`~/.kimi-code/config.toml`): `hooks install --agent gemini|kimi`, and `setup` adds them when run in that agent. Answers are shaped per agent (Gemini: JSON only; Kimi: the brief arrives with the first message, a reminder is exit code 2).
- `summary.json` beside `view.html` (format `omino-summary`, version 1): the plan's title, active stage progress and what waits for the user, so other apps such as a Mandala tab can show it without running Omino.
- `setup` only offers hooks and permissions for the agent it runs in (detected from its environment, or `--agent`); a Codex user is no longer asked about Gemini or Kimi.
- Windows: hook commands no longer carry the POSIX `PATH=…` prefix there.
- `--dry-run` on a command that cannot preview is refused instead of doing the real thing; `migrate` keeps machine files out of the plan's history; the skill lists every command.

## 0.5.2 — 2026-11-19

- `omino install` / `uninstall` (`npx omino install`): puts the skill where each agent on the machine looks for skills — `~/.agents/skills` (Codex, Gemini CLI, Kimi Code CLI, Copilot CLI) and `~/.claude/skills` unless the plugin is installed — and updates older copies.
- One writer at a time: `record`, `link`, `lane` and `close` take a lock in the plan folder; a crashed writer's lock is taken over.
- Examples and test fixtures are plain plan folders; the examples ship with a ready `view.html`.
- README rewritten for v0.5 with new screenshots.

## 0.5.1 — 2026-11-19

- A plan is one line of work with one goal. The intent is shown as the goal; the skill explains how to write it for an own product, a piece of work in a team repository, and a fork.
- `init --name`; the link to a plan stays on this machine unless `--share` writes `.omino.json`.
- `omino lane`: one lane per repository when a plan spans several; the session brief says which lane the folder is.
- A workspace folder above several repositories can carry the plan.
- `omino close [--reopen]`; the next piece of work in the same folder starts a new plan.
- `omino projects --open`: one page with every plan on the machine.

## 0.5.0 — 2026-11-18

- Plans move out of the working tree to `~/.omino/projects/<id>/`, shared by every worktree and clone, with their own git history.
- `where`, `migrate` (also from git history), `projects`, `link`, `allow`, `setup`.
- The same hooks serve Claude Code and Codex; a Codex plugin manifest.
- The page: icons and colour for who did it, git, status and time; relations as "depends on / affects"; stages as columns headed by a progress track.

## 0.4.1 — 2026-11-18

- Fixes from a behaviour evaluation with a weaker model; `/omino:plan`.

## 0.4.0 — 2026-11-17

- Claude Code plugin with hooks (session brief, page answers, record reminder), `find`, `brief`, `doctor`, unlinked-note checks, format version, MIT licence.

## 0.1 – 0.3

- File format, skill, CLI, viewer (graph, board, list), adopt flow, seven-turn test scenario; decisions and provenance; live mode.
