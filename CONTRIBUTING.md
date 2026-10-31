# Contributing to nanodev

Thanks for helping!

## Issues

Issues are the best way to help: bug reports, missing features, confusing messages, docs gaps.
[Open one here](https://github.com/nanosite-ai/nanodev/issues/new/choose) and include `nanodev --version`, your OS, your Node.js version and
`nanodev doctor` output. Never paste a token (`ndv_…`), a publishable key or anything from `~/.nanodev/`.

## Pull requests

PRs are welcome and we read every one. nanodev is developed inside nanosite.ai's main repository, and this
repository is synced from it, so we don't merge PRs here directly: when we take a change, we apply it upstream and it
comes back with the next sync (you keep the credit in the commit). Small, focused PRs with a test are easiest to take.

## Developing

```bash
npm install
npm run build
npm test
node bin/nanodev.mjs --help
```

`create-nanodev/` is plain JavaScript; its tests run with the root `npm test`. The plugin skills in
`plugin/skills/` are generated from nano-site's agent guidance and overwritten on every sync: propose skill changes in
an issue rather than a PR. Check the plugin with `claude plugin validate plugin`.

`src/vendor/` holds modules copied from nano-site (the lockfile check the server also runs); keep them in sync
with upstream rather than diverging.
