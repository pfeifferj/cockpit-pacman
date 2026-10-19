import { test, expect } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";

test("news read state is reversible and stale dismissal Undo preserves newer state", async ({ pacman }) => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires a disposable VM snapshot");
  await pacman.navigateToPlugin();
  const result = JSON.parse(await guestCommand(pacman.frame, ["python3", "-c", `
import json, pathlib, stat, subprocess, sys
root = pathlib.Path.home() / '.config/cockpit-pacman'
root.mkdir(parents=True, exist_ok=True)
kinds = ['reboot', 'services', 'pacnew', 'scheduled']
names = ['news-read.json', *[kind + '-dismissed.json' for kind in kinds]]
paths = [root / name for name in names]
saved = {path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() else None for path in paths}
def run(*args, success=True):
    process = subprocess.run([sys.argv[1], *args], capture_output=True, text=True, timeout=15)
    response = json.loads(process.stdout)
    assert ('code' not in response) == success, (args, process.stdout, process.stderr)
    return response
try:
    (root / 'news-read.json').write_text('{"dismissed":[]}')
    run('news-mark-read', 'https://archlinux.org/news/fixture-one/')
    run('news-mark-read', 'https://archlinux.org/news/fixture-two/')
    news = run('news-mark-unread', 'https://archlinux.org/news/fixture-one/')
    results = {}
    for kind in kinds:
        run('mark-dismissed', kind, 'previous')
        run('mark-dismissed', kind, 'current')
        restored = run('restore-dismissed', kind, 'current', 'previous')
        run('mark-dismissed', kind, 'external')
        rejected = run('restore-dismissed', kind, 'current', 'previous', success=False)
        preserved = run('dismissal-state', kind)
        cleared = run('restore-dismissed', kind, 'external')
        results[kind] = {'restored': restored, 'rejected': rejected, 'preserved': preserved, 'cleared': cleared}
    print(json.dumps({'news': news, 'dismissals': results}))
finally:
    for path, snapshot in saved.items():
        if snapshot is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(snapshot[0])
            path.chmod(snapshot[1])
`, BACKEND], false));
  expect(result.news.dismissed).toEqual(["https://archlinux.org/news/fixture-two/"]);
  for (const kind of ["reboot", "services", "pacnew", "scheduled"]) {
    expect(result.dismissals[kind]).toMatchObject({
      restored: { signature: "previous" },
      rejected: { code: "config_changed" },
      preserved: { signature: "external" },
      cleared: { signature: null },
    });
  }
});
