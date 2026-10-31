---
name: debug-hydration
description: 'Find and fix SSR hydration errors in a nano-site store (Minified React error #418/#423/#425, "Hydration failed because the server rendered HTML didn''t match the client", "cannot be a descendant of", content that flashes after load). Use as soon as one shows up in the browser console or a page flashes on load.'
---

<!-- Generated from nano-site's agent guidance (the same guidance its web editor's AI follows). Don't edit it here: propose changes in an issue at https://github.com/nanosite-ai/nanodev/issues -->

# Debugging SSR hydration errors

A store is rendered to HTML on the server, then React hydrates that HTML in the browser. The first client
render must produce exactly the same markup. When it doesn't, React throws a hydration error, discards the
server HTML and re-renders on the client (a visible flash, lost SEO markup, a slower page).

## Workflow

1. Reproduce it locally with `nanodev dev`. The local server runs React's development build, so the
   console shows the full message instead of a minified code.
2. Open the page in the browser with the console open and reload (a hydration error only happens on a
   full page load, not on client-side navigation).
3. Read React's message:
   - **`Hydration failed because the server rendered HTML/text didn't match the client`**, followed by the
     component tree down to the mismatch. Lines starting with **`+` are what the client rendered, `-` what
     the server sent**.
   - **`In HTML, <div> cannot be a descendant of <p>. This will cause a hydration error.`**: invalid
     nesting; the `>`-marked lines show the offending elements.
4. Fix the cause (below), reload, and read the console again. React reports only the first mismatch in
   each hydrated section, so a second bug in the same component shows up after the first is fixed. Check
   the other key pages too (home, a product page, about): a bug in the header or footer shows up
   everywhere.
5. When the same error survives two fix-and-reload rounds, stop and report what you found.
6. After `nanodev push`, confirm in the nano-site editor's preview (the production build), or on a
   `nanodev preview` link, before publishing.

## Fixes by cause

**Text differs** (`+`/`-` lines are text). The most common case.
- A value that changes between renders ran during render: `new Date()`, `Date.now()`, `Math.random()`,
  `crypto.randomUUID()`, `toLocaleString()`. Render a stable value, or render the server value first and update
  it after mount:
  ```tsx
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => setNow(new Date().toLocaleTimeString()), []);
  return <span>{now ?? ""}</span>;
  ```
  Number, date and currency formatting must use an explicit locale (and `timeZone` for dates) so the server
  and the browser agree: `new Intl.NumberFormat("en-US", …)` / `toLocaleDateString("en-US", { timeZone: "UTC" })`.
- Otherwise the text comes from browser-only state (localStorage cart, auth hint, `navigator.language`,
  window size). Render the server-safe default first and switch in `useEffect`.

**An element exists on one side only** (a `+` or `-` element). Render code branches on the environment:
`typeof window !== "undefined"`, `localStorage`/`sessionStorage`, `document.cookie`, `matchMedia`,
`window.innerWidth`, or client-only state read in a `useState` initializer. Render the **same** tree first, then
change it after mount:
```tsx
const [mounted, setMounted] = useState(false);
useEffect(() => setMounted(true), []);
{mounted && isLoggedIn && <span>Welcome back</span>}
```
For values from a browser store, `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` with a
`getServerSnapshot` equal to the server's value is the idiomatic fix. Responsive differences should be done
with CSS (Tailwind `sm:`/`md:`), not JS branching on width.

**Invalid HTML nesting** ("cannot be a descendant of"). The browser's HTML parser rearranges some markup
(`<div>`, `<p>`, `<ul>`, headings, etc. inside `<p>`; `<a>` inside `<a>`; `<button>` inside `<button>`; `<tr>` without
`<tbody>`), so the DOM can never match. Change the tags, e.g. make the outer `<p>` a `<div>`, the inner `<div>` a
`<span>`, or make nested links siblings. Watch for components that render a `<div>`/`<p>` (shadcn `Card`,
`Skeleton`, `Badge`, …) used inside a `<p>`.

**An attribute differs** (`className`, `style`, `href`, `id`, …). It's computed from browser-only state (theme
from localStorage; random ids: use `useId()`), or it includes a time or random value. Compute it identically on
both sides and change it after mount.

## Rules
- Fix the root cause. Don't delete the feature or hide the element.
- `suppressHydrationWarning` is only acceptable on a single element whose **text** is legitimately different
  (e.g. a live clock), never on a container, and never for markup differences.
- Don't disable SSR or wrap large trees in client-only guards to silence errors.
- Never read `window`/`document`/`localStorage` during render or in a `useState` initializer. Do it in
  `useEffect` or event handlers.
