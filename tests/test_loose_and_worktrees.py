"""Plan documents under other conventions, and plans and changes in other worktrees."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts" / "plan-graph.py"
SHARED_COPY = SKILL.parent / "worktree-cycle" / "scripts" / "worktree_overlap.py"
sys.path.insert(0, str(SKILL / "scripts"))

from plan_graph.loose import classify, status_line  # noqa: E402

HUD = """# 뷰포트 HUD 개편

> **상태 (코드 대조 2026-11-16)**: 남은 것 2건: 토글 위치, 접힘 기억.

근거 코드: `apps/web/hud.tsx`, `apps/web/panel/`, `Toolbar.tsx`, `ui/menu.mjs:12`,
`apps/web/{hud.tsx,style.css}`, `missing/file.ts`, `pnpm test`.

## 실측

- `Gone.tsx` 는 없다.
"""

DONE = """# 끝난 정리

> **상태: 완료** (근거 — `apps/web/hud.tsx`, 확인 2026-11-16).
"""

YAML = """---
id: old-index
summary: v1 frontmatter
---
# 옛 계획

- 상태: 초안, 결정 전 착수 없음
"""


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))
    return path


class CliCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="plan-graph-loose-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "repo"
        self.root.mkdir()

    def run_cli(self, *args: str, expect: int = 0, cwd: Path | None = None) -> dict[str, object]:
        command = [sys.executable, str(SCRIPT), *args, "--json"]
        if cwd is None:
            command.extend(["--root", str(self.root)])
        result = subprocess.run(
            command, cwd=cwd or SKILL, capture_output=True, text=True, encoding="utf-8", timeout=60
        )
        self.assertEqual(
            result.returncode, expect, f"{command}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
        payload = json.loads(result.stdout)
        self.assertEqual(set(payload), {"ok", "command", "root", "data", "diagnostics", "changes"})
        return payload

    def git(self, cwd: Path, *args: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True, encoding="utf-8"
        )
        return result.stdout

    def init_repo(self) -> None:
        self.git(self.root, "init", "-q", "-b", "main")
        self.git(self.root, "config", "user.email", "test@example.com")
        self.git(self.root, "config", "user.name", "Test")
        self.git(self.root, "config", "commit.gpgsign", "false")

    @staticmethod
    def codes(payload: dict[str, object]) -> list[str]:
        return [item["code"] for item in payload["diagnostics"]]


class LoosePlanTests(CliCase):
    def setUp(self) -> None:
        super().setUp()
        for path in (
            "apps/web/hud.tsx",
            "apps/web/style.css",
            "apps/web/panel/a.ts",
            "apps/web/widgets/Toolbar.tsx",
            "src/static/ui/menu.mjs",
        ):
            write(self.root / path, "x\n")
        plans = self.root / "docs" / "plans"
        write(plans / "2026-11-17-viewport-hud.md", HUD)
        write(plans / "2026-11-16-finished.md", DONE)
        write(plans / "2026-08-19-old-index.md", YAML)
        write(plans / "README.md", "# 규약\n\n상태 줄을 단다.\n")
        write(plans / "mockups" / "a.md", "# 목업\n")

    def test_status_lines_follow_the_documented_forms(self) -> None:
        cases = {
            "# T\n\n> **상태 (코드 대조 2026-11-16)**: 남은 것 5건: a\n": ("남은 것 5건: a", "active"),
            "# T\n\n> **상태: 완료** (근거 — x)\n": ("완료 (근거 — x)", "done"),
            "# T\n상태: dev 반영(2026-11-18, squash). 남은 것: 실기 확인\n": (
                "dev 반영(2026-11-18, squash). 남은 것: 실기 확인", "active"),
            "# T\n\n- 상태: 초안, 결정 전 착수 없음\n": ("초안, 결정 전 착수 없음", "active"),
            "# T\n\nStatus: done\n": ("done", "done"),
            "# T\n\n> **상태: 대부분 완료 — 남은 것 2건**\n": ("대부분 완료 — 남은 것 2건", "active"),
            "# T\n\n> **상태: 완료 — 남은 것 1건**\n": ("완료 — 남은 것 1건", "active"),
            "# T\n\n## 1. 지금 상태\n\n상태: 완료\n": ("", "active"),
            "# T\n\n상태: 완료됨\n": ("완료됨", "done"),
            "# T\n\nStatus: done (opened follow-up issue)\n": ("done (opened follow-up issue)", "done"),
            "# T\n\n> **상태: 완료** (근거: `src/openapi.ts`)\n": ("완료 (근거: `src/openapi.ts`)", "done"),
            "# T\n\nStatus: donezo\n": ("donezo", "active"),
            "# T\n\n```\n상태: 완료\n```\n": ("", "active"),
        }
        for text, (line, state) in cases.items():
            with self.subTest(text=text):
                self.assertEqual(status_line(text), line)
                self.assertEqual(classify(status_line(text)), state)

    def test_documents_without_frontmatter_are_read_with_a_warning(self) -> None:
        doctor = self.run_cli("doctor")
        self.assertEqual(doctor["data"]["counts"], {"plans": 3, "active": 2, "done": 1, "loose": 3})
        self.assertEqual(doctor["data"]["dirs"], [".agents/plans", "docs/plans"])
        self.assertEqual(self.codes(doctor), ["loose_plans"])
        self.assertEqual(doctor["diagnostics"][0]["path"], "docs/plans")

        why = self.run_cli("why", "2026-11-17-viewport-hud")
        plan = why["data"]["plan"]
        self.assertEqual(plan["kind"], "loose")
        self.assertEqual(plan["title"], "뷰포트 HUD 개편")
        self.assertEqual(plan["status"], "active")
        self.assertEqual(plan["status_line"], "남은 것 2건: 토글 위치, 접힘 기억.")
        self.assertEqual(
            plan["scope"],
            [
                "apps/web/hud.tsx",
                "apps/web/panel/**",
                "apps/web/widgets/Toolbar.tsx",
                "src/static/ui/menu.mjs",
                "apps/web/style.css",
            ],
        )
        old = self.run_cli("why", "2026-08-19-old-index")["data"]["plan"]
        self.assertEqual((old["kind"], old["title"], old["status_line"]), ("loose", "옛 계획", "초안, 결정 전 착수 없음"))

    def test_context_routes_paths_to_loose_documents(self) -> None:
        payload = self.run_cli("context", "--path", "apps/web/panel/a.ts")
        self.assertEqual(payload["data"]["selected"], ["2026-11-17-viewport-hud"])
        item = payload["data"]["decision_pack"][0]
        self.assertEqual(item["kind"], "loose")
        self.assertIn("남은 것 2건", item["status_line"])
        self.assertIn("근거 코드", item["outcome"])

    def test_cli_never_rewrites_or_deletes_loose_documents(self) -> None:
        before = {path: path.read_bytes() for path in (self.root / "docs" / "plans").glob("*.md")}
        for args in (
            ("close", "2026-11-17-viewport-hud"),
            ("close", "2026-11-17-viewport-hud", "--force"),
            ("update", "2026-11-17-viewport-hud", "--add-tag", "hud"),
            ("rename", "2026-11-17-viewport-hud", "hud"),
            ("drop", "2026-11-16-finished"),
            ("reopen", "2026-11-16-finished"),
            ("replace", "2026-11-17-viewport-hud", "hud-v2", "--title", "HUD v2", "--tag", "hud"),
        ):
            with self.subTest(args=args):
                payload = self.run_cli(*args, expect=1)
                self.assertEqual(self.codes(payload), ["loose_plan"])
        gc = self.run_cli("gc")
        self.assertEqual(gc["changes"], [])
        after = {path: path.read_bytes() for path in (self.root / "docs" / "plans").glob("*.md")}
        self.assertEqual(before, after)

    def test_create_warns_about_the_existing_plan_directory(self) -> None:
        payload = self.run_cli("create", "hud-toggle", "--title", "HUD toggle", "--tag", "hud",
                               "--require", "2026-11-17-viewport-hud")
        self.assertIn("foreign_plan_dir", self.codes(payload))
        self.assertTrue((self.root / ".agents" / "plans" / "hud-toggle.md").exists())
        status = self.run_cli("status")
        waiting = [item["id"] for item in status["data"]["waiting"]]
        self.assertEqual(waiting, ["hud-toggle"])

    def test_loose_pairs_raise_no_overlap_warnings(self) -> None:
        write(self.root / "docs" / "plans" / "2026-11-18-other.md", "# 또 다른\n\n`apps/web/hud.tsx`\n")
        doctor = self.run_cli("doctor")
        self.assertNotIn("scope_overlap", self.codes(doctor))
        self.run_cli("create", "hud-owner", "--title", "HUD owner", "--scope", "apps/web/hud.tsx")
        doctor = self.run_cli("doctor")
        self.assertIn("scope_overlap", self.codes(doctor))

    def test_configured_directory_is_read_and_written(self) -> None:
        self.init_repo()
        self.git(self.root, "config", "plan-graph.dir", "docs/plans")
        write(self.root / ".agents" / "plans" / "ignored.md", "# 안 읽힘\n")
        payload = self.run_cli("create", "hud-toggle", "--title", "HUD toggle", "--tag", "hud")
        self.assertNotIn("foreign_plan_dir", self.codes(payload))
        created = self.root / "docs" / "plans" / "hud-toggle.md"
        self.assertTrue(created.read_text(encoding="utf-8").startswith("---\n{"))
        doctor = self.run_cli("doctor")
        self.assertEqual(doctor["data"]["dirs"], ["docs/plans"])
        self.assertEqual(doctor["data"]["counts"]["plans"], 4)
        self.assertEqual(doctor["data"]["counts"]["loose"], 3)
        self.fill_and_close(created, "hud-toggle")
        self.assertFalse(created.exists())
        self.assertTrue((self.root / "docs" / "plans" / "2026-11-16-finished.md").exists())

    def fill_and_close(self, path: Path, plan_id: str) -> None:
        content = path.read_text(encoding="utf-8")
        for section in ("Outcome", "Decisions", "Completion"):
            content = content.replace(f"## {section}\n\nTBD", f"## {section}\n\nRecorded.")
        path.write_text(content, encoding="utf-8")
        self.run_cli("close", plan_id)


class StoreToleranceTests(CliCase):
    def test_legacy_v1_store_is_skipped_with_a_warning(self) -> None:
        write(self.root / ".agents" / "plan" / "graph.yaml", "plans: []\n")
        self.run_cli("create", "core", "--title", "Core", "--tag", "core")
        for command in ("status", "context", "doctor"):
            with self.subTest(command=command):
                payload = self.run_cli(command)
                legacy = [item for item in payload["diagnostics"] if item["code"] == "legacy_store"]
                self.assertEqual([item["severity"] for item in legacy], ["warning"])

    def test_agents_plans_document_without_frontmatter_is_loose(self) -> None:
        write(self.root / ".agents" / "plans" / "notes.md", "# Notes\n\nStatus: draft\n")
        payload = self.run_cli("doctor")
        self.assertEqual(self.codes(payload), ["loose_plans"])
        self.assertEqual(payload["data"]["counts"]["loose"], 1)

    def test_other_tools_json_frontmatter_outside_agents_plans_is_loose(self) -> None:
        write(self.root / "docs" / "plans" / "x.md", '---\n{"status": "draft", "owner": "me"}\n---\n# X\n')
        write(self.root / "docs" / "plans" / "y.md", '---\n{"status": "active", "requires": [\n---\n# Y\n')
        payload = self.run_cli("doctor", expect=1)
        self.assertEqual(
            sorted((item["code"], item.get("plan")) for item in payload["diagnostics"]),
            [("invalid_json", "y"), ("loose_plans", None)],
        )

    def test_replace_keeps_the_old_plans_directory(self) -> None:
        self.run_cli("create", "core", "--title", "Core", "--tag", "core")
        target = self.root / "docs" / "plans"
        target.mkdir(parents=True)
        (self.root / ".agents" / "plans" / "core.md").replace(target / "core.md")
        payload = self.run_cli("replace", "core", "core-v2", "--title", "Core v2", "--tag", "core")
        self.assertTrue((target / "core-v2.md").exists())
        why = self.run_cli("why", "core-v2")
        self.assertEqual(why["data"]["lineage"][0]["recover"], "git log --all -- docs/plans/core.md")
        self.assertEqual(payload["changes"][0]["action"], "replace")

    def test_broken_json_frontmatter_in_agents_plans_is_still_an_error(self) -> None:
        write(self.root / ".agents" / "plans" / "bad.md", "---\nnot json\n---\n# Bad\n")
        payload = self.run_cli("doctor", expect=1)
        self.assertIn("invalid_json", self.codes(payload))


class OtherWorktreeTests(CliCase):
    """Main worktree on `main`, linked worktrees `a` and `b` beside the repository."""

    def setUp(self) -> None:
        super().setUp()
        self.init_repo()
        write(self.root / ".gitignore", ".plans/\n")
        write(self.root / "src" / "x.py", "x = 0\n")
        write(self.root / "src" / "y.py", "y = 0\n")
        write(self.root / "src" / "z.py", "z = 0\n")
        write(self.root / "docs" / "plans" / "2026-11-01-shared.md", "# 공유\n\n`src/x.py`\n")
        self.git(self.root, "add", "-A")
        self.git(self.root, "commit", "-qm", "seed")
        self.a = self.base / "wt-a"
        self.b = self.base / "wt-b"
        self.git(self.root, "worktree", "add", "-q", "-b", "a", str(self.a))
        self.git(self.root, "worktree", "add", "-q", "-b", "b", str(self.b))
        self.addCleanup(self.remove_worktrees)
        write(self.a / "src" / "x.py", "x = 1\n")
        self.git(self.a, "commit", "-qam", "a changes x")
        write(self.a / "src" / "y.py", "y = 1\n")  # uncommitted
        write(self.b / "src" / "x.py", "x = 2\n")
        self.git(self.b, "commit", "-qam", "b changes x")

    def remove_worktrees(self) -> None:
        for path in (self.a, self.b):
            subprocess.run(["git", "-C", str(self.root), "worktree", "remove", "--force", str(path)],
                           capture_output=True, check=False)

    def overlap_of(self, payload: dict[str, object], path: Path) -> dict[str, object] | None:
        for item in payload["data"]["overlaps"]:
            if Path(item["path"]).resolve() == path.resolve():
                return item
        return None

    def test_committed_and_uncommitted_changes_of_another_worktree_overlap(self) -> None:
        payload = self.run_cli("overlap", cwd=self.b)
        self.assertTrue(payload["data"]["available"])
        self.assertEqual(payload["data"]["here"]["changed"], ["src/x.py"])
        self.assertEqual(payload["data"]["here"]["base"], "main")
        found = self.overlap_of(payload, self.a)
        self.assertIsNotNone(found)
        self.assertEqual((found["branch"], found["shared_files"]), ("a", ["src/x.py"]))
        self.assertEqual(found["plans"], [])
        self.assertIsNone(self.overlap_of(payload, self.root))

        selected = self.run_cli("overlap", "--path", "src/y.py", cwd=self.b)
        self.assertEqual(self.overlap_of(selected, self.a)["shared_files"], ["src/y.py"])
        directory = self.run_cli("overlap", "--path", "src/", cwd=self.b)
        self.assertEqual(self.overlap_of(directory, self.a)["shared_files"], ["src/x.py", "src/y.py"])
        quiet = self.run_cli("overlap", "--path", "src/z.py", cwd=self.b)
        self.assertEqual(quiet["data"]["overlaps"], [])

    def test_context_reports_other_worktrees_for_committed_work(self) -> None:
        payload = self.run_cli("context", cwd=self.b)
        self.assertIn("2026-11-01-shared", payload["data"]["selected"])
        others = payload["data"]["other_worktrees"]
        self.assertEqual([Path(item["path"]).resolve() for item in others], [self.a.resolve()])
        skipped = self.run_cli("context", "--no-other-worktrees", cwd=self.b)
        self.assertEqual(skipped["data"]["other_worktrees"], [])

    def test_ignored_plans_of_another_worktree_are_read_from_disk(self) -> None:
        write(self.root / ".plans" / "2026-11-20-x-rework.md", "# x 다시 짜기\n\n- 상태: 진행 중\n\n`src/x.py`\n")
        write(self.root / ".plans" / "2026-11-02-finished.md", "# 끝\n\n상태: 완료\n\n`src/x.py`\n")
        payload = self.run_cli("overlap", cwd=self.b)
        main = self.overlap_of(payload, self.root)
        self.assertIsNotNone(main)
        self.assertTrue(main["main"])
        self.assertEqual(main["shared_files"], [])
        self.assertEqual(
            [(plan["path"], plan["status_line"], plan["matched"]) for plan in main["plans"]],
            [(".plans/2026-11-20-x-rework.md", "진행 중", ["src/x.py"])],
        )
        # The committed docs/plans document is identical here, so it is nobody's own.
        self.assertEqual(self.overlap_of(payload, self.a)["plans"], [])

    def test_changed_plan_document_in_another_worktree_is_its_own(self) -> None:
        write(self.a / "docs" / "plans" / "2026-11-01-shared.md", "# 공유 (a 판)\n\n`src/x.py`\n")
        payload = self.run_cli("overlap", cwd=self.b)
        plans = self.overlap_of(payload, self.a)["plans"]
        self.assertEqual([plan["title"] for plan in plans], ["공유 (a 판)"])

    def test_editing_my_own_plan_does_not_make_siblings_own_it(self) -> None:
        write(self.b / "docs" / "plans" / "2026-11-01-shared.md", "# 공유 (b 판)\n\n`src/x.py`\n")
        edited = self.run_cli("overlap", cwd=self.b)
        self.assertIsNone(self.overlap_of(edited, self.root))
        self.assertEqual(self.overlap_of(edited, self.a)["plans"], [])
        (self.b / "docs" / "plans" / "2026-11-01-shared.md").unlink()
        deleted = self.run_cli("overlap", cwd=self.b)
        self.assertIsNone(self.overlap_of(deleted, self.root))
        self.assertEqual(self.overlap_of(deleted, self.a)["plans"], [])

    def test_one_unreadable_plan_does_not_hide_other_worktrees(self) -> None:
        write(
            self.a / ".agents" / "plans" / "weird.md",
            '---\n{"status": "active", "requires": [], "replaces": [], "scope": ["[unclosed"],'
            ' "tags": []}\n---\n# Weird\n',
        )
        payload = self.run_cli("overlap", cwd=self.b)
        self.assertEqual(self.overlap_of(payload, self.a)["shared_files"], ["src/x.py"])
        context = self.run_cli("context", cwd=self.b)
        self.assertEqual(len(context["data"]["other_worktrees"]), 1)

    def test_unignored_nested_worktree_is_not_a_change(self) -> None:
        nested = self.root / ".worktrees" / "c"
        self.git(self.root, "worktree", "add", "-q", "-b", "c", str(nested))
        self.addCleanup(lambda: subprocess.run(
            ["git", "-C", str(self.root), "worktree", "remove", "--force", str(nested)],
            capture_output=True, check=False,
        ))
        payload = self.run_cli("overlap", cwd=self.b)
        main = [item for item in payload["data"]["worktrees"] if item["main"]]
        self.assertEqual(main[0]["changed"], 0)

    @unittest.skipUnless(SHARED_COPY.exists(), "worktree-cycle is not installed beside plan-graph")
    def test_worktree_cycle_check_reaches_the_same_judgement(self) -> None:
        mine = self.run_cli("overlap", cwd=self.b)
        result = subprocess.run(
            [sys.executable, str(SHARED_COPY), "check", "--repo", str(self.root), "--branch", "b", "--json"],
            capture_output=True, text=True, encoding="utf-8", timeout=60, check=True,
        )
        theirs = json.loads(result.stdout)
        self.assertEqual(theirs["files"], mine["data"]["here"]["changed"])
        self.assertEqual(
            {(str(Path(item["path"]).resolve()), tuple(item["files"])) for item in theirs["overlaps"]},
            {
                (str(Path(item["path"]).resolve()), tuple(item["shared_files"]))
                for item in mine["data"]["overlaps"]
                if item["shared_files"]
            },
        )

    def test_without_git_overlap_degrades(self) -> None:
        plain = self.base / "plain"
        plain.mkdir()
        payload = self.run_cli("overlap", "--root", str(plain), cwd=SKILL)
        self.assertFalse(payload["data"]["available"])


if __name__ == "__main__":
    unittest.main()
