#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

const argv = process.argv.slice(2);
const option = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const match = argv.find((item) => item.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`--${name} requires a value`);
    return value;
  }
  return fallback;
};

function fail(message) {
  process.stderr.write(`locate-source: ${message}\n`);
  process.exit(2);
}

function run(binary, args, cwd) {
  return spawnSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function readInput(path) {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(path), "utf8");
  return JSON.parse(raw);
}

function normalizePath(repoRoot, path) {
  const absolute = isAbsolute(path) ? path : resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute).split(sep).join("/");
  if (!rel || rel === "." || rel.startsWith("../") || rel === "..") return null;
  return rel;
}

function sourceFile(path) {
  if (/^(?:node_modules|\.git|dist|build|\.next|out|coverage)\//.test(path)) return false;
  return /\.(?:[cm]?[jt]sx?|css|scss|sass|less|vue|svelte|html?|mdx)$/.test(path);
}

function safeFilePath(repoRoot, path) {
  try {
    const real = realpathSync(resolve(repoRoot, path));
    const rel = relative(repoRoot, real);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? real : null;
  } catch {
    return null;
  }
}

function listFiles(repoRoot) {
  const git = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], repoRoot);
  if (git.status !== 0) fail(`git ls-files failed: ${(git.stderr || "").trim()}`);
  return git.stdout.split("\0").filter(Boolean).map((path) => path.split(sep).join("/"))
    .filter(sourceFile).filter((path) => safeFilePath(repoRoot, path));
}

function available(binary) {
  const probe = run(binary, ["--version"], process.cwd());
  return probe.status === 0;
}

function fixedMatches(repoRoot, files, query, useRg) {
  if (!query || query.length < 2 || query.length > 800) return [];
  if (useRg) {
    const found = run("rg", ["-l", "-F", "--no-messages", "--", query, repoRoot], repoRoot);
    if (found.status !== 0 && found.status !== 1) return [];
    const allowed = new Set(files);
    return found.stdout.split(/\r?\n/).filter(Boolean).map((path) => normalizePath(repoRoot, path))
      .filter((path) => path && allowed.has(path));
  }
  const result = [];
  for (const path of files) {
    try {
      const safePath = safeFilePath(repoRoot, path);
      if (safePath && readFileSync(safePath, "utf8").includes(query)) result.push(path);
    } catch { /* unreadable source is not a candidate */ }
  }
  return result;
}

function cleanText(value, max = 160) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length < 2 || text.length > max) return null;
  return text;
}

function classTokens(className) {
  return String(className || "").split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 3 && token.length <= 100)
    .filter((token) => !/^(active|hidden|block|flex|grid|relative|absolute|container|row|col|button|btn)$/.test(token))
    .slice(0, 18);
}

function routeSignals(url) {
  try {
    return new URL(url).pathname.split("/").filter((part) => part.length >= 3 && !/^\d+$/.test(part)).slice(-4);
  } catch {
    return [];
  }
}

function suffixHint(value, files) {
  if (!value) return null;
  let decoded = String(value);
  try { decoded = decodeURIComponent(decoded); } catch { /* keep original */ }
  decoded = decoded.replace(/^webpack:\/\/?/, "").replace(/^file:\/\//, "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/@fs\//, "/");
  decoded = decoded.split(/[?#]/)[0].replace(/\\/g, "/");
  const direct = files.find((file) => decoded.endsWith(`/${file}`) || decoded === file || decoded.endsWith(file));
  if (direct) return direct;
  const base = decoded.split("/").pop();
  const basenameMatches = files.filter((file) => file.split("/").pop() === base);
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function linePreview(repoRoot, path, queries) {
  try {
    const safePath = safeFilePath(repoRoot, path);
    if (!safePath) return null;
    const lines = readFileSync(safePath, "utf8").split(/\r?\n/);
    for (const query of queries) {
      const index = lines.findIndex((line) => line.includes(query));
      if (index >= 0) return { line: index + 1, preview: lines[index].trim().slice(0, 240) };
    }
  } catch { /* optional preview */ }
  return null;
}

const repoArg = option("repo", process.cwd());
const inputArg = option("input", "-");
let repoRoot;
try { repoRoot = realpathSync(resolve(repoArg)); }
catch { fail(`repo does not exist: ${repoArg}`); }
let request;
try { request = readInput(inputArg); }
catch (error) { fail(`could not read input: ${error.message}`); }
const picks = Array.isArray(request.payload?.picks)
  ? request.payload.picks
  : Array.isArray(request.picks)
    ? request.picks
    : request.element ? [request.element] : [];
if (!Array.isArray(picks) || !picks.length) fail("input does not contain any picks");
const files = listFiles(repoRoot);
const fileSet = new Set(files);
const useRg = available("rg");
const signals = [];
const directSignals = [];

function addSignal(family, label, query, weight) {
  const normalized = cleanText(query, 800);
  if (!normalized || signals.some((signal) => signal.family === family && signal.query === normalized)) return;
  signals.push({ family, label, query: normalized, weight });
}

function addDirect(family, label, path, weight) {
  if (path && fileSet.has(path)) directSignals.push({ family, label, path, weight });
}

for (const pick of picks) {
  const attrs = pick.attributes || {};
  addSignal("attribute", "data-testid", attrs.dataTestId, 0.42);
  addSignal("attribute", "aria-label", attrs.ariaLabel || pick.ariaLabel, 0.36);
  addSignal("attribute", "id", attrs.id || pick.id, 0.34);
  addSignal("attribute", "name", attrs.name || pick.name, 0.3);
  const classes = attrs.class || pick.className || "";
  const sequence = cleanText(classes, 400);
  if (sequence && sequence.includes(" ")) addSignal("class", "class sequence", sequence, 0.38);
  for (const token of classTokens(classes)) addSignal("class", `class ${token}`, token, 0.16);
  addSignal("text", "visible text", cleanText(pick.text, 120), 0.34);
  addSignal("text", "accessible name", cleanText(pick.accessibleName, 120), 0.3);
  for (const nearby of (pick.nearbyText || []).slice(0, 5)) addSignal("nearby", "nearby text", cleanText(nearby, 120), 0.13);
  for (const hint of pick.sourceHints?.react || []) {
    const hinted = suffixHint(hint.fileName, files);
    addDirect("runtime", `React source ${hint.component || "component"}`, hinted, 0.58);
    if (hint.component && hint.component.length >= 3) addSignal("component", `React component ${hint.component}`, hint.component, 0.28);
  }
  for (const rule of pick.sourceHints?.matchedStyles || []) {
    const hinted = suffixHint(rule.sourceUrl, files);
    addDirect("css-origin", `matched CSS ${rule.selectorText || "rule"}`, hinted, 0.6);
    addSignal("css-selector", "matched CSS selector", cleanText(rule.selectorText, 180), 0.25);
  }
  for (const part of routeSignals(pick.frame?.url || request.target?.url || "")) addSignal("route", `route ${part}`, part, 0.14);
}

const candidates = new Map();
function candidate(path) {
  if (!candidates.has(path)) candidates.set(path, { path, familyScores: {}, signals: [], queries: [] });
  return candidates.get(path);
}

for (const direct of directSignals) {
  const entry = candidate(direct.path);
  entry.familyScores[direct.family] = Math.max(entry.familyScores[direct.family] || 0, direct.weight);
  entry.signals.push({ family: direct.family, label: direct.label, weight: direct.weight, direct: true });
}

for (const signal of signals) {
  const matches = fixedMatches(repoRoot, files, signal.query, useRg);
  if (!matches.length) continue;
  const uniqueness = matches.length === 1 ? 1 : matches.length <= 3 ? 0.82 : matches.length <= 8 ? 0.62 : 0.3;
  for (const path of matches) {
    const entry = candidate(path);
    const contribution = signal.weight * uniqueness;
    const cap = { attribute: 0.45, class: 0.4, text: 0.36, nearby: 0.16, route: 0.18, component: 0.3, "css-selector": 0.28 }[signal.family] || 0.5;
    entry.familyScores[signal.family] = Math.min(cap, (entry.familyScores[signal.family] || 0) + contribution);
    entry.signals.push({ family: signal.family, label: signal.label, query: signal.query, filesMatched: matches.length, weight: Number(contribution.toFixed(3)) });
    entry.queries.push(signal.query);
  }
}

const ranked = Array.from(candidates.values()).map((entry) => {
  const families = Object.entries(entry.familyScores).filter(([, score]) => score > 0);
  const score = Math.min(1, families.reduce((sum, [, value]) => sum + value, 0));
  const preview = linePreview(repoRoot, entry.path, entry.queries);
  return {
    path: entry.path,
    score: Number(score.toFixed(3)),
    signalFamilies: families.map(([family]) => family),
    signals: entry.signals.sort((a, b) => b.weight - a.weight).slice(0, 10),
    ...(preview ? { matches: [preview] } : { matches: [] }),
  };
}).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 8);

const top = ranked[0];
const second = ranked[1];
const margin = top ? top.score - (second?.score || 0) : 0;
const confidence = top && top.score >= 0.82 && top.signalFamilies.length >= 2 && margin >= 0.12
  ? "high"
  : top && top.score >= 0.55 ? "medium" : "low";
const warnings = [];
if (!useRg) warnings.push("rg was unavailable; used the slower Node file-scan fallback");
if (!ranked.length) warnings.push("no source file matched the selected element evidence");
if (top && second && margin < 0.12) warnings.push(`top candidates are separated by only ${margin.toFixed(3)}`);
if (top && top.signalFamilies.length < 2) warnings.push("top candidate lacks two independent signal families");

process.stdout.write(`${JSON.stringify({
  protocolVersion: 2,
  repoRoot,
  confidence,
  thresholds: { highScore: 0.82, highMargin: 0.12, mediumScore: 0.55, independentFamilies: 2 },
  candidates: ranked,
  warnings,
})}\n`);
