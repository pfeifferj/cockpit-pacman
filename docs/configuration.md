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
- `schedule.enabled`: whether scheduled upgrades are requested. The UI shows the
  actual timer status separately.
- `schedule.mode`: `check` (report available updates only) or `upgrade` (apply them).
- `schedule.schedule`: a systemd `OnCalendar` spec, or one of the presets
  `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `quarterly`.
- `schedule.max_packages`: skip the entire upgrade when the number of eligible
  updates exceeds this limit; `0` means unlimited.

Enabling a schedule writes a systemd timer drop-in at
`/etc/systemd/system/cockpit-pacman-scheduled.timer.d/schedule.conf`.

Editing `config.json` does not apply changes to systemd. Save the schedule in the
plugin to update the timer. Unknown timer status and differences between saved
settings and actual activity are shown separately.

A lock held by another process, a required manual intervention, or an exceeded
package limit records a skipped run, writes a warning to the journal, and exits
unsuccessfully so the unit's `OnFailure` handler runs. The next timer occurrence
tries again; the backend does not retry a blocked upgrade in the background.

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

## Pending configuration files

When Updates reports pending configuration files, choose **Review configuration
files**. With administrative access, compare a `.pacnew` or `.pacsave` file
(including older `.pacsave.1`, `.pacsave.2` and so on) under `/etc` with the
current file, then keep the current version, use the new version, restore a
saved version, or edit and save a merge. If the current file is missing,
**Keep current** leaves it missing.

Using the new or saved version also takes that file's owner, mode, modification
time and extended attributes, as `pacdiff` does. A saved merge keeps your local
file's owner, mode and attributes: the current file for a `.pacnew` (the new
file if there is none) and the saved file for a `.pacsave`. Replaced and removed
files are copied to `/etc/.cockpit-pacman-backups`, which mirrors the layout of
`/etc`, and stay there until you remove them. The result lists their paths.

Linked files, binary or non-UTF-8 files, files larger than 1 MiB, and merges of
files that mix CRLF and LF line endings need manual review, for example with
`pacdiff`. So do files that are not owned by root or are writable by group or
others, files in such directories, and pending files outside `/etc`. The review
lists those that belong to installed packages but does not open them. Package
operations must finish and `pacman.conf` must be valid before a choice is
applied.

## Proxies

Create `/etc/cockpit-pacman/proxy.json` to route Arch service requests, mirror
probes, package/database downloads and scheduled runs. Changes apply to the
next request or scheduled run.

```json
{
  "mode": "proxy",
  "all_proxy": "http://proxy.example.org:3128",
  "no_proxy": "localhost,127.0.0.0/8,.example.internal"
}
```

`all_proxy` is required. Optional `http_proxy` and `https_proxy` override it;
`no_proxy` lists hosts, domains or CIDRs to bypass (`*` bypasses everything).
Proxy mode replaces inherited proxy settings, including the bypass list.

Without the file, or with `{"mode":"inherit"}`, libcurl uses the process's
proxy environment. `HTTP_PROXY` is ignored; use lowercase `http_proxy`.
Cockpit and systemd may not inherit your shell's environment.
`{"mode":"direct"}` disables proxies. Inherit/direct modes reject endpoint
and bypass fields.

Endpoints support `http://`, `https://`, `socks5://` and `socks5h://`.
SOCKS5 resolves destination names locally; SOCKS5h resolves them at the proxy.
For authentication, use `http://user:password@host:port` with percent-encoded
credentials. HTTPS uses the system CA store.

The file and its directory must be root-owned, not symlinks, and not writable
by other users. Cockpit users need directory access and permission to read the
file: use `0644` without credentials, or `0640` with a suitable group or ACL
when credentials are present. World-readable credentials are rejected.

Invalid or unreadable settings block network operations. Failed proxy
connections never fall back to direct access. Local operations remain available.

Key retrieval and refresh use dirmngr, which needs separate configuration. Both are
blocked in `proxy`/`direct` modes and in `inherit` mode with an active proxy.
After configuring dirmngr, allow refresh with `"keyring": "external"`;
`"keyring": "deny"` always blocks it. Package hooks also control their own
networking.
