import { expect } from "chai";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { fundedSuiteOutputPath } from "../../scripts/funded-suite-output";

describe("funded suite output", function () {
  const roots: string[] = [];

  afterEach(function () {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function temporaryRoot(): string {
    const root = mkdtempSync(resolve(tmpdir(), "cipherdex-funded-suite-"));
    roots.push(root);
    return root;
  }

  it("binds the aggregate evidence path to the canonical public repository", function () {
    const root = temporaryRoot();
    mkdirSync(resolve(root, "evidence"));
    const sourceCommit = "a".repeat(40);

    expect(fundedSuiteOutputPath(root, sourceCommit)).to.equal(
      resolve(root, "evidence", `coti-testnet-${sourceCommit}.json`),
    );
  });

  it("rejects relative roots, malformed commits, and non-directory evidence roots", function () {
    const root = temporaryRoot();
    writeFileSync(resolve(root, "evidence"), "not a directory");

    expect(() => fundedSuiteOutputPath("evidence", "a".repeat(40))).to.throw(
      "public repository root must be absolute",
    );
    expect(() => fundedSuiteOutputPath(root, "not-a-commit")).to.throw(
      "source commit is invalid",
    );
    expect(() => fundedSuiteOutputPath(root, "a".repeat(40))).to.throw(
      "evidence root must be a real directory",
    );
  });

  it("rejects a linked evidence root", function () {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(resolve(outside, "evidence"));
    symlinkSync(
      resolve(outside, "evidence"),
      resolve(root, "evidence"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => fundedSuiteOutputPath(root, "a".repeat(40))).to.throw(
      "evidence root must be a real directory",
    );
  });
});
