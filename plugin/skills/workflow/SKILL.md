---
name: workflow
description: 'The nanodev loop for a nano-site store or website cloned to this machine: run it, pull, edit, push, then publish. Use when starting work in a folder linked with nanodev (it has .nanodev/project.json), before sharing or publishing a change, after "nanodev pull" reports new commits, or when a push is rejected.'
---

<!-- Generated from nano-site's agent guidance (the same guidance its web editor's AI follows). Don't edit it here: propose changes in an issue at https://github.com/nanosite-ai/nanodev/issues -->

# Working on a nano-site project with nanodev

This folder is a git clone of a project that lives on nanosite.ai. The cloud project is the source of
truth: the owner may also edit it in the web editor (with its AI), and teammates may push from their own
clones. `nanodev` keeps this folder and the cloud in step.

`AGENTS.md` describes this project (type, folder map, rules). Read it first.

## The loop

1. `nanodev status`: which project this is and whether you are ahead of or behind nano-site.
2. `nanodev pull`: start from the newest version. It rebases your local commits on top and reinstalls
   dependencies when `package-lock.json` changed.
3. `nanodev dev`: run the project locally (a store runs the real server-rendered app against its live
   catalog; a website runs vite). Leave it running; it hot-reloads and tells you when nano-site has new
   commits.
4. Make one focused change. Check it in the browser at the URL `nanodev dev` printed, and run
   `npx tsc --noEmit` when the project has a `tsconfig.json`.
5. `nanodev push -m "<what changed, in the owner's words>"`: commit and send your work to nano-site. It
   rebases on new commits first, checks the lockfile can install in the cloud, and updates the shared
   version (`main`) that the nano-site editor and every clone see. It does not make the change live.
6. Going live is Publish: the Publish button in the nano-site editor, or `nanodev publish` if your nanodev
   version has it. To show the owner a change before that, share a `nanodev preview` link if your nanodev
   version has it (`nanodev --help` lists the commands), or the nano-site editor's preview after pushing.

Push small and often: one change per push keeps conflicts rare and makes each change easy to review and
undo in the web editor's history.

## When something goes wrong

- **Push rejected because nano-site moved on:** run `nanodev pull`, then `nanodev push` again.
- **Rebase conflict:** open the conflicted files, keep both sides' intent, `git add` them and run
  `git rebase --continue`, then push. `git rebase --abort` returns to where you were.
- **Lockfile refused (missing Linux bindings):** let `nanodev push` repair it (the default), or run
  `npm install --package-lock-only` and commit `package-lock.json`.
- **Uncommitted changes block a pull:** commit them, or run `nanodev pull --autostash`.

## Ground rules

- Edit source files only. `dist/`, `node_modules/` and `.nanodev/` are generated or local.
- Dependencies change only when you change them: install with `npm install <pkg>` and commit both
  `package.json` and `package-lock.json`. The cloud installs exactly the lockfile.
- Keep secrets out of the repo. Store keys and payment settings live in the nano-site backoffice.
- The "Local development (nanodev)" block in `AGENTS.md` (between the `nanodev:begin` and `nanodev:end`
  markers) is maintained by nano-site and replaced when a newer guide ships. Put project notes outside it.

For store code, load `nanodev:store`. For website code, load `nanodev:website`. For hydration errors in a
store, load `nanodev:debug-hydration`.
