# Troubleshooting

Where things live, what the less obvious messages mean, and how to recover.

## The database is locked

pacman holds `db.lck` in its database directory (`/var/lib/pacman`, or `DBPath`
from `pacman.conf`) for the length of a transaction. A lock left behind by a
crash blocks every later operation.

The plugin looks for a process holding the file, matching by inode so a holder
in another mount namespace is still found. The affected view waits for a live
holder or offers to remove a stale lock and retry. If the holder cannot be
checked, enable administrative access and retry; the lock is left alone.
Lock removal is recorded under `journalctl -t cockpit-pacman`.

By hand:

```bash
sudo fuser -v /var/lib/pacman/db.lck
sudo rm /var/lib/pacman/db.lck   # only when fuser found nothing
```

If `fuser` prints a process, it is mid-transaction; leave the lock alone.

## An upgrade was interrupted

Cancel stops an operation only before libalpm starts committing. Once package
changes begin, they and the post-transaction hooks run to completion, and a
cancel requested meanwhile is reported alongside the result. Closing the tab,
logging out, or a dropped websocket counts as a cancel and is noted in the
journal.

A commit still stops partway when the backend is killed (SIGKILL, OOM, power
loss) or libalpm fails mid-transaction: some packages are upgraded, the rest
are not, and the post-transaction hooks (initramfs, systemd reload) may not
have run.

Check `pacman.log` to see what was applied. Re-run the upgrade for packages
still out of date. Reinstall any already-upgraded package whose required hooks
failed; repeating the upgrade alone will not redo a current kernel's hooks.

## Only some repositories updated

> Failed to refresh package databases: failed to retrieve some files

Databases refresh per repository, so one dead mirror leaves that repository
stale while the others move on. Upgrading against a half-updated set is the
partial upgrade Arch does not support, so the upgrade refuses to start.

Check which repository failed in the log above the message, then fix the
mirrorlist in the Mirrors tab or retry later.

> error: failed to synchronize all databases (no servers configured for repository)

That repository has no enabled `Server` or `Include` line. If this follows an
edit, restore the previous `/etc/pacman.conf` from Backup history in the
Repositories tab.

## A scheduled run did not happen

```bash
systemctl list-timers cockpit-pacman-scheduled.timer
journalctl -u cockpit-pacman-scheduled.service
```

Run records are stored in `/var/log/cockpit-pacman/scheduled.jsonl`. The plugin
also checks systemd's latest completed invocation, so a missing or unreadable
record does not silently leave the previous run at the top of the history.

- A cgroup-wide kill can also kill `ExecStopPost`. The separate failure handler
  writes to the journal, and systemd supplies the failed result to the UI.
- Unreadable or malformed configuration stops a scheduled run before any
  package work. The error is journaled; an interrupted-run record whose mode
  cannot be read labels it `unknown`.
- A full log filesystem prevents the JSONL write. The write error is journaled
  without changing the package operation's exit status. A successful service
  without a record appears as **Record unavailable**, with unknown package
  counts, rather than a failed upgrade.

New records include the systemd invocation ID to avoid duplicate entries.
Independent service evidence describes only the most recent invocation and
can be lost after reboot or unit unloading; it does not reconstruct older
missing records. Use the journal for older diagnostics when available.

## A save was refused

Repositories and Mirrors refuse a save if the file changed since it was read
or pacman holds the database lock. Your edits stay in the page. Reload and
reapply them, or review the outside changes before choosing to overwrite.
Undo also checks the saved revision and refuses to overwrite a later edit.

## History origins

History labels transactions recorded by the plugin as From Cockpit or
Scheduled upgrade. Older entries matched to a scheduled run by time are
labelled Probably scheduled. Unlabelled entries can come from pacman or
another tool; they do not establish who ran the command.

## Backend command diagnostics

Commands that end with an error, and background news refreshes, write
warnings under `journalctl -t cockpit-pacman`. A news refresh that uses cached
content also records the refresh error. The argument list and credential input
are not logged, though an error message can name the package or path involved.
Journal writes are best effort and bounded; an unavailable journal does not
prevent a command from returning its result to the UI.

## Advisories that look ancient

The Security panel reads Arch's security tracker, whose records stay open
until someone closes them, often long after a fix ships, so an old advisory
keeps matching current versions.

Advisories are split by whether updating resolves them; "no fix recorded"
means the tracker names no version to upgrade to. To turn the panel off, see
`security_advisories` in [configuration.md](configuration.md).

## Where things live

| Path | What |
|---|---|
| `/etc/cockpit-pacman/config.json` | Schedule, ignored packages, feature flags. Root owned, `0644`. |
| `/etc/systemd/system/cockpit-pacman-scheduled.timer.d/schedule.conf` | The `OnCalendar` override the schedule writes. |
| `/var/log/cockpit-pacman/scheduled.jsonl` | One line per scheduled run. |
| `~/.config/cockpit-pacman/` | Per-user caches and dismissals. Deleting it costs the dismissals; the caches rebuild. |
| `/etc/pacman.conf.backup.<epoch>` | Taken before each repository save. |
| `/etc/pacman.d/mirrorlist.backup.<epoch>` | Taken before each mirrorlist save. |

Five backups of each are kept. The newest backup is protected so a restore can
be undone; remaining slots prefer manual backups. The Origin column identifies
manual and automatic backups.

Restore from Backup history in the Mirrors and Repositories tabs, or by hand:

```bash
sudo cp /etc/pacman.d/mirrorlist.backup.1787527641 /etc/pacman.d/mirrorlist
```

## Every panel says not permitted

The plugin reads as the logged-in user and asks for administrator access only
to change something. A view that stopped working usually means the session has
not escalated: use the administrative access button in Cockpit's header.

Uninstalling keeps `/etc/cockpit-pacman`, `/var/log/cockpit-pacman` and the
backups. Remove them by hand if you want them gone.
