# cockpit-pacman

[![AUR package](https://img.shields.io/aur/version/cockpit-pacman)](https://aur.archlinux.org/packages/cockpit-pacman)

A Cockpit plugin for Arch Linux package management using direct alpm.rs integration.

## Features

![View and search installed packages](docs/img/installed.png)
View and search installed packages, filter by install reason (explicit/dependency) and repository

![View package information](docs/img/details.png)
View package information

![Check for and apply system updates](docs/img/updates.png)
Check for and apply system updates

![Search for available packages in repos](docs/img/search.png)
Search for available packages in repos

## Prerequisites

- [Cockpit](https://cockpit-project.org/) must be installed and running:
  ```bash
  sudo pacman -S cockpit
  sudo systemctl enable --now cockpit.socket
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
