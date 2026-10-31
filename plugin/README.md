# nanodev plugin for Claude Code

By nanosite.ai. Skills for working on a nano-site store or website you cloned with `nanodev link` or created with
`npm create @nanosite/nanodev`:

| Skill | Use it for |
|---|---|
| `nanodev:workflow` | the loop: `status`, `pull`, `dev`, `preview`, `push`, `publish`, and what to do when a push or rebase fails |
| `nanodev:store` | store code: SSR rules, SDK hooks and `src/prefetch.ts`, `<Seo>`, i18n, local checkout limits |
| `nanodev:website` | website code: pages, `<Head>`, sections, i18n, the contact form |
| `nanodev:debug-hydration` | hydration errors (React #418/#423/#425, "Hydration failed", content that flashes) |

## Install

nano-site commits an agent guide into every project: a "Local development (nanodev)" block in `AGENTS.md`, an
`@AGENTS.md` import in `CLAUDE.md`, and a `.claude/settings.json` that offers this plugin
(`extraKnownMarketplaces.nanosite` and `enabledPlugins["nanodev@nanosite"]`, from the
[nanosite plugin catalog](https://github.com/nanosite-ai/claude-plugins)). Claude Code offers to install it when you trust the
project folder. To install it yourself:

```text
/plugin marketplace add nanosite-ai/claude-plugins
/plugin install nanodev@nanosite
```

`nanodev doctor` warns when a project's committed marketplace isn't the catalog. Projects that still offer the older
`nanodev@nanodev` move to `nanodev@nanosite` on nano-site's next agent-guide refresh.

## Where the skills come from

`skills/*/SKILL.md` are generated from nano-site's own agent guidance, the same guidance the AI in nano-site's web
editor follows, so local agents and the web editor work the same way, and synced into this repository. To change a
skill, [open an issue](https://github.com/nanosite-ai/nanodev/issues/new/choose) describing what the agent got wrong or should know: edits made
directly here would be overwritten by the next sync.

## Try it locally

```bash
claude plugin validate plugin
claude --plugin-dir plugin            # from a project folder, with this repo's plugin/ path
```

## Evals

`evals/` holds two cases: a store gets a "Low stock" badge (SSR-safe, translated, published), and a website gets an
FAQ section. Each case seeds a small linked project with `fixture.sh`.

```bash
claude plugin eval plugin --scaffold --allow-tools Edit Write Bash --runs 3
```

`Bash` lets the agent run `nanodev push`; Claude Code grants a shell only where it can sandbox it (Linux, macOS). On
Windows run with `--allow-tools Edit Write`: the `published` grader then fails by design.
