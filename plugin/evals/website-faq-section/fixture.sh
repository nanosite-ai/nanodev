#!/usr/bin/env bash
# A tiny linked nano-site website with one page.
set -euo pipefail

mkdir -p .nanodev src/pages src/layout src/components/sections src/i18n/locales

cat > .nanodev/project.json <<'EOF'
{ "projectId": "eval-site", "api": "https://api.nanosite.ai", "type": "website", "name": "Eval Bakery" }
EOF

cat > package.json <<'EOF'
{ "name": "eval-site", "private": true, "type": "module", "dependencies": { "react": "^19.2.7", "react-i18next": "^17.0.11" } }
EOF

printf 'node_modules/\ndist/\n.env*\n' > .gitignore

# The AGENTS.md block nano-site writes into every project (generated from nano-site's agent guidance;
# don't edit it here).
# nanodev-agents-block: website
cat > AGENTS.md <<'NANODEV_AGENTS_EOF'
<!-- nanodev:begin v=4 -->
## Local development (nanodev)

This section is for developers working on this website on their own machine with the nanodev CLI. The
nano-site editor skips it.

This is a nano-site **website**: a React 19 + Vite + Tailwind v4 + shadcn/ui project that nano-site
prerenders into static pages. The project on nanosite.ai is the shared version; a linked folder is a git
clone of it.

### Folder map
- `src/pages/`: one default-export component per page (`index.tsx` is `/`).
- `src/layout/`: `Head.tsx` (every `<head>` tag), `Body.tsx`, `Header.tsx`, `Footer.tsx`.
- `src/components/sections/`: page sections. `src/components/ui/`: shadcn.
- `src/i18n/`: language config and catalogs. `src/css/index.css`: Tailwind and theme tokens.

### Commands
- `nanodev status`: which project this is, and whether the folder is ahead of or behind nano-site.
- `nanodev pull`: get the newest version (edits from the nano-site editor, its AI, or teammates).
- `nanodev dev`: run the website locally with hot reload.
- `nanodev push -m "<what changed>"`: send your commits to nano-site, updating the shared version.
- `nanodev preview`: build this folder (uncommitted changes too) into a private link, in the same runtime
  as the live site, without changing the shared version.
- `nanodev publish`: push, then put exactly that commit live. Going live is a separate step from pushing;
  only publish when the owner asked for it.
- `nanodev publish --preview-link`: push, then build exactly that commit to the project's preview link
  (`<id>-preview.nanosite.live`) instead of the live site. No new version; the live site is unchanged.

### Rules
- Edit source files only: `dist/`, `node_modules/` and `.nanodev/` are generated or local.
- Start with `nanodev pull`, check the change with `nanodev dev`, and push small and often: one focused
  change per push.
- Packages change only when you change them: `npm install <pkg>` and commit `package.json` together with
  `package-lock.json`. The lockfile is the source of truth; nano-site installs exactly what it lists.
- Copy visitors read lives in `src/i18n/locales/en.ts` (and every other locale file), rendered with `t()`.
- Keep secrets out of the repo.
- Pages are prerendered: use `window`, `document` and `localStorage` only in `useEffect` or event
  handlers.
- Every page renders `<Head>` from `src/layout/Head` with its own title and description.
- The contact form posts to `POST /api/contactus`, served on nano-site previews and the live site.

Claude Code: the `nanodev` plugin (offered in `.claude/settings.json`) adds the skills `nanodev:workflow`,
`nanodev:store`, `nanodev:website` and `nanodev:debug-hydration`.
<!-- nanodev:end -->
NANODEV_AGENTS_EOF
printf '@AGENTS.md\n' > CLAUDE.md

cat > src/i18n/locales/en.ts <<'EOF'
export const en = {
  hero: { title: "Fresh bread every morning", cta: "Visit us" },
};
export type Catalog = typeof en;
EOF

cat > src/layout/Head.tsx <<'EOF'
export const Head = ({ title, description }: { title: string; description: string }) => (
  <>
    <title>{title}</title>
    <meta name="description" content={description} />
  </>
);
EOF

cat > src/layout/Body.tsx <<'EOF'
import type { ReactNode } from "react";
export const Body = ({ children }: { children: ReactNode }) => <main>{children}</main>;
EOF

cat > src/components/sections/Hero.tsx <<'EOF'
import { useTranslation } from "react-i18next";
export const Hero = () => {
  const { t } = useTranslation();
  return (
    <section className="py-24 text-center">
      <h1 className="text-4xl font-bold">{t("hero.title")}</h1>
      <a href="#visit" className="mt-6 inline-block rounded bg-primary px-4 py-2 text-primary-foreground">{t("hero.cta")}</a>
    </section>
  );
};
EOF

cat > src/pages/index.tsx <<'EOF'
import { Head } from "../layout/Head";
import { Body } from "../layout/Body";
import { Hero } from "../components/sections/Hero";

const TITLE = "Eval Bakery - Fresh bread in Lisbon";
const DESCRIPTION = "A neighbourhood bakery baking sourdough every morning.";

const Page = () => (
  <>
    <Head title={TITLE} description={DESCRIPTION} />
    <Body>
      <Hero />
    </Body>
  </>
);
export default Page;
EOF

git init --quiet
git add -A
git -c user.name=eval -c user.email=eval@example.test commit --quiet -m "Initial website"
