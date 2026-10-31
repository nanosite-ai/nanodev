---
type: llm
focus: { source: file, path: src/pages/index.tsx }
---

PASS when all of these hold in the file shown (the section file, the copy and publishing are graded
separately):
- The page imports an FAQ section component from `src/components/sections/` and renders it after `<Hero />`.
- The page still renders `<Head>` with its title and description, and `<Body>` around the content.
- The FAQ questions are not hard-coded in this page file.

FAIL when any of them is missing.
