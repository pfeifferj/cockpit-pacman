# cockpit-pacman

[![AUR package](https://img.shields.io/aur/version/cockpit-pacman)](https://aur.archlinux.org/packages/cockpit-pacman)

A Cockpit plugin for Arch Linux package management using direct alpm.rs integration.

## Features

![Check for and apply system updates](docs/img/updates.png)
Check for updates with system overview, reboot notifications, and scheduled upgrades

![View and search installed packages](docs/img/installed.png)
Browse installed packages with filtering by install reason and repository

<details>
<summary>More screenshots</summary>

![Package details](docs/img/details.png)
View package details with dependencies, metadata, and downgrade options

![Dependency graph](docs/img/graph.png)
Visualize package dependency relationships

![Search packages](docs/img/search.png)
Search available packages across repositories with install status

![History](docs/img/history.png)
Browse package history grouped by upgrade runs

![Cache](docs/img/cache.png)
Manage package cache with configurable cleanup

![Keyring](docs/img/keyring.png)
View and manage pacman keyring

![Mirrors](docs/img/mirrors.png)
Test and configure pacman mirrors

</details>

## Prerequisites

[Cockpit](https://cockpit-project.org/) must be installed and running:
```bash
sudo pacman -S cockpit
sudo systemctl enable --now cockpit.socket
```

### Optional dependencies

The plugin is self-contained for most functionality. Cache cleanup requires `paccache` from `pacman-contrib`:

```bash
sudo pacman -S pacman-contrib
```

## Installation

### From AUR (recommended)

```bash
# Using an AUR helper (e.g., paru)
paru -S cockpit-pacman

# Or manually
git clone https://aur.archlinux.org/cockpit-pacman.git
cd cockpit-pacman
makepkg -si
```

### From source

Requires Rust toolchain and npm:
```bash
sudo pacman -S rust npm
```

#### Build

```bash
make build
```

#### Install

```bash
# System-wide
sudo make install

# Development (symlinks)
make devel-install
```

## Development

```bash
make devel-install
npm run watch
```

## License

GPL-3.0
