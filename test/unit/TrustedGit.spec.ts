import { expect } from "chai";
import { isAbsolute } from "node:path";

import { trustedGitExecutable } from "../../scripts/trusted-git";

describe("trusted Git executable", function () {
  it("resolves only an approved absolute system executable", function () {
    const executable = trustedGitExecutable({});
    expect(isAbsolute(executable)).to.equal(true);
  });

  it("rejects an injected executable outside the approved system paths", function () {
    expect(() => trustedGitExecutable({ CIPHERDEX_TRUSTED_GIT: __filename }))
      .to.throw("not an approved system executable");
  });
});
