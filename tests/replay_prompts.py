"""Replay the real prompts a store has captured against a copy of that store.

Retrieval changes are tuned on tests/golden_retrieval.json, but only real prompts
show how much a change injects in practice. The events table keeps each prompt
for seven days, so this copies the store (never writing to it), rebuilds the
copy's indexes with the current code, and reports how many prompts received
memory and how many tokens that cost, split by harness messages and user prompts.

    python3 tests/replay_prompts.py [--store ~/.agents/memory] [--session] [--out FILE]

Run it before and after a change (e.g. with `git stash`) and compare.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from agent_memory.db import Database  # noqa: E402
from agent_memory.providers import NullProvider  # noqa: E402
from agent_memory.retrieval import Retriever  # noqa: E402
from agent_memory.util import is_harness_message  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", default=str(Path.home() / ".agents" / "memory"))
    parser.add_argument("--session", action="store_true", help="replay as one session (upper bound of repeat suppression)")
    parser.add_argument("--out", help="write per-prompt results as JSON")
    args = parser.parse_args()

    source = Path(args.store).expanduser() / "agent-memory.sqlite3"
    with tempfile.TemporaryDirectory(prefix="agent-memory-replay-") as raw:
        home = Path(raw)
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as live, sqlite3.connect(
            home / "agent-memory.sqlite3"
        ) as copy:
            live.backup(copy)
        with Database(home) as db:
            db.rebuild_indexes()
            prompts = [
                (str(row["repo_key"]), str(db.decode_payload(row["payload_zlib"]).get("prompt", "")))
                for row in db.conn.execute(
                    "SELECT repo_key,payload_zlib FROM events WHERE kind='user_prompt' ORDER BY created_at"
                )
            ]
            retriever = Retriever(db, NullProvider())
            results = []
            for project, prompt in prompts:
                if not prompt:
                    continue
                packet = retriever.recall(
                    project=project,
                    prompt=prompt,
                    harness="claude",
                    session_id="replay" if args.session else None,
                )
                results.append(
                    {
                        "source": "harness" if is_harness_message(prompt) else "user",
                        "prompt": prompt[:300],
                        "items": [item["statement"][:120] for item in packet["items"]],
                        "tokens": packet["token_estimate"],
                    }
                )
    report = {}
    for source in ("user", "harness"):
        rows = [row for row in results if row["source"] == source]
        report[source] = {
            "prompts": len(rows),
            "with_items": sum(1 for row in rows if row["items"]),
            "mean_items": round(sum(len(row["items"]) for row in rows) / max(1, len(rows)), 2),
            "tokens": sum(row["tokens"] for row in rows),
        }
    print(json.dumps(report, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
