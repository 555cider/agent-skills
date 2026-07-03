# Examples

Three worked runs: selected element → diagnosis → ranked candidates → validated diff. Diffs are
illustrative; always re-validate against the actual repo.

## 1. Button spacing too tight

**Instruction:** "The buttons in this toolbar are jammed together — add space."
**Element:** `<div class="flex">` wrapping two `<button>`s; `computedStyle.gap: "0px"`.
`nearbyText: ["Save", "Cancel"]`. Page route `/settings`.

**Diagnosis:** The flex row has no `gap`; children sit flush. Fix is a spacing utility on the row.

**Candidates:**
- `src/components/SettingsToolbar.tsx` — score 0.92 — exact `class="flex"` + both button labels
  ("Save"/"Cancel") match; route `/settings` maps here.
- `src/components/Toolbar.tsx` — score 0.3 — generic `flex` only; no label match.

**Diff:**
```diff
--- a/src/components/SettingsToolbar.tsx
+++ b/src/components/SettingsToolbar.tsx
@@ -12,7 +12,7 @@ export function SettingsToolbar() {
   return (
-    <div className="flex">
+    <div className="flex gap-2">
       <button onClick={onSave}>Save</button>
       <button onClick={onCancel}>Cancel</button>
     </div>
```
**confidence:** high · **canAutoApply:** false (pending user approval)

## 2. Layout breaks on mobile

**Instruction:** "This card row overflows horizontally on my phone."
**Element:** `<div class="grid grid-cols-3">`; `rect.width` exceeds viewport at 375px;
`page.viewport.width: 375`.

**Diagnosis:** A fixed 3-column grid does not reflow on narrow viewports, forcing horizontal
overflow. Make columns responsive.

**Candidates:**
- `src/components/CardRow.tsx` — score 0.85 — unique `grid grid-cols-3` sequence match.
- `src/styles/cards.css` — score 0.35 — has a `.card-row` rule but no col count.

**Diff:**
```diff
--- a/src/components/CardRow.tsx
+++ b/src/components/CardRow.tsx
@@ -8,7 +8,7 @@ export function CardRow({ items }) {
-    <div className="grid grid-cols-3 gap-4">
+    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
```
**confidence:** high · **canAutoApply:** false

## 3. Wrong Tailwind color class

**Instruction:** "This badge should be green, not gray."
**Element:** `<span class="badge bg-gray-200 text-gray-600">Active</span>`; text "Active".

**Diagnosis:** The badge uses neutral gray utilities regardless of state; the "Active" state should
use a success color.

**Candidates:**
- `src/components/StatusBadge.tsx` — score 0.9 — `bg-gray-200 text-gray-600` sequence + "Active"
  label match.

**Diff:**
```diff
--- a/src/components/StatusBadge.tsx
+++ b/src/components/StatusBadge.tsx
@@ -4,7 +4,7 @@ export function StatusBadge({ label }) {
-    <span className="badge bg-gray-200 text-gray-600">{label}</span>
+    <span className="badge bg-green-100 text-green-700">{label}</span>
```
**confidence:** medium · **warnings:** ["Badge may be shared across states; if other states reuse
this component, gate the color on a status prop instead of hardcoding green."] · **canAutoApply:** false
