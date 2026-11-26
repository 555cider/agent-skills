from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock


SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts" / "plan-graph.py"
sys.path.insert(0, str(SKILL / "scripts"))

from plan_graph.model import make_plan, render_plan  # noqa: E402
from plan_graph.routing import build_context, critical_path, topological_order  # noqa: E402
from plan_graph.store import (  # noqa: E402
    PlanGraphError,
    apply_plan_set,
    find_cycle,
    load_store,
    lock_path_for,
)


def _symlinks_usable() -> bool:
    """Whether this process can actually create one, not whether the API exists.

    `os.symlink` is present on Windows and raises WinError 1314 unless the account holds
    SeCreateSymbolicLinkPrivilege — off by default outside Developer Mode. Guarding on
    `hasattr` therefore let two tests run and error out on every ordinary Windows
    checkout, which is indistinguishable in CI output from the security check they
    protect having broken.
    """
    if not hasattr(os, "symlink"):
        return False
    with tempfile.TemporaryDirectory() as probe:
        target = Path(probe) / "target"
        target.mkdir()
        try:
            os.symlink(target, Path(probe) / "link", target_is_directory=True)
        except (OSError, NotImplementedError, AttributeError):
            return False
    return True


SYMLINKS_USABLE = _symlinks_usable()


class PlanGraphCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="plan-graph-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_cli(
        self,
        *args: str,
        expect: int = 0,
        root: bool = True,
        cwd: Path | None = None,
    ) -> tuple[dict[str, object], subprocess.CompletedProcess[str]]:
        command = [sys.executable, str(SCRIPT), *args]
        if root:
            command.extend(["--root", str(self.root)])
        command.append("--json")
        result = subprocess.run(
            command,
            cwd=cwd or SKILL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
        )
        self.assertEqual(
            result.returncode,
            expect,
            msg=f"command: {' '.join(command)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["ok"], expect == 0)
        self.assertEqual(
            set(payload),
            {"ok", "command", "root", "data", "diagnostics", "changes"},
        )
        return payload, result

    def create(
        self,
        plan_id: str,
        *,
        title: str | None = None,
        scopes: tuple[str, ...] = (),
        tags: tuple[str, ...] = (),
        requires: tuple[str, ...] = (),
        parent: str | None = None,
    ) -> dict[str, object]:
        args = ["create", plan_id, "--title", title or plan_id.replace("-", " ").title()]
        if parent is not None:
            args.extend(["--parent", parent])
        for scope in scopes:
            args.extend(["--scope", scope])
        for tag in tags:
            args.extend(["--tag", tag])
        for base in requires:
            args.extend(["--require", base])
        payload, _ = self.run_cli(*args)
        return payload

    def plan_file(self, plan_id: str) -> Path:
        return self.root / ".agents" / "plans" / f"{plan_id}.md"

    def fill_sections(self, plan_id: str, *sections: str) -> None:
        path = self.plan_file(plan_id)
        content = path.read_text(encoding="utf-8")
        for section in sections or ("Outcome", "Decisions", "Completion"):
            content = content.replace(
                f"## {section}\n\nTBD", f"## {section}\n\n{section} recorded."
            )
        path.write_text(content, encoding="utf-8")

    def test_create_uses_strict_json_frontmatter_and_template(self) -> None:
        payload = self.create("auth-gate", scopes=("apps/backend/**",), tags=("auth",))
        self.assertEqual(payload["changes"][0]["action"], "create")
        content = self.plan_file("auth-gate").read_text(encoding="utf-8")
        self.assertTrue(content.startswith("---\n{\n"))
        self.assertIn('"status": "active"', content)
        self.assertNotIn('"id"', content)
        self.assertIn("# Auth Gate", content)
        for section in ("Outcome", "Evidence", "Decisions", "Implementation", "Acceptance", "Completion"):
            self.assertIn(f"## {section}", content)
        self.run_cli("doctor")

    def test_create_dry_run_has_no_filesystem_artifacts(self) -> None:
        payload, _ = self.run_cli(
            "create",
            "preview-only",
            "--title",
            "Preview only",
            "--tag",
            "preview",
            "--dry-run",
        )
        self.assertTrue(payload["data"]["dry_run"])
        self.assertEqual(payload["changes"][0]["action"], "create")
        self.assertFalse((self.root / ".agents").exists())
        self.assertFalse((self.root / ".plan-graph.lock").exists())

    def test_strict_json_rejects_duplicate_keys_and_constants(self) -> None:
        directory = self.root / ".agents" / "plans"
        directory.mkdir(parents=True)
        template = """---
{{
  "status": {status},
  "requires": [],
  "replaces": [],
  "scope": [],
  "tags": ["test"]{extra}
}}
---
# Bad

## Outcome

x

## Evidence

x

## Decisions

x

## Implementation

x

## Acceptance

x

## Completion

x
"""
        (directory / "duplicate.md").write_text(
            template.format(status='"active"', extra=',\n  "status": "done"'),
            encoding="utf-8",
        )
        (directory / "constant.md").write_text(
            template.format(status="NaN", extra=""),
            encoding="utf-8",
        )
        payload, _ = self.run_cli("doctor", expect=1)
        invalid = {
            item["plan"]
            for item in payload["diagnostics"]
            if item["code"] == "invalid_json"
        }
        self.assertEqual(invalid, {"constant", "duplicate"})

    def test_context_routes_paths_query_dependencies_and_affected_plans(self) -> None:
        self.create("quality-gate", scopes=("apps/backend/analysis/**",), tags=("quality",))
        self.create(
            "simulation-core",
            scopes=("apps/backend/simulation/**",),
            tags=("시뮬레이션", "grounding"),
            requires=("quality-gate",),
        )
        self.create(
            "simulation-ui",
            scopes=("apps/frontend/simulation/**",),
            tags=("simulation ui",),
            requires=("simulation-core",),
        )
        selected, _ = self.run_cli(
            "context",
            "--path",
            "apps/backend/simulation/engine.py",
            "--query",
            "시뮬레이션 grounding",
        )
        self.assertEqual(selected["data"]["selected"], ["simulation-core"])
        self.assertEqual(selected["data"]["required"], ["quality-gate"])
        self.assertEqual(selected["data"]["affected"], ["simulation-ui"])
        self.assertEqual(
            selected["data"]["read_order"],
            ["quality-gate", "simulation-core", "simulation-ui"],
        )
        roles = {item["id"]: item["role"] for item in selected["data"]["decision_pack"]}
        self.assertEqual(
            roles,
            {"quality-gate": "required", "simulation-core": "selected", "simulation-ui": "affected"},
        )
        self.assertIn("matched_by", selected["data"]["decision_pack"][1])

    def test_git_root_and_default_dirty_path_routing(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.name", "Test"], check=True)
        self.create("backend", scopes=("apps/backend/**",), tags=("backend",))
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "seed"], check=True)
        nested = self.root / "apps" / "backend"
        nested.mkdir(parents=True)
        (nested / "service.py").write_text("changed = True\n", encoding="utf-8")
        payload, _ = self.run_cli("context", root=False, cwd=nested)
        self.assertEqual(payload["root"], str(self.root.resolve()))
        self.assertEqual(payload["data"]["selected"], ["backend"])
        self.assertFalse((nested / ".agents").exists())

        rejected, _ = self.run_cli(
            "doctor", "--root", str(nested), expect=1, root=False, cwd=nested
        )
        self.assertEqual(rejected["diagnostics"][0]["code"], "root_not_toplevel")

    def test_status_derives_readiness_and_critical_path(self) -> None:
        self.create("base", tags=("base",))
        self.create("middle", tags=("middle",), requires=("base",))
        self.create("leaf", tags=("leaf",), requires=("middle",))
        payload, _ = self.run_cli("status")
        self.assertEqual([item["id"] for item in payload["data"]["ready"]], ["base"])
        self.assertEqual([item["id"] for item in payload["data"]["waiting"]], ["middle", "leaf"])
        self.assertEqual(payload["data"]["critical_path"], ["base", "middle", "leaf"])

    def test_update_preserves_body_and_rejects_cycle(self) -> None:
        self.create("base", tags=("base",))
        self.create("child", tags=("child",), requires=("base",))
        child_path = self.plan_file("child")
        content = child_path.read_text(encoding="utf-8").replace(
            "## Outcome\n\nTBD", "## Outcome\n\nCustom body marker"
        )
        child_path.write_text(content, encoding="utf-8")
        self.run_cli("update", "child", "--add-scope", "apps/child/**")
        self.assertIn("Custom body marker", child_path.read_text(encoding="utf-8"))
        before = self.plan_file("base").read_bytes()
        failed, _ = self.run_cli("update", "base", "--add-require", "child", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "cycle")
        self.assertEqual(self.plan_file("base").read_bytes(), before)

    def test_rename_updates_all_requirements(self) -> None:
        self.create("old-base", tags=("base",))
        self.create("child", tags=("child",), requires=("old-base",))
        payload, _ = self.run_cli("rename", "old-base", "new-base", "--title", "New Base")
        self.assertEqual(payload["changes"][0], {"action": "rename", "from": "old-base", "to": "new-base"})
        store = load_store(self.root)
        self.assertEqual(set(store.plans), {"new-base", "child"})
        self.assertEqual(store.plans["child"].requires, ("new-base",))
        self.assertEqual(store.plans["new-base"].title, "New Base")

    def test_replace_refuses_active_dependents_then_records_tombstone(self) -> None:
        self.create("old", tags=("old",))
        self.create("dependent", tags=("dep",), requires=("old",))
        failed, _ = self.run_cli(
            "replace", "old", "new", "--title", "New", "--tag", "new", expect=1
        )
        self.assertEqual(failed["diagnostics"][0]["code"], "active_dependents")
        self.run_cli("drop", "dependent")
        self.run_cli("replace", "old", "new", "--title", "New", "--tag", "new")
        store = load_store(self.root)
        self.assertEqual(store.plans["new"].replaces, ("old",))
        reused, _ = self.run_cli("create", "old", "--title", "Again", "--tag", "again", expect=1)
        self.assertEqual(reused["diagnostics"][0]["code"], "id_reused")

    def test_close_retains_required_done_then_prunes_closed_tree(self) -> None:
        self.create("base", tags=("base",))
        self.create("child", tags=("child",), requires=("base",))
        self.fill_sections("base")
        self.fill_sections("child")
        self.run_cli("close", "base")
        store = load_store(self.root)
        self.assertEqual(store.plans["base"].status, "done")
        dry, _ = self.run_cli("close", "child", "--dry-run")
        self.assertEqual(
            [item["plan"] for item in dry["changes"] if item["action"] == "prune"],
            ["base", "child"],
        )
        self.assertTrue(self.plan_file("base").exists())
        self.run_cli("close", "child")
        self.assertEqual(load_store(self.root).plans, {})

    def git(self, *args: str) -> None:
        subprocess.run(["git", "-C", str(self.root), *args], check=True)

    def churned_repo(self, commits: int = 5) -> Path:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        self.create("core", scopes=("apps/core/**",), tags=("core",))
        target = self.root / "apps" / "core" / "engine.py"
        target.parent.mkdir(parents=True)
        target.write_text("seed\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "seed")
        for index in range(commits):
            target.write_text(f"rev {index}\n", encoding="utf-8")
            self.git("commit", "-aqm", f"churn {index}")
        return target

    def test_doctor_warns_stale_plan_after_scope_churn(self) -> None:
        self.churned_repo(commits=5)
        payload, _ = self.run_cli("doctor")
        stale = [item for item in payload["diagnostics"] if item["code"] == "stale_plan"]
        self.assertEqual([item["plan"] for item in stale], ["core"])
        relaxed, _ = self.run_cli("doctor", "--stale-after", "10")
        self.assertNotIn("stale_plan", [item["code"] for item in relaxed["diagnostics"]])
        context, _ = self.run_cli("context", "--plan", "core")
        staleness = context["data"]["decision_pack"][0]["staleness"]
        self.assertEqual(staleness["state"], "stale")
        self.assertEqual(staleness["commits_since_plan_update"], 5)
        # Text output used to drop the staleness that JSON carried.
        self.assertIn("Staleness: stale", self.run_text("context", "--plan", "core"))

    def test_non_ascii_repository_path_is_discovered_and_aged(self) -> None:
        # git prints the toplevel as UTF-8; decoding it with the locale codec (cp949 on
        # a Korean Windows console) lost the root and broke discovery.
        self.root = self.root / "계획 저장소 🧠"
        self.root.mkdir()
        self.churned_repo(commits=5)
        payload, _ = self.run_cli("doctor", root=False, cwd=self.root)
        self.assertEqual(Path(str(payload["root"])).resolve(), self.root.resolve())
        stale = [item for item in payload["diagnostics"] if item["code"] == "stale_plan"]
        self.assertEqual([item["plan"] for item in stale], ["core"])

    def test_doctor_warns_overlapping_unrelated_active_plans(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.create("checkout-api", scopes=("apps/checkout/**",), tags=("checkout",))
        self.create("checkout-recovery", scopes=("apps/checkout/**",), tags=("recovery",))
        shared = self.root / "apps" / "checkout" / "service.py"
        shared.parent.mkdir(parents=True)
        shared.write_text("x\n", encoding="utf-8")
        payload, _ = self.run_cli("doctor")
        overlaps = [item for item in payload["diagnostics"] if item["code"] == "scope_overlap"]
        self.assertEqual(len(overlaps), 1)
        self.assertEqual(overlaps[0]["plan"], "checkout-api")

    def test_why_reports_blockers_staleness_overlap_and_lineage(self) -> None:
        self.create("auth-session", tags=("auth",))
        self.create(
            "checkout-api",
            scopes=("apps/checkout/**",),
            tags=("checkout",),
            requires=("auth-session",),
        )
        self.create("checkout-recovery", scopes=("apps/checkout/**",), tags=("recovery",))
        self.create("frontend", tags=("front",), requires=("checkout-api",))
        self.run_cli("update", "checkout-api", "--add-replace", "old-import")
        shared = self.root / "apps" / "checkout" / "service.py"
        shared.parent.mkdir(parents=True)
        shared.write_text("x\n", encoding="utf-8")
        payload, _ = self.run_cli("why", "checkout-api")
        data = payload["data"]
        self.assertEqual(data["plan"]["id"], "checkout-api")
        self.assertEqual(data["readiness"], "waiting")
        self.assertEqual(data["blockers"], ["auth-session"])
        self.assertEqual(data["dependents"]["active"], ["frontend"])
        self.assertEqual(data["staleness"]["state"], "unknown")
        self.assertEqual(
            data["overlaps"],
            [{"plan": "checkout-recovery", "shared_files": ["apps/checkout/service.py"]}],
        )
        self.assertEqual(
            data["lineage"],
            [
                {
                    "replaced": "old-import",
                    "recover": "git log --all -- .agents/plans/old-import.md",
                }
            ],
        )
        self.assertFalse(data["prunable"])
        self.assertIn("Completion", data["unfilled_sections"])

    def test_close_refuses_tbd_decision_sections(self) -> None:
        self.create("skeleton", tags=("skeleton",))
        failed, _ = self.run_cli("close", "skeleton", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "unverified_completion")
        self.assertIn("Outcome", failed["diagnostics"][0]["message"])
        self.assertEqual(load_store(self.root).plans["skeleton"].status, "active")

    def test_close_force_abandons_with_recovery_only_without_active_dependents(self) -> None:
        self.create("abandoned", tags=("abandoned",))
        self.create("keeper", tags=("keeper",), requires=("abandoned",))
        refused, _ = self.run_cli("close", "abandoned", "--force", expect=1)
        self.assertEqual(refused["diagnostics"][0]["code"], "active_dependents")
        self.assertEqual(load_store(self.root).plans["abandoned"].status, "active")
        self.run_cli("drop", "keeper")
        original = self.plan_file("abandoned").read_bytes()
        payload, _ = self.run_cli("close", "abandoned", "--force")
        self.assertTrue(payload["data"]["abandoned"])
        self.assertFalse(self.plan_file("abandoned").exists())
        recovery = Path(payload["data"]["recovery_directory"])
        self.assertEqual((recovery / "abandoned.md").read_bytes(), original)

    def test_close_preserves_latest_uncommitted_bytes_before_pruning(self) -> None:
        self.create("scratch", tags=("scratch",))
        self.fill_sections("scratch")
        original = self.plan_file("scratch").read_bytes()
        preview, _ = self.run_cli("close", "scratch", "--dry-run")
        self.assertFalse((self.root / ".agents" / "plan-recovery").exists())
        self.assertEqual(self.plan_file("scratch").read_bytes(), original)
        payload, _ = self.run_cli("close", "scratch")
        recovery = Path(payload["data"]["recovery_directory"])
        self.assertEqual((recovery / "scratch.md").read_bytes(), original)
        self.assertFalse(self.plan_file("scratch").exists())

    def test_recovery_write_failure_preserves_live_plan(self) -> None:
        self.create("scratch", tags=("scratch",))
        original = self.plan_file("scratch").read_bytes()
        before = load_store(self.root).plans
        with mock.patch("plan_graph.store._atomic_write_bytes", side_effect=OSError("backup unavailable")):
            with self.assertRaises(PlanGraphError) as raised:
                apply_plan_set(self.root, before, {})
        self.assertEqual(raised.exception.code, "recovery_failed")
        self.assertEqual(self.plan_file("scratch").read_bytes(), original)

    def test_whitespace_only_list_values_are_rejected_before_writing(self) -> None:
        # CLI values reach validation unstripped; a blank tag used to be written and then
        # broke every later command on load.
        failed, _ = self.run_cli("create", "a-plan", "--title", "A", "--tag", "   ", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "invalid_metadata")
        self.assertFalse(self.plan_file("a-plan").exists())
        self.create("b-plan", tags=("b",))
        failed, _ = self.run_cli("update", "b-plan", "--add-tag", "  ", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "invalid_metadata")

    def test_close_on_done_plan_reports_no_changes(self) -> None:
        self.create("base", tags=("base",))
        self.create("child", tags=("child",), requires=("base",))
        self.fill_sections("base")
        self.run_cli("close", "base")
        before = self.plan_file("base").read_bytes()
        for extra in ((), ("--force",)):
            failed, _ = self.run_cli("close", "base", *extra, expect=1)
            self.assertEqual(failed["diagnostics"][0]["code"], "no_changes")
        self.assertEqual(self.plan_file("base").read_bytes(), before)
        self.run_cli("reopen", "base")
        self.assertEqual(load_store(self.root).plans["base"].status, "active")

    def test_drop_refuses_indirect_active_dependent_through_done_plan(self) -> None:
        self.create("base", tags=("base",))
        self.create("middle", tags=("middle",), requires=("base",))
        self.create("leaf", tags=("leaf",), requires=("middle",))
        self.fill_sections("middle")
        self.run_cli("close", "middle")
        failed, _ = self.run_cli("drop", "base", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "active_dependents")
        self.assertIn("leaf", failed["diagnostics"][0]["message"])

    def test_gc_prunes_only_unretained_done_plans(self) -> None:
        self.create("keep", tags=("keep",))
        self.create("active", tags=("active",), requires=("keep",))
        self.fill_sections("keep")
        self.run_cli("close", "keep")
        orphan = make_plan(root=self.root, plan_id="orphan", title="Orphan", tags=["orphan"])
        orphan = replace(orphan, status="done")
        self.plan_file("orphan").write_text(render_plan(orphan), encoding="utf-8")
        doctor, _ = self.run_cli("doctor")
        self.assertIn("prunable_done", [item["code"] for item in doctor["diagnostics"]])
        status, _ = self.run_cli("status")
        self.assertEqual(
            [item["id"] for item in status["data"]["retained_done"]],
            ["keep"],
        )
        self.run_cli("gc")
        self.assertEqual(set(load_store(self.root).plans), {"keep", "active"})

    def test_doctor_reports_each_field_error_once(self) -> None:
        # parse_plan owns per-field checks; the graph pass used to repeat them, so doctor
        # printed every error twice -- and the second copy accepted scope ".".
        self.create("core", tags=("core",))
        path = self.plan_file("core")
        content = path.read_text(encoding="utf-8").replace(
            '"tags": [\n    "core"\n  ]', '"tags": ["core", "Core"]'
        ).replace('"scope": []', '"scope": ["."]')
        self.assertIn('"scope": ["."]', content)
        self.assertIn('"Core"', content)
        path.write_text(content, encoding="utf-8")
        payload, _ = self.run_cli("doctor", expect=1)
        errors = [
            (item["code"], item["message"])
            for item in payload["diagnostics"]
            if item["severity"] == "error"
        ]
        self.assertEqual(len(errors), len(set(errors)), errors)
        codes = [code for code, _ in errors]
        self.assertEqual(codes.count("invalid_scope"), 1)
        self.assertEqual(codes.count("duplicate_metadata"), 1)

    def test_doctor_ignores_store_in_nested_git_worktree(self) -> None:
        nested = self.root / ".worktrees" / "feature"
        nested.mkdir(parents=True)
        (nested / ".git").write_text("gitdir: /tmp/example\n", encoding="utf-8")
        (nested / ".agents" / "plans").mkdir(parents=True)
        payload, _ = self.run_cli("doctor")
        self.assertEqual(payload["diagnostics"], [])

    @unittest.skipUnless(SYMLINKS_USABLE, "this OS or account cannot create symlinks")
    def test_symlink_agents_parent_is_rejected_without_traversal(self) -> None:
        outside = self.root / "outside-agents"
        (outside / "plans").mkdir(parents=True)
        os.symlink(outside, self.root / ".agents", target_is_directory=True)
        payload, _ = self.run_cli("doctor", expect=1)
        codes = [item["code"] for item in payload["diagnostics"]]
        self.assertIn("symlink_store", codes)
        self.assertEqual(payload["data"]["counts"]["plans"], 0)

    def test_cli_writes_utf8_whatever_the_console_codepage_is(self) -> None:
        """Plan titles and queries are routinely non-ASCII, and the JSON must survive.

        Python picks the locale encoding for a redirected stdout on Windows, so this CLI
        emitted cp949 there while writing `ensure_ascii=False`. The caller does not even
        get an error: `subprocess.run` loses the decode exception in its reader thread and
        returns `stdout=None`, which reads as "the command printed nothing".
        """
        self.create("simulation-core", tags=("시뮬레이션",), title="시뮬레이션 접지")
        env = os.environ.copy()
        # The fix has to work unprompted; the escape hatch would hide its absence.
        env.pop("PYTHONIOENCODING", None)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "context", "--query", "시뮬레이션", "--root", str(self.root), "--json"],
            cwd=SKILL, capture_output=True, text=True, encoding="utf-8", env=env,
            timeout=20, stdin=subprocess.DEVNULL, check=False,
        )
        self.assertIsNotNone(result.stdout, "stdout failed to decode as UTF-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("시뮬레이션", result.stdout)

    def test_store_changed_after_read_is_concurrent_change(self) -> None:
        self.create("one", tags=("one",))
        stale = load_store(self.root).plans
        # Another writer changes the store between this read and the write.
        self.run_cli("update", "one", "--add-tag", "two")
        written = self.plan_file("one").read_bytes()
        after = {"one": replace(stale["one"], title="Renamed")}
        with self.assertRaises(PlanGraphError) as raised:
            apply_plan_set(self.root, stale, after)
        self.assertEqual(raised.exception.code, "concurrent_change")
        self.assertEqual(self.plan_file("one").read_bytes(), written)

    def test_live_lock_blocks_mutation_and_is_preserved(self) -> None:
        self.create("one", tags=("one",))
        lock = lock_path_for(self.root)
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(json.dumps({"pid": os.getpid(), "token": "foreign"}), encoding="utf-8")
        payload, _ = self.run_cli("update", "one", "--add-tag", "two", expect=1)
        self.assertEqual(payload["diagnostics"][0]["code"], "store_locked")
        self.assertTrue(lock.exists())

    @unittest.skipUnless(os.name == "nt", "Windows liveness contract")
    def test_windows_lock_probe_does_not_signal_owner(self) -> None:
        from plan_graph.store import FileLock
        lock = self.root / "probe.lock"
        lock.write_text(json.dumps({"pid": os.getpid(), "token": "foreign"}), encoding="utf-8")
        with mock.patch("plan_graph.store.os.kill", side_effect=AssertionError("must not signal on Windows")):
            self.assertFalse(FileLock(lock)._reclaim_stale())

    def test_transaction_rolls_back_partial_write_failure(self) -> None:
        self.create("base", tags=("base",))
        self.create("child", tags=("child",), requires=("base",))
        before_store = load_store(self.root).plans
        before_bytes = {plan_id: plan.path.read_bytes() for plan_id, plan in before_store.items()}
        after = {
            plan_id: replace(plan, tags=(*plan.tags, "changed"))
            for plan_id, plan in before_store.items()
        }
        from plan_graph import store as store_module

        real_write = store_module._atomic_write_bytes
        calls = 0

        def fail_second(path: Path, data: bytes) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected failure")
            real_write(path, data)

        with mock.patch.object(store_module, "_atomic_write_bytes", side_effect=fail_second):
            with self.assertRaises(PlanGraphError) as raised:
                apply_plan_set(self.root, before_store, after)
        self.assertEqual(raised.exception.code, "write_failed")
        for plan_id, data in before_bytes.items():
            self.assertEqual(self.plan_file(plan_id).read_bytes(), data)

    def run_text(self, *args: str, cwd: Path | None = None) -> str:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--root", str(self.root)],
            cwd=cwd or SKILL, capture_output=True, text=True, encoding="utf-8",
            timeout=20, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_fenced_code_headings_are_not_title_or_sections(self) -> None:
        # A `# comment` in a shell block read as a second H1: duplicate_title failed
        # every command, and `## step` inside a fence split a section in two.
        self.create("scripted", tags=("scripted",))
        path = self.plan_file("scripted")
        content = path.read_text(encoding="utf-8").replace(
            "## Implementation\n\nTBD",
            "## Implementation\n\nRun:\n\n```bash\n# install deps\nnpm ci\n## Outcome\n```\n\n"
            "~~~~\n# also code\n```\nstill code\n~~~~\nafter fences",
        )
        path.write_text(content, encoding="utf-8")
        doctor, _ = self.run_cli("doctor")
        self.assertEqual(
            [item for item in doctor["diagnostics"] if item["severity"] == "error"], []
        )
        plan = load_store(self.root).plans["scripted"]
        self.assertEqual(plan.title, "Scripted")
        self.assertIn("# install deps", plan.sections["Implementation"])
        self.assertTrue(plan.sections["Implementation"].endswith("after fences"))
        self.assertEqual(plan.sections["Outcome"], "TBD")
        self.run_cli("update", "scripted", "--title", "Scripted v2")
        updated = path.read_text(encoding="utf-8")
        self.assertIn("# Scripted v2\n", updated)
        self.assertIn("# install deps\n", updated)

    def test_relative_path_resolves_from_working_directory(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.create("checkout", scopes=("apps/checkout/**",), tags=("checkout",))
        self.create("billing", scopes=("apps/billing/api/*.py",), tags=("billing",))
        nested = self.root / "apps" / "checkout"
        nested.mkdir(parents=True)
        (self.root / "apps" / "billing" / "api").mkdir(parents=True)
        payload, _ = self.run_cli("context", "--path", "service.py", root=False, cwd=nested)
        self.assertEqual(payload["data"]["selectors"]["paths"], ["apps/checkout/service.py"])
        self.assertEqual(payload["data"]["selected"], ["checkout"])
        sibling, _ = self.run_cli("context", "--path", "../billing/api/x.py", root=False, cwd=nested)
        self.assertEqual(sibling["data"]["selected"], ["billing"])
        escape, _ = self.run_cli("context", "--path", "../../../x.py", root=False, cwd=nested, expect=1)
        self.assertEqual(escape["diagnostics"][0]["code"], "path_escape")

    def test_directory_path_selects_scopes_under_it(self) -> None:
        self.create("checkout", scopes=("apps/checkout/**",), tags=("checkout",))
        self.create("billing", scopes=("apps/billing/api/*.py",), tags=("billing",))
        self.create("docs", scopes=("docs/**",), tags=("docs",))
        (self.root / "apps" / "checkout" / "src").mkdir(parents=True)
        payload, _ = self.run_cli("context", "--path", "apps/checkout")
        self.assertEqual(payload["data"]["selectors"]["paths"], ["apps/checkout/"])
        self.assertEqual(payload["data"]["selected"], ["checkout"])
        for value, expected in (("apps", ["billing", "checkout"]), ("apps/billing/web/", [])):
            payload, _ = self.run_cli("context", "--path", value)
            self.assertEqual(sorted(payload["data"]["selected"]), expected, value)
        # A file path that does not exist is still a file, not a directory.
        missing, _ = self.run_cli("context", "--path", "apps/billing")
        self.assertEqual(missing["data"]["selectors"]["paths"], ["apps/billing"])
        self.assertEqual(missing["data"]["selected"], [])

    def test_git_history_timeout_warns_instead_of_failing(self) -> None:
        import plan_graph.store as store_module
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        real_run = subprocess.run
        calls: list[list[str]] = []

        def slow_log(command, *args, **kwargs):
            calls.append(list(command))
            if "log" in command:
                raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 10))
            return real_run(command, *args, **kwargs)

        with mock.patch.object(store_module.subprocess, "run", side_effect=slow_log):
            warnings = store_module.assert_new_id(self.root, {}, "fresh-id")
        self.assertEqual([item.code for item in warnings], ["id_history_unchecked"])
        log_calls = [call for call in calls if "log" in call]
        self.assertIn("--max-count=1", log_calls[0])

    def test_recovery_copies_live_in_common_git_dir_of_linked_worktree(self) -> None:
        self.churned_repo(commits=0)
        linked = self.root.parent / f"{self.root.name}-linked"
        self.git("worktree", "add", "-q", str(linked))
        self.addCleanup(lambda: subprocess.run(
            ["git", "-C", str(self.root), "worktree", "remove", "--force", str(linked)],
            check=False, capture_output=True,
        ))
        payload, _ = self.run_cli("close", "core", "--force", root=False, cwd=linked)
        recovery = Path(payload["data"]["recovery_directory"]).resolve()
        common = (self.root / ".git").resolve()
        self.assertEqual(recovery.parent, common / "plan-graph-recovery")
        self.git("worktree", "remove", "--force", str(linked))
        self.assertTrue((recovery / "core.md").exists())

    def test_nested_store_scan_uses_git_file_list(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".gitignore").write_text("build/\n", encoding="utf-8")
        tracked = self.root / "apps" / "web" / ".agents" / "plans"
        tracked.mkdir(parents=True)
        (tracked / "x.md").write_text("x\n", encoding="utf-8")
        legacy = self.root / "apps" / "old" / ".agents" / "plan"
        legacy.mkdir(parents=True)
        (legacy / "graph.yaml").write_text("next: 1\n", encoding="utf-8")
        ignored = self.root / "build" / ".agents" / "plans"
        ignored.mkdir(parents=True)
        (ignored / "y.md").write_text("y\n", encoding="utf-8")
        payload, _ = self.run_cli("doctor", expect=1)
        found = sorted((item["code"], item["path"]) for item in payload["diagnostics"])
        self.assertEqual(
            found,
            [
                ("nested_legacy_store", "apps/old/.agents/plan/graph.yaml"),
                ("nested_store", "apps/web/.agents/plans"),
            ],
        )


class PlanTreeTests(unittest.TestCase):
    """`parent`: plans split into pieces, a parent waiting for its active children."""

    # The CLI helpers, without inheriting (and rerunning) every CLI test.
    setUp = PlanGraphCliTests.setUp
    run_cli = PlanGraphCliTests.run_cli
    run_text = PlanGraphCliTests.run_text
    create = PlanGraphCliTests.create
    plan_file = PlanGraphCliTests.plan_file
    fill_sections = PlanGraphCliTests.fill_sections

    MISSING = object()

    def set_metadata(self, plan_id: str, key: str, value: object) -> None:
        path = self.plan_file(plan_id)
        content = path.read_text(encoding="utf-8")
        _, head, body = content.split("---\n", 2)
        metadata = json.loads(head)
        if value is self.MISSING:
            metadata.pop(key, None)
        else:
            metadata[key] = value
        path.write_text("---\n" + json.dumps(metadata, indent=2) + "\n---\n" + body, encoding="utf-8")

    def codes(self, payload: dict[str, object], severity: str | None = None) -> list[str]:
        return [
            item["code"]
            for item in payload["diagnostics"]
            if severity is None or item["severity"] == severity
        ]

    def test_parent_key_is_optional_and_validated(self) -> None:
        self.create("root-plan", tags=("root",))
        before = self.plan_file("root-plan").read_text(encoding="utf-8")
        self.assertNotIn('"parent"', before)
        self.create("piece", tags=("piece",), parent="root-plan")
        content = self.plan_file("piece").read_text(encoding="utf-8")
        self.assertIn('"parent": "root-plan"', content)
        self.assertEqual(load_store(self.root).plans["piece"].parent, "root-plan")
        doctor, _ = self.run_cli("doctor", "--structural-only")
        self.assertEqual(self.codes(doctor, "error"), [])
        for value, code in ((None, "invalid_metadata"), ("", "invalid_metadata"),
                            (3, "invalid_metadata"), ("Not An Id", "invalid_relation_id")):
            self.set_metadata("piece", "parent", value)
            failed, _ = self.run_cli("doctor", "--structural-only", expect=1)
            self.assertIn(code, self.codes(failed, "error"), value)
            self.assertNotIn("unknown_metadata", self.codes(failed), value)
        self.set_metadata("piece", "parent", self.MISSING)
        self.run_cli("doctor", "--structural-only")

    def test_active_children_make_parent_wait_and_close_unblocks_it(self) -> None:
        self.create("app", tags=("app",))
        self.create("app-auth", tags=("auth",), parent="app")
        self.create("app-ui", tags=("ui",), parent="app", requires=("app-auth",))
        status, _ = self.run_cli("status")
        waiting = {item["id"]: item for item in status["data"]["waiting"]}
        self.assertEqual(set(waiting), {"app", "app-ui"})
        self.assertEqual(waiting["app"]["active_children"], ["app-auth", "app-ui"])
        self.assertEqual(waiting["app"]["blockers"], [])
        self.assertEqual([item["id"] for item in status["data"]["ready"]], ["app-auth"])
        self.assertIn("app: App; children=app-auth,app-ui", self.run_text("status"))
        failed, _ = self.run_cli("close", "app", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "active_children")
        forced, _ = self.run_cli("close", "app", "--force", expect=1)
        self.assertEqual(forced["diagnostics"][0]["code"], "active_children")
        dropped, _ = self.run_cli("drop", "app", expect=1)
        self.assertEqual(dropped["diagnostics"][0]["code"], "active_children")
        self.fill_sections("app-auth")
        self.fill_sections("app-ui")
        self.run_cli("close", "app-auth")
        closed, _ = self.run_cli("close", "app-ui")
        self.assertEqual(closed["data"]["unblocked"], ["app"])
        # Done children no longer hold the parent, but stay under it until it closes,
        # so the parent is not read as unexpanded again.
        self.assertEqual(set(load_store(self.root).plans), {"app", "app-auth", "app-ui"})
        gc, _ = self.run_cli("gc", "--dry-run")
        self.assertEqual(gc["changes"], [])
        tree, _ = self.run_cli("tree")
        by_id = {node["id"]: node for node in tree["data"]["nodes"]}
        self.assertFalse(by_id["app"]["unexpanded"])
        self.assertEqual(by_id["app"]["readiness"], "ready")
        self.assertEqual(by_id["app"]["children"], ["app-auth", "app-ui"])
        why, _ = self.run_cli("why", "app")
        self.assertFalse(why["data"]["unexpanded"])
        self.assertEqual(why["data"]["children"]["done"], ["app-auth", "app-ui"])
        self.fill_sections("app")
        closed_app, _ = self.run_cli("close", "app")
        self.assertEqual(
            sorted(c["plan"] for c in closed_app["changes"] if c["action"] == "prune"),
            ["app", "app-auth", "app-ui"],
        )
        self.assertEqual(load_store(self.root).plans, {})

    def test_closed_pieces_stay_while_any_ancestor_is_active(self) -> None:
        self.create("root-plan", tags=("root",))
        self.create("branch", tags=("branch",), parent="root-plan")
        self.create("leaf", tags=("leaf",), parent="branch")
        for plan_id in ("leaf", "branch"):
            self.fill_sections(plan_id)
            self.run_cli("close", plan_id)
        self.assertEqual(set(load_store(self.root).plans), {"root-plan", "branch", "leaf"})
        status, _ = self.run_cli("status")
        self.assertEqual(
            [item["id"] for item in status["data"]["retained_done"]], ["branch", "leaf"]
        )

    def test_critical_path_runs_through_children_to_the_parent(self) -> None:
        self.create("p", tags=("p",))
        self.create("c1", tags=("c1",), parent="p")
        self.create("c2", tags=("c2",), parent="p", requires=("c1",))
        self.create("c3", tags=("c3",), parent="p", requires=("c2",))
        self.create("x", tags=("x",), requires=("p",))
        status, _ = self.run_cli("status")
        self.assertEqual(status["data"]["critical_path"], ["c1", "c2", "c3", "p", "x"])
        self.assertIn("Critical path: c1 -> c2 -> c3 -> p -> x", self.run_text("status"))

    def test_context_does_not_list_its_own_tree_as_overlapping(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.create("checkout", scopes=("apps/checkout/**",), tags=("checkout",))
        self.create(
            "checkout-api", scopes=("apps/checkout/api/**",), tags=("api",), parent="checkout"
        )
        self.create(
            "checkout-api-retry", scopes=("apps/checkout/api/**",), tags=("retry",),
            parent="checkout-api",
        )
        self.create("billing", scopes=("apps/checkout/api/**",), tags=("billing",))
        shared = self.root / "apps" / "checkout" / "api" / "x.py"
        shared.parent.mkdir(parents=True)
        shared.write_text("x\n", encoding="utf-8")
        payload, _ = self.run_cli("context", "--plan", "checkout-api", "--no-other-worktrees")
        self.assertEqual(payload["data"]["ancestors"], ["checkout"])
        self.assertEqual(payload["data"]["overlapping"], ["billing"])

    def test_gc_keeps_done_ancestors_of_active_plans(self) -> None:
        self.create("prereq", tags=("prereq",))
        self.create("phase", tags=("phase",), requires=("prereq",))
        self.create("consumer", tags=("consumer",), requires=("phase",))
        self.fill_sections("prereq")
        self.fill_sections("phase")
        self.run_cli("close", "prereq")
        self.run_cli("close", "phase")
        # A piece added under a done plan: the parent is kept for the tree, and the
        # parent's own prerequisite for the parent.
        payload = self.create("late-piece", tags=("late",), parent="phase")
        self.assertIn("done_parent", self.codes(payload))
        self.run_cli("drop", "consumer")
        gc, _ = self.run_cli("gc", "--dry-run")
        self.assertEqual(gc["changes"], [])
        status, _ = self.run_cli("status")
        self.assertEqual(
            [item["id"] for item in status["data"]["retained_done"]], ["prereq", "phase"]
        )
        why, _ = self.run_cli("why", "phase")
        self.assertFalse(why["data"]["prunable"])

    def test_removing_a_parent_moves_its_needed_done_children_up(self) -> None:
        for command in ("drop", "replace", "close"):
            with self.subTest(command=command):
                self.setUp()
                self.create("top", tags=("top",))
                self.create("mid", tags=("mid",), parent="top")
                self.create("done-piece", tags=("piece",), parent="mid")
                self.create("user", tags=("user",), requires=("done-piece",))
                self.fill_sections("done-piece")
                self.run_cli("close", "done-piece")
                args = {
                    "drop": ("drop", "mid"),
                    "replace": ("replace", "mid", "mid-v2", "--title", "Mid v2", "--tag", "v2"),
                    "close": ("close", "mid", "--force"),
                }[command]
                payload, _ = self.run_cli(*args)
                self.assertIn({"action": "relink", "plan": "done-piece"}, payload["changes"])
                expected = "mid-v2" if command == "replace" else "top"
                self.assertEqual(load_store(self.root).plans["done-piece"].parent, expected)
                self.run_cli("doctor", "--structural-only")

    def test_requires_from_a_kept_done_ancestor_refuses_removal(self) -> None:
        self.create("base", tags=("base",))
        self.create("phase", tags=("phase",), requires=("base",))
        self.create("consumer", tags=("consumer",), requires=("phase",))
        self.fill_sections("base")
        self.fill_sections("phase")
        self.run_cli("close", "base")
        self.run_cli("close", "phase")
        self.create("late-piece", tags=("late",), parent="phase")
        self.run_cli("drop", "consumer")
        refused, _ = self.run_cli("drop", "base", expect=1)
        self.assertEqual(refused["diagnostics"][0]["code"], "active_dependents")
        self.assertIn("phase", refused["diagnostics"][0]["message"])

    def test_active_grandchild_under_done_child_still_holds_the_parent(self) -> None:
        self.create("top", tags=("top",))
        self.create("mid", tags=("mid",), parent="top")
        self.create("low", tags=("low",), parent="mid")
        self.set_metadata("mid", "status", "done")
        status, _ = self.run_cli("status")
        waiting = {item["id"]: item for item in status["data"]["waiting"]}
        self.assertEqual(waiting["top"]["active_children"], ["low"])
        failed, _ = self.run_cli("close", "top", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "active_children")

    def test_doctor_reports_dangling_parent_cycles_and_redundant_require(self) -> None:
        self.create("alpha", tags=("alpha",))
        self.create("beta", tags=("beta",), parent="alpha")
        self.run_cli("update", "alpha", "--add-require", "beta")
        warned, _ = self.run_cli("doctor", "--structural-only")
        redundant = [d for d in warned["diagnostics"] if d["code"] == "redundant_parent_require"]
        self.assertEqual([d["plan"] for d in redundant], ["alpha"])
        self.run_cli("update", "alpha", "--remove-require", "beta")

        self.set_metadata("beta", "parent", "ghost")
        dangling, _ = self.run_cli("doctor", "--structural-only", expect=1)
        self.assertIn("dangling_parent", self.codes(dangling, "error"))

        self.set_metadata("beta", "parent", "beta")
        selfish, _ = self.run_cli("doctor", "--structural-only", expect=1)
        self.assertIn("parent_cycle", self.codes(selfish, "error"))

        self.set_metadata("beta", "parent", "alpha")
        self.set_metadata("alpha", "parent", "beta")
        looped, _ = self.run_cli("doctor", "--structural-only", expect=1)
        self.assertEqual(self.codes(looped, "error").count("parent_cycle"), 1)

        # A child requiring its own ancestor waits for a plan that waits for it.
        self.set_metadata("alpha", "parent", self.MISSING)
        self.set_metadata("beta", "requires", ["alpha"])
        deadlock, _ = self.run_cli("doctor", "--structural-only", expect=1)
        cycle = [d for d in deadlock["diagnostics"] if d["code"] == "cycle"]
        self.assertEqual(len(cycle), 1)
        self.assertIn("parent", cycle[0]["message"])

    def test_parent_child_scopes_are_not_an_overlap(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.create("checkout", scopes=("apps/checkout/**",), tags=("checkout",))
        self.create(
            "checkout-api", scopes=("apps/checkout/api/**",), tags=("checkout",), parent="checkout"
        )
        shared = self.root / "apps" / "checkout" / "api" / "x.py"
        shared.parent.mkdir(parents=True)
        shared.write_text("x\n", encoding="utf-8")
        doctor, _ = self.run_cli("doctor")
        self.assertNotIn("scope_overlap", self.codes(doctor))
        self.assertNotIn("possible_duplicate", self.codes(doctor))

    def test_tree_lists_depth_readiness_and_unexpanded(self) -> None:
        self.create("root-plan", tags=("root",))
        self.create("first", tags=("first",), parent="root-plan")
        self.create("second", tags=("second",), parent="root-plan", requires=("first",))
        self.create("first-leaf", tags=("leaf",), parent="first")
        self.create("other-root", tags=("other",))
        self.fill_sections("first-leaf", "Implementation")
        payload, _ = self.run_cli("tree")
        nodes = payload["data"]["nodes"]
        self.assertEqual(
            [(node["id"], node["depth"]) for node in nodes],
            [("other-root", 0), ("root-plan", 0), ("first", 1), ("first-leaf", 2), ("second", 1)],
        )
        by_id = {node["id"]: node for node in nodes}
        self.assertEqual(by_id["root-plan"]["children"], ["first", "second"])
        self.assertEqual(by_id["root-plan"]["readiness"], "waiting")
        self.assertEqual(by_id["first-leaf"]["readiness"], "ready")
        self.assertEqual(by_id["second"]["readiness"], "waiting")
        unexpanded = {node["id"] for node in nodes if node["unexpanded"]}
        self.assertEqual(unexpanded, {"second", "other-root"})
        self.assertEqual(payload["data"]["counts"]["unexpanded"], 2)
        sub, _ = self.run_cli("tree", "first")
        self.assertEqual([node["id"] for node in sub["data"]["nodes"]], ["first", "first-leaf"])
        self.assertEqual(sub["data"]["ancestors"], ["root-plan"])
        text = self.run_text("tree")
        self.assertIn("    - first: First [waiting]", text)
        self.assertIn("      - first-leaf: First Leaf [ready]", text)
        self.assertIn("    - second: Second [waiting, unexpanded]", text)
        missing, _ = self.run_cli("tree", "ghost", expect=1)
        self.assertEqual(missing["diagnostics"][0]["code"], "unknown_plan")

    def test_tree_shows_detached_plans_of_a_broken_store(self) -> None:
        self.create("root-plan", tags=("root",))
        self.create("orphan", tags=("orphan",), parent="root-plan")
        self.create("loop-a", tags=("a",))
        self.create("loop-b", tags=("b",), parent="loop-a")
        # Sorts before the cycle members, and must still print under its parent.
        self.create("a-loop-piece", tags=("piece",), parent="loop-a")
        self.set_metadata("orphan", "parent", "ghost")
        self.set_metadata("loop-a", "parent", "loop-b")
        payload, _ = self.run_cli("tree")
        nodes = {node["id"]: node for node in payload["data"]["nodes"]}
        detached = {plan_id: node.get("detached") for plan_id, node in nodes.items()}
        self.assertEqual(detached["root-plan"], None)
        self.assertEqual(detached["orphan"], "missing_parent")
        self.assertEqual(
            sorted(str(v) for k, v in detached.items() if "loop" in k),
            ["None", "None", "parent_cycle"],
        )
        self.assertGreater(nodes["a-loop-piece"]["depth"], 0)
        self.assertEqual(len(payload["data"]["nodes"]), 5)
        self.assertIn("dangling_parent", self.codes(payload, "error"))
        self.assertIn("parent_cycle", self.codes(payload, "error"))
        self.assertIn("Detached (parent missing or on a parent cycle):", self.run_text("tree"))

    def test_context_and_why_carry_the_ancestor_chain(self) -> None:
        self.create("product", tags=("product",))
        self.create("billing", tags=("billing",), parent="product")
        self.create("invoice-export", tags=("invoice",), parent="billing")
        self.create("invoice-mail", tags=("mail",), parent="billing")
        context, _ = self.run_cli("context", "--plan", "invoice-export")
        data = context["data"]
        self.assertEqual(data["ancestors"], ["product", "billing"])
        self.assertEqual(data["read_order"][:3], ["product", "billing", "invoice-export"])
        roles = {item["id"]: item["role"] for item in data["decision_pack"]}
        self.assertEqual(roles["product"], "ancestor")
        self.assertEqual(roles["billing"], "ancestor")
        self.assertIn("outcome", data["decision_pack"][0])
        self.assertEqual(data["decision_pack"][2]["parent"], "billing")
        self.assertIn("Ancestors: product -> billing", self.run_text("context", "--plan", "invoice-export"))
        # A selected ancestor keeps its role and still reads first.
        both, _ = self.run_cli("context", "--plan", "invoice-export", "--plan", "product")
        self.assertEqual(both["data"]["ancestors"], ["billing"])
        self.assertEqual(both["data"]["read_order"][:2], ["product", "billing"])

        why, _ = self.run_cli("why", "billing")
        self.assertEqual(why["data"]["parent"], "product")
        self.assertEqual(why["data"]["ancestors"], ["product"])
        self.assertEqual(why["data"]["children"], {"active": ["invoice-export", "invoice-mail"], "done": []})
        self.assertEqual(why["data"]["readiness"], "waiting")
        self.assertFalse(why["data"]["unexpanded"])
        text = self.run_text("why", "billing")
        self.assertIn("parent: product (ancestors: product)", text)
        self.assertIn("active children: invoice-export, invoice-mail", text)
        leaf, _ = self.run_cli("why", "invoice-mail")
        self.assertTrue(leaf["data"]["unexpanded"])

    def test_create_and_update_parent_validation(self) -> None:
        self.create("top", tags=("top",))
        self.create("mid", tags=("mid",), parent="top")
        self.create("low", tags=("low",), parent="mid")
        unknown, _ = self.run_cli(
            "create", "stray", "--title", "Stray", "--tag", "x", "--parent", "ghost", expect=1
        )
        self.assertEqual(unknown["diagnostics"][0]["code"], "unknown_plan")
        self.assertFalse(self.plan_file("stray").exists())
        before = self.plan_file("top").read_bytes()
        cycle, _ = self.run_cli("update", "top", "--parent", "low", expect=1)
        self.assertEqual(cycle["diagnostics"][0]["code"], "parent_cycle")
        self_cycle, _ = self.run_cli("update", "top", "--parent", "top", expect=1)
        self.assertEqual(self_cycle["diagnostics"][0]["code"], "parent_cycle")
        self.assertEqual(self.plan_file("top").read_bytes(), before)
        bad, _ = self.run_cli("update", "low", "--parent", "ghost", expect=1)
        self.assertEqual(bad["diagnostics"][0]["code"], "unknown_plan")
        self.run_cli("update", "low", "--parent", "top")
        self.assertEqual(load_store(self.root).plans["low"].parent, "top")
        self.run_cli("update", "low", "--clear-parent")
        self.assertNotIn('"parent"', self.plan_file("low").read_text(encoding="utf-8"))
        same, _ = self.run_cli("update", "low", "--clear-parent", expect=1)
        self.assertEqual(same["diagnostics"][0]["code"], "no_changes")
        _, usage = self.run_cli_raw("update", "low", "--parent", "top", "--clear-parent")
        self.assertEqual(usage.returncode, 2)

    def run_cli_raw(self, *args: str) -> tuple[None, subprocess.CompletedProcess[str]]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--root", str(self.root), "--json"],
            cwd=SKILL, capture_output=True, text=True, encoding="utf-8", timeout=20, check=False,
        )
        return None, result

    def test_rename_relinks_children(self) -> None:
        self.create("old-parent", tags=("parent",))
        self.create("kid", tags=("kid",), parent="old-parent")
        payload, _ = self.run_cli("rename", "old-parent", "new-parent")
        self.assertIn({"action": "relink", "plan": "kid"}, payload["changes"])
        self.assertEqual(load_store(self.root).plans["kid"].parent, "new-parent")
        self.run_cli("doctor", "--structural-only")

    def test_replace_without_subtree_refuses_active_children(self) -> None:
        self.create("holder", tags=("holder",))
        self.create("held", tags=("held",), parent="holder")
        failed, _ = self.run_cli("replace", "holder", "fresh", "--title", "Fresh", "--tag", "f", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "active_children")
        self.assertIn("--subtree", failed["diagnostics"][0]["message"])

    def test_replace_subtree_removes_descendants_and_takes_the_place(self) -> None:
        self.create("root-plan", tags=("root",))
        self.create("wrong", tags=("wrong",), parent="root-plan")
        self.create("wrong-a", tags=("wa",), parent="wrong")
        self.create("wrong-b", tags=("wb",), parent="wrong")
        self.create("wrong-a-1", tags=("wa1",), parent="wrong-a", requires=("wrong-b",))
        self.create("sibling", tags=("sibling",), parent="root-plan", requires=("wrong-a",))
        refused, _ = self.run_cli(
            "replace", "wrong", "right", "--title", "Right", "--tag", "right", "--subtree", expect=1
        )
        self.assertEqual(refused["diagnostics"][0]["code"], "active_dependents")
        self.assertIn("sibling", refused["diagnostics"][0]["message"])
        self.run_cli("update", "sibling", "--remove-require", "wrong-a")
        originals = {
            plan_id: self.plan_file(plan_id).read_bytes()
            for plan_id in ("wrong", "wrong-a", "wrong-b", "wrong-a-1")
        }
        dry, _ = self.run_cli(
            "replace", "wrong", "right", "--title", "Right", "--tag", "right", "--subtree", "--dry-run"
        )
        self.assertTrue(self.plan_file("wrong-a-1").exists())
        payload, _ = self.run_cli(
            "replace", "wrong", "right", "--title", "Right", "--tag", "right", "--subtree"
        )
        self.assertEqual(payload["changes"], dry["changes"])
        self.assertEqual(payload["changes"][0], {"action": "replace", "from": "wrong", "to": "right"})
        self.assertEqual(
            sorted(c["plan"] for c in payload["changes"] if c["action"] == "drop"),
            ["wrong-a", "wrong-a-1", "wrong-b"],
        )
        store = load_store(self.root)
        self.assertEqual(set(store.plans), {"root-plan", "right", "sibling"})
        self.assertEqual(store.plans["right"].parent, "root-plan")
        self.assertEqual(store.plans["right"].replaces, ("wrong",))
        recovery = Path(payload["data"]["recovery_directory"])
        for plan_id, data in originals.items():
            self.assertEqual((recovery / f"{plan_id}.md").read_bytes(), data)
        self.run_cli("doctor", "--structural-only")


class PlanGraphAlgorithmTests(unittest.TestCase):
    def test_deep_dag_is_iterative_and_deterministic(self) -> None:
        root = Path("/tmp/deep-plan-graph")
        plans = {}
        previous = None
        for index in range(1500):
            plan_id = f"p-{index}"
            plan = make_plan(
                root=root,
                plan_id=plan_id,
                title=f"Plan {index}",
                requires=[previous] if previous else [],
                tags=[f"tag-{index}"],
            )
            plans[plan_id] = plan
            previous = plan_id
        self.assertEqual(find_cycle(plans), [])
        ordered = topological_order(plans)
        self.assertEqual(ordered[0], "p-0")
        self.assertEqual(ordered[-1], "p-1499")
        self.assertEqual(critical_path(plans), ordered)
        context = build_context(root, plans, explicit_plans=["p-1499"])
        self.assertEqual(len(context["required"]), 1499)


if __name__ == "__main__":
    unittest.main()
