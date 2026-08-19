import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SYSTEM_ENVIRONMENT = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "CI", "GITHUB_ACTIONS",
]);
const TRUSTED_GIT_CANDIDATES = Object.freeze(
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      ]
    : ["/usr/bin/git", "/bin/git"],
);
const GIT_CONFIG_NULL = process.platform === "win32" ? "NUL" : "/dev/null";
const COMMIT = /^[0-9a-f]{40}$/iu;
const TARGET = /^scripts\/[a-z0-9-]+\.ts$/u;
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

process.umask(0o077);

function selectedEnvironment(names, source = process.env) {
  const environment = { NODE_OPTIONS: "--max-old-space-size=8192" };
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return environment;
}

function parseArguments(arguments_) {
  const values = new Map();
  const passthrough = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      passthrough.push(...arguments_.slice(index + 1));
      break;
    }
    if (!["--repository", "--commit", "--environment", "--target"].includes(argument)) {
      throw new Error(`unsupported funded launcher argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value || values.has(argument)) throw new Error(`invalid funded launcher ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const repository = values.get("--repository");
  const commit = values.get("--commit");
  const environment = values.get("--environment");
  const target = values.get("--target");
  if (!repository || !commit || !environment || !target) {
    throw new Error(
      "usage: funded-launcher --repository <path> --commit <40-hex> " +
        "--environment <absolute-path> --target <scripts/name.ts> -- [target arguments]",
    );
  }
  if (!COMMIT.test(commit) || !TARGET.test(target)) {
    throw new Error("funded launcher requires a full commit and a canonical script target");
  }
  if (passthrough.length > 8 || passthrough.some((value) => value.length > 128)) {
    throw new Error("funded launcher target arguments are invalid");
  }
  return Object.freeze({ repository, commit: commit.toLowerCase(), environment, target, passthrough });
}

function trustedGit() {
  const candidate = TRUSTED_GIT_CANDIDATES.find(existsSync);
  if (!candidate) throw new Error("funded launcher requires Git at a trusted system path");
  return realpathSync(candidate);
}

function npmCli() {
  const candidates = process.platform === "win32"
    ? [resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    : ["/usr/lib/node_modules/npm/bin/npm-cli.js", "/usr/local/lib/node_modules/npm/bin/npm-cli.js"];
  const candidate = candidates.find(existsSync);
  if (!candidate) throw new Error("funded launcher cannot resolve the trusted npm CLI");
  return realpathSync(candidate);
}

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: options.encoding,
    stdio: options.stdio ?? (options.encoding ? "pipe" : "inherit"),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.failure ?? `trusted command failed: ${arguments_[0] ?? executable}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function gitEnvironment(systemEnvironment, safeDirectory) {
  const canonicalSafeDirectory = process.platform === "win32"
    ? safeDirectory.replaceAll("\\", "/")
    : safeDirectory;
  return {
    ...systemEnvironment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_CONFIG_NULL,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: GIT_CONFIG_NULL,
    GIT_CONFIG_KEY_2: "safe.directory",
    GIT_CONFIG_VALUE_2: canonicalSafeDirectory,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
}

function runGit(git, cwd, environment, arguments_) {
  return run(git, ["--no-replace-objects", "--no-pager", ...arguments_], {
    cwd,
    env: environment,
    encoding: "utf8",
    failure: `funded launcher Git operation failed: ${arguments_[0]}`,
  });
}

function assertExternalEnvironment(repositoryRoot, path) {
  if (!isAbsolute(path)) throw new Error("funded environment path must be absolute");
  const original = lstatSync(path);
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1) {
    throw new Error("funded environment must be a single-link regular file");
  }
  const canonical = realpathSync(path);
  const fromRepository = relative(repositoryRoot, canonical);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error("funded environment must remain outside the repository");
  }
  return canonical;
}

function assertManagedRuntime(root, path) {
  const fromRoot = relative(root, path);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("funded runtime escaped its operator-owned root");
  }
}

function restrictOperatorDirectory(path) {
  const canonical = realpathSync(resolve(path));
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("operator runtime root must be a real directory");
  }
  if (process.platform !== "win32") {
    chmodSync(canonical, 0o700);
    return canonical;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$path=$env:CIPHERDEX_OPERATOR_PATH",
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetOwner($current)",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$inheritance=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
    "$propagation=[System.Security.AccessControl.PropagationFlags]::None",
    "$allow=[System.Security.AccessControl.AccessControlType]::Allow",
    "$full=[System.Security.AccessControl.FileSystemRights]::FullControl",
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current,$full,$inheritance,$propagation,$allow)))",
    "foreach($sidValue in @('S-1-5-18','S-1-5-32-544')) {",
    "  $sid=New-Object System.Security.Principal.SecurityIdentifier($sidValue)",
    "  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$full,$inheritance,$propagation,$allow)))",
    "}",
    "[System.IO.Directory]::SetAccessControl($path,$acl)",
  ].join("\n");
  const result = spawnSync(WINDOWS_POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], {
    env: { ...selectedEnvironment(SYSTEM_ENVIRONMENT), CIPHERDEX_OPERATOR_PATH: canonical },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("unable to restrict the operator-owned funded runtime directory");
  }
  return canonical;
}

function persistentRecoveryRoot(repositoryRoot) {
  const recoveryRoot = resolve(homedir(), ".cipherdex", "recovery");
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const canonicalRecoveryRoot = restrictOperatorDirectory(recoveryRoot);
  const repositoryId = createHash("sha256")
    .update(repositoryRoot.toLowerCase(), "utf8")
    .digest("hex");
  const repositoryRecoveryRoot = resolve(canonicalRecoveryRoot, repositoryId);
  mkdirSync(repositoryRecoveryRoot, { recursive: true, mode: 0o700 });
  return restrictOperatorDirectory(repositoryRecoveryRoot);
}

function materializeInternalFileLinks(root) {
  const canonicalRoot = realpathSync(root);
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      const fromRoot = relative(canonicalRoot, target);
      const targetStat = lstatSync(target);
      if (
        fromRoot === "" ||
        fromRoot.startsWith("..") ||
        isAbsolute(fromRoot) ||
        !targetStat.isFile() ||
        targetStat.isSymbolicLink()
      ) throw new Error("private funded dependency link escapes its authenticated runtime");
      const contents = readFileSync(target);
      unlinkSync(path);
      writeFileSync(path, contents, { mode: targetStat.mode & 0o700 ? 0o700 : 0o600 });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
    }
  };
  visit(canonicalRoot);
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const repositoryRoot = realpathSync(resolve(input.repository));
  const repositoryStat = lstatSync(repositoryRoot);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new Error("funded launcher repository must be a real directory");
  }
  const environmentPath = assertExternalEnvironment(repositoryRoot, resolve(input.environment));
  const recoveryRoot = persistentRecoveryRoot(repositoryRoot);
  const git = trustedGit();
  const systemEnvironment = selectedEnvironment(SYSTEM_ENVIRONMENT);
  const hardenedGitEnvironment = gitEnvironment(systemEnvironment, repositoryRoot);

  const objectType = runGit(git, repositoryRoot, hardenedGitEnvironment, [
    "cat-file", "-t", input.commit,
  ]);
  if (objectType !== "commit") throw new Error("approved funded revision is not a commit");

  const runtimeRoot = resolve(
    process.env.CIPHERDEX_OPERATOR_RUNTIME_ROOT ?? resolve(homedir(), ".cipherdex", "runtimes"),
  );
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  // The installed launcher establishes this boundary using built-ins only. It
  // must not import code from the mutable checkout before authentication.
  restrictOperatorDirectory(runtimeRoot);

  const runtime = resolve(
    realpathSync(runtimeRoot),
    `run-${input.commit}-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  assertManagedRuntime(realpathSync(runtimeRoot), runtime);
  mkdirSync(runtime, { recursive: false, mode: 0o700 });
  restrictOperatorDirectory(runtime);

  try {
    runGit(git, runtime, hardenedGitEnvironment, ["init", "--quiet"]);
    runGit(git, runtime, hardenedGitEnvironment, [
      "-c", "protocol.file.allow=always",
      "fetch", "--quiet", "--no-tags", pathToFileURL(repositoryRoot).href, input.commit,
    ]);
    runGit(git, runtime, hardenedGitEnvironment, [
      "-c", `core.hooksPath=${GIT_CONFIG_NULL}`,
      "checkout", "--quiet", "--detach", input.commit,
    ]);
    if (runGit(git, runtime, hardenedGitEnvironment, ["rev-parse", "--verify", "HEAD"]) !== input.commit) {
      throw new Error("private funded runtime resolved a different source commit");
    }
    if (runGit(git, runtime, hardenedGitEnvironment, [
      "status", "--porcelain=v1", "--untracked-files=all",
    ]) !== "") throw new Error("private funded runtime source is not clean");

    run(process.execPath, [npmCli(), "ci", "--ignore-scripts"], {
      cwd: runtime,
      env: systemEnvironment,
      failure: "locked private funded dependency installation failed",
    });
    const hardhatResolver = await import(
      `${pathToFileURL(resolve(runtime, "scripts", "resolve-hardhat-cli.mjs")).href}?commit=${input.commit}`
    );
    const hardhatCli = hardhatResolver.resolveHardhatCli(runtime);
    for (const command of ["clean", "compile"]) {
      run(process.execPath, [hardhatCli, command], {
        cwd: runtime,
        env: systemEnvironment,
        failure: `private funded Hardhat ${command} failed`,
      });
    }

    // npm creates executable links (primarily node_modules/.bin) on POSIX.
    // Resolve only links whose regular-file target is inside this authenticated
    // runtime, then measure and execute a link-free private tree.
    materializeInternalFileLinks(runtime);

    const privateFilesystem = await import(
      `${pathToFileURL(resolve(runtime, "scripts", "private-filesystem.mjs")).href}?commit=${input.commit}`
    );
    privateFilesystem.assertPrivateTree(runtime);
    privateFilesystem.assertPrivateFile(environmentPath, "read");
    const trackedFiles = runGit(git, runtime, hardenedGitEnvironment, ["ls-files", "-z"])
      .split("\0")
      .filter(Boolean);
    const receiptRoot = resolve(runtime, ".git", "cipherdex-receipts");
    mkdirSync(receiptRoot, { recursive: false, mode: 0o700 });
    privateFilesystem.restrictPrivateDirectory(receiptRoot);
    const reviewedBuild = await import(
      `${pathToFileURL(resolve(runtime, "scripts", "reviewed-build-receipt.mjs")).href}?commit=${input.commit}`
    );
    const runtimeReceipt = reviewedBuild.recordReviewedBuild(runtime, input.commit, {
      trackedFiles,
      receiptRoot,
    });
    if (runtimeReceipt.sourceCommit !== input.commit) {
      throw new Error("reviewed funded build receipt has the wrong source commit");
    }
    privateFilesystem.assertPrivateTree(runtime);

    const childEnvironment = {
      ...systemEnvironment,
      CIPHERDEX_OPERATOR_LAUNCHER_ACTIVE: "1",
      CIPHERDEX_AUTHENTICATED_SOURCE_COMMIT: input.commit,
      CIPHERDEX_PUBLIC_REPOSITORY_ROOT: repositoryRoot,
      CIPHERDEX_FUNDED_ENV_FILE: environmentPath,
      CIPHERDEX_FUNDED_STATE_ROOT: recoveryRoot,
      CIPHERDEX_BUILD_RECEIPT_ROOT: receiptRoot,
      CIPHERDEX_TRUSTED_GIT: git,
    };
    run(process.execPath, [
      resolve(runtime, "scripts", "run-fresh-hardhat.mjs"),
      input.target,
      ...input.passthrough,
    ], {
      cwd: runtime,
      env: childEnvironment,
      failure: "reviewed funded target failed",
    });
  } finally {
    if (existsSync(runtime)) {
      assertManagedRuntime(realpathSync(runtimeRoot), runtime);
      rmSync(runtime, { recursive: true, force: true });
    }
  }
}

await main();
