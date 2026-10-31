---
type: llm
focus: { source: file, path: src/components/storefront/ProductCard.tsx }
---

PASS when all of these hold in the file shown (publishing is graded separately):
- The card shows a badge only when the first variant's `available` count is between 1 and 5.
- The badge text comes from the i18n catalog through `t()` (a key added to `src/i18n/locales/en.ts`), not a
  hard-coded string in the JSX.
- The badge is computed from the product data during render, so the server HTML and the first client
  render match (no browser globals, current time or random values).
- The existing "Sold out" text and price still render as before.

FAIL when any of them is missing.
