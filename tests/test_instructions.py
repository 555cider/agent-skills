"""Rules a host already loads from its instruction files are not injected again."""

from __future__ import annotations

from agent_memory.instructions import loaded_rules, native_memory_dirs
from agent_memory.models import Candidate
from agent_memory.retrieval import Retriever


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_claude_reads_home_and_ancestor_instruction_files(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    home = tmp_path / "home"
    repo = tmp_path / "work" / "repo"
    _write(home / ".claude" / "CLAUDE.md", "# 전역\n\n- 커밋 메시지에 `Co-Authored-By:` 트레일러를 절대 넣지 않는다.\n")
    _write(repo / "CLAUDE.md", "- Run pnpm check before pushing.\n  Wrapped continuation of the same rule.\n")
    _write(repo / "AGENTS.md", "- Codex only rule about deploy scripts.\n")
    (repo / "pkg").mkdir()

    claude = loaded_rules("claude", repo / "pkg", home=home)
    assert any("Co-Authored-By" in rule for rule in claude)
    assert any("pnpm check" in rule and "continuation" in rule for rule in claude)
    assert not any("Codex only" in rule for rule in claude)
    assert any("Codex only" in rule for rule in loaded_rules("codex", repo, home=home))


def test_recall_skips_records_the_host_already_loaded(memory):
    db, service, project = memory
    loaded = service.create_memory(
        Candidate(kind="preference", scope="project", statement="커밋 메시지는 핵심만 짧게 쓴다.", authority="explicit"),
        project=project,
    )
    other = service.create_memory(
        Candidate(kind="preference", scope="project", statement="커밋 전에 git status 를 확인한다.", authority="explicit"),
        project=project,
    )
    packet = Retriever(db, service.provider).recall(
        project=project, prompt="커밋해줘", loaded_rules=["커밋 메시지는 핵심만 짧게."]
    )
    ids = {item["id"] for item in packet["items"]}
    assert loaded["id"] not in ids and other["id"] in ids


def test_claude_follows_imports_four_hops_from_the_config_dir(tmp_path, monkeypatch):
    home = tmp_path / "home"
    profile = tmp_path / "profile"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(profile))
    _write(profile / "CLAUDE.md", "# 프로필\n\n@~/.claude/CLAUDE.md\n\n```\n@code.md\n```\nInline `@code.md` too.\n")
    _write(home / ".claude" / "CLAUDE.md", "- 발견한 버그를 고칠까요로 넘기지 않는다.\n\nSee @one.md for more.\n")
    _write(home / ".claude" / "one.md", "- hop two rule about release notes\n@two.md\n")
    _write(home / ".claude" / "two.md", "- hop three rule about changelog entries\n@three.md\n")
    _write(home / ".claude" / "three.md", "- hop four rule about version tags\n@four.md\n")
    _write(home / ".claude" / "four.md", "- hop five rule is beyond the limit\n")
    _write(profile / "punct.md", "- rule imported with trailing punctuation\n")
    _write(profile / "paren.md", "- rule imported from inside parentheses\n")
    (profile / "CLAUDE.md").write_text(
        (profile / "CLAUDE.md").read_text(encoding="utf-8") + "Also @punct.md, and (@paren.md).\n",
        encoding="utf-8",
    )
    _write(profile / "code.md", "- inside a code span rule\n")
    repo = tmp_path / "repo"
    repo.mkdir()

    rules = loaded_rules("claude", repo, home=home)

    assert any("고칠까요" in rule for rule in rules)
    assert any("hop four" in rule for rule in rules)
    assert not any("hop five" in rule for rule in rules)
    assert not any("code span" in rule for rule in rules)
    assert any("trailing punctuation" in rule for rule in rules)
    assert any("inside parentheses" in rule for rule in rules)
    # Codex has no import syntax; its AGENTS.md is read as written.
    assert not any("고칠까요" in rule for rule in loaded_rules("codex", repo, home=home))


def test_claude_counts_the_projects_auto_memory_index_as_loaded(tmp_path, monkeypatch):
    home = tmp_path / "home"
    profile = tmp_path / "profile"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(profile))
    repo = tmp_path / "opt" / "repo"
    worktree = repo / ".worktrees" / "topic"
    worktree.mkdir(parents=True)
    memory_dir = profile / "projects" / _slug(repo) / "memory"
    _write(memory_dir / "MEMORY.md", "- [Deploy](deploy.md) — deploys go through rsync to staging first\n")

    rules = loaded_rules("claude", worktree, home=home, project_root=repo)

    assert any("rsync to staging" in rule for rule in rules)
    assert native_memory_dirs("claude", worktree, home=home, project_root=repo) == [memory_dir.resolve()]
    assert native_memory_dirs("codex", worktree, home=home, project_root=repo) == []


def _slug(path):
    import re

    return re.sub(r"[^A-Za-z0-9]", "-", str(path.resolve()))


def test_claude_recall_skips_records_adopted_from_its_own_auto_memory(memory, tmp_path, monkeypatch):
    db, service, project = memory
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    native = tmp_path / "home" / ".claude" / "projects" / "C--repo" / "memory"
    elsewhere = tmp_path / "home" / ".claude" / "projects" / "C--other" / "memory"

    def adopted(statement, directory):
        return service.create_memory(
            Candidate(
                kind="preference",
                scope="project",
                statement=statement,
                authority="explicit",
                evidence=[
                    {"kind": "import.claude-memory", "summary": f"~/{(directory / 'deploy.md').relative_to(tmp_path / 'home').as_posix()} § deploy"}
                ],
            ),
            project=project,
        )

    own = adopted("Deploys go through rsync to the staging host first.", native)
    other = adopted("Deploys run the rsync smoke check after upload.", elsewhere)
    retriever = Retriever(db, service.provider)

    claude = retriever.recall(project=project, prompt="rsync deploy", harness="claude", native_memory_dirs=[native])
    codex = retriever.recall(project=project, prompt="rsync deploy", harness="codex", session_id="c")

    assert {item["id"] for item in claude["items"]} == {other["id"]}
    assert {item["id"] for item in codex["items"]} == {own["id"], other["id"]}
