Source: pacman-key 0.4.0 from crates.io, upstream commit
`76c203dfd0288e34040134f6c012ac2f7109353c` in
https://github.com/pfeifferj/pacman-key-rs.

Published archive SHA-256:
`d09933bb0be010740b7a257b203220eb39e289572863e166711dc163b5202a87`.

The source, tests, and GPL license are retained here. The Cargo manifest adds
`libc` and the `tempfile` dev-dependency and is marked `publish = false`.
Local changes manage subprocess groups and apply cancellation/deadlines through
output collection and the full refresh operation. This copy avoids depending on
an unpublished upstream fix.
