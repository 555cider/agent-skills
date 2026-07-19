#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from agent_memory.constants import RECORD_SCHEMA  # noqa: E402
from agent_memory.db import Database  # noqa: E402
from agent_memory.providers import NullProvider  # noqa: E402
from agent_memory.retrieval import Retriever  # noqa: E402
from agent_memory.util import digest_text, repo_key, semantic_tokens, stable_json, utc_now  # noqa: E402


def percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * percent) - 1))
    return ordered[index]


def seed(db: Database, records: int, project: str) -> None:
    now = utc_now()
    def memory_rows():
        for index in range(records):
            memory_id = f"mem_bench_{index:08d}"
            statement = f"Component {index} uses verification command check-token-{index}."
            yield (
                memory_id,
                RECORD_SCHEMA,
                "procedure",
                "project",
                project,
                "[]",
                statement,
                "[]",
                "active",
                "verified",
                0.9,
                now,
                "2099-01-01T00:00:00.000Z",
                1,
                digest_text(statement),
                now,
                now,
                now,
            )

    def fts_rows():
        for index in range(records):
            memory_id = f"mem_bench_{index:08d}"
            statement = f"Component {index} uses verification command check-token-{index}."
            yield (memory_id, statement, "", "", " ".join(semantic_tokens(statement)))

    def trigram_rows():
        for index in range(records):
            memory_id = f"mem_bench_{index:08d}"
            statement = f"Component {index} uses verification command check-token-{index}."
            yield (memory_id, statement + " " + " ".join(semantic_tokens(statement)))

    with db.transaction(immediate=True):
        db.conn.executemany(
            "INSERT INTO memories(id,schema_name,kind,scope,repo_key,path_globs_json,statement,"
            "conditions_json,state,authority,confidence,valid_from,stale_after,revision,content_hash,"
            "created_at,updated_at,last_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            memory_rows(),
        )
        if db.fts5:
            db.conn.executemany(
                "INSERT INTO memory_fts(memory_id,statement,conditions,paths,semantic) VALUES(?,?,?,?,?)",
                fts_rows(),
            )
        if db.trigram:
            db.conn.executemany(
                "INSERT INTO memory_trigram(memory_id,text) VALUES(?,?)", trigram_rows()
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=int, default=50_000)
    parser.add_argument("--queries", type=int, default=200)
    parser.add_argument("--recall-p95-ms", type=float, default=100.0)
    parser.add_argument("--hook-p95-ms", type=float, default=150.0)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="agent-memory-bench-") as raw:
        with Database(Path(raw)) as db:
            project = repo_key(Path(raw))
            seed(db, args.records, project)
            retriever = Retriever(db, NullProvider())
            timings: list[float] = []
            misses = 0
            for index in range(args.queries):
                target = (index * 7919) % args.records
                started = time.perf_counter()
                packet = retriever.recall(
                    project=project,
                    prompt=f"How do I run check-token-{target}?",
                    limit=5,
                )
                timings.append((time.perf_counter() - started) * 1000)
                if not any(f"check-token-{target}" in item["statement"] for item in packet["items"]):
                    misses += 1
            hook_timings: list[float] = []
            hook_misses = 0
            script = SKILL_ROOT / "scripts" / "memory.py"
            for index in range(min(25, args.queries)):
                target = (index * 7919) % args.records
                payload = stable_json(
                    {
                        "session_id": "benchmark",
                        "event_id": f"hook-{index}",
                        "cwd": raw,
                        "prompt": f"How do I run check-token-{target}?",
                    }
                )
                started = time.perf_counter()
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(script),
                        "--memory-home",
                        raw,
                        "hook",
                        "--harness",
                        "codex",
                        "--event",
                        "user_prompt",
                    ],
                    input=payload,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=5,
                    check=False,
                )
                hook_timings.append((time.perf_counter() - started) * 1000)
                if completed.returncode or f"check-token-{target}" not in completed.stdout:
                    hook_misses += 1
            result = {
                "records": args.records,
                "queries": args.queries,
                "misses": misses,
                "median_ms": round(statistics.median(timings), 3),
                "p95_ms": round(percentile(timings, 0.95), 3),
                "threshold_ms": args.recall_p95_ms,
                "hook_queries": len(hook_timings),
                "hook_misses": hook_misses,
                "hook_p95_ms": round(percentile(hook_timings, 0.95), 3),
                "hook_threshold_ms": args.hook_p95_ms,
            }
            print(json.dumps(result, indent=2))
            return (
                1
                if misses
                or hook_misses
                or result["p95_ms"] > args.recall_p95_ms
                or result["hook_p95_ms"] > args.hook_p95_ms
                else 0
            )


if __name__ == "__main__":
    raise SystemExit(main())
