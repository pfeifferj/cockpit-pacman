# ArchWeb Signoffs

cockpit-pacman can display and manage [ArchWeb package signoffs](https://archlinux.org/packages/signoffs/) directly from the Cockpit UI. The Signoffs tab appears when credentials are stored in the system keyring via the [Secret Service D-Bus API](https://specifications.freedesktop.org/secret-service/latest/) (GNOME Keyring, KeePassXC, etc.).

## Setup

### 1. Install libsecret

`secret-tool` (part of `libsecret`) is used to store credentials:

```bash
sudo pacman -S libsecret
```

A Secret Service provider must be running. GNOME Keyring is the most common:

```bash
sudo pacman -S gnome-keyring
```

KeePassXC also implements the Secret Service API and works as an alternative.

### 2. Store ArchWeb credentials

```bash
secret-tool store --label="ArchWeb (cockpit-pacman)" service cockpit-pacman type archweb username YOUR_ARCHWEB_USERNAME
```

Enter your ArchWeb password when prompted. The attributes `service`, `type`, and `username` must be set exactly as shown.

### 3. Verify

```bash
secret-tool lookup service cockpit-pacman type archweb
```

Should print your ArchWeb password. Once configured, reload cockpit-pacman and the Signoffs tab will appear.

## How it works

On page load, the cockpit-pacman frontend queries the Secret Service via D-Bus for an item matching `{service: "cockpit-pacman", type: "archweb"}`. If found, credentials are read from the keyring and passed to the backend as a base64-encoded argument on each signoff operation. The backend never stores or caches credentials.
