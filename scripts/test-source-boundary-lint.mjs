import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import solc from "solc";

import {
  assertEarlyHardhatRunSequence,
  maskSourceCommentsAndLiterals,
  uniqueFunctionBody,
  uniqueFunctionDeclaration,
} from "./source-boundary-lint.mjs";
import { assertCompiledPrivacyDecryptBoundary } from "./solidity-privacy-ast.mjs";

const fixture = `
// function guarded() external { unsafe(); }
string constant DECOY = "function guarded() external { unsafe(); }";
/* function guarded() external { unsafe(); } */
function guarded() external nonReentrant {
  enforceInvariant();
}
`;

assert.doesNotMatch(maskSourceCommentsAndLiterals(fixture), /unsafe/);
assert.match(maskSourceCommentsAndLiterals(fixture), /string constant DECOY\s*=\s*;/);
assert.match(uniqueFunctionDeclaration(fixture, "guarded", "fixture"), /nonReentrant/);
assert.match(uniqueFunctionBody(fixture, "guarded", "fixture"), /enforceInvariant/);
assert.match(
  uniqueFunctionBody(
    "async function generic<T extends object>(value: T) { return value; }",
    "generic",
    "generic fixture",
  ),
  /return value/,
);
assert.throws(
  () => uniqueFunctionBody(`${fixture}\nfunction guarded() external {}`, "guarded"),
  /expected exactly one function guarded, found 2/,
);
assert.throws(
  () => maskSourceCommentsAndLiterals("contract Broken { /*"),
  /unterminated block comment/,
);
const interpolated = maskSourceCommentsAndLiterals(
  "const message = `hidden ${error.data} ${`nested ${error.cause}`} tail`;",
);
assert.doesNotMatch(interpolated, /hidden|nested|tail/);
assert.match(interpolated, /error\.data/);
assert.match(interpolated, /error\.cause/);

const compileBlockers = ["ethers.provider.getNetwork", "ethers.getContractFactory"];
assert.doesNotThrow(() => assertEarlyHardhatRunSequence(
  `async function main() {
    await hre.run("clean");
    await hre.run("compile");
    await ethers.provider.getNetwork();
  }`,
  "safe-runner.ts",
  ["clean", "compile"],
  compileBlockers,
));

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const freshRunnerSource = readFileSync("scripts/run-fresh-hardhat.mjs", "utf8");
const freshTargets = new Map([
  ["testnet:preflight", "scripts/testnet-preflight.ts --network cotiTestnet"],
  ["testnet:best-execution-feasibility", "scripts/testnet-best-execution-feasibility.ts --network cotiTestnet"],
  ["testnet:best-execution", "scripts/testnet-best-execution.ts --network cotiTestnet"],
  ["testnet:fee-collection", "scripts/testnet-fee-collection.ts --network cotiTestnet"],
  ["gas:measure", "scripts/measure-deployment-gas.ts"],
  ["deploy:testnet", "scripts/deploy-testnet.ts --network cotiTestnet"],
]);
for (const [script, target] of freshTargets) {
  assert.equal(
    packageJson.scripts[script],
    `node scripts/run-fresh-hardhat.mjs ${target}`,
  );
}
assert.doesNotMatch(freshRunnerSource, /from\s+["']\.\.?\//);
const cleanPosition = freshRunnerSource.lastIndexOf('runHardhat(["clean"])');
const compilePosition = freshRunnerSource.lastIndexOf('runHardhat(["compile"])');
const runPosition = freshRunnerSource.lastIndexOf(
  'runHardhat(["run", "--no-compile", target, ...targetArguments])',
);
assert.ok(cleanPosition >= 0 && cleanPosition < compilePosition && compilePosition < runPosition);
for (const unsafe of [
  `async function dead() { await hre.run("compile"); }
   async function main() { await ethers.provider.getNetwork(); }`,
  `async function main() {
     await fake.hre.run("clean");
     await fake.hre.run("compile");
     await ethers.provider.getNetwork();
   }`,
  `async function main() {
     await ethers.provider.getNetwork();
     await hre.run("clean");
     await hre.run("compile");
   }`,
  `async function loadStale() { await ethers.getContractFactory("Stale"); }
   async function main() {
     await loadStale();
     await hre.run("clean");
     await hre.run("compile");
   }`,
  `async function main() {
     await (async () => ethers.getContractFactory("Stale"))();
     await hre.run("clean");
     await hre.run("compile");
   }`,
]) {
  assert.throws(
    () => assertEarlyHardhatRunSequence(
      unsafe,
      "unsafe-runner.ts",
      ["clean", "compile"],
      compileBlockers,
    ),
    /main must directly await|must begin with|after artifact or network work/,
  );
}
assert.throws(
  () => assertEarlyHardhatRunSequence(
    `async function reviewedGitCheck() { await ethers.getContractFactory("Stale"); }
     async function main() {
       await reviewedGitCheck();
       await hre.run("clean");
       await hre.run("compile");
     }`,
    "unsafe-allowed-helper.ts",
    ["clean", "compile"],
    compileBlockers,
    ["reviewedGitCheck"],
  ),
  /must begin with/,
);
for (const eagerModuleWork of [
  `const staleFactoryPromise = ethers.getContractFactory("Stale");`,
  `const staleFactoryPromise = ethers["getContractFactory"]("Stale");`,
  `const getFactory = ethers.getContractFactory;
   const staleFactoryPromise = getFactory("Stale");`,
  `const api = ethers;
   const { getContractFactory } = api;
   const staleFactoryPromise = getContractFactory("Stale");`,
  `const key = "getContractFactory";
   const staleFactoryPromise = (ethers as any)[key]("Stale");`,
  `void (async () => {
     await ethers.getContractFactory("Stale");
   })();`,
  `void (() => {
     const api = ethers;
     const getFactory = api.getContractFactory;
     return getFactory("Stale");
   })();`,
  `class UnsafeStaticField {
     static factory = ethers.getContractFactory("Stale");
   }`,
  `class UnsafeStaticBlock {
     static { ethers.getContractFactory("Stale"); }
   }`,
  `class UnsafeComputedName {
     [ethers.getContractFactory("Stale")]() {}
   }`,
  `const UnsafeClassExpression = class {
     static factory = ethers.getContractFactory("Stale");
   };`,
  `function loadStaleFactory() {
     return ethers.getContractFactory("Stale");
   }
   void loadStaleFactory();`,
  `function loadStaleFactoryAlias() {
     return ethers.getContractFactory("Stale");
   }
   const invokeStaleFactory = loadStaleFactoryAlias;
   void invokeStaleFactory();`,
  `const loadStaleFactoryArrow = () => ethers.getContractFactory("Stale");
   void loadStaleFactoryArrow();`,
  `void (() => {
     function nestedLoadStaleFactory() {
       return ethers.getContractFactory("Stale");
     }
     return nestedLoadStaleFactory();
   })();`,
]) {
  assert.throws(
    () => assertEarlyHardhatRunSequence(
      `${eagerModuleWork}
       async function main() {
         await hre.run("clean");
         await hre.run("compile");
       }`,
      "unsafe-module-initializer.ts",
      ["clean", "compile"],
      compileBlockers,
    ),
    /module initialization/,
  );
}
assert.doesNotThrow(() => assertEarlyHardhatRunSequence(
  `const lazyFactory = () => ethers.getContractFactory("Stale");
   class LazyClass {
     instanceFactory = ethers.getContractFactory("Stale");
     method() { return ethers.getContractFactory("Stale"); }
     static lazyFactory = () => ethers.getContractFactory("Stale");
   }
   async function main() {
     await hre.run("clean");
     await hre.run("compile");
     await ethers.getContractFactory("Fresh");
   }
   void main();`,
  "safe-lazy-initializers.ts",
  ["clean", "compile"],
  compileBlockers,
));
for (const helperBody of [
  `await ethers["getContractFactory"]("Stale");`,
  `const getFactory = ethers.getContractFactory; await getFactory("Stale");`,
  `const { getContractFactory } = ethers; await getContractFactory("Stale");`,
  `const key = "getContractFactory"; await ethers[key]("Stale");`,
  `const api = ethers; await api.getContractFactory("Stale");`,
  `const api = ethers; const key = "getContractFactory"; await api[key]("Stale");`,
  `const api = ethers; const { getContractFactory } = api; await getContractFactory("Stale");`,
  `await (ethers as any).getContractFactory("Stale");`,
]) {
  assert.throws(
    () => assertEarlyHardhatRunSequence(
      `async function reviewedGitCheck() { ${helperBody} }
       async function main() {
         await reviewedGitCheck();
         await hre.run("clean");
         await hre.run("compile");
       }`,
      "unsafe-helper-alias.ts",
      ["clean", "compile"],
      compileBlockers,
      ["reviewedGitCheck"],
    ),
    /must begin with/,
  );
}
assert.throws(
  () => assertEarlyHardhatRunSequence(
    `const staleFactory = () => ethers.getContractFactory("Stale");
     async function main() {
       await staleFactory();
       await hre.run("clean");
       await hre.run("compile");
     }`,
    "unsafe-top-level-wrapper.ts",
    ["clean", "compile"],
    compileBlockers,
  ),
  /must begin with/,
);

function compileAst(body, options = {}) {
  const path = options.path ?? "contracts/ConfidentialBestExecutionRouter.sol";
  const contractName = options.contractName ?? "ConfidentialBestExecutionRouter";
  const source = `
    pragma solidity ^0.8.20;
    type gtUint256 is uint256;
    type gtBool is uint256;
    library MpcCore {
      function decrypt(gtUint256 value) internal pure returns (uint256) {
        return gtUint256.unwrap(value);
      }
      function decrypt(gtBool value) internal pure returns (bool) {
        return gtBool.unwrap(value) != 0;
      }
    }
    contract ${contractName} {
      error InvalidCanonicalPool();
      struct CandidateSet { address[] pools; uint256[] feeTiers; uint256 count; }
      ${body}
    }
  `;
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [path]: { content: source } },
    settings: { outputSelection: { "*": { "": ["ast"] } } },
  })));
  const errors = (output.errors ?? []).filter((error) => error.severity === "error");
  assert.deepEqual(errors, []);
  return { path, sources: output.sources };
}

const safeAst = compileAst(`
  function _selectBest(gtUint256 bestIndex, CandidateSet memory candidates)
    internal pure returns (address selectedPool, uint256 selectedFeeBps)
  {
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }
`);
assert.equal(
  assertCompiledPrivacyDecryptBoundary(safeAst.sources, [safeAst.path]),
  1,
);

const leakingAst = compileAst(`
  event Diagnostic(uint256 datum);
  function _leak(gtUint256 secret) internal {
    uint256 neutral = MpcCore.decrypt(secret);
    emit Diagnostic(neutral);
  }
`);
assert.throws(
  () => assertCompiledPrivacyDecryptBoundary(leakingAst.sources, [leakingAst.path]),
  /outside the reviewed route-index boundary/,
);

for (const unsafeRouteIndex of [
  `function _selectBest(gtUint256 bestIndex, CandidateSet memory candidates)
    internal pure returns (address selectedPool, uint256 selectedFeeBps)
  {
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= type(uint256).max) revert InvalidCanonicalPool();
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }`,
  `function _selectBest(
    gtUint256 bestIndex,
    CandidateSet memory candidates,
    CandidateSet memory attackerCandidates
  ) internal pure returns (address selectedPool, uint256 selectedFeeBps) {
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
    selectedPool = attackerCandidates.pools[selectedIndex];
    selectedFeeBps = attackerCandidates.feeTiers[selectedIndex];
  }`,
  `function _selectBest(gtUint256 bestIndex, CandidateSet memory candidates)
    internal pure returns (address selectedPool, uint256 selectedFeeBps)
  {
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= candidates.count) {
      if (false) revert InvalidCanonicalPool();
    }
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }`,
  `function _selectBest(gtUint256 bestIndex, CandidateSet memory candidates, bool guard)
    internal pure returns (address selectedPool, uint256 selectedFeeBps)
  {
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (guard) {
      if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
    }
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }`,
  `function _selectBest(
    gtUint256 bestIndex,
    CandidateSet memory candidates,
    CandidateSet memory attackerCandidates
  ) internal pure returns (address selectedPool, uint256 selectedFeeBps) {
    candidates.count = attackerCandidates.count;
    candidates.pools = attackerCandidates.pools;
    candidates.feeTiers = attackerCandidates.feeTiers;
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }`,
  `function _selectBest(gtUint256 bestIndex, CandidateSet memory candidates)
    internal pure returns (address selectedPool, uint256 selectedFeeBps)
  {
    address[] memory aliasPools = candidates.pools;
    aliasPools[0] = address(1);
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }`,
  `function _mutate(address[] memory pools) internal pure { pools[0] = address(1); }
   function _selectBest(gtUint256 bestIndex, CandidateSet memory candidates)
    internal pure returns (address selectedPool, uint256 selectedFeeBps)
  {
    _mutate(candidates.pools);
    uint256 selectedIndex = MpcCore.decrypt(bestIndex);
    if (selectedIndex >= candidates.count) revert InvalidCanonicalPool();
    selectedPool = candidates.pools[selectedIndex];
    selectedFeeBps = candidates.feeTiers[selectedIndex];
  }`,
]) {
  const fixtureAst = compileAst(unsafeRouteIndex);
  assert.throws(
    () => assertCompiledPrivacyDecryptBoundary(fixtureAst.sources, [fixtureAst.path]),
    /canonical bound|canonical guard|unreviewed sink|CandidateSet is mutated|array escapes/,
  );
}

const safeBoolAst = compileAst(`
  function _safeBool(gtBool secret) internal pure {
    if (!MpcCore.decrypt(secret)) revert InvalidCanonicalPool();
  }
`);
assert.equal(
  assertCompiledPrivacyDecryptBoundary(safeBoolAst.sources, [safeBoolAst.path]),
  0,
);

const safeFullExitAst = compileAst(`
  bool private initialized;
  function removeLiquidity(gtBool fullExit)
    external
  {
    bool isFullExit = MpcCore.decrypt(fullExit);
    if (isFullExit) {
      initialized = false;
    }
  }
`, {
  path: "contracts/ConfidentialCPMM.sol",
  contractName: "ConfidentialCPMM",
});
assert.equal(
  assertCompiledPrivacyDecryptBoundary(safeFullExitAst.sources, [safeFullExitAst.path]),
  0,
);

const sideEffectingFullExitAst = compileAst(`
  event SecretBranchTaken();
  bool private initialized;
  function removeLiquidity(gtBool fullExit)
    external
  {
    bool isFullExit = MpcCore.decrypt(fullExit);
    if (isFullExit) {
      emit SecretBranchTaken();
      initialized = false;
    }
  }
`, {
  path: "contracts/ConfidentialCPMM.sol",
  contractName: "ConfidentialCPMM",
});
assert.throws(
  () => assertCompiledPrivacyDecryptBoundary(
    sideEffectingFullExitAst.sources,
    [sideEffectingFullExitAst.path],
  ),
  /full-exit boolean reaches an unreviewed sink/,
);

for (const leakingBoolBody of [
  `function _leakBool(gtBool secret) internal pure returns (bool) {
    return MpcCore.decrypt(secret);
  }`,
  `event BoolDiagnostic(bool datum);
   function _emitBool(gtBool secret) internal {
     bool datum = MpcCore.decrypt(secret);
     emit BoolDiagnostic(datum);
   }`,
  `event SecretBranchTaken();
   function _branchLeak(gtBool secret) internal {
     if (MpcCore.decrypt(secret)) emit SecretBranchTaken();
   }`,
  `event SecretBranchTaken();
   function _emitAndReturnFalse() internal returns (bool) {
     emit SecretBranchTaken();
     return false;
   }
   function _shortCircuitLeak(gtBool secret) internal {
     if (MpcCore.decrypt(secret) && _emitAndReturnFalse()) {
       revert InvalidCanonicalPool();
     }
   }`,
  `event SecretBranchTaken();
   function _emitAndReturnFalse() internal returns (gtBool) {
     emit SecretBranchTaken();
     return gtBool.wrap(0);
   }
   function _decryptArgumentLeak(gtBool secret) internal {
     if (MpcCore.decrypt(secret) && MpcCore.decrypt(_emitAndReturnFalse())) {
       revert InvalidCanonicalPool();
     }
   }`,
  `event SecretBranchTaken();
   function _emitAndReturnFalse() internal returns (gtBool) {
     emit SecretBranchTaken();
     return gtBool.wrap(0);
   }
   function _singleDecryptArgumentLeak() internal {
     if (MpcCore.decrypt(_emitAndReturnFalse())) {
       revert InvalidCanonicalPool();
     }
   }`,
]) {
  const boolAst = compileAst(leakingBoolBody);
  assert.throws(
    () => assertCompiledPrivacyDecryptBoundary(boolAst.sources, [boolAst.path]),
    /plaintext MPC bool/,
  );
}

console.log("Source boundary lexer self-tests passed.");
