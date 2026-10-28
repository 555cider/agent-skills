import concurrent.futures
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'reserve-ports.py'


class PortReservations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='port-reservations-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'WORKTREE_CYCLE_PORT_REGISTRY': str(self.root / 'registry.json')}

    def reserve(self, name, base=None):
        git_dir = self.root / name
        git_dir.mkdir(exist_ok=True)
        cmd = [sys.executable, str(SCRIPT), '--repo', str(self.root / name),
               '--branch', 'feature', '--git-dir', str(git_dir)]
        if base is not None:
            cmd += ['--port-base', str(base)]
        return subprocess.run(cmd, env=self.env, capture_output=True, text=True)

    def test_explicit_collision_across_repositories(self):
        first = self.reserve('one')
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.reserve('two', int(first.stdout))
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('reserved', second.stderr)
        self.assertFalse((self.root / 'two' / 'worktree-ports').exists())

    def test_explicit_occupied_port_is_rejected(self):
        with socket.socket() as listener:
            for port in range(20000, 30000, 10):
                try:
                    listener.bind(('127.0.0.1', port))
                    break
                except OSError:
                    continue
            else:
                self.skipTest('no free fixture port')
            listener.listen()
            result = self.reserve('busy', port)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('unavailable', result.stderr)

    def test_concurrent_allocations_are_unique(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(self.reserve, ['a', 'b', 'c', 'd']))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len({r.stdout.strip() for r in results}), 4)
        self.assertEqual(len(json.loads((self.root / 'registry.json').read_text())), 4)

    def test_fresh_lock_file_survives_simultaneous_first_use(self):
        # Regression: the lock used to seed a byte into a fresh lock file, and a process could
        # flush that byte into the region another had just locked; Windows answers EACCES.
        # Start several lockers at the same instant against a lock file nobody has created.
        helper = '\n'.join([
            'import importlib.util, os, sys, time',
            'from pathlib import Path',
            'spec = importlib.util.spec_from_file_location("rp", sys.argv[1])',
            'rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)',
            'lock, start = Path(sys.argv[2]), float(sys.argv[3])',
            'while time.time() < start: pass',
            'with rp.registry_lock(lock):',
            '    fd = os.open(lock.with_name("held"), os.O_CREAT | os.O_EXCL | os.O_WRONLY)',
            '    time.sleep(0.002); os.close(fd); os.unlink(lock.with_name("held"))',
        ])
        for attempt in range(3):
            lock = self.root / f'fresh-{attempt}.lock'
            start = time.time() + 1.0
            procs = [subprocess.Popen([sys.executable, '-c', helper, str(SCRIPT), str(lock), str(start)],
                                      stderr=subprocess.PIPE, text=True) for _ in range(8)]
            for proc in procs:
                _, err = proc.communicate()
                self.assertEqual(proc.returncode, 0, err)

    def test_removed_reservation_is_reclaimed(self):
        first = self.reserve('old')
        self.assertEqual(first.returncode, 0, first.stderr)
        (self.root / 'old' / 'worktree-ports').unlink()
        again = self.reserve('new', int(first.stdout))
        self.assertEqual(again.returncode, 0, again.stderr)

    def test_simultaneous_explicit_collision_has_one_winner(self):
        fixture = self.reserve('fixture')
        self.assertEqual(fixture.returncode, 0, fixture.stderr)
        base = int(fixture.stdout)
        (self.root / 'fixture' / 'worktree-ports').unlink()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda name: self.reserve(name, base), ['a', 'b', 'c', 'd']))
        self.assertEqual(sum(item.returncode == 0 for item in results), 1)

    def test_auto_allocation_skips_new_listener_on_preferred_block(self):
        first = self.reserve('same')
        self.assertEqual(first.returncode, 0, first.stderr)
        base = int(first.stdout)
        (self.root / 'same' / 'worktree-ports').unlink()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', base))
            listener.listen()
            second = self.reserve('same')
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertNotEqual(int(second.stdout), base)

    def test_corrupt_registry_is_not_overwritten(self):
        path = self.root / 'registry.json'
        path.write_text('{broken', encoding='utf-8')
        result = self.reserve('one')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_text(), '{broken')
        self.assertFalse((self.root / 'one' / 'worktree-ports').exists())


if __name__ == '__main__':
    unittest.main()
