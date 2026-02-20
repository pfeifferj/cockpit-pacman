# Changelog

## [0.3.1] - 2026-02-20

### Added
- Arch Linux news feed in the Updates tab
- Network error detection with link to Arch Linux status page

### Fixed
- System hooks not running after upgrades due to alpm_utils overwriting hookdir
- Alerts positioned outside card in up-to-date view

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
