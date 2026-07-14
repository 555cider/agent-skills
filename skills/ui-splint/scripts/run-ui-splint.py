#!/usr/bin/env python3
"""
ui-splint runner — drives a route x viewport x theme x state matrix, injects the
deterministic audit (audit.js) into every rendered state, captures viewport-clipped
screenshots + per-finding element crops, and writes findings.json + coverage.json.

This is the BATCH/CI path. Interactively, you can instead inject audit.js via the
Playwright or chrome-devtools MCP (browser_evaluate / evaluate_script) — see SKILL.md.

Why not the old capture.py approach: full-page stitched screenshots HIDE the
sticky-bar-overlaps-content defect class and downscale away small-text contrast.
This runner measures defects in the live DOM instead of asking a model to eyeball them.

Usage:
  python3 run-ui-splint.py http://localhost:3000 \
      [--config audit-config.json] [--out-dir .ui-splint] [--routes /,/login] \
      [--no-screenshots]

Exit code: non-zero if any un-baselined Fail is found (so it can gate completion).
Requires: pip install playwright && playwright install chromium
"""

import sys
import os
import json
import argparse
import datetime as _dt
import copy
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDIT_JS = HERE / "audit.js"
DEFAULT_CONFIG = HERE / "audit-config.default.json"


def load_config(path):
    cfg = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8")) if DEFAULT_CONFIG.exists() else {}
    # An explicitly-passed --config must not silently fall back to defaults on a typo'd path.
    if path:
        p = Path(path)
        if not p.exists():
            sys.stderr.write(f"--config file not found: {path}\n")
            sys.exit(2)
        user = json.loads(p.read_text(encoding="utf-8"))
        cfg.update(user)
    return cfg


def init_script():
    """audit.js + auto-install of the CLS observer, run BEFORE page scripts."""
    src = AUDIT_JS.read_text(encoding="utf-8")
    return src + "\n;try{window.__uiSplintInstallCLS&&window.__uiSplintInstallCLS();}catch(e){}\n"


def main():
    ap = argparse.ArgumentParser(description="Run the ui-splint deterministic audit across a render matrix.")
    ap.add_argument("base_url", help="Base URL of the running app, e.g. http://localhost:3000")
    ap.add_argument("--config", default=None, help="Path to a project audit-config.json (merged over defaults)")
    ap.add_argument("--out-dir", default=".ui-splint", help="Output directory for screenshots + JSON")
    ap.add_argument("--routes", default=None, help="Comma-separated routes overriding config (e.g. /,/login)")
    ap.add_argument("--no-screenshots", action="store_true", help="Skip screenshot capture (audit JSON only)")
    args = ap.parse_args()

    # Error messages can carry page-derived text (selectors, aria-labels) that is
    # non-ASCII; the Windows console defaults to cp949 and would raise
    # UnicodeEncodeError mid-report. Force UTF-8 with replacement where supported.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.stderr.write(
            "Error: 'playwright' is not installed.\n"
            "Prefer the zero-dependency runner (no pip needed), which drives an installed Chrome:\n"
            "  node audit-chrome.mjs <url> [--config audit-config.json]\n"
            "Or install Playwright:  pip install playwright && playwright install chromium\n"
            "Or run the audit interactively via the Playwright/chrome-devtools MCP — see SKILL.md.\n"
        )
        sys.exit(2)

    if not AUDIT_JS.exists():
        sys.stderr.write(f"Error: audit.js not found at {AUDIT_JS}\n")
        sys.exit(2)

    cfg = load_config(args.config)
    raw_routes = (args.routes.split(",") if args.routes else cfg.get("routes", ["/"]))
    # Trim whitespace and ensure a leading slash so `--routes "/ , login"` still
    # composes into valid URLs.
    routes = []
    for r in raw_routes:
        r = str(r).strip()
        if not r:
            continue
        routes.append(r if r.startswith("/") else "/" + r)
    if not routes:
        routes = ["/"]
    api_mock_pattern = cfg.get("apiMockPattern", "**/api/**")
    state_mocks = cfg.get("stateMocks", {})
    theme_init_scripts = cfg.get("themeInitScripts", {})
    viewports = cfg.get("viewports", [
        {"name": "mobile", "width": 390, "height": 844, "isMobile": True, "dpr": 3},
        {"name": "desktop", "width": 1280, "height": 900, "isMobile": False, "dpr": 1},
    ])
    themes = cfg.get("themes", ["light", "dark"])
    states = cfg.get("states", ["default"])
    scroll_positions = cfg.get("scrollPositions", ["top", "bottom"])
    wait_selector = cfg.get("waitForSelector")
    baseline = cfg.get("baseline", [])
    audit_cfg = cfg.get("auditConfig", {})

    out_dir = Path(args.out_dir)
    (out_dir / "screens").mkdir(parents=True, exist_ok=True)
    init = init_script()

    all_findings = []
    coverage_cells = []
    UA_MOBILE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
                 "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    UA_DESKTOP = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for route in routes:
            url = args.base_url.rstrip("/") + route
            for vp in viewports:
                is_mobile = bool(vp.get("isMobile"))
                for theme in themes:
                    context = browser.new_context(
                        viewport={"width": vp["width"], "height": vp["height"]},
                        device_scale_factor=vp.get("dpr", 1),
                        # NB: do NOT set is_mobile=True — combined with dpr>1 Playwright reports a
                        # bogus innerHeight (height x (dpr+1)) which breaks all geometry rules.
                        # has_touch gives touch emulation; the audit gets isMobile via auditConfig.
                        has_touch=is_mobile,
                        user_agent=UA_MOBILE if is_mobile else UA_DESKTOP,
                        color_scheme=theme,
                    )
                    theme_script = theme_init_scripts.get(theme)
                    if theme_script:
                        context.add_init_script(
                            "(()=>{const run=()=>{try{" + str(theme_script) +
                            "\n;window.__uiSplintThemeInit={ok:true};}catch(e){window.__uiSplintThemeInit={ok:false,error:String(e&&e.message||e)};}};"
                            "if(document.documentElement)run();else{const o=new MutationObserver(()=>{if(document.documentElement){o.disconnect();run();}});o.observe(document,{childList:true});}})();"
                        )
                    context.add_init_script(init)
                    page = context.new_page()
                    for state in states:
                        cell = {
                            "route": route, "viewport": vp["name"], "theme": theme, "state": state,
                            "themeDriver": "init-script" if theme_script else "media",
                        }
                        try:
                            state_route = apply_state_route(
                                page, state, api_mock_pattern, state_mocks
                            )  # mock network for empty/error/loading
                            cell["stateDriver"] = state_route["driver"]
                            response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                            if response and response.status >= 400:
                                raise RuntimeError(f"HTTP {response.status} loading {url}")
                            if theme_script:
                                theme_proof = page.evaluate("window.__uiSplintThemeInit || {ok:false,error:'theme init did not run'}")
                                if not theme_proof.get("ok"):
                                    raise RuntimeError(f"theme init failed: {theme_proof.get('error')}")
                            if wait_selector:
                                page.wait_for_selector(wait_selector, timeout=15000)
                            page.wait_for_timeout(400)
                            try:
                                page.evaluate("document.fonts && document.fonts.ready")
                            except Exception:
                                pass
                            cell_findings = []
                            cell_rules_skipped = []
                            for sp in scroll_positions:
                                scroll_to(page, sp)
                                page.wait_for_timeout(120)
                                report = page.evaluate(
                                    "(cfg) => window.__uiSplintAudit(cfg)",
                                    {**audit_cfg, "route": route, "theme": theme,
                                     "state": state, "isMobile": is_mobile, "baseline": baseline},
                                )
                                for skipped in report.get("coverage", {}).get("rulesSkipped", []):
                                    if skipped not in cell_rules_skipped:
                                        cell_rules_skipped.append(skipped)
                                for f in report.get("findings", []):
                                    f["scroll"] = sp
                                    f["cell"] = cell
                                cell_findings += report.get("findings", [])
                                if not args.no_screenshots and sp in ("top", "bottom"):
                                    shot = out_dir / "screens" / f"{slug(route)}_{vp['name']}_{theme}_{state}_{sp}.png"
                                    page.screenshot(path=str(shot))  # viewport-clipped (NOT full_page)
                            deduped = dedupe(cell_findings)
                            all_findings += deduped
                            cell["counts"] = count_sev(deduped)
                            if cell_rules_skipped:
                                cell["rulesSkipped"] = cell_rules_skipped
                                cell["status"] = "error"
                                cell["error"] = "audit rule(s) skipped: " + "; ".join(cell_rules_skipped)
                            else:
                                cell["interceptions"] = state_route["interceptions"]
                                status, reason = state_coverage(state, state_route)
                                cell["status"] = status
                                if reason:
                                    cell["reason"] = reason
                        except Exception as e:
                            cell["status"] = "error"
                            cell["error"] = str(e)
                            sys.stderr.write(f"  ! {cell}: {e}\n")
                        coverage_cells.append(cell)
                        print(f"  audited {cell.get('status')}: {route} {vp['name']} {theme} {state} "
                              f"-> {cell.get('counts', {})}")
                    context.close()
        browser.close()

    findings = dedupe_global(all_findings)
    (out_dir / "findings.json").write_text(json.dumps(findings, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "coverage.json").write_text(json.dumps({
        "base_url": args.base_url,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "matrix": coverage_cells,
        "totals": count_sev(findings),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    totals = count_sev(findings)
    print(f"\nUI Splint: {totals} across {len(coverage_cells)} matrix cells -> {out_dir}/findings.json")
    errors = [cell for cell in coverage_cells if cell.get("status") != "checked"]
    if errors:
        print(f"BLOCKED: {len(errors)} matrix cell(s) were not verified. Review coverage.json before claiming the work complete.")
        sys.exit(1)
    fails = [f for f in findings if f.get("severity") == "Fail"]
    if fails:
        print(f"BLOCKED: {len(fails)} un-baselined Fail finding(s). Review before claiming the work complete.")
        sys.exit(1)
    sys.exit(0)


# ----- state + interaction helpers -----
def apply_state_route(page, state, api_pattern="**/api/**", state_mocks=None):
    """Install a state mock and return proof of whether it intercepted a request.

    Merely registering a Playwright route does not prove that the rendered page
    requested the mocked resource. Callers must only mark a non-default matrix
    cell checked after ``interceptions`` becomes non-zero.
    """
    state_mocks = state_mocks or {}
    owned_patterns = {api_pattern}
    for configured in state_mocks.values():
        if isinstance(configured, list):
            owned_patterns.update(str(rule.get("pattern")) for rule in configured if isinstance(rule, dict) and rule.get("pattern"))
    for pattern in owned_patterns:
        try:
            page.unroute(pattern)
        except Exception:
            pass

    rules = state_mocks.get(state)
    driver = "configured-mock" if rules is not None else "fallback-mock"
    if rules is None:
        fallback = {
            "empty": [{"pattern": api_pattern, "status": 200, "contentType": "application/json", "body": []}],
            "error": [{"pattern": api_pattern, "status": 503, "contentType": "application/json", "body": {"error": "Service Unavailable"}}],
            "loading": [{"pattern": api_pattern, "hold": True}],
        }
        rules = fallback.get(state, [])
        if not rules:
            driver = "page-default" if state == "default" else "none"
    if not isinstance(rules, list):
        raise ValueError(f"stateMocks.{state} must be an array")
    tracker = {
        "state": state,
        "patterns": [str(rule.get("pattern", "")) for rule in rules if isinstance(rule, dict)],
        "configured": bool(rules),
        "interceptions": 0,
        "driver": driver,
    }
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict) or not rule.get("pattern"):
            raise ValueError(f"stateMocks.{state}[{index}] requires pattern")
        if bool(rule.get("hold")) == ("body" in rule):
            raise ValueError(f"stateMocks.{state}[{index}] requires exactly one of body or hold:true")

        def handler(route, spec=rule):
            tracker["interceptions"] += 1
            if spec.get("hold"):
                return None
            body = spec.get("body")
            if not isinstance(body, str):
                body = json.dumps(body, ensure_ascii=False)
            route.fulfill(
                status=int(spec.get("status", 200)),
                content_type=str(spec.get("contentType", "application/json")),
                body=body,
            )

        page.route(str(rule["pattern"]), handler)
    return tracker


def state_coverage(state, tracker, api_pattern=None):
    """Return coverage status/reason from the state mock's interception proof."""
    if state == "default" or tracker["interceptions"] > 0:
        return "checked", None
    if tracker["configured"]:
        return (
            "not-forced",
            f"data state not forced: no request matched configured patterns {tracker['patterns']!r}",
        )
    return "not-forced", f"data state not forced: no mock is configured for state {state!r}"


def scroll_to(page, where):
    if where == "top":
        page.evaluate("window.scrollTo(0,0)")
    elif where == "bottom":
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    elif where == "mid":
        page.evaluate("window.scrollTo(0, document.body.scrollHeight/2)")


# ----- aggregation helpers -----
def dedupe(findings):
    seen, out = set(), []
    for f in findings:
        k = (f.get("rule"), f.get("selector"), f.get("message"))
        if k in seen:
            continue
        seen.add(k)
        out.append(f)
    return out


def dedupe_global(findings):
    """Aggregate a rule+selector within a route, preserving its worst evidence.

    Route is part of the identity because the same selector on two screens need
    not share a root cause. Within one route, the representative is the highest
    severity finding and ``cell`` remains its evidence pointer. ``cells`` records
    every distinct matrix cell that surfaced the aggregate.
    """
    severity_rank = {"Polish": 1, "Risk": 2, "Fail": 3}
    by = {}
    for f in findings:
        cell = copy.deepcopy(f.get("cell")) if isinstance(f.get("cell"), dict) else None
        route = cell.get("route") if cell else None
        k = (route, f.get("rule"), f.get("selector"))
        if k not in by:
            item = copy.deepcopy(f)
            item["instances"] = 1
            item["cells"] = [cell] if cell else []
            by[k] = item
            continue

        current = by[k]
        current["instances"] = current.get("instances", 1) + 1
        if cell and not any(same_cell(cell, seen) for seen in current["cells"]):
            current["cells"].append(cell)
        if severity_rank.get(f.get("severity"), 0) > severity_rank.get(current.get("severity"), 0):
            replacement = copy.deepcopy(f)
            replacement["instances"] = current["instances"]
            replacement["cells"] = current["cells"]
            by[k] = replacement
    return list(by.values())


def same_cell(left, right):
    """Compare matrix-cell identity without depending on counts/status metadata."""
    fields = ("route", "viewport", "theme", "state")
    return all(left.get(field) == right.get(field) for field in fields)


def count_sev(findings):
    c = {"Fail": 0, "Risk": 0, "Polish": 0}
    for f in findings:
        s = f.get("severity")
        if s in c:
            c[s] += 1
    return c


def slug(route):
    return (route.strip("/").replace("/", "_") or "root")


if __name__ == "__main__":
    main()
