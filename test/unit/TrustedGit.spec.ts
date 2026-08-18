import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  trustedGitArguments,
  trustedGitEnvironment,
  trustedGitExecutable,
} from "../../scripts/trusted-git";

describe("trusted Git executable", function () {
  it("resolves only an approved absolute system executable", function () {
    const executable = trustedGitExecutable({});
    expect(isAbsolute(executable)).to.equal(true);
  });

  it("rejects an injected executable outside the approved system paths", function () {
    expect(() => trustedGitExecutable({ CIPHERDEX_TRUSTED_GIT: fileURLToPath(import.meta.url) }))
      .to.throw("not an approved system executable");
  });

  it("builds a credential-free, helper-restricted child environment", function () {
    const environment = trustedGitEnvironment({
      PATH: "system-path",
      COTI_TESTNET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      COTI_AES_KEY: "22".repeat(16),
      CIPHERDEX_FEE_BENEFICIARY: `0x${"33".repeat(20)}`,
    });

    expect(environment.PATH).to.equal("system-path");
    expect(environment.COTI_TESTNET_PRIVATE_KEY).to.equal(undefined);
    expect(environment.COTI_AES_KEY).to.equal(undefined);
    expect(environment.CIPHERDEX_FEE_BENEFICIARY).to.equal(undefined);
    expect(environment.GIT_CONFIG_NOSYSTEM).to.equal("1");
    expect(environment.GIT_CONFIG_KEY_0).to.equal("core.fsmonitor");
    expect(environment.GIT_CONFIG_VALUE_0).to.equal("false");
    expect(environment.GIT_CONFIG_KEY_1).to.equal("core.hooksPath");
    expect(environment.GIT_NO_REPLACE_OBJECTS).to.equal("1");
  });

  it("forces non-interactive, replacement-free Git arguments", function () {
    expect(trustedGitArguments(["status", "--porcelain=v1"]))
      .to.deep.equal(["--no-replace-objects", "--no-pager", "status", "--porcelain=v1"]);
  });

  it("reads the reviewed object even when the repository defines a replacement", function () {
    const directory = mkdtempSync(join(tmpdir(), "cipherdex-trusted-git-"));
    const executable = trustedGitExecutable({}, directory);
    const isolatedEnvironment = trustedGitEnvironment();
    const run = (
      arguments_: readonly string[],
      replacementFree = true,
    ): string => {
      const environment = { ...isolatedEnvironment };
      if (!replacementFree) delete environment.GIT_NO_REPLACE_OBJECTS;
      const result = spawnSync(
        executable,
        replacementFree
          ? trustedGitArguments(arguments_)
          : ["--no-pager", ...arguments_],
        { cwd: directory, env: environment, encoding: "utf8", windowsHide: true },
      );
      if (result.error || result.status !== 0) {
        throw new Error(result.error?.message ?? result.stderr.trim());
      }
      return result.stdout.trim();
    };

    try {
      run(["init"]);
      run(["config", "user.email", "security-test@cipherdex.invalid"]);
      run(["config", "user.name", "CipherDEX Security Test"]);
      run(["config", "commit.gpgsign", "false"]);
      writeFileSync(join(directory, "payload.txt"), "reviewed\n", "utf8");
      run(["add", "payload.txt"]);
      run(["commit", "-m", "reviewed"]);
      const reviewedCommit = run(["rev-parse", "HEAD"]);

      writeFileSync(join(directory, "payload.txt"), "replacement\n", "utf8");
      run(["commit", "-am", "replacement"]);
      const replacementCommit = run(["rev-parse", "HEAD"]);
      run(["replace", reviewedCommit, replacementCommit]);

      expect(run(["show", `${reviewedCommit}:payload.txt`], false)).to.equal("replacement");
      expect(run(["show", `${reviewedCommit}:payload.txt`])).to.equal("reviewed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
