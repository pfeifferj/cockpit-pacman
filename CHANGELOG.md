# Changelog

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
