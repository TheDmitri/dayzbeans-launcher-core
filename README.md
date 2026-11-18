# Day(Z) Beans Launcher — free DayZ launcher and server browser for Windows and Linux

[Day(Z) Beans Launcher](https://dayzbeanslauncher.com) is a complete, released and
actively maintained desktop launcher for DayZ. It browses servers, downloads and
syncs each server's Steam Workshop mods, and joins in one click. It runs natively
on **Windows 10/11** and on **Linux** (with Steam and Proton). It is **free for
players**, with no account to create.

This repository publishes the launcher's system-level source code: everything that
runs on your computer and can touch it. It ships with the tools to check that the
installer you downloaded was built from this code.

**Download:** [dayzbeanslauncher.com/download](https://dayzbeanslauncher.com/download)
or [GitHub Releases](https://github.com/TheDmitri/dayzbeans-launcher-core/releases).

---

## At a glance

| | |
| --- | --- |
| **What it is** | A full DayZ launcher: server browser, mod manager, one-click join |
| **Status** | Production. Released installers since 2025, with automatic updates |
| **Windows** | Windows 10 and 11: installer (`Setup.exe`) and portable `.exe`, Authenticode-signed |
| **Linux** | AppImage and `.deb`. DayZ runs through Steam with Proton, native or Flatpak Steam |
| **Price for players** | Free. No subscription, no premium tier, no account |
| **Languages** | 12 interface languages |
| **Game safety** | Starts DayZ through Steam. Never patches game files or BattlEye |
| **Verifiability** | Reproducible build of the system-level code, Sigstore attestation on every release |
| **License** | Source-available: read, compile, verify, publish findings. See [LICENSE](LICENSE) |

## Features

- **Server browser** with filters for map, mods, perspective (1PP/3PP), region,
  language and categories such as PvP, PvE and roleplay.
- **Queue and population info** before you join.
- **One-click join**: the launcher subscribes to the server's Steam Workshop mods,
  waits for the download, loads them in the right order and starts the game.
- **Mod manager**: disk usage, cleanup of unused mods, repair of broken downloads.
- **Impersonator protection**: fake servers that copy the name of a known server are
  detected and blacklisted on our side, before they reach your list.
- **Favourites, history and Steam friends** so you can find and join the servers
  your group plays on.
- **Community hub**: server events, articles and mod showcases.
- **Join links** (`dayzbeans://`) that server owners can put on their website or Discord.
- **Automatic updates**, signed and verified before they are installed.

## Why this repository exists

DayZ server owners asked how they could trust a launcher they cannot read. The
answer is to let them check it. Everything in the launcher that can touch your
machine is published here, and the release pipeline fails if the shipped installer
contains system-level code that is not in this repository.

**This is source-available, not open source.** You may read it, compile it, verify
it, and publish anything you find. You may not reuse it in other software. See
[LICENSE](LICENSE).

## Downloads

Every release is published here, under
[Releases](https://github.com/TheDmitri/dayzbeans-launcher-core/releases) — the
same signed files served from [dayzbeanslauncher.com](https://dayzbeanslauncher.com),
with `SHA256SUMS.txt`, the Sigstore bundles, `ELECTRON-HASHES.txt` and
`APP-ASAR-SHA256.txt` attached alongside them. Each release contains the Windows
installer, the Windows portable build, the Linux AppImage and the Linux `.deb`.

The point is that the binary, the source it was built from, and everything needed
to check one against the other all sit at the same URL, on infrastructure that
isn't ours.

## Why a signing warning appears

The installer is signed with an OV certificate. Windows SmartScreen shows
"unknown publisher" warnings for signed applications until they build download
reputation, which takes time and volume — it is not a statement that anything is
wrong with the file. The warning is why this repository exists: rather than ask
you to click through it on trust, we publish the code and a way to check it.

## What this repository contains

The launcher you install is the complete product. This repository contains the part
of it that runs with access to your system. The interface and the online services
stay proprietary.

| Published here | Proprietary |
| --- | --- |
| Everything that touches your machine | The Angular user interface |
| Filesystem and Windows registry access | Server discovery and ranking |
| Game process launch and arguments | The backend |
| Steam integration | |
| Mod download and management | |
| Auto-update | |
| The custom `dayzbeans://` URI handler | |
| The full IPC surface: handlers, preload bridge, and schemas | |

The unpublished code runs in a sandboxed renderer process. It cannot touch your
computer except by calling into the IPC surface published here — so reading
[`src/electron/`](src/electron/) tells you everything the launcher is able to do
to your machine.

Start with:

- [`src/electron/ipc-handlers.ts`](src/electron/ipc-handlers.ts) — every operation the UI can request
- [`src/electron/preload.ts`](src/electron/preload.ts) — the bridge between UI and system
- [`src/electron/platform-utils.ts`](src/electron/platform-utils.ts) — filesystem and registry
- [`src/electron/update-service.ts`](src/electron/update-service.ts) — how updates are fetched and applied
- [`src/environments/`](src/environments/) — every endpoint contacted

## Verifying that your installed launcher matches this code

The main process is compiled with plain `tsc` — no bundler, no minifier — and that
compilation is byte-for-byte reproducible. So the JavaScript inside an installed
launcher can be matched against this repository exactly.

`ELECTRON-HASHES.txt` in this repository is the SHA256 of every compiled
main-process file for the tagged release. Check your own installation against it:

**Windows (PowerShell), one command:**

```powershell
irm https://raw.githubusercontent.com/TheDmitri/dayzbeans-launcher-core/main/verify.ps1 | iex
```

**Or manually, on any platform:**

```bash
# 1. Extract the app archive from your installation
#    Windows default: %LOCALAPPDATA%\Programs\dayz-bean-launcher\resources\app.asar
npx @electron/asar extract app.asar extracted/

# 2. Hash the compiled main process and compare
git clone https://github.com/TheDmitri/dayzbeans-launcher-core
cd dayzbeans-launcher-core
node scripts/electron-hashes.js --dir ../extracted/dist-electron --check ELECTRON-HASHES.txt
```

A match means the code running on your machine is the code in this repository.

**Rebuild it yourself** rather than trusting our manifest:

```bash
npm ci
npx tsc -p tsconfig.electron.json
node scripts/electron-hashes.js --dir dist-electron --check ELECTRON-HASHES.txt
```

This is also run publicly on every push — see the `verify` workflow. If the
published source ever stopped matching the published hashes, that badge goes red
where everyone can see it.

## Verifying the installer itself

Separate from the source: every release artifact is Authenticode-signed, hashed in
`SHA256SUMS.txt`, scanned by VirusTotal, and carries a Sigstore bundle proving it
was produced by our release workflow at a specific commit.

```bash
cosign verify-blob <file> --bundle <file>.sigstore.json \
  --certificate-identity-regexp 'github.com/TheDmitri/dayz-launch' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Full instructions: [docs/security/verify-download.md](docs/security/verify-download.md).

## "Can I build it from source?"

To use the launcher, download the installer: it is the complete, signed application.
This repository lets you rebuild and check the system-level code, not produce your
own copy of the whole application. "Build from source" usually stands in for two
different questions, so here is the answer to each.

**If the question is "is this binary malicious?"** — building is a means, not the
goal, and a weak one. Most open-source projects can be built from source and still
can't prove the shipped binary matches, because the build isn't reproducible. This
one can:

```bash
npm ci
npx tsc -p tsconfig.electron.json
node scripts/electron-hashes.js --dir dist-electron --check ELECTRON-HASHES.txt
```

Three commands, no trust required. The result is byte-identical to the code inside
the installer you downloaded, and our release pipeline fails outright if it ever
isn't. The interface runs sandboxed and can only reach your system through the IPC
surface in this repository, so reading `src/electron/` tells you the complete set
of things the launcher is able to do to your computer.

**If the question is "can I fork it and stop depending on you?"** — no, and that's
a licensing decision rather than a security one. The interface is proprietary and
is not in this repository, so a local build of this code alone has no interface to
show. Wanting that right
is fair; we'd rather say plainly that it isn't on offer than let the verification
story above blur into an answer it doesn't give.

What you can still confirm without any of the unpublished code:

| Question | Answered by |
| --- | --- |
| Is my install the genuine release, unmodified? | `APP-ASAR-SHA256.txt` — covers the **whole** package, interface included |
| Does the code that touches my machine match this source? | `ELECTRON-HASHES.txt` and the commands above |
| Did this binary come out of their pipeline at a specific commit? | the Sigstore attestation on every release |
| What is the launcher *able* to do to my system? | `src/electron/` — all of it |

## Reporting something

Security issues: see [SECURITY.md](SECURITY.md). You do not need our permission to
publish a finding — the license says so explicitly.

Pull requests are disabled; this repository is a published snapshot of a private
codebase, not a development repository. Issues are open and read.

## Snapshot

Each commit here is one released launcher version, pushed automatically by the
release workflow. `SNAPSHOT.txt` names the version and the source commit, which is
the same commit named in the release's Sigstore attestation.
