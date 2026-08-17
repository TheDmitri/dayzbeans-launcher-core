# For Server Owners: "Is Day(Z) Beans Launcher Safe?"

A one-page answer you can forward to your staff or post in your Discord.

---

## The concern is fair

Recommending an executable to your players puts your community's reputation on the
line, not ours. So instead of asking you to trust a claim, here is what you can
check yourself.

The part of the launcher that touches a player's machine — filesystem, registry,
game launch, Steam, mods, auto-update — is published in full at
[dayzbeans-launcher-core](https://github.com/TheDmitri/dayzbeans-launcher-core).
You can read it, and you can confirm the installed launcher was built from it. The
user interface and our server data stay private, and cannot reach a machine except
through that published surface.

## What you can verify in five minutes

**1. It is signed, all the way down.** Every Windows binary in a release is
Authenticode-signed — including `Day(Z) Beans Launcher.exe` after installation,
not just the installer. Right-click → Properties → Digital Signatures, or:

```powershell
Get-AuthenticodeSignature .\DayZ-Beans-Launcher-<VERSION>-Setup.exe
```

Our release pipeline refuses to publish a build that fails this check, so an
unsigned file claiming to be ours did not come from us.

**2. It matches a published checksum.** `SHA256SUMS.txt` ships with every release
and the same hashes appear in `latest.json`.

**3. It provably came out of our CI, untouched by human hands.** Each artifact
carries a [Sigstore](https://www.sigstore.dev/) bundle that cryptographically binds
it to a specific repository, workflow run, and commit. Verify offline — no access
to our (private) repository needed:

```bash
cosign verify-blob DayZ-Beans-Launcher-<VERSION>-Setup.exe \
  --bundle DayZ-Beans-Launcher-<VERSION>-Setup.exe.sigstore.json \
  --certificate-identity-regexp 'github.com/TheDmitri/dayz-launch' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

This is the check that answers "could a developer have slipped something into the
build?" — no, because the binary is tied to the exact commit that produced it.

**4. Independent scans.** Every release is uploaded to VirusTotal and the permalink
is published in the release notes, whatever the verdict.

**5. Microsoft's own package repository.** `winget install
DayZBeansLauncher.DayZBeansLauncher` — the manifest is human-reviewed by Microsoft
and pins the installer's SHA256.

**6. The installed launcher matches published source.** The main process compiles
reproducibly, so this is an exact match rather than a resemblance. On Windows:

```powershell
irm https://raw.githubusercontent.com/TheDmitri/dayzbeans-launcher-core/main/verify.ps1 | iex
```

Full instructions: **[verify-download.md](verify-download.md)**

**Linux players:** point them at the `.deb` on Debian-based systems (Ubuntu, Zorin,
Mint, Pop!\_OS). The AppImage triggers an "apps from unknown sources" warning on
desktops with an app-safety gatekeeper — that is inherent to the AppImage format,
which carries no package identity, and no signature can suppress it. Installed from
the `.deb` the launcher is a known package and the warning does not appear.

## What it actually does on a player's machine

We publish the complete inventory: every privileged operation the interface can
request, every filesystem path touched, every process started, every host
contacted — **[transparency.md](transparency.md)**. A CI check fails our build if
that document ever stops matching the code, so it cannot quietly go stale.

Short version:

- Touches your DayZ folder, your Steam Workshop folder, and its own settings
  folder. Nothing else.
- Starts DayZ and Steam. Can stop hung DayZ processes when asked.
- Contacts six hosts, all listed. No ad or analytics networks.
- Never asks for a Steam password; all Steam work goes through the Steam client
  already running on the machine.
- Installs per-user, no administrator rights, no service, no driver.
- Crash reporting is the only data collected, and it can be switched off in
  Settings → Privacy — with it off, the reporting SDK is never even loaded.

## If that still is not enough

**Read the code.** The Electron main process — the only part of the launcher with
any access to a player's machine — is published at
[dayzbeans-launcher-core](https://github.com/TheDmitri/dayzbeans-launcher-core).
No request, no NDA, no walkthrough needed. Start with `src/electron/ipc-handlers.ts`
(every operation the interface can request) and `src/electron/platform-utils.ts`
(filesystem and registry).

It is source-available, not open source: read it, compile it, verify it, publish
anything you find. Reuse in other software is not permitted.

If you would rather be walked through it, or need something in writing for your
staff, contact **admin@dayzbeanslauncher.com**.

If an antivirus product has flagged us to your community, send us the product name,
the detection name, and the file's SHA256. We submit signed builds for
reclassification, and the exact detection name makes that go much faster.
