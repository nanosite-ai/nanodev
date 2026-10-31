---
name: website
description: 'How to change a nano-site website (React + Vite + Tailwind v4 + shadcn/ui, prerendered to static pages). Use for any edit in a website project: pages, sections, the page head and SEO, translations, the contact form, styling.'
---

<!-- Generated from nano-site's agent guidance (the same guidance its web editor's AI follows). Don't edit it here: propose changes in an issue at https://github.com/nanosite-ai/nanodev/issues -->

# Changing a nano-site website

A website is a React 19 + Vite + Tailwind v4 + shadcn/ui project that nano-site prerenders into static
HTML pages (one set per language) and serves from its CDN. Its only backend feature is the contact form.
When the owner needs accounts, payments or shared data, that is a nano-site store.

## Where things live

- `src/pages/`: one default-export component per page (`index.tsx` is `/`, `404.tsx` the not-found page).
- `src/layout/`: `Head.tsx` (all `<head>` tags), `Body.tsx`, `Header.tsx`, `Footer.tsx`.
- `src/components/sections/`: page sections. `src/components/ui/`: shadcn primitives.
  `src/components/seo/`: `JsonLd` and Open Graph helpers used by `<Head>`.
- `src/css/index.css`: Tailwind and the theme tokens (`--primary`, `--background`, …).
- `src/i18n/`: `config.ts` and `locales/en.ts` (the source catalog).
- `public/` and `src/assets/`: static files and bundled images.

## Rules

- Pages render the same HTML at build time and in the browser: read `window`, `document` and
  `localStorage` inside `useEffect` or event handlers, and reveal browser-only values after mount.
- Every page renders `<Head>` from `src/layout/Head` with its own title and description.
- Style with Tailwind utilities and the theme tokens; keep colors in `src/css/index.css`.
- Check the change with `nanodev dev`, then `nanodev push`. Pushing updates the shared version; going live
  is `nanodev publish` (or Publish in the nano-site editor).

## Foundation
- Stack: React 19 + React Router 7 + Vite + Tailwind v4 + TypeScript + shadcn/ui.
- Websites: pages are default-export components in `src/pages/` built with `<Head>` and `<Body>` from
  `src/layout/`. Sections go in `src/components/sections/`.
- Colors: shadcn semantic tokens in `src/css/index.css` `:root` (`--primary`, `--background`…), used through
  the matching utilities (`bg-primary`, `text-foreground`).
- Style with Tailwind utilities; write custom CSS for what Tailwind can't express.

## `<Head>` layout component

All standard `<head>` tags — title, description, canonical URL, Open Graph, Twitter Card, favicon links, theme color, robots, and sitemap — are rendered by `<Head>` from `src/layout/Head.tsx`.

**Never** import `SiteHead`, `OpenGraph`, `TwitterCard`, or `FaviconLinks` directly in page files — always use `<Head>`.

Define SEO values as **module-level constants** in each page file and pass them as props. Do **not** create `<name>.meta.ts` files.

```tsx
import { Head } from "../layout/Head";
import { Body } from "../layout/Body";
import { type LocalBusinessSchema } from "../components/seo/JsonLd";

const SITE_NAME = "Acme Plumbing";
const BRAND_COLOR = "#1e40af";
const CANONICAL_URL = "https://acme-plumbing.com";
const OG_IMAGE = "https://acme-plumbing.com/og.jpg";
const TITLE = "Acme Plumbing - Fast & Reliable";
const DESCRIPTION = "Licensed plumbers serving Tel Aviv since 2005.";

const jsonLd: LocalBusinessSchema = { /* … */ };

const Page = () => (
  <>
    <Head
      title={TITLE}
      description={DESCRIPTION}
      canonicalUrl={CANONICAL_URL}
      siteName={SITE_NAME}
      brandColor={BRAND_COLOR}
      ogImage={OG_IMAGE}
      ogLogo="https://acme-plumbing.com/logo.png"
      jsonLd={jsonLd}
    />
    <Body>{/* page content */}</Body>
  </>
);
```

### `<Head>` props

| Prop | Required | Notes |
|---|---|---|
| `title` | yes | `<title>` and default OG/Twitter title |
| `description` | yes | meta description and default OG/Twitter description |
| `canonicalUrl` | recommended | Canonical URL and OG/Twitter URL |
| `siteName` | recommended | OG site name and favicon generation |
| `brandColor` | recommended | Theme color and favicon background |
| `ogImage` | recommended | OG/Twitter share image URL |
| `ogImageWidth` | no | Defaults to `1200` |
| `ogImageHeight` | no | Defaults to `630` |
| `ogImageType` | no | Defaults to `image/jpeg` |
| `ogImageAlt` | no | Defaults to `title` |
| `ogLogo` | no | OG logo URL |
| `jsonLd` | recommended | Structured data schema object |

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

## Contact form

Contact forms post to `POST /api/contactus`, which nano-site serves on preview and live sites (the local
vite server has no backend, so test the submit in the nano-site editor's preview after pushing).

### Request body

```json
{
  "name":    "string (optional, max 100)",
  "email":   "string (optional, a valid email)",
  "phone":   "string (optional)",
  "message": "string (required, max 2000)"
}
```

Omit empty optional fields rather than sending `""`. Ask for an email or a phone so the owner can reply.

The message is emailed to the contact address in the project's settings on nanosite.ai (Project settings → Contact).

### Requirements

- Validate `message` is present before submitting.
- Show a success message on `2xx` and an error message on non-`2xx`, in the site's main language.
- Disable the submit button while the request is in flight (prevent double-submits).
- Trim whitespace from all fields before sending.
- Do not log user-entered values to the console.

## Accessibility & responsive (WCAG 2.1 AA)
- Text contrast of at least 4.5:1, visible `:focus-visible` styles, `alt` text on meaningful images (`alt=""`
  on decorative ones), semantic HTML with labeled controls (eslint-plugin-jsx-a11y strict).
- Responsive from mobile to desktop, touch targets of at least 44×44 px, content within the viewport width,
  and a hamburger menu on mobile (right side in RTL, left in LTR).

## Typography
- Google Fonts, with distinct families or weights for headings and body. Choose families other than
  Playfair Display, Times New Roman and Georgia.

## Icons & assets
- Icons come from `lucide-react` (pre-installed), imported by name. Decorative icons get `aria-hidden`;
  icon-only buttons get an `aria-label` on the button.
- lucide has no brand or social-network logos. For those, reuse what the project already has: the user's
  own SVGs, an existing icon component, or `src/components/ui/social-icons.tsx` when present (`InstagramIcon`,
  `XTwitterIcon`, `LinkedinIcon`, … used like lucide icons). Otherwise write them as inline SVG components.
- User uploads are served at `/uploads/<filename>`. External images need `width`, `height` and `alt`.
