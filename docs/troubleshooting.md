# Troubleshooting

Where things live, what the less obvious messages mean, and how to recover.

## The database is locked

pacman holds `db.lck` in its database directory (`/var/lib/pacman`, or `DBPath`
from `pacman.conf`) for the length of a transaction. A lock left behind by a
crash blocks every later operation.

The plugin looks for a process holding the file, matching by inode so a holder
in another mount namespace is still found. If nothing holds it, the Updates
view offers to clear it and logs that it did (`journalctl -t cockpit-pacman`).

By hand:

```bash
sudo fuser -v /var/lib/pacman/db.lck
sudo rm /var/lib/pacman/db.lck   # only when fuser found nothing
```

If `fuser` prints a process, it is mid-transaction; leave the lock alone.

## An upgrade was interrupted

> Operation interrupted - system may be in inconsistent state

libalpm stops between packages: some are upgraded, the rest are not, and the
post-transaction hooks (initramfs, systemd reload) did not run.

Re-run the upgrade. Nothing resumes; the transaction is recomputed from the
database, so whatever is still out of date is upgraded and the hooks run at
the end.

Two lookalikes:

- Cancel interrupts on purpose, and reports this.
- Closing the tab, logging out, or a dropped websocket does not interrupt a
  transaction that is already applying. The backend finishes it, records it,
  and notes the disconnection in the journal. Work that has not started stops.

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

Each run appends one JSON line to `/var/log/cockpit-pacman/scheduled.jsonl`,
and the Updates view reads that file. Three cases run without writing a record:

- The service was killed cgroup-wide (`systemctl kill`, systemd-oomd). The
  failure handler (`cockpit-pacman-failure@.service`) runs outside the cgroup
  and still leaves a line.
- `config.json` is malformed. The run exits non-zero before doing any work,
  which also reaches the failure handler.
- `/var/log` is full. The write error goes to stderr and the run still exits
  0, since an upgrade that already landed must not be reported as failed. The
  journal has the line.

When the file and the journal disagree, the journal is the authority.

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

Five backups of each are kept. Manual ones outrank the automatic ones taken
before a restore, so a run of restores cannot evict them; the Origin column in
Backup history says which is which.

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
