# 公开发布前检查清单

## 已完成

- [x] `package.json` 可发布：去掉 `private`，加上 `files`（只打包 skill、命令、hook、两个插件清单、README、CHANGELOG、LICENSE），`npm pack` 共 17 个文件、约 98 KB。
- [x] 从打包文件全局安装后，`omino install` 能把 skill 放进 `~/.agents/skills` 和 `~/.claude/skills`。
- [x] npm 上 `omino` 这个包名目前没人用。
- [x] 版本号统一为 1.0.0（`package.json`、`omino.mjs`、两个插件清单），`CHANGELOG.md` 已写。
- [x] 六个用户命令（`/omino-plan` … `/omino-clear`）；`npm pack` 共 25 个文件、约 123 KB。
- [x] `_to_delete/` 已加入 `.gitignore`。
- [x] Claude Code 的安装命令已按官方文档改正：`/plugin marketplace add maktub-ai/omino`，再 `/plugin install omino@omino`。
- [x] 文档、SKILL 和测试里的项目名都是虚构的例子。
- [x] 示例都是虚构的个人 Todo App；示例页面里不含本机路径。
- [x] 79 个自动测试通过。

## 需要你决定

- [x] **公开内容已确认。** `docs/framework.md` 去掉了商业规划一节；仓库以干净历史（单个 1.0.0 提交）公开。
- [x] **`docs/dev/v0.md` 随仓库公开。**
- [x] **仓库改为公开。**
- [ ] **发布到 npm。** 需要你的 npm 账号：`npm login`，然后在仓库根目录 `npm publish`。发布之后 `npx omino install` 才可用。

## 公开后再核实

- [ ] 在一台干净的机器上，按 README 走一遍 Claude Code 插件安装。
- [ ] Codex 从 GitHub 安装插件的具体命令，核实后补进 README。
- [ ] `npx omino install` 在 macOS 上跑一遍。
