# What Day(Z) Beans Launcher Does On Your Machine

This document states exactly what the application is *able* to do on your computer,
rather than asking you to take a general assurance on faith.

Everything below is derived directly from the Electron main process — the only
part of the launcher that can touch your computer at all. The user interface runs
in a sandboxed renderer with no direct filesystem, process, or network privileges;
it can only ask the main process to do the specific things listed in
[the capability inventory](#capability-inventory). There is no other route.

That main process is published in full at
[dayzbeans-launcher-core](https://github.com/TheDmitri/dayzbeans-launcher-core), so
this document is a summary of code you can read rather than a description you have
to trust. The user interface and the server data behind it remain private; neither
can reach your machine except through the published surface.

If you want to verify that the copy you downloaded is the copy this document
describes — and that it was built from that published source — see
[verify-download.md](verify-download.md).

---

## The short version

- **Reads and writes** your DayZ installation folder, your Steam Workshop content
  folder, and its own settings folder. Nothing else.
- **Starts** `DayZ_x64.exe` (or `steam`), and Steam itself. It can stop DayZ
  processes when you ask it to.
- **Contacts** six hosts, listed below. No advertising, analytics, or fingerprinting
  networks.
- **Does not** read documents, browser data, credentials, Discord tokens, game
  files outside DayZ, or anything belonging to other applications.
- **Does not** require administrator rights. The installer is per-user
  (`perMachine: false`) and installs no service and no driver.
- **Never asks for your Steam password.** All Steam interaction goes through the
  Steamworks API against the Steam client already running on your machine.

---

## Network destinations

Every host the launcher contacts, and why. You can verify this list with a firewall
log or Wireshark — that is the point of publishing it.

| Host | Purpose |
|------|---------|
| `api.dayzbeanslauncher.com` | Server list, server details, launcher version check; the referral contest page (see below) |
| `download.dayzbeanslauncher.com` | Downloading launcher updates |
| `glitchtip.dayzbeanslauncher.com` | Crash reports (opt-out, see below) |
| `steamcommunity.com` | Steam Workshop mod metadata |
| `discord.com` | Discord Rich Presence ("Playing on …") |
| Game servers you interact with | Direct A2S/query packets to fetch live player counts and ping |
| Your local network (Direct Connect, opt-in) | A2S query broadcast on the DayZ query ports, only while **Scan local network** is on |

Local-only IPC (never leaves your machine): the Steam client, and the Discord
desktop client for Rich Presence.

**Referral contests.** Only when you open a contest page (Halloween 2026: 5 October to
7 November), the launcher sends the backend your launcher's random install id and the
SteamID64 of the Steam account signed in on this computer, in the body of an HTTPS request
(never in a URL). The backend does not store the SteamID64: it keeps a keyed hash of it
(HMAC-SHA256 with a server-side secret), used only to make sure one Steam account counts
once, and deletes contest data three months after the prizes are handed out. Not opening
the contest page means none of this is sent.

**There is no telemetry endpoint beyond GlitchTip**, and GlitchTip receives crash
reports only — stack traces, launcher version, OS version. Not behaviour, not
server visits, not which servers you play on. Screenshot capture is explicitly
disabled (`attachScreenshot: false`) because a frame could contain your username or
a server IP.

You can turn crash reporting off entirely in **Settings → Privacy → Send crash
reports**. When it is off, the reporting SDK is never initialised, so nothing is
sent and no connection to GlitchTip is opened.

---

## Filesystem access

| Location | Access | Why |
|----------|--------|-----|
| DayZ installation folder | read, write | Locate `DayZ_x64.exe`; create the `!dzbl` folder of mod junctions (Windows) or `@workshopId` symlinks (Linux) that DayZ requires to load mods |
| Steam `steamapps` / Workshop content folder | read | Detect which mods you already have and how large they are |
| `%APPDATA%/Day(Z) Beans Launcher` (or the platform equivalent, `app.getPath('userData')`) | read, write | Settings, cache, and `app-debug.log` / `protocol-debug.log` |
| A folder you pick yourself via the file dialog | read | Only when you use "Browse" to point the launcher at your DayZ install |
| A DayZ server running on this PC (Direct Connect) | read | Its `serverDZ.cfg` and the `meta.cpp` / `mod.cpp` of the mod folders on its command line, to show the server's name and required mods. A mod that is not on the Workshop is linked into the `!dzbl` folder only when you choose **Load local mods** |

The mod junctions and symlinks the launcher creates are the standard mechanism
DayZ uses to load Workshop mods. They point into your existing Steam Workshop
folder; no mod content is copied or modified.

Nothing outside these paths is opened. The launcher has no code that enumerates
your user profile, browser storage, or other games.

---

## Processes it starts

| Process | When |
|---------|------|
| `DayZ_x64.exe` (or `steam -applaunch`) | You click Join or Play |
| Steam client (`steam.exe`, `flatpak run com.valvesoftware.Steam`, `open -a Steam`) | Steam is required and not running |
| `ping` | Measuring latency to a game server |
| `tasklist`, and PowerShell `Get-CimInstance Win32_Process` filtered to `DayZServer*` (Windows; Linux reads `/proc`) | Direct Connect looking for DayZ servers on this PC. Only processes named `DayZServer…` are read, for their command line |
| The launcher's own downloaded installer (`/S`) | You accept an update |

`kill-dayz-processes` terminates DayZ, and only DayZ. It exists because DayZ
regularly hangs on exit and blocks the next launch; it is invoked when you cancel a
join or when a stale instance blocks a new one. It matches DayZ process names only.

The launcher registers the `dayz://` URL scheme so a "Join via website" link can
open it. Incoming URLs are parsed for a server id and nothing else.

---

## Capability inventory

This is the complete set of operations the sandboxed user interface can ask the
privileged main process to perform. It is the launcher's entire attack surface
against your machine. If an operation is not on this list, the application cannot
do it, regardless of what the interface displays.

A CI check (`scripts/check-ipc-doc-drift.sh`) fails the build if this list ever
drifts from the code, so it cannot quietly fall out of date.

<!-- IPC_CHANNELS_START -->
### Launching and playing

- `join-server` — download/verify required mods, create mod links, launch DayZ against a server
- `cancel-join-process` — abort an in-progress join (does not unsubscribe your mods)
- `is-dayz-running` — check whether DayZ is currently running
- `kill-dayz-processes` — terminate hung DayZ processes
- `verify-dayz-installation` — locate `DayZ_x64.exe`
- `verify-dayz-path` — check that a folder you selected really is a DayZ install
- `find-dayz-edition` — locate the install of one DayZ edition (stable or Experimental), so an Experimental server is only joined with the Experimental client
- `get-spotlight-server-id` — read and clear a pending `dayz://` join request

### Servers and pings

- `ping-server` — ICMP latency to one server
- `ping-server-gamedig` — game-protocol query of one server
- `ping-servers-gamedig` — game-protocol query of many servers
- `get-server-info-gamedig` — live details for one server
- `clear-ping-cache` — drop cached latency results

Direct Connect, for servers the public list does not show:

- `discover-local-servers` — find DayZ servers running on this PC (see *Processes it
  starts* and *Filesystem access* below) by querying the DayZ ports on `127.0.0.1`, and,
  only when you turn on **Scan local network**, by a query broadcast to your local
  network. Takes no address from the interface.
- `query-dayz-server` — query the one address you typed, on at most six ports

### Mods (Steam Workshop)

- `get-installed-mods-from-disk` — list mods present in the Workshop folder
- `is-mod-installed` — check one mod via Steam
- `is-mod-installed-on-disk` — check one mod on the filesystem
- `open-mod-folder` — open the Workshop folder in your file manager
- `steam-detect-installation` — locate the Steam installation
- `steam-ensure-initialized` — start the Steamworks API session
- `steam-is-initialized` — report Steamworks API state
- `steam-is-running` — check whether the Steam client is running
- `steam-get-user-info` — your Steam display name and id, from the local client
- `steam-get-subscribed-items` — your Workshop subscriptions
- `steam-get-subscribed-items-fast` — cached form of the above
- `steam-subscribe-item` — subscribe to a mod a server requires
- `steam-unsubscribe-item` — unsubscribe from a mod
- `steam-force-download` — ask Steam to re-download a mod that is missing or corrupt
- `steam-get-item-download-info` — download progress for a mod
- `steam-get-item-install-info` — install path and size for a mod
- `steam-get-mod-sizes` — sizes for a set of mods
- `steam-get-workshop-item-details` — Workshop metadata for a mod
- `steam-get-workshop-items-batch` — Workshop metadata for many mods
- `steam-get-mod-update-status` / `steam-get-mod-update-statuses` — whether installed mods are behind their Workshop version
- `mods-sweep-updates` — check every subscribed mod and ask Steam to update the outdated ones (also runs at startup)

### Settings and storage

- `getStoreData` — read one key from launcher settings
- `setStoreData` — write one key to launcher settings
- `deleteStoreData` — delete one key from launcher settings
- `save-settings` — persist the settings screen
- `get-api-urls` — report which backend URLs this build uses
- `get-anonymous-id` — read (or create once) the launcher's random install id, a UUID
  tied to nothing about you. It goes with server-list and update requests so the backend
  can count active launchers.
- `showOpenDialog` — open the OS folder picker so you can choose your DayZ folder
- `get-auto-start` / `set-auto-start` — launch on login
- `set-close-to-tray` / `set-minimize-to-tray` — window behaviour
- `start-minimized` — start hidden in the tray
- `set-auto-download` / `set-auto-install` — update behaviour

### Window and application

- `window-minimize`, `window-maximize`, `window-close` — title bar buttons
- `window-is-maximized`, `window-is-fullscreen`, `window-toggle-fullscreen` — window state
- `restart-app` — restart the launcher
- `force-quit` — exit, bypassing close-to-tray
- `get-suspension-state` — report whether background polling is suspended
- `show-notification` — show a desktop notification
- `open-external` — open a link in your default browser (validated scheme)

### Updates

- `get-app-version` — the running version
- `check-for-updates` — ask the backend for a newer version
- `download-and-install-update` — download and run the signed installer
- `get-download-status` — update download progress
- `show-update-dialog` — display the update prompt

### Discord Rich Presence

- `discord-update-presence` — set presence
- `discord-clear-presence` — clear presence
- `discord-is-connected` — report Discord connection state
- `discord-set-playing` — "Playing on <server>"
- `discord-set-browsing` — "Browsing servers"
- `discord-set-connecting` — "Connecting"
- `discord-set-downloading` — "Downloading mods"
- `discord-set-managing-mods` — "Managing mods"
- `discord-set-viewing-server` — "Viewing <server>"

### Steam status

- `get-steam-status` — combined Steam running/initialised state for the header

### DayZ profiles

DayZ keeps your keybinds, video settings and gamma in a profile folder outside the
game install. These channels read that folder and can copy a profile within it;
nothing here writes to a profile you already use.

- `list-dayz-profiles` — list the profiles found in your DayZ profiles folder
- `resolve-profiles-folder` — report where that folder is and whether it exists
- `open-profiles-folder` — open it in your file manager
- `clone-dayz-profile` — copy an existing profile to a new name
- `check-dayz-profile-drift` — notice that the profile DayZ is using has changed

### Offline server list

The server list is saved to a single file in the launcher's own data folder so the
list still opens when our servers cannot be reached. It holds public server
information only — the same list anyone sees before signing in.

- `snapshot-write` — save the current server list (size-capped)
- `snapshot-read` — load the saved list
- `snapshot-stat` — report its size and age
- `snapshot-clear` — delete it, also exposed as **Settings → Cache → Offline server list**

### Diagnostics and support

- `open-log-folder` — show the launcher's log file in your file manager
- `steam-get-diagnostics` — collect Steam detection details for a support report. The
  report is redacted before it reaches the interface: your home directory and
  username are stripped, because it is written to be pasted in public.
<!-- IPC_CHANNELS_END -->

---

## Security properties worth naming

- The renderer runs with `sandbox: true` and `contextIsolation`. It cannot call
  Node.js APIs; it can only send the messages listed above through a preload script
  with a fixed, enumerated surface.
- `open-external` validates the URL scheme before handing it to the OS, so a
  malicious server name cannot turn a link into a local file or command execution.
- The update flow only accepts download URLs from the launcher's own manifest, and
  the installer it runs is Authenticode-signed and checksummed.
- The installer is per-user and requires no elevation.

---

## Still not satisfied?

That is reasonable — none of this is a substitute for reading the code. If you run
a large community and need more than a published description, contact us (see
[SECURITY.md](../../SECURITY.md)) and we will arrange a read-only walkthrough of
the main-process source with you directly.
