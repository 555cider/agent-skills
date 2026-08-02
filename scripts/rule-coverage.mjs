function normalizeRules(value) {
  if (!Array.isArray(value)) return [];
  const unique = [];
  for (const rule of value) {
    if (typeof rule !== 'string' || !rule.trim() || unique.includes(rule)) continue;
    unique.push(rule);
  }
  return unique;
}

export function assessRuleCoverage(coverage, context = {}) {
  const manifest = coverage && typeof coverage === 'object' ? coverage : {};
  const rulesExpected = normalizeRules(manifest.rulesExpected);
  const rulesRun = normalizeRules(manifest.rulesRun);
  const rulesSkipped = normalizeRules(manifest.rulesSkipped);
  const rulesMissing = rulesExpected.filter(rule => !rulesRun.includes(rule));
  const result = {
    scroll: context.scroll ?? null,
    phase: context.phase ?? null,
    status: 'checked',
    rulesExpected,
    rulesRun,
    rulesMissing,
    rulesSkipped,
  };

  if (!Array.isArray(manifest.rulesExpected)) {
    result.status = 'error';
    result.error = 'audit coverage did not report rulesExpected';
  } else if (!rulesExpected.length) {
    result.status = 'error';
    result.error = 'audit coverage expected zero rules';
  } else if (!Array.isArray(manifest.rulesRun)) {
    result.status = 'error';
    result.error = 'audit coverage did not report rulesRun';
  } else if (!Array.isArray(manifest.rulesSkipped)) {
    result.status = 'error';
    result.error = 'audit coverage did not report rulesSkipped';
  } else if (rulesSkipped.length) {
    result.status = 'error';
    result.error = 'audit rule(s) skipped: ' + rulesSkipped.join('; ');
  } else if (rulesMissing.length) {
    result.status = 'error';
    result.error = 'audit rule(s) did not run: ' + rulesMissing.join(', ');
  }

  return result;
}
