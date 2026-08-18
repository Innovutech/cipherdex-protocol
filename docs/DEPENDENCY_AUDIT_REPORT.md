# Dependency Audit Report

Date: 2026-08-18

## Environment and result

- Node: `v24.16.x`
- npm: `11.13.x`
- install: `npm ci --ignore-scripts`
- production audit: `0` findings at every severity
- full operational audit: `0` findings at every severity
- dependency graph: complete, with no missing or invalid required package
- production dependencies: COTI contracts and OpenZeppelin contracts only

The previous Hardhat 2/toolbox graph and its advisory-bearing transitive
packages were removed. CipherDEX now uses pinned Hardhat 3 and the smallest set
of official Nomic Foundation plugins required for compile, ethers integration,
Mocha, Chai matchers, and TypeChain.

## Compatibility work completed

The migration included:

- an ESM Hardhat 3 configuration;
- local plugin composition instead of `hardhat-toolbox`;
- the Hardhat 3 runtime/task and Solidity hook adapters under `hardhat/`;
- split build-info handling for privacy/security AST checks;
- TypeScript `ESNext`/bundler module resolution;
- unchanged Solidity `0.8.28` and Paris EVM output;
- complete contract, SDK, deployment-runner, evidence, and security tests.

`skipLibCheck` remains enabled only for incompatible upstream declaration output
from the pinned COTI/TypeChain packages. CipherDEX source remains under strict
type checking, and runtime/API validation is not weakened.

## Lifecycle and native-code review

The lockfile contains two packages marked with lifecycle scripts:

| Package | Purpose | Disposition |
| --- | --- | --- |
| `esbuild@0.28.2` | Hardhat build dependency | Script execution is disabled. The exact platform binary is lockfile-pinned and compile/tests prove availability. |
| `fsevents@2.3.3` | Optional macOS filesystem events | Optional, not loaded on the supported Windows/Linux paths, and its script is not executed. |

No project lifecycle script, Git dependency, downloaded external compiler, or
unreviewed native package is required. The compiler is the exact npm-pinned
`solc@0.8.28` package.

## Override disposition

The exact overrides for `diff@8.0.3`, `glob@13.0.6`,
`serialize-javascript@7.0.5`, and `tmp@0.2.7` replace advisory-affected
transitive ranges with compatible patched releases. They are covered by the full
compile/test/boundary suite and must be removed when every direct upstream range
naturally resolves to the same or newer reviewed versions.

No advisory is ignored or baselined. Any future critical, high, medium, or low
finding in either audit is a release blocker until explicitly investigated and
resolved.
