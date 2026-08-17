# Verifying Your Download

Five independent checks. None of them require trusting us. The first four work on
the downloaded file alone; the fifth goes further and matches the launcher
installed on your machine against its published source, line for line.

Replace `<VERSION>` with the version you downloaded (for example `1.4.2`).

---

## 1. Checksum — is this the file we published?

Every release ships `SHA256SUMS.txt` next to the binaries, and the same hashes
appear in
[`latest.json`](https://download.dayzbeanslauncher.com/launcher-releases/latest/latest.json).

**Windows (PowerShell):**

```powershell
Get-FileHash .\DayZ-Beans-Launcher-<VERSION>-Setup.exe -Algorithm SHA256
```

**Linux / macOS:**

```bash
sha256sum DayZ-Beans-Launcher-<VERSION>.AppImage
```

Compare against:

```
https://download.dayzbeanslauncher.com/launcher-releases/<VERSION>/SHA256SUMS.txt
```

A mismatch means the file was altered after we built it. Do not run it.

---

## 2. Code signature — who signed this binary?

Every Windows binary in a release is Authenticode-signed, including the executables
the installer writes to disk — not just the installer.

**The download:**

```powershell
Get-AuthenticodeSignature .\DayZ-Beans-Launcher-<VERSION>-Setup.exe |
  Format-List Status, SignerCertificate
```

**And, after installing, the application itself:**

```powershell
# Finds the installed launcher wherever you chose to put it, and checks every
# executable it shipped.
Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter '*Beans Launcher*.exe' |
  ForEach-Object { Get-AuthenticodeSignature $_.FullName } |
  Format-Table Status, Path
```

Both must report `Status: Valid`. Checking the installed executable matters: an
installer that is signed but drops unsigned binaries is a real and common pattern,
and it is the specific gap this project closed.

---

## 3. Build provenance — where did this binary come from?

This is the strongest check available for a closed-source application. Each artifact
ships a [Sigstore](https://www.sigstore.dev/) bundle (`<filename>.sigstore.json`)
created by our CI using a short-lived certificate issued to the GitHub Actions
workflow that built it. It cryptographically binds the file to a repository, a
workflow, and a commit — proving no human hand touched the binary between the build
and the download.

Install [cosign](https://github.com/sigstore/cosign), then:

```bash
cosign verify-blob DayZ-Beans-Launcher-<VERSION>-Setup.exe \
  --bundle DayZ-Beans-Launcher-<VERSION>-Setup.exe.sigstore.json \
  --certificate-identity-regexp 'github.com/TheDmitri/dayz-launch' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Expected output: `Verified OK`.

This verification is entirely offline against the bundle and the public Sigstore
trust root. It works even though the repository is private — you do not need, and
will not be asked for, any access to it.

The bundles are attached to every
[GitHub Release](https://github.com/TheDmitri/dayz-launch/releases) and stored
alongside the binaries on the CDN.

---

## 4. Malware scan — what do third parties say?

Every release is uploaded to VirusTotal by CI and the permalink is published in the
GitHub release notes, whatever the result.

You can also check any file yourself without uploading it, using the hash from
step 1:

```
https://www.virustotal.com/gui/file/<sha256>
```

**A note on results.** Newly published Electron applications routinely collect one
or two generic heuristic detections (names like `Trojan.Generic`,
`Unsafe.AI_Score`) from engines that treat "large, recently seen, self-updating
installer" as suspicious in itself. These are not findings about our code. Judge a
scan on named, reproducible detections from major engines, and compare against the
same file's history over time.

---

## 5. Source — is the installed launcher built from the published code?

The first four checks prove the file is the one we published. This one proves what
that file *is*.

Everything in the launcher that touches your machine — filesystem and registry
access, game launch, Steam, mods, auto-update, and the whole IPC surface — is
published at
[dayzbeans-launcher-core](https://github.com/TheDmitri/dayzbeans-launcher-core).

That source is compiled with a plain `tsc`: no bundler, no minifier, and the output
is byte-for-byte reproducible. So the JavaScript inside an installed launcher can be
matched against the repository exactly, rather than merely resembling it.

**Windows, one command:**

```powershell
irm https://raw.githubusercontent.com/TheDmitri/dayzbeans-launcher-core/main/verify.ps1 | iex
```

It runs two checks: that your installed `app.asar` is byte-identical to the released
one (no dependencies), and that every compiled main-process file inside it matches
`ELECTRON-HASHES.txt` from the public repository (needs Node.js).

**Any platform, manually:**

```bash
# Extract the app archive from your installation. On Windows the default path is
# %LOCALAPPDATA%\Programs\dayz-bean-launcher\resources\app.asar
npx @electron/asar extract app.asar extracted/

git clone https://github.com/TheDmitri/dayzbeans-launcher-core
cd dayzbeans-launcher-core
git checkout v<VERSION>
node scripts/electron-hashes.js --dir ../extracted/dist-electron --check ELECTRON-HASHES.txt
```

**Or rebuild it yourself**, trusting our manifest for nothing:

```bash
npm ci
npx tsc -p tsconfig.electron.json
node scripts/electron-hashes.js --dir dist-electron --check ELECTRON-HASHES.txt
```

The public repository runs that same rebuild on every push, on Windows, Linux and
macOS. If published source ever stopped reproducing published hashes, its CI badge
goes red without anyone having to notice by hand.

The code is source-available, not open source: read it, compile it, verify it, and
publish anything you find — see its LICENSE for what is not permitted.

---

## Installing from winget instead

If you would rather not evaluate any of the above, install through Microsoft's
package repository. The manifest is human-reviewed and pins the installer's SHA256,
so Microsoft's own review sits between you and the binary:

```powershell
winget install DayZBeansLauncher.DayZBeansLauncher
```

---

## Linux: "unknown package" / "apps from unknown sources"

On Zorin, Ubuntu and other desktops with an app-safety gatekeeper, launching the
AppImage raises a warning that it comes from an unknown source.

This is not a signature problem and no signature can fix it. The gatekeeper is
looking for *package identity* — a maintainer, an origin, a version known to the
package system. An AppImage is a single self-contained file and carries none of
that by design, so it is flagged on principle, exactly as every other AppImage is.

On Debian-based systems (Ubuntu, Zorin, Mint, Pop!\_OS), install the `.deb`
instead:

```bash
sudo apt install ./DayZ-Beans-Launcher-<VERSION>.deb
```

The launcher is then a known installed package, the warning does not appear, and
you get a proper menu entry and working `dayz://` join links. Verify it first with
the checksum and cosign steps above — both cover the `.deb` as well.

The AppImage remains the right choice on distributions without `.deb` support. The
warning there is inherent to the format.

## SmartScreen warnings

You may still see a Windows SmartScreen prompt on a new release. SmartScreen builds
reputation per signing certificate, accumulated through download volume, and a fresh
release of a small application has not accumulated much. The publisher name shown in
the prompt should read as our certificate subject rather than "Unknown Publisher" —
that distinction is the meaningful one.

If it says **Unknown Publisher**, something is wrong. Do not run it, and please
[report it](../../SECURITY.md).

---

## What this does not prove

Honest limits. Checks 1–4 prove the file is authentic, unmodified, built by our
pipeline from a specific commit, and not flagged by mainstream scanners. Check 5
proves the main process is compiled from the published source.

What none of them prove: the Angular user interface is not published, so you cannot
read it. It runs in a sandboxed renderer and can reach your machine only by calling
into the IPC surface that *is* published — so check 5 bounds what the unpublished
half is able to do, without showing you what it looks like.

For the full inventory of what the application is capable of doing on your machine,
see [transparency.md](transparency.md).
