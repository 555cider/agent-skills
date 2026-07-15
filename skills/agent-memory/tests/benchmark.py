#!/usr/bin/env python3
"""Repeatable FTS query benchmark for the agent-memory derived index.

This isolates index/query cost from filesystem fixture creation. The production
rebuild code and recall SQL are used unchanged; only the Markdown entry loader
is replaced with deterministic synthetic records.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import statistics
import tempfile
import time


def load_memory_module():
    script = Path(__file__).resolve().parents[1] / "scripts" / "memory.py"
    spec = importlib.util.spec_from_file_location("agent_memory_benchmark", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=int, default=50_000)
    parser.add_argument("--queries", type=int, default=200)
    parser.add_argument("--max-p95-ms", type=float, default=25.0)
    args = parser.parse_args()
    memory = load_memory_module()
    repo_key = "benchmark-repo"
    entries = []
    for index in range(args.records):
        entries.append(
            {
                "key": f"record:mem_bench_{index}",
                "kind": "record",
                "scope": "project",
                "repo_key": repo_key,
                "memory_type": "project-fact",
                "status": "active",
                "priority": "explicit",
                "source": "repo",
                "confidence": "high",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
                "last_verified": "2026-01-01",
                "summary": f"Synthetic memory number {index}",
                "aliases": f"alias-{index} shared-benchmark-term",
                "tags": "benchmark",
                "body": f"Deterministic body for record {index}",
                "evidence": "benchmark fixture",
                "path": f"/synthetic/{index}.md",
                "id": f"mem_bench_{index}",
            }
        )

    with tempfile.TemporaryDirectory(prefix="agent-memory-benchmark-") as raw:
        home = Path(raw)
        original_loader = memory.indexed_memory_entries
        memory.indexed_memory_entries = lambda _home: entries
        started = time.perf_counter()
        built = memory.rebuild_index(home)
        build_ms = (time.perf_counter() - started) * 1000
        memory.indexed_memory_entries = original_loader
        if built.get("backend") != "sqlite_fts5":
            print("SKIP fts5 unavailable")
            return 0

        samples = []
        for query_index in range(args.queries):
            started = time.perf_counter()
            # Prompt recall is usually selective (a command, repo term, alias,
            # or component name), so rotate deterministic unique aliases.
            wanted = f"alias-{query_index % args.records}"
            results = memory.sqlite_recall(home, repo_key, [wanted], False, 40)
            samples.append((time.perf_counter() - started) * 1000)
            if not results:
                raise RuntimeError("benchmark query returned no records")

    p50 = statistics.median(samples)
    p95 = sorted(samples)[max(0, int(len(samples) * 0.95) - 1)]
    print(f"records={args.records} queries={args.queries} build_ms={build_ms:.3f} p50_ms={p50:.3f} p95_ms={p95:.3f}")
    if p95 > args.max_p95_ms:
        print(f"FAIL p95 {p95:.3f}ms exceeds {args.max_p95_ms:.3f}ms")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
