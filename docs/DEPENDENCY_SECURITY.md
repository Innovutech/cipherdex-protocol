# Dependency and Supply-Chain Review

The first dependency set was reviewed before creating the package manifest.

## Direct packages

- `@coti-io/coti-contracts@1.3.5`: official COTI package; repository points to
  `coti-io/coti-contracts`; package integrity was checked through npm metadata.
- `@openzeppelin/contracts@5.4.0`: official OpenZeppelin repository and exact
  version; no install lifecycle script is used by this project.
- `hardhat@2.29.0` and `@nomicfoundation/hardhat-toolbox@5.0.0`: official
  Nomic Foundation repository; development-only toolchain.
- `ethers` is provided by the reviewed Hardhat toolbox dependency tree; no separate
  runtime wallet package is used by the contracts.
- `typescript@5.9.3`, `ts-node@10.9.2`, `chai@4.5.0`, `dotenv@16.4.5` were checked
  against their established upstream repositories and pinned exactly.

No GitHub dependency, `postinstall`, `preinstall`, native binary, `patch-package`
flow or downloaded third-party build artifact is used by this repository.

## Installation policy

Use `npm ci --ignore-scripts`. Review the generated lockfile and run
`npm audit --omit=dev --audit-level=high` before running any build. Do not use
`npm audit fix --force`. Any future package must be pinned, provenance-reviewed,
and added only with a lockfile diff and targeted compatibility tests.

## Remaining review

The complete transitive graph is only considered accepted after the first clean
`npm ci --ignore-scripts`, lockfile audit, `npm ls --all`, and production-only audit
are recorded in the release report. A passing compile alone is not a supply-chain
approval.

