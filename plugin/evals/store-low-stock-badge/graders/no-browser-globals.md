---
type: regex
target: { source: file, path: src/components/storefront/ProductCard.tsx }
pattern: "\\b(window|localStorage|document)\\.|Date\\.now\\(|Math\\.random\\("
match: not_contains
---
