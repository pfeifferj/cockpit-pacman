# Read measurements

Measured on 2026-10-11 in the Arch/Cockpit VM with four virtual CPUs, 4 GB RAM,
libalpm 16.0.1 and release builds. The comparison used identical sync databases
(299 core packages and 15,041 extra packages), 218 local database entries and
the same repository-map cache. The baseline was commit `03ab638`.

Each command ran once, then seven more times in fresh processes. The table
reports the median of those seven runs. Kernel page caches were left warm.
The cache fixture contained 11,195 sparse files: 2,239 package names with five
versions each. Cache reads use filenames and metadata, so archive contents
were unnecessary for these measurements.

| Command | Before | After | Response before | Response after |
| --- | ---: | ---: | ---: | ---: |
| `cache-info` | 32.1 ms | 23.7 ms | 1,231,556 B | 4,470 B |
| `list-installed 0 50` | 29.0 ms | 22.5 ms | 9,578 B | 9,578 B |
| `search linux 0 50` | 195.1 ms | 173.5 ms | 9,218 B | 9,218 B |
| `dependency-tree bash 3 forward 0` | 26.4 ms | 21.7 ms | 2,314 B | 2,314 B |

The default cache response contains 50 package groups instead of every file.
This reduces its payload by 99.6%. Opening a group's file list fetches a
separate page with complete filenames, including architecture and compression.
The backend still scans and groups the whole directory to calculate totals.

Unchanged commands also ran faster in the second batch, so the timing
difference cannot be attributed entirely to the cache changes. The payload
reduction is independent of that variation.

A direct libalpm probe used seven fresh handles in separate processes.
The first package-cache lookup across both sync databases took a median
166.9 ms in the first batch and 139.4 ms in the second. A second lookup on
the same handle took about 0.002 ms. Search pays that parsing cost; the
installed-package `bash` dependency query above is a different workload.
The backend retains its existing process lifetime.
