import { test, type FrameLocator } from "@playwright/test";
import { guestCommand } from "./guest";

export async function withSavedConfig(frame: FrameLocator, kind: "repo" | "mirror", run: () => Promise<void>): Promise<void> {
  const snapshot = (await guestCommand(frame, ["python3", "-c", `
import json, pathlib, re, shutil, sys, tempfile
target = pathlib.Path('/etc/pacman.conf' if sys.argv[1] == 'repo' else '/etc/pacman.d/mirrorlist')
manifest = target.parent / ('.pacman-conf-backups.meta.json' if sys.argv[1] == 'repo' else '.mirrorlist-backups.meta.json')
pattern = re.escape(target.name) + r'\\.backup\\.[0-9]+'
paths = [target, manifest, *(p for p in target.parent.iterdir() if re.fullmatch(pattern, p.name))]
work = pathlib.Path(tempfile.mkdtemp(prefix='cpac-config-e2e-'))
files = {}
for path in paths:
    if path.exists():
        info = path.stat()
        shutil.copy2(path, work / path.name)
        files[path.name] = [info.st_uid, info.st_gid]
(work / 'snapshot.json').write_text(json.dumps({'parent': str(target.parent), 'names': [target.name, manifest.name], 'pattern': pattern, 'files': files}))
print(work)
`, kind])).trim();
  let failure: { error: unknown } | undefined;
  try {
    await run();
  } catch (error) {
    failure = { error };
  }
  try {
    await guestCommand(frame, ["python3", "-c", `
import json, os, pathlib, re, shutil, sys
work = pathlib.Path(sys.argv[1])
saved = json.loads((work / 'snapshot.json').read_text())
parent = pathlib.Path(saved['parent'])
for path in parent.iterdir():
    if path.name in saved['names'] or re.fullmatch(saved['pattern'], path.name):
        path.unlink()
for name, (uid, gid) in saved['files'].items():
    target = parent / name
    shutil.copy2(work / name, target)
    os.chown(target, uid, gid)
shutil.rmtree(work)
`, snapshot]);
  } catch (error) {
    if (!failure) throw error;
    test.info().annotations.push({ type: "cleanup failed", description: `Configuration snapshot: ${snapshot}. ${String(error)}` });
  }
  if (failure) throw failure.error;
}
