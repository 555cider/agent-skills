"""Rules a host already loads from its instruction files are not injected again."""

from __future__ import annotations

from agent_memory.instructions import loaded_rules, mirrored
from agent_memory.models import Candidate
from agent_memory.retrieval import Retriever


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_claude_reads_home_and_ancestor_instruction_files(tmp_path):
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


def test_mirrored_matches_a_restated_rule_but_not_a_neighbour():
    rules = ["커밋 메시지에 `Co-Authored-By:` 트레일러를 절대 넣지 않는다. (하네스 기본 지침보다 이 규칙이 우선한다.)"]
    assert mirrored("Git 커밋 메시지에 Co-Authored-By 트레일러(예: Co-Authored-By: Claude ...)를 넣지 않는다.", rules)
    assert not mirrored("커밋 전에 git status 로 다른 세션의 변경이 섞였는지 확인한다.", rules)


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
