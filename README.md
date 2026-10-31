# nanodev

Work on your [nano-site](https://nanosite.ai) store or website on your own computer, with your own editor and
your own AI agent. **nanodev by nanosite.ai.**

Your project stays one project: its code lives in a git repository on nano-site, and nanodev keeps your folder and
the cloud in sync. Switch between the AI builder on the web and your local editor whenever you like.

> **Beta** (`0.1.0-beta.0`). Something not working? [Open an issue](https://github.com/nanosite-ai/nanodev/issues/new/choose).

This repository holds:

| Folder | What | npm |
|---|---|---|
| `/` (`src/`, `bin/`) | the `nanodev` CLI | [`@nanosite/nanodev`](https://www.npmjs.com/package/@nanosite/nanodev) |
| `create-nanodev/` | `npm create @nanosite/nanodev` | [`@nanosite/create-nanodev`](https://www.npmjs.com/package/@nanosite/create-nanodev) |
| `plugin/` | the nanodev Claude Code plugin | (this repo is its marketplace) |

## Install

Requires Node.js 22.12 or newer and git.

Start a new store, running locally:

```bash
npm create @nanosite/nanodev@beta my-store
```

Or install the CLI and work on an existing project:

```bash
npm install -g @nanosite/nanodev@beta
nanodev login            # approve in your browser
nanodev link             # pick a project: clone + install it
cd <project>
nanodev dev              # stores: SSR dev server with live store data; websites: vite
nanodev push             # commit, rebase and push to nano-site
nanodev publish          # push, then publish that commit to your live site
```

More: `pull`, `preview` (a private cloud preview of your folder), `status`, `open`, `doctor`, `config`. Run
`nanodev <command> --help`; every command takes `--json`.

## The Claude Code plugin

nano-site writes an agent guide into every project (`AGENTS.md`, `CLAUDE.md`) and offers this plugin in the
project's `.claude/settings.json`, so Claude Code suggests it when you trust the folder. To add it yourself:

```text
/plugin marketplace add nanosite-ai/nanodev
/plugin install nanodev@nanodev
```

Skills: `nanodev:workflow` (the local loop), `nanodev:store` (SSR, SDK hooks, SEO, i18n), `nanodev:website` and
`nanodev:debug-hydration`. See [plugin/README.md](./plugin/README.md).

## Docs

https://nanosite.ai/docs/develop-locally

## Issues and feedback

Bugs and ideas are welcome: [open an issue](https://github.com/nanosite-ai/nanodev/issues/new/choose). Include `nanodev --version`, your OS and
Node.js version, and the output of `nanodev doctor`. Never paste tokens (`ndv_…`) or the contents of
`~/.nanodev/`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT, see [LICENSE](./LICENSE). Made by [nanosite.ai](https://nanosite.ai).
