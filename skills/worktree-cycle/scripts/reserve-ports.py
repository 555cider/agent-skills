#!/usr/bin/env python3
"""Serialize per-user, cross-repository port candidates; strict server bind is still required."""
import argparse
from contextlib import contextmanager, ExitStack
import errno
import hashlib
import json
import os
from pathlib import Path
import socket
import shlex
import subprocess
import sys
import time


@contextmanager
def registry_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        deadline = time.monotonic() + 10
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('port registry is busy; retry after the other allocator exits')
                time.sleep(0.05)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def available(base):
    with ExitStack() as stack:
        for port in range(base, base + 10):
            for family, host in ((socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
                try:
                    sock = stack.enter_context(socket.socket(family, socket.SOCK_STREAM))
                    if family == socket.AF_INET6:
                        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    if os.name == 'nt':
                        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                    sock.bind((host, port))
                except OSError as exc:
                    if family == socket.AF_INET6 and exc.errno in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.EADDRNOTAVAIL):
                        continue
                    return False
        return True


def recorded_base(git_dir):
    try:
        for line in (Path(git_dir) / 'worktree-ports').read_text(encoding='utf-8').splitlines():
            if line.startswith('WORKTREE_PORT_BASE='):
                return int(line.split('=', 1)[1])
    except (FileNotFoundError, ValueError):
        return None


def atomic_write(path, content):
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    try:
        with temporary.open('w', encoding='utf-8', newline='\n') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def reserve(args):
    registry = Path(os.environ.get('WORKTREE_CYCLE_PORT_REGISTRY',
                                  str(Path.home() / '.cache/worktree-cycle/ports.json'))).resolve()
    git_dir = Path(args.git_dir).resolve(strict=True)
    if args.port_base is not None and (args.port_base % 10 or not 20000 <= args.port_base <= 29990):
        raise RuntimeError('port base must be a multiple of 10 in 20000..29990')
    with registry_lock(registry.with_suffix('.lock')):
        rows = json.loads(registry.read_text(encoding='utf-8')) if registry.exists() else []
        rows = [row for row in rows if recorded_base(row['git_dir']) == row['base']]
        # Import legacy sibling reservations; older installs in other repositories remain
        # outside this registry until used by the updated allocator.
        siblings = subprocess.run(['git', '-C', args.repo, 'worktree', 'list', '--porcelain'],
                                  capture_output=True, text=True, encoding='utf-8')
        for line in siblings.stdout.splitlines():
            if not line.startswith('worktree '):
                continue
            result = subprocess.run(['git', '-C', line[9:], 'rev-parse', '--absolute-git-dir'],
                                    capture_output=True, text=True, encoding='utf-8')
            if result.returncode:
                continue
            other = str(Path(result.stdout.strip()).resolve())
            base = recorded_base(other)
            if base is not None and all(row['git_dir'] != other for row in rows):
                rows.append({'git_dir': other, 'base': base})
        used = {row['base'] for row in rows if row['git_dir'] != str(git_dir)}
        seed = int.from_bytes(hashlib.sha256(f'{Path(args.repo).resolve()}\n{args.branch}'.encode()).digest()[:8], 'big') % 1000
        candidates = [args.port_base] if args.port_base is not None else [20000 + ((seed + i) % 1000) * 10 for i in range(1000)]
        for base in candidates:
            if base in used:
                if args.port_base is not None:
                    raise RuntimeError(f'port block {base} is already reserved')
                continue
            if not available(base):
                if args.port_base is not None:
                    raise RuntimeError(f'port block {base} is unavailable to bind')
                continue
            rows = [row for row in rows if row['git_dir'] != str(git_dir)]
            rows.append({'git_dir': str(git_dir), 'base': base})
            atomic_write(git_dir / 'worktree-ports', f'WORKTREE_BRANCH={shlex.quote(args.branch)}\nWORKTREE_PORT_BASE={base}\nWORKTREE_PORT_COUNT=10\n')
            atomic_write(registry, json.dumps(rows, indent=2) + '\n')
            return base
        raise RuntimeError('no available port block')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--branch', required=True)
    parser.add_argument('--git-dir', required=True)
    parser.add_argument('--port-base', type=int)
    args = parser.parse_args()
    try:
        print(reserve(args))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
        print(f'port reservation failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
