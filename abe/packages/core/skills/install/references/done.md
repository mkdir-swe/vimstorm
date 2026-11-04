# Part: done

Passes when every required part passes. Its line names the changed files for the person to commit: `git status` of `abe.yaml`, `abe/` (its workflows, skills and scripts: `abe/scripts/prototype-start` when the Prototype part wrote it) and `.claude/skills/` (and `CLAUDE.md`, `AGENTS.md` when the install wrote them). Do it last.

1. **The start script line.** `CLAUDE.md` and the `run-app` skill name `.claude/skills/run-app/scripts/start` only if that file exists and the app ran through the gate ([verify](verify.md)). When `read.kind.runs` is false (nothing to run here), or the person chose "can't run here", name none: change that line to say nothing runs here, or that the app was not run on this machine yet (see the Verification pack, `.claude/skills/verify-<app>/`). Edit only the lines the install wrote.
2. Run `abe install check done`.
3. Tell the person, in a few lines:
   - the install is Done;
   - the files to commit, as the line names them, and that you never commit or push them: they review them in `git diff`, commit and push, so teammates get the same board, checks, sources and Verification pack;
   - how the app runs locally (`abe run start`, its port rule; or that nothing runs here; or that it was not run here and why, in one plain sentence: "The app was not run here: port 3000 is held by another process."), the checks, and what to review first;
   - when a merge deploys (`read.deploys`): "a merge here deploys <envs>", and who merges.
4. When the board is On this machine and has no card (`abe card list`), say there is nothing for the Factory to take yet, and give the command that makes the first: `card create --title "<what to build>"`, after `abe` in Terminal.

`.abe/` is never among the files to commit: the env files and `.abe/settings.local.yaml` are the person's, and stay out of git.
