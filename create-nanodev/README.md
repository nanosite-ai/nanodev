# create-nanodev

Start a new [nano-site](https://nanosite.ai) store (or website) and run it on your computer. By nanosite.ai.

```bash
npm create nanodev@beta my-store
```

This runs `nanodev create my-store` from [`@nanosite/nanodev`](https://www.npmjs.com/package/@nanosite/nanodev):
it logs you in through your browser, lets you pick a template or the starter kit, creates the project in your
nano-site account, clones it into `./my-store`, installs it and starts the dev server.

Options are passed through to `nanodev create`:

```bash
npm create nanodev@beta my-store -- --template ecommerce --no-dev
npm create nanodev@beta -- --type website --name "My Site"
```

Requires Node.js 22.12 or newer and git. nanodev is in beta.

- Docs: https://nanosite.ai/docs/develop-locally
- Issues: https://github.com/nanosite-ai/nanodev/issues

MIT licensed.
