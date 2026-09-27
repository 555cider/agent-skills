#!/usr/bin/env node

// Offline precision report for the source locator, read from saved fix results.
// It never changes thresholds; it shows whether the ones in locate-source.mjs hold up.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const MIN_SAMPLE = 20;
const NOTE = "Only applied edits carry an outcome, and they all passed the high-confidence gate, "
  + "so this is precision of the auto-apply tier, not calibration across all scores. "
  + `Treat bins with n < ${MIN_SAMPLE} as anecdotes; this report never changes thresholds.`;

const roots = process.argv.slice(2);
if (!roots.length || roots.some((arg) => arg.startsWith("--"))) {
  process.stderr.write("usage: locator-report.mjs <artifact-dir>...\n");
  process.exit(2);
}

function resultFiles(directory, depth = 0) {
  if (depth > 4 || !existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    const file = join(child, "fix-result.json");
    if (/^request-/.test(entry.name) && existsSync(file)) found.push(file);
    else found.push(...resultFiles(child, depth + 1));
  }
  return found;
}

function normalize(path) {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

// Candidates are repo-relative; changes may be recorded relative or absolute.
function samePath(candidate, changed) {
  const a = normalize(candidate);
  const b = normalize(changed);
  return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

function wilson(hits, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Number(Math.max(0, center - half).toFixed(3)), Number(Math.min(1, center + half).toFixed(3))];
}

const byStatus = {};
const unreadable = [];
const bins = new Map();
const misses = [];
let results = 0;
let labeled = 0;

for (const file of [...new Set(roots.flatMap((root) => resultFiles(resolve(root))))].sort()) {
  let result;
  try { result = JSON.parse(readFileSync(file, "utf8")); }
  catch { unreadable.push(file); continue; }
  results += 1;
  byStatus[result.status] = (byStatus[result.status] || 0) + 1;

  const top = result.candidates?.[0];
  const changed = (result.changes || []).map((change) => change.file).filter(Boolean);
  if (result.status !== "applied_verified" || !top || !changed.length) continue;
  labeled += 1;
  const hit = changed.some((path) => samePath(top.path, path));
  const floor = Math.min(9, Math.floor(Number(top.score) * 10));
  const range = `${(floor / 10).toFixed(2)}-${((floor + 1) / 10).toFixed(2)}`;
  const bin = bins.get(range) || { range, n: 0, hits: 0 };
  bin.n += 1;
  if (hit) bin.hits += 1;
  bins.set(range, bin);
  if (!hit) misses.push({ file, top: top.path, score: top.score, changed });
}

process.stdout.write(`${JSON.stringify({
  results,
  byStatus,
  labeled,
  bins: [...bins.values()].sort((a, b) => a.range.localeCompare(b.range)).map((bin) => ({
    ...bin,
    precision: Number((bin.hits / bin.n).toFixed(3)),
    ci95: wilson(bin.hits, bin.n),
    sufficient: bin.n >= MIN_SAMPLE,
  })),
  misses: misses.slice(0, 10),
  unreadable,
  note: NOTE,
}, null, 2)}\n`);
