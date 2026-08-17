# Security Policy

## Reporting a vulnerability

Email **admin@dayzbeanslauncher.com**.

Please include what you found, how to reproduce it, and the launcher version
(**Settings → About**). If you would rather report privately over Discord, ask a
staff member for a direct channel — do not post details in a public channel.

What to expect:

| | |
|---|---|
| First response | within 72 hours |
| Assessment and severity | within 7 days |
| Fix for a confirmed critical issue | as fast as we can build and sign a release |
| Credit | in the release notes, unless you prefer otherwise |

We will not pursue legal action against anyone who reports a genuine issue in good
faith, does not access or modify other users' data, and gives us reasonable time to
fix it before publishing.

There is no paid bounty programme.

## "Is this launcher malware?"

A legitimate question, and one we would rather answer with evidence than with
reassurance.

**The source of everything that touches your machine is published**, at
[dayzbeans-launcher-core](https://github.com/TheDmitri/dayzbeans-launcher-core):
filesystem and registry access, game launch, Steam integration, mod downloads,
auto-update, and the complete IPC surface between the interface and the system.
The user interface and the server data behind it stay private, and they cannot
reach your machine except through that published surface.

It is source-available rather than open source: you may read it, compile it,
verify it, and publish anything you find in it, but not reuse it in other
software.

That repository also documents how to confirm that the launcher installed on your
machine is built from exactly that source — the compiled main process is
reproducible byte-for-byte, so the check is exact rather than a matter of trust.

- **What the launcher can do to your machine** — the complete inventory of
  privileged operations, filesystem paths, processes, and network destinations:
  [transparency.md](https://github.com/TheDmitri/dayzbeans-launcher-core/blob/main/docs/security/transparency.md)
- **Verifying the file you downloaded** — checksums, code signature, cryptographic
  build provenance, VirusTotal:
  [verify-download.md](https://github.com/TheDmitri/dayzbeans-launcher-core/blob/main/docs/security/verify-download.md)

Every release is:

- Authenticode-signed, including the executables the installer writes to disk
- published with a SHA256 in `SHA256SUMS.txt` and in `latest.json`
- published with a Sigstore bundle proving which commit and CI run produced it,
  verifiable offline without any access to this repository
- scanned by VirusTotal with the permalink published in the release notes
- mirrored to GitHub Releases and submitted to `microsoft/winget-pkgs`

A build that fails any signature check never reaches the download CDN — the release
pipeline refuses to publish it.

## Server owners and community operators

The Electron main-process source — the only part of the launcher with access to
your machine — is published in full at
[dayzbeans-launcher-core](https://github.com/TheDmitri/dayzbeans-launcher-core),
so no walkthrough or NDA is needed to audit it. If you would still rather be walked
through it, or need something in writing before recommending the launcher to your
players, contact us at the address above.

## Reporting a false positive

If an antivirus product flags a release, please tell us the product name, the
detection name, and the SHA256 of the file. We submit signed builds to Microsoft and
to the relevant vendors for reclassification, and having the exact detection name
makes that much faster.

## Data we collect

Crash reports only: stack traces, launcher version, operating system version. No
behavioural tracking, no advertising identifiers, no record of which servers you
play on. Screenshot capture is disabled.

Crash reporting can be turned off completely in **Settings → Privacy → Send crash
reports**; when it is off, the reporting SDK is never initialised and no connection
is made.
