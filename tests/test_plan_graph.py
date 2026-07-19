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
    ) -> dict[str, object]:
        args = ["create", plan_id, "--title", title or plan_id.replace("-", " ").title()]
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

    def test_empty_store_context_and_doctor(self) -> None:
        doctor, _ = self.run_cli("doctor")
        self.assertEqual(doctor["data"]["counts"], {"plans": 0, "active": 0, "done": 0})
        context, _ = self.run_cli("context", "--query", "anything")
        self.assertEqual(context["data"]["decision_pack"], [])
        self.assertEqual(context["data"]["candidates"], [])

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

    def test_query_body_requires_two_tokens_but_never_adds_relations(self) -> None:
        self.create("alpha", tags=("unrelated",))
        path = self.plan_file("alpha")
        content = path.read_text(encoding="utf-8").replace(
            "## Outcome\n\nTBD", "## Outcome\n\nKorean calibration evidence pipeline"
        )
        path.write_text(content, encoding="utf-8")
        payload, _ = self.run_cli("context", "--query", "calibration evidence")
        self.assertEqual(payload["data"]["selected"], ["alpha"])
        self.assertEqual(load_store(self.root).plans["alpha"].requires, ())
        single, _ = self.run_cli("context", "--query", "calibration")
        self.assertEqual(single["data"]["selected"], [])

    def test_no_match_returns_ready_candidates(self) -> None:
        self.create("base", tags=("base",))
        self.create("child", tags=("child",), requires=("base",))
        payload, _ = self.run_cli("context", "--query", "totally different words")
        self.assertEqual(payload["data"]["selected"], [])
        self.assertEqual([item["id"] for item in payload["data"]["candidates"]], ["base"])

    def test_changed_plan_file_selects_itself(self) -> None:
        self.create("base", tags=("base",))
        payload, _ = self.run_cli("context", "--path", ".agents/plans/base.md")
        self.assertEqual(payload["data"]["selected"], ["base"])
        self.assertIn(
            "path:plan-file",
            payload["data"]["decision_pack"][0]["matched_by"],
        )

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

    def test_explicit_query_ignores_dirty_paths_without_worktree_flag(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.create("backend", scopes=("apps/backend/**",), tags=("backend",))
        self.create("frontend", scopes=("apps/frontend/**",), tags=("frontend",))
        dirty = self.root / "apps" / "backend" / "service.py"
        dirty.parent.mkdir(parents=True)
        dirty.write_text("x\n", encoding="utf-8")
        query_only, _ = self.run_cli("context", "--query", "frontend")
        self.assertEqual(query_only["data"]["selected"], ["frontend"])
        combined, _ = self.run_cli("context", "--query", "frontend", "--worktree")
        self.assertEqual(set(combined["data"]["selected"]), {"backend", "frontend"})

    def test_status_derives_readiness_and_critical_path(self) -> None:
        self.create("base", tags=("base",))
        self.create("middle", tags=("middle",), requires=("base",))
        self.create("leaf", tags=("leaf",), requires=("middle",))
        payload, _ = self.run_cli("status")
        self.assertEqual([item["id"] for item in payload["data"]["ready"]], ["base"])
        self.assertEqual([item["id"] for item in payload["data"]["waiting"]], ["middle", "leaf"])
        self.assertEqual(payload["data"]["critical_path"], ["base", "middle", "leaf"])

    def test_status_projects_active_chain_through_retained_done_plan(self) -> None:
        self.create("base", tags=("base",))
        self.create("middle", tags=("middle",), requires=("base",))
        self.create("leaf", tags=("leaf",), requires=("middle",))
        self.run_cli("close", "middle")
        payload, _ = self.run_cli("status")
        self.assertEqual([item["id"] for item in payload["data"]["ready"]], ["base"])
        self.assertEqual([item["id"] for item in payload["data"]["waiting"]], ["leaf"])
        self.assertEqual(
            [item["id"] for item in payload["data"]["retained_done"]],
            ["middle"],
        )
        self.assertEqual(payload["data"]["critical_path"], ["base", "leaf"])

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

    def test_reopen_retained_done_plan(self) -> None:
        self.create("base", tags=("base",))
        self.create("child", tags=("child",), requires=("base",))
        self.run_cli("close", "base")
        self.run_cli("reopen", "base")
        self.assertEqual(load_store(self.root).plans["base"].status, "active")

    def test_drop_refuses_indirect_active_dependent_through_done_plan(self) -> None:
        self.create("base", tags=("base",))
        self.create("middle", tags=("middle",), requires=("base",))
        self.create("leaf", tags=("leaf",), requires=("middle",))
        self.run_cli("close", "middle")
        failed, _ = self.run_cli("drop", "base", expect=1)
        self.assertEqual(failed["diagnostics"][0]["code"], "active_dependents")
        self.assertIn("leaf", failed["diagnostics"][0]["message"])

    def test_gc_prunes_only_unretained_done_plans(self) -> None:
        self.create("keep", tags=("keep",))
        self.create("active", tags=("active",), requires=("keep",))
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

    def test_doctor_rejects_legacy_nested_and_invalid_plans(self) -> None:
        legacy = self.root / ".agents" / "plan"
        legacy.mkdir(parents=True)
        (legacy / "graph.yaml").write_text("next: 1\n", encoding="utf-8")
        nested = self.root / "apps" / "backend" / ".agents" / "plans"
        nested.mkdir(parents=True)
        invalid_dir = self.root / ".agents" / "plans"
        invalid_dir.mkdir(parents=True)
        (invalid_dir / "bad.md").write_text("---\nnot json\n---\n# Bad\n", encoding="utf-8")
        payload, _ = self.run_cli("doctor", expect=1)
        codes = {item["code"] for item in payload["diagnostics"]}
        self.assertTrue({"legacy_store", "nested_store", "invalid_json"} <= codes)

    def test_doctor_ignores_store_in_nested_git_worktree(self) -> None:
        nested = self.root / ".worktrees" / "feature"
        nested.mkdir(parents=True)
        (nested / ".git").write_text("gitdir: /tmp/example\n", encoding="utf-8")
        (nested / ".agents" / "plans").mkdir(parents=True)
        payload, _ = self.run_cli("doctor")
        self.assertEqual(payload["diagnostics"], [])

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlink_store_is_rejected(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        agents = self.root / ".agents"
        agents.mkdir()
        os.symlink(outside, agents / "plans", target_is_directory=True)
        payload, _ = self.run_cli("doctor", expect=1)
        self.assertEqual(payload["diagnostics"][0]["code"], "symlink_store")

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlink_agents_parent_is_rejected_without_traversal(self) -> None:
        outside = self.root / "outside-agents"
        (outside / "plans").mkdir(parents=True)
        os.symlink(outside, self.root / ".agents", target_is_directory=True)
        payload, _ = self.run_cli("doctor", expect=1)
        codes = [item["code"] for item in payload["diagnostics"]]
        self.assertIn("symlink_store", codes)
        self.assertEqual(payload["data"]["counts"]["plans"], 0)

    def test_routing_path_escape_is_rejected(self) -> None:
        self.create("one", tags=("one",))
        payload, _ = self.run_cli("context", "--path", "../outside.py", expect=1)
        self.assertEqual(payload["diagnostics"][0]["code"], "path_escape")

    def test_live_lock_blocks_mutation_and_is_preserved(self) -> None:
        self.create("one", tags=("one",))
        lock = lock_path_for(self.root)
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(json.dumps({"pid": os.getpid(), "token": "foreign"}), encoding="utf-8")
        payload, _ = self.run_cli("update", "one", "--add-tag", "two", expect=1)
        self.assertEqual(payload["diagnostics"][0]["code"], "store_locked")
        self.assertTrue(lock.exists())

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

    def test_cycle_reports_chain(self) -> None:
        root = Path("/tmp/cycle-plan-graph")
        one = make_plan(root=root, plan_id="one", title="One", requires=["two"], tags=["one"])
        two = make_plan(root=root, plan_id="two", title="Two", requires=["one"], tags=["two"])
        cycle = find_cycle({"one": one, "two": two})
        self.assertEqual(cycle[0], cycle[-1])
        self.assertEqual(set(cycle[:-1]), {"one", "two"})


if __name__ == "__main__":
    unittest.main()
