#!/usr/bin/env bash
# A tiny linked nano-site store: the files an agent needs to read to add a badge the SSR-safe way.
set -euo pipefail

mkdir -p .nanodev src/pages src/components/storefront src/i18n/locales src/lib

cat > .nanodev/project.json <<'EOF'
{ "projectId": "eval-store", "api": "https://api.nanosite.ai", "type": "store", "name": "Eval Store" }
EOF

cat > package.json <<'EOF'
{
  "name": "eval-store",
  "private": true,
  "type": "module",
  "dependencies": {
    "@nanosite/ecommerce-sdk": "^0.4.1",
    "@nanosite/store-runtime": "^0.1.0-beta.0",
    "@tanstack/react-query": "^5.101.0",
    "react": "^19.2.7",
    "react-i18next": "^17.0.11"
  }
}
EOF

printf 'node_modules/\ndist/\n.env*\n' > .gitignore

# The AGENTS.md block nano-site writes into every project (generated from nano-site's agent guidance;
# don't edit it here).
# nanodev-agents-block: store
cat > AGENTS.md <<'NANODEV_AGENTS_EOF'
<!-- nanodev:begin v=4 -->
## Local development (nanodev)

This section is for developers working on this store on their own machine with the nanodev CLI. The
nano-site editor skips it.

This is a nano-site **store**: a React 19 + Vite + Tailwind v4 + shadcn/ui storefront that nano-site
renders on the server (SSR) and hydrates in the browser, with its catalog, cart and orders served by
`@nanosite/ecommerce-sdk`. The project on nanosite.ai is the shared version; a linked folder is a git clone
of it.

### Folder map
- `src/App.tsx`: routes. `src/pages/*Page.tsx`: pages.
- `src/components/layout/`: header and footer. `storefront/`, `cart/`, `customer/`: shop UI. `ui/`: shadcn.
- `src/prefetch.ts`: the data each route puts in the server HTML.
- `src/components/seo/Seo.tsx`: each page's `<head>`.
- `src/i18n/`: language config and catalogs. `src/css/index.css`: Tailwind and theme tokens.

### Commands
- `nanodev status`: which project this is, and whether the folder is ahead of or behind nano-site.
- `nanodev pull`: get the newest version (edits from the nano-site editor, its AI, or teammates).
- `nanodev dev`: run the store locally with hot reload.
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
- Copy shoppers read lives in `src/i18n/locales/en.ts` (and every other locale file), rendered with `t()`.
- Keep secrets out of the repo; keys and settings live in the nano-site backoffice.
- The same code runs on the server and in the browser: use `window`, `document` and `localStorage` only
  in `useEffect` or event handlers, and keep the first client render identical to the server HTML.
- Get data through the SDK's React Query hooks. Data a page shows in its server HTML is prefetched in
  `src/prefetch.ts` with the SDK's `get…QueryOptions(...)`, and rendered with the `…Suspense` hook inside a
  `<Suspense>` with a same-size skeleton.
- Every page renders a `<Seo>` from its own data.
- Money is integer minor units (`1999` = 19.99).
- Checkout and payments are off in local development: check the checkout after pushing, in the nano-site
  preview.
- Products, prices and store settings are data in the nano-site backoffice, not code.

Claude Code: the `nanodev` plugin (offered in `.claude/settings.json`) adds the skills `nanodev:workflow`,
`nanodev:store`, `nanodev:website` and `nanodev:debug-hydration`.
<!-- nanodev:end -->
NANODEV_AGENTS_EOF
printf '@AGENTS.md\n' > CLAUDE.md

cat > src/i18n/locales/en.ts <<'EOF'
export const en = {
  product: {
    addToCart: "Add to cart",
    soldOut: "Sold out",
  },
};
export type Catalog = typeof en;
EOF

cat > src/lib/money.ts <<'EOF'
export const formatAmount = (amount: number, currency = "USD"): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
EOF

cat > src/components/storefront/ProductCard.tsx <<'EOF'
import { useTranslation } from "react-i18next";
import type { ProductDTO } from "@nanosite/ecommerce-sdk";
import { formatAmount } from "@/lib/money";

export const ProductCard = ({ product }: { product: ProductDTO }) => {
  const { t } = useTranslation();
  const variant = product.variants[0];
  const price = variant?.prices[0];
  const soldOut = (variant?.available ?? 0) <= 0;
  return (
    <a href={`/products/${product.slug}`} className="group block rounded-lg border p-3">
      {product.images[0] && <img src={product.images[0]} alt={product.title} width={400} height={400} />}
      <h3 className="mt-2 font-medium">{product.title}</h3>
      {price && <p className="text-sm">{formatAmount(price.amount, price.currencyCode)}</p>}
      {soldOut && <span className="text-xs text-muted-foreground">{t("product.soldOut")}</span>}
    </a>
  );
};
EOF

cat > src/pages/StorePage.tsx <<'EOF'
import { useListStoreProductsSuspense } from "@nanosite/ecommerce-sdk";
import { ProductCard } from "@/components/storefront/ProductCard";

export const StorePage = () => {
  const res = useListStoreProductsSuspense({});
  const products = res.data.status === 200 ? res.data.data.data : [];
  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {products.map((p) => (
        <li key={p.id}>
          <ProductCard product={p} />
        </li>
      ))}
    </ul>
  );
};
EOF

cat > src/prefetch.ts <<'EOF'
import type { QueryClient } from "@tanstack/react-query";
import { getListStoreProductsQueryOptions } from "@nanosite/ecommerce-sdk";

export const prefetchForRoute = async (client: QueryClient, pathname: string): Promise<void> => {
  if (pathname === "/" || pathname === "/shop") await client.prefetchQuery(getListStoreProductsQueryOptions({}));
};
EOF

git init --quiet
git add -A
git -c user.name=eval -c user.email=eval@example.test commit --quiet -m "Initial store"
