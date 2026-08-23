# Configuration

Persistent settings live in `/etc/cockpit-pacman/config.json`. The file is owned
by root and written `0644`: only root may change it, but the plugin reads it as
the logged-in user, so it has to be world-readable. It is normally managed
through the plugin UI. The backend rewrites it atomically under a lock, so hand
edits are safe between operations.

A file written by an older version is `0600` and stays that way until the next
save, which rewrites it `0644`.

## Schema

```json
{
  "security_advisories": true,
  "ignored_packages": ["linux", "nvidia"],
  "schedule": {
    "enabled": false,
    "mode": "upgrade",
    "schedule": "weekly",
    "max_packages": 0
  }
}
```

- `ignored_packages`: package names excluded from upgrades (pacman `IgnorePkg`).
- `schedule.enabled`: whether the scheduled-upgrade systemd timer is active.
- `schedule.mode`: `check` (report available updates only) or `upgrade` (apply them).
- `schedule.schedule`: a systemd `OnCalendar` spec, or one of the presets
  `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `quarterly`.
- `schedule.max_packages`: safety cap on how many packages a scheduled run will
  upgrade; `0` means unlimited.

Enabling a schedule writes a systemd timer drop-in at
`/etc/systemd/system/cockpit-pacman-scheduled.timer.d/schedule.conf`.

## Forward compatibility

Keys the running backend does not recognize are preserved, not dropped, when the
file is rewritten. A config written by a newer version round-trips through an
older one without losing fields, so upgrading and downgrading the plugin does not
silently discard settings.

## security_advisories

Whether to consult the Arch Security Tracker. Defaults to `true`.

Set it to `false` on systems the tracker does not describe, for example a
distribution that backports fixes without closing the tracker's records (see
[troubleshooting](troubleshooting.md#advisories-that-look-ancient) for why
those records linger). With the feature off the backend makes no request to
security.archlinux.org and says so explicitly, rather than showing an empty
list that would read as a clean bill of health.

The setting fails open: a config that cannot be read or parsed leaves
advisories on, so a broken file cannot quietly suppress security data.
