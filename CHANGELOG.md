# Changelog

## [0.3.8] - 2026-08-30

### Added
- Security advisories can be turned off with `security_advisories` in `/etc/cockpit-pacman/config.json`
- Advisories an update fixes are separated from ones with no fix available, so the count and the severity badge only reflect work you can actually do
- Advisory groups the tracker has not triaged are reported rather than dropped, so a group carrying a real fixed version is no longer withheld
- Scheduled runs record how long they took, why they were skipped, and whether they cleaned up after a run that was killed
- The schedule modal shows the calendar systemd is actually on beside the configured one
- A failed scheduled run is reported to the journal, so a run that dies before it can record anything still leaves a trace
- Warning before leaving the page during a running upgrade
- Warning when the open page is older than the backend it talks to, which happens when the plugin is upgraded under an open session
- Mirror backups show which were taken by hand
- Troubleshooting page in the documentation

### Changed
- Downgrades report progress and errors like every other package operation, and can be cancelled at a safe point
- An interactive upgrade refreshes the package databases first and refuses to continue if a repository fails, rather than applying a partial upgrade
- Most commands no longer ask for administrative access they do not use, so a session that has not escalated keeps the Updates and Repositories tabs
- The Updates tab no longer re-downloads the package databases on every visit, and reuses the security tracker feed for an hour instead of fetching it on every visit
- The orphan, cache and keyring tiles no longer wait for archlinux.org to answer before they settle
- Listing installed packages drops from about 334ms to 60ms, the service restart check from 818ms to 18ms, and cleaning the cache no longer opens every archive it is keeping
- An upgrade no longer floods the log viewer with alpm's own tracing, and the view stays responsive while one runs
- The dependency graph no longer relays out on every keystroke

### Fixed
- A cancelled or interrupted upgrade is no longer reported as a successful one
- Cancelling before anything was applied no longer warns that the system may be inconsistent
- Logging out, or Cockpit restarting its websocket, no longer interrupts a running upgrade
- Install, remove and orphan removal can be cancelled at a safe point
- Saving `pacman.conf` no longer reorders sections or moves comments away from the lines they describe
- A repository disabled and re-enabled in the UI keeps its servers instead of ending up with none
- A save that would leave pacman with no enabled repository or mirror is refused
- A restore no longer deletes older backups, and manual backups outrank automatic ones
- A stale database lock is no longer removed when the check could not see who held it, and clearing one leaves a notice on the page and a line in the journal
- The keyring view no longer offers to initialize a keyring it could not read
- The keyring permission warning expects pacman's default 755 instead of recommending 700, and a symlinked keyring directory no longer draws a warning
- A dismissed `.pacnew` no longer hides a later config file written to the same path
- Realtime kernels are identified correctly and count as needing a reboot
- The service restart check says when it could not see every process
- A malformed `config.json` no longer silently empties the ignored-package list, letting packages you excluded come back as pending updates
- The schedule modal and the ignored-package list load in a session that has not escalated, and a run history that cannot be read is no longer shown as an empty one
- Choosing a filter while a search is still in flight no longer has the older results overwrite the filtered ones
- The dependency graph holds to its node cap
- A streaming failure shows the backend's full error context instead of only its headline
- Applying a schedule no longer leaves the systemd timer and `config.json` disagreeing when part of the change fails
- A scheduled run that failed during the commit records what alpm said instead of blaming the timeout

## [0.3.7] - 2026-06-15

### Added
- Downgrade packages to any earlier version using the Arch Linux Archive
- `pacman.conf` backup history with restore and delete in the Repositories tab
- Pagination in the Updates and Mirrors lists
- Clicking the Security tile filters the updates list to security upgrades
- Notification when an upgrade leaves `.pacnew`/`.pacsave` config files that need merging
- After clearing a stale database lock, the interrupted sync, upgrade, or downgrade resumes automatically, including upgrades waiting on a confirmation
- Confirmation prompt before setting a repository SigLevel that disables signature verification
- Failed or deferred scheduled upgrades now surface in the Updates view and the Cockpit overview health card
- More tooltips and popovers explaining controls across the UI

### Changed
- Cache info, downgrade listing, and mirror testing are much faster on large package caches and when testing many mirrors
- Network failures are now detected and the affected views degrade gracefully instead of showing raw errors when offline
- The plugin page loads faster on first open

### Fixed
- Cancelling a sync or upgrade no longer risks interrupting a transaction mid-commit
- Cancelling a downgrade no longer risks leaving the pacman database locked
- An upgrade no longer hangs holding the package database lock if the Cockpit page stops reading its output
- Package details in the signoffs view now resolve against the package's own repository

## [0.3.6] - 2026-05-11

### Added
- Repositories tab for managing `pacman.conf` repositories (db8fdc6, 1972c3d)
- Services-restart alert in Updates view for stale systemd services after an upgrade (0237f04, 49e0c2c)
- Dismissable services-restart alert (47a5262)
- Dismissable system reboot alert (7286d2d)
- Ignore and unignore actions in the package details modal and row kebab (f0053fe, 8a8869e)
- Update status published to the Cockpit overview page health card (33e55fb)

### Changed
- Banners render above the card on every tab (8cdf0e4)
- Ignored packages can no longer be selected in the updates list (5f583f2)
- Mirrors view no longer renders repo-specific overrides (now managed in Repositories) (5d90c0c)
- Update-stats per package cached against pacman.log mtime to avoid rewalking the log on every package details open (65ffa9e)

### Fixed
- Repositories filter change silently dropping unsaved edits (0c75779)
- Modals closing on any click outside the dialog instead of only backdrop clicks (dfdaa63)
- Kernel preflight missing non-stock kernels that did not match by provides (cf90afa)
- News dismissals not persisting across reloads (f1ce9b0)
- Save Changes button misaligned with the Mirrors toolbar (bb1e53b)
- Ignored update rows briefly misrendering while ignore state loaded after the update list (f3a85c7)
- News summaries with multi-byte characters truncating mid-codepoint (23ed2e7)
- Backend panics on NTP backward time steps and mutex poisoning in the repo cache (4a4c0e9)

## [0.3.5] - 2026-04-12

### Added
- Reboot Now button and reboot-on-completion checkbox in post-upgrade flow (ea38b6c)
- Per-repository mirror servers shown inline with source pills (ada39fe)
- Auto-run mirror status fetch and latency tests on load (11947da)
- Mirrorlist refresh using the Arch mirror status API (c81f3fb)
- Mirrorlist backup history with restore and delete (8393c6e)
- Added/removed diff view when previewing mirrorlist changes (058d895)

### Changed
- Unified mirrors table combining global mirrorlist and repo overrides (ada39fe)
- All timestamps display as relative time with full timestamp on hover (3ef9fa4)

### Fixed
- Stale pacman database lock detection and recovery (2ce5fa8)
- IPv6 fallback for HTTP mirror requests (4525373)
- Double-click vs single-click distinction on dependency graph nodes (cae14fb)

## [0.3.4] - 2026-03-26

### Added
- Contextual popover explainers and clickable license links (afd4de7)
- Cache table grouped by package name with version pills (bae0156)
- ArchWeb package signoff support with sign and revoke actions (58ae312)
- Pagination in the signoffs table (bac7d05)
- Update frequency and packaging metadata in package details modal (e4b0e09)
- View history button in package details modal (aade846)
- Package install from the details modal (b89a33f)
- Arch Security Tracker integration with severity badges and vulnerable package count (cc30314)

### Fixed
- History search input losing focus during background refetch (bdebb0c)
- Manage buttons not visible in up-to-date view (6197cb2)

## [0.3.3] - 2026-03-15

### Added
- Package uninstall from the details modal with confirmation and progress feedback (0fcd6e4)
- Package name search and expand-all toggle in History view (66d12b0)
- Preflight warning when firmware packages are upgraded without a matching kernel upgrade (d9e49ec)

### Changed
- Updates view now syncs the package database on load instead of relying on stale state (fd9e47d)

## [0.3.2] - 2026-02-28

### Fixed
- Dependency graph max depth warning only shown when slider is at maximum (7330ecc)

## [0.3.1] - 2026-02-20

### Added
- Arch Linux news feed in the Updates tab (d509747)
- Network error detection with link to Arch Linux status page (1f46219)

### Fixed
- System hooks not running after upgrades due to alpm_utils overwriting hookdir (9f5de24)
- Alerts positioned outside card in up-to-date view (496cfbd)

## [0.3.0] - 2026-01-23

### Added
- Mirror management tab for viewing, testing, and saving mirrors (5825ee9)
- Dependency graph visualization in Installed Packages tab (b618384, 32f333d)
- Scheduled unattended upgrades via systemd timer (c1432fe)
- Reboot indicator after kernel or critical package updates (e35edff)
- History entries grouped by upgrade runs with accordion UI (fe3b998)
- Clickable rows for package details in more views (9f62de5)
- Auto-fetch mirror status on load when cache is empty (cd04ce5)

### Fixed
- Race conditions and memory leaks in frontend/backend (b27f260)
- Provides packages not resolved in dependency graph (8268af7)

## [0.2.0] - 2026-01-18

### Added
- Cache tab for viewing and cleaning package cache with configurable version retention (7dd68aa)
- History tab for browsing pacman.log with filtering by action type (7dd68aa)
- Package downgrade support from cached versions in package details (7dd68aa)
- Orphans tab for viewing and removing orphan packages (ad0eccd)
- Ignored packages feature to exclude packages from upgrades (f045b11, 0bf5ffc)
- Typeahead search when adding ignored packages with version preview (9e3bc1a)
- Timeout protection for long-running operations (26792fc)
- Graceful error recovery with reload option when errors occur (ea43efa, b9a7fdc)

### Changed
- Renamed "pinned" to "ignored" to match pacman terminology (0bf5ffc)
- Improved keyring view with support for all trust levels (0bf5ffc)
- Redesigned statistics display across all tabs (e72365e, 9692a22, feb17f0)
- Numbers now display with thousands separators (feb17f0)

### Fixed
- Package downgrade not finding cached versions (d8ebfb2)
- Operations could fail if a previous operation was cancelled (fb218c3)
- Cache cleanup now validates version count (max 100) (fb218c3)
- Improved error messages with better formatting (fb218c3)
- Negative file sizes no longer display incorrectly (b5471c8)
