# Candidate Ranking

Rank source-file candidates for a selected element by how uniquely each signal ties the element to
code. Score 0..1; keep the reasoning so it can be surfaced in `candidateFiles[].reason`.

## Signals

**High value** (a match here is usually decisive)
- Exact selected visible text match.
- `aria-label`, `data-testid`, `id`, `name` attribute value match.
- Unique `className` or a distinctive Tailwind class sequence match.
- Nearby heading or button label match (from `nearbyText`).
- Route segment match (URL path → page/route file).

**Medium value**
- Partial / substring text match.
- A `className` that repeats across a few files.
- Component name inferred from the URL or breadcrumb.
- CSS selector or CSS-module class match.

**Low value** (rarely enough on their own)
- Generic class names only (`container`, `row`, `btn`).
- A match inside a generated bundle or build output.
- No source-text match at all.

## Scoring guidance

- Combine signals: two independent high-value matches in the same file → `score ≈ 0.9+`, treat as
  `high` confidence. One medium signal alone → cap around `0.4`, `low`/`medium` confidence.
- Prefer the file that owns the **markup/class** producing the issue over files that merely
  reference it. For Tailwind/utility issues that is usually the component's JSX/TSX/Vue/Svelte file;
  for cascade issues it may be a CSS/SCSS/module file — include both when unsure.
- If the top two candidates are close, keep both in `candidateFiles` and explain the tie in `warnings`.

## Search roots

**Prefer** (search these first): `src/`, `app/`, `pages/`, `components/`, `styles/`.

**Exclude** (never rank source from here): `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`,
`out/`, `coverage/`.
