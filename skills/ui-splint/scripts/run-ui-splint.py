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
      [--no-screenshots] [--probes]            # --probes enables MUTATING state probes (mock envs only)

Exit code: non-zero if any un-baselined Fail is found (so it can gate completion).
Requires: pip install playwright && playwright install chromium
"""

import sys
import os
import json
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDIT_JS = HERE / "audit.js"
DEFAULT_CONFIG = HERE / "audit-config.default.json"


def load_config(path):
    cfg = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8")) if DEFAULT_CONFIG.exists() else {}
    if path and Path(path).exists():
        user = json.loads(Path(path).read_text(encoding="utf-8"))
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
    ap.add_argument("--probes", action="store_true", help="Enable MUTATING probes (double-submit). Mock/stub envs ONLY.")
    args = ap.parse_args()

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
    routes = (args.routes.split(",") if args.routes else cfg.get("routes", ["/"]))
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
                    context.add_init_script(init)
                    page = context.new_page()
                    for state in states:
                        cell = {"route": route, "viewport": vp["name"], "theme": theme, "state": state}
                        try:
                            apply_state_route(page, state)  # mock network for empty/error/loading
                            response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                            if response and response.status >= 400:
                                raise RuntimeError(f"HTTP {response.status} loading {url}")
                            if wait_selector:
                                page.wait_for_selector(wait_selector, timeout=15000)
                            page.wait_for_timeout(400)
                            try:
                                page.evaluate("document.fonts && document.fonts.ready")
                            except Exception:
                                pass
                            if args.probes and state == "default":
                                run_probes(page)

                            cell_findings = []
                            for sp in scroll_positions:
                                scroll_to(page, sp)
                                page.wait_for_timeout(120)
                                report = page.evaluate(
                                    "(cfg) => window.__uiSplintAudit(cfg)",
                                    {**audit_cfg, "route": route, "theme": theme,
                                     "state": state, "isMobile": is_mobile, "baseline": baseline},
                                )
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
                            cell["status"] = "checked"
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
        "base_url": args.base_url, "matrix": coverage_cells,
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
def apply_state_route(page, state):
    """Route mocks for data states. Customize the URL pattern per project in config."""
    try:
        page.unroute("**/api/**")
    except Exception:
        pass
    if state == "empty":
        page.route("**/api/**", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    elif state == "error":
        page.route("**/api/**", lambda r: r.fulfill(status=503, content_type="application/json",
                                                     body='{"error":"Service Unavailable"}'))
    elif state == "loading":
        page.route("**/api/**", lambda r: None)  # never fulfilled -> stuck loading


def run_probes(page):
    """MUTATING probes — only call against mocked/stubbed environments."""
    try:
        page.evaluate("""() => {
          const btn = document.querySelector('button[type=submit],[type=submit],form button');
          if (btn) { btn.click(); btn.click(); }  // double-submit: should be guarded while pending
        }""")
    except Exception:
        pass


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
    """Collapse the same rule+selector seen across scroll/cells into one with instance count."""
    by = {}
    for f in findings:
        k = (f.get("rule"), f.get("selector"))
        if k in by:
            by[k]["instances"] = by[k].get("instances", 1) + 1
        else:
            f["instances"] = 1
            by[k] = f
    return list(by.values())


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
