/**
 * electron-builder custom Windows signing hook (SSL.com eSigner / CodeSignTool).
 *
 * WHY A CUSTOM HOOK INSTEAD OF SIGNING THE INSTALLER AFTERWARDS
 * ------------------------------------------------------------
 * The CI used to run the `sslcom/esigner-codesign` action on the finished
 * `*Setup*.exe`. That signs the outer NSIS installer and nothing else, so the
 * files NSIS actually writes to disk — `Day(Z) Beans Launcher.exe` and
 * `Uninstall Day(Z) Beans Launcher.exe` — stayed unsigned. Users got a signed
 * download that installed an unsigned application, which is exactly the shape
 * SmartScreen and Defender heuristics punish, and exactly the observation that
 * feeds "this launcher is malware" rumours.
 *
 * Wiring the signer into electron-builder instead means every binary is signed
 * before it is packed, so the installed app is signed too.
 *
 * QUOTA
 * -----
 * The SSL.com eSigner plan allows 20 signatures per month. One release run costs
 * roughly: app exe + uninstaller + NSIS installer + portable exe. Two things keep
 * that from blowing up:
 *   - `signingHashAlgorithms: ["sha256"]` in electron-builder.json. The default is
 *     `['sha1', 'sha256']`, which would call this hook TWICE per file.
 *   - `alreadySigned` below, because electron-builder asks for the same app exe
 *     again when it builds the second target (portable) from the same app dir.
 * Every call is logged with a running count so the quota spend of a release is
 * visible in the build log.
 *
 * BEHAVIOUR WITHOUT CREDENTIALS
 * -----------------------------
 * No credentials (local `npm run package:win`, forks, dev CI builds) means this
 * hook no-ops instead of failing, so unsigned local builds still work. CI is what
 * enforces that a *release* is signed: it exports SIGN_REQUIRED=true, which turns
 * a missing credential or a failed CodeSignTool run into a hard error.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * electron-builder hands the same app exe to the hook once per target that packs
 * it. Signing it twice would be a second charge against the monthly quota for a
 * byte-identical result, so remember what has already gone through.
 */
const alreadySigned = new Set();
let signCount = 0;

/**
 * Resolves the Java entry point inside an extracted CodeSignTool distribution.
 *
 * CodeSignTool.bat is deliberately NOT used. Since the fix for CVE-2024-27980,
 * Node refuses to execute .bat/.cmd through spawn/execFile without `shell: true`
 * and fails with EINVAL. Turning on `shell: true` would concatenate the arguments
 * into one command string, which means the eSigner password and TOTP secret would
 * be parsed by cmd.exe -- a `&`, `^` or `%` in the password would corrupt the
 * command or leak into the log.
 *
 * The batch file is only a two-line wrapper:
 *
 *   .\jdk-11.0.2\bin\java -jar .\jar\code_sign_tool-1.3.3.jar %*
 *
 * so calling that java directly is both simpler and safe: arguments stay a real
 * array and no shell ever sees them. The Windows distribution bundles its own
 * JDK 11, so no separate Java install is needed on the runner.
 *
 * The jar reads `./conf/code_sign_tool.properties` (client id, OAuth and
 * timestamp endpoints) relative to the WORKING DIRECTORY, so the caller must run
 * it with cwd set to the distribution root or every sign fails with
 * FileNotFoundException.
 */
function resolveTool(home) {
  const jarDir = path.join(home, 'jar');
  const jars = fs.existsSync(jarDir)
    ? fs.readdirSync(jarDir).filter((f) => /^code_sign_tool-.*\.jar$/.test(f))
    : [];
  if (jars.length === 0) {
    throw new Error(`No code_sign_tool-*.jar found under ${jarDir}`);
  }

  // Version is part of the filename and changes between releases, so glob rather
  // than pin. Bundled JDK first; fall back to a Java on PATH if the layout of the
  // distribution ever changes.
  const bundled = fs
    .readdirSync(home)
    .filter((f) => f.startsWith('jdk-'))
    .map((f) => path.join(home, f, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
    .find((p) => fs.existsSync(p));

  return { java: bundled || 'java', jar: path.join(jarDir, jars[0]) };
}

function credentials() {
  const {
    ES_USERNAME,
    ES_PASSWORD,
    ES_CREDENTIAL_ID,
    ES_TOTP_SECRET,
    CODESIGNTOOL_HOME,
  } = process.env;

  if (!ES_USERNAME || !ES_PASSWORD || !ES_CREDENTIAL_ID || !ES_TOTP_SECRET) {
    return null;
  }
  if (!CODESIGNTOOL_HOME) {
    return null;
  }
  return {
    username: ES_USERNAME,
    password: ES_PASSWORD,
    credentialId: ES_CREDENTIAL_ID,
    totpSecret: ES_TOTP_SECRET,
    home: CODESIGNTOOL_HOME,
  };
}

module.exports = async function signWindows(configuration) {
  const filePath = configuration.path;
  const required = process.env.SIGN_REQUIRED === 'true';
  const creds = credentials();

  if (!creds) {
    const message = `No eSigner credentials in the environment; cannot sign ${path.basename(filePath)}`;
    if (required) {
      throw new Error(
        `${message}. SIGN_REQUIRED=true, so this is a release build and must not ship unsigned.`
      );
    }
    console.log(`[sign] SKIP (unsigned build) ${path.basename(filePath)}`);
    return;
  }

  const resolved = path.resolve(filePath);
  if (alreadySigned.has(resolved)) {
    console.log(`[sign] SKIP (already signed this run) ${path.basename(filePath)}`);
    return;
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Cannot sign missing file: ${resolved}`);
  }

  signCount += 1;
  console.log(`[sign] #${signCount} CodeSignTool -> ${path.basename(filePath)}`);

  const { java, jar } = resolveTool(creds.home);

  // `-override` signs in place, so there is no output file to move back and no
  // chance of an unsigned copy surviving next to a signed one.
  //
  // `-malware_block` is deliberately NOT passed. It is a bare flag that overrides
  // the malware-scan policy configured server-side at SSL.com; leaving it off
  // keeps that configured default, which is what the previous
  // sslcom/esigner-codesign setup effectively used. VirusTotal in CI is the scan
  // that actually gets published and reviewed.
  const args = [
    '-jar',
    jar,
    'sign',
    `-username=${creds.username}`,
    `-password=${creds.password}`,
    `-credential_id=${creds.credentialId}`,
    `-totp_secret=${creds.totpSecret}`,
    `-input_file_path=${resolved}`,
    '-override',
  ];

  try {
    execFileSync(java, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      // Required: the jar loads ./conf/code_sign_tool.properties relative to cwd.
      cwd: creds.home,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`CodeSignTool failed for ${path.basename(filePath)}: ${error.message}`);
  }

  alreadySigned.add(resolved);
};
