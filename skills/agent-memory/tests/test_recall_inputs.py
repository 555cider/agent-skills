"""What the prompt hook treats as the user's request.

Measured on a real store: of 739 prompt events, 421 were task notifications and
217 slash commands, so recall mostly answered the host and the command name.
"""

from __future__ import annotations

import pytest

from agent_memory.models import Candidate
from agent_memory.retrieval import Retriever
from agent_memory.util import recall_query, repo_key, user_text

PASTE = '\n\n<pasted_content id="7676">\ninstallHook.js:1 [tessellate] the shape kernel did not draw 3 objects\n</pasted_content id="7676">\n'


def candidate(statement: str) -> Candidate:
    return Candidate(kind="preference", scope="project", statement=statement, authority="explicit", confidence=1.0)


@pytest.mark.parametrize(
    ("prompt", "query"),
    [
        ("<task-notification>\n<task-id>b1</task-id>\n<summary>done</summary>\n</task-notification>", ""),
        ("<task-notification><summary>x</summary></task-notification>\n\nrerun the deploy", "rerun the deploy"),
        ("/agent-skills:step-back", ""),
        ("/agent-skills:step-back   ", ""),
        ("/agent-skills:peer-review the rsync deploy plan", "the rsync deploy plan"),
        ("/daily-report\n어제 배포", "어제 배포"),
        (
            "<command-message>step-back is running</command-message>\n"
            "<command-name>/agent-skills:step-back</command-name>\n<command-args></command-args>",
            "",
        ),
        (
            "<command-name>/peer-review</command-name>\n<command-args>deploy plan</command-args>",
            "deploy plan",
        ),
        (PASTE, ""),
        ("why does the kernel fail here?" + PASTE, "why does the kernel fail here?"),
        ('<pasted_content id="1">\ncut short by the host', ""),
        # A path is not a command.
        ("/c/opt/repo/build.sh fails", "/c/opt/repo/build.sh fails"),
        ("린트 돌려줘", "린트 돌려줘"),
        ("[SYSTEM NOTIFICATION] background job finished", ""),
        ("<task-notification>\n<summary>cut short", ""),
        # A path the user typed first is not a command.
        ("/v1.2 release notes", "/v1.2 release notes"),
        ("explain what `<pasted_content>` means here", "explain what `<pasted_content>` means here"),
    ],
)
def test_recall_query_keeps_only_what_the_user_asked(prompt, query):
    assert recall_query(prompt) == query


def test_user_text_drops_a_notification_but_keeps_the_paste():
    assert user_text("<task-notification>x</task-notification>") == ""
    assert "pasted_content" in user_text("look" + PASTE)


@pytest.mark.parametrize(
    "prompt",
    [
        "/agent-skills:step-back",
        "<command-name>/agent-skills:step-back</command-name>\n<command-args></command-args>",
        PASTE,
    ],
)
def test_command_names_and_pastes_recall_nothing(memory, prompt):
    db, service, project = memory
    service.create_memory(candidate("Run the agent-skills step-back check when a decision is unclear."), project=project)
    service.create_memory(candidate("installHook tessellate kernel errors mean the wasm needs a rebuild."), project=project)

    packet = Retriever(db, service.provider).recall(project=project, prompt=prompt)

    assert packet["items"] == []
    assert packet["context"] == ""


def test_slash_command_arguments_are_the_query(memory):
    db, service, project = memory
    stored = service.create_memory(candidate("The rsync deploy plan copies to the staging host first."), project=project)

    packet = Retriever(db, service.provider).recall(
        project=project, prompt="/agent-skills:peer-review the rsync deploy plan"
    )

    assert [item["id"] for item in packet["items"]] == [stored["id"]]


@pytest.mark.parametrize(
    "prompt",
    [
        "/agent-skills:agent-memory remember that deploys go through rsync",
        "<command-name>/x</command-name>\n<command-args>forget the rsync caveat</command-args>",
    ],
)
def test_slash_commands_neither_store_nor_forget(memory, tmp_path, prompt):
    db, service, _ = memory
    project = repo_key(tmp_path)
    stored = service.create_memory(candidate("the rsync caveat is that deletes are not mirrored"), project=project)

    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={"session_id": "s", "event_id": "c1", "prompt": prompt},
        cwd=tmp_path,
    )

    assert result["immediate_memories"] == [] and result["forgotten"] == []
    assert db.conn.execute("SELECT count(*) FROM memories WHERE id=?", (stored["id"],)).fetchone()[0] == 1


def test_user_words_after_a_notification_still_store(memory, tmp_path):
    _, service, _ = memory

    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={
            "session_id": "s",
            "event_id": "c2",
            "prompt": "<task-notification><summary>done</summary></task-notification>\n"
            "remember that deploys go through rsync",
        },
        cwd=tmp_path,
    )

    assert [item["statement"] for item in result["stored"]] == ["deploys go through rsync"]



def test_an_existing_path_is_not_a_command(monkeypatch):
    import agent_memory.util as util

    monkeypatch.setattr(util.os.path, "exists", lambda value: value == "/tmp")
    assert recall_query("/tmp 폴더를 기억해") == "/tmp 폴더를 기억해"
    assert recall_query("/review the plan") == "the plan"
