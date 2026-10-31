---
name: store
description: 'How to change a nano-site store (server-rendered React storefront on @nanosite/ecommerce-sdk) safely. Use for any edit in a store project: pages, components, product UI, SEO, translations, data fetching, or anything that must keep server rendering and hydration working.'
---

<!-- Generated from nano-site's agent guidance (the same guidance its web editor's AI follows). Don't edit it here: propose changes in an issue at https://github.com/nanosite-ai/nanodev/issues -->

# Changing a nano-site store

A store is a React 19 + Vite + Tailwind v4 + shadcn/ui storefront that nano-site renders on the server
(SSR) and hydrates in the browser. The same component code runs in both places, and the catalog, cart,
orders and settings come from the store's commerce backend through `@nanosite/ecommerce-sdk`.

The project's own `AGENTS.md` has the full SSR guide. This skill is the short version plus the SDK
patterns.

## Where things live

- `src/App.tsx`: the routes. Pages are `src/pages/*Page.tsx`.
- `src/components/layout/`: header, footer, language switcher. `src/components/storefront/`, `cart/`,
  `customer/`: shop UI. `src/components/ui/`: shadcn primitives.
- `src/prefetch.ts`: `prefetchForRoute(client, pathname)`, the data each route needs in the server HTML.
- `src/components/seo/Seo.tsx`: the per-page `<head>` (title, description, canonical, Open Graph, JSON-LD).
- `src/i18n/`: `config.ts` and `locales/en.ts` (the source catalog), one file per extra language.
- `src/lib/money.ts`, `src/lib/originContext.ts`: money formatting and the site origin for canonical URLs.
- The SSR runtime and build belong to the platform (`@nanosite/store-runtime`). Use them through
  `nanodev dev`; leave them unmodified.

## SSR rules (server and browser render the same thing)

- Read `window`, `document`, `localStorage`, `navigator` and `location` inside `useEffect` or event
  handlers. Module scope, render and `useState` initializers also run on the server.
- Keep anything that changes the server-rendered view (auth, locale, flags) in a cookie: the server sees
  cookies, never `localStorage`.
- Keep the first client render identical to the server HTML. Browser-only values (current time, random
  ids, viewport, stored cart) appear after mount; use `useId()` for ids and CSS breakpoints for layout.
- Format numbers, money and dates with an explicit locale (and `timeZone` for dates).
- Per-request data flows through the SDK's request config; keep module-level state free of request data.

## Data: SDK hooks, prefetched for SSR

- Fetch everything through the generated hooks from `@nanosite/ecommerce-sdk` (TanStack React Query).
  Every query hook has a Suspense twin (`useListStoreProductsSuspense`).
- Data that must be in the server HTML is prefetched: add the route to `prefetchForRoute` in
  `src/prefetch.ts` with the SDK's `get…QueryOptions(...)` helper, so the query key matches the hook.
- Components that render query data use the `…Suspense` hook inside a `<Suspense>` whose fallback is a
  skeleton the same size as the content. Call a Suspense hook only where the query succeeds for this
  visitor (render auth-gated queries in a child shown after the auth check).
- Money is integer minor units (`1999` = 19.99). Format it for display with `src/lib/money.ts`.

## Every new page

1. Register the route in `src/App.tsx`.
2. Prefetch its queries in `src/prefetch.ts`.
3. Render a `<Seo>` from the page's own data (non-suspense hooks inside `<Seo>`); private pages use
   `robots="noindex, nofollow"`. Build canonical and Open Graph URLs from `useOrigin()`.
4. Put its copy in `src/i18n/locales/en.ts` (and every other locale) and render it with `t()`.

## Local development

- `nanodev dev` runs the real server-rendered app against the store's live catalog, so what you see
  locally is what the cloud serves.
- Checkout and payments are off in local development. Build and check the cart locally, then check the
  checkout after pushing, in the nano-site editor's preview (or a `nanodev preview` link if your nanodev
  version has it).
- Products, prices, collections and settings are data in the backoffice, not code. Change them on
  nanosite.ai.
- For a hydration error (`Minified React error #418/#423/#425`, "Hydration failed", content that flashes
  after load), load `nanodev:debug-hydration`.

## SDK reference

The examples below use the plain hooks to show the arguments and response shapes. In a component that
renders the data, call the `…Suspense` twin with the same arguments (and prefetch it, as above).

## Catalog: list, search, filter, sort

```tsx
import { useListStoreProducts, useGetStoreProduct } from "@nanosite/ecommerce-sdk";

const products = useListStoreProducts({
  q: "shirt",            // optional free-text title search
  collection: "summer",  // optional collection slug
  sort: "price_asc",     // "newest" | "title" | "price_asc" | "price_desc"
  minPrice: 1000, maxPrice: 5000, currency: "USD", // optional price range (minor units)
});
const items = products.data?.data.data ?? []; // ProductDTO[]

const detail = useGetStoreProduct(slug, { query: { enabled: Boolean(slug) } });
const product = detail.data?.status === 200 ? detail.data.data : undefined;
```

Only **published** products are returned (drafts are admin-only).

## Collections

```tsx
import { useListStoreCollections, useGetStoreCollection } from "@nanosite/ecommerce-sdk";

const collections = useListStoreCollections();        // res.data?.data.data → CollectionDTO[]
const coll = useGetStoreCollection(slug, { query: { enabled: Boolean(slug) } });
const withProducts = coll.data?.status === 200 ? coll.data.data : undefined; // { …collection, products }
```

Build a nav from collections and either link to a collection page (`getStoreCollection`)
or pass `collection: slug` to `useListStoreProducts`.

## Data model

- Product: `id`, `slug`, `title`, `description`, `status`, `images` (string URLs — render
  `images[0]` as the cover), `collectionIds`, `variants[]`.
- Variant: inventory (`onHand`, `reserved`, `available`) + `prices[]`.
- **Money is integer minor units** (`1999` = `$19.99`); `prices[]` has one entry per currency.

```tsx
const usd = variant.prices.find((p) => p.currencyCode === "USD") ?? variant.prices[0];
new Intl.NumberFormat("en-US", { style: "currency", currency: usd.currencyCode })
  .format(usd.amount / 100);
```

## Localize text

When copy is still hardcoded English JSX, wrap it in `t()` and add the key to **every** locale catalog:

```tsx
// before:  <button>Add to cart</button>
// after:
import { useTranslation } from "react-i18next";
const { t } = useTranslation();
<button>{t("product.addToCart")}</button>
```
Then add `product.addToCart` to `en.ts` (`"Add to cart"`) AND to each other locale (`fr.ts`: `"Ajouter au
panier"`, …). **Never add a key to one catalog only** — a missing key falls back to the base language, so a
half-translated catalog silently shows English. Keep keys grouped by area (`header.*`, `product.*`, …).

## Accessibility & responsive (WCAG 2.1 AA)
- Text contrast of at least 4.5:1, visible `:focus-visible` styles, `alt` text on meaningful images (`alt=""`
  on decorative ones), semantic HTML with labeled controls (eslint-plugin-jsx-a11y strict).
- Responsive from mobile to desktop, touch targets of at least 44×44 px, content within the viewport width,
  and a hamburger menu on mobile (right side in RTL, left in LTR).

## Icons & assets
- Icons come from `lucide-react` (pre-installed), imported by name. Decorative icons get `aria-hidden`;
  icon-only buttons get an `aria-label` on the button.
- lucide has no brand or social-network logos. For those, reuse what the project already has: the user's
  own SVGs, an existing icon component, or `src/components/ui/social-icons.tsx` when present (`InstagramIcon`,
  `XTwitterIcon`, `LinkedinIcon`, … used like lucide icons). Otherwise write them as inline SVG components.
- User uploads are served at `/uploads/<filename>`. External images need `width`, `height` and `alt`.
