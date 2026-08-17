import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const TRUSTED_GIT_CANDIDATES = Object.freeze(
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      ]
    : ["/usr/bin/git", "/bin/git"],
);

function normalizedPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function trustedGitExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string {
  const candidate = environment.CIPHERDEX_TRUSTED_GIT ??
    TRUSTED_GIT_CANDIDATES.find((value) => existsSync(value));
  if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) {
    throw new Error("CipherDEX requires Git at a trusted absolute system path");
  }

  const executable = realpathSync(candidate);
  if (!lstatSync(executable).isFile()) {
    throw new Error("CipherDEX trusted Git path is not a regular file");
  }
  const allowed = TRUSTED_GIT_CANDIDATES
    .filter((value) => existsSync(value))
    .map((value) => normalizedPath(realpathSync(value)));
  if (!allowed.includes(normalizedPath(executable))) {
    throw new Error("CipherDEX trusted Git path is not an approved system executable");
  }

  const root = realpathSync(resolve(workingDirectory));
  const fromRoot = relative(root, executable);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    throw new Error("CipherDEX refuses a repository-controlled Git executable");
  }
  return executable;
}
