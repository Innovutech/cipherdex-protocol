# Dependency and Supply-Chain Policy

CipherDEX treats the JavaScript build toolchain as part of the deployment trust
boundary even though it is not embedded in deployed bytecode.

## Pinned direct packages

Production dependencies are limited to:

- `@coti-io/coti-contracts@1.3.5`, from the official COTI package and repository;
- `@openzeppelin/contracts@5.4.0`, from the official OpenZeppelin package and
  repository.

The development toolchain uses exact versions of Hardhat 3 and only the official
plugins required by this repository:

- `hardhat@3.12.0`;
- `@nomicfoundation/hardhat-ethers@4.0.15`;
- `@nomicfoundation/hardhat-ethers-chai-matchers@3.0.11`;
- `@nomicfoundation/hardhat-mocha@3.1.0`;
- `@nomicfoundation/hardhat-typechain@3.0.0`;
- `ethers@6.17.0`, `solc@0.8.28`, `typescript@5.9.3`, `mocha@11.8.0`,
  `chai@5.3.3`, and the exact type packages in `package.json`.

The former Hardhat 2 toolbox graph was removed. Narrow lockfile overrides are
used only for patched compatible releases of `diff`, `glob`,
`serialize-javascript`, and `tmp`; `npm run verify` proves the resulting graph
and toolchain behavior.

## Installation and lifecycle policy

Use the committed lockfile and install with:

```bash
npm ci --ignore-scripts
```

The locked graph marks only `esbuild@0.28.2` and optional
`fsevents@2.3.3` as packages with install scripts. Those scripts are not executed
by the required installation command. The platform-specific esbuild binary is
locked as an optional package and the repository verifies that the installed
toolchain can compile and test without lifecycle execution. `fsevents` is an
optional macOS filesystem dependency and is not loaded on the supported Windows
or Linux deployment paths.

The repository has no `preinstall`, `install`, or `postinstall` script, GitHub
dependency, `patch-package` flow, or runtime download step. New dependencies,
new lifecycle scripts, native binaries, and new overrides require an explicit
provenance review before installation or execution.

## External Ledger signing tool

Mainnet deployment deliberately adds no Ledger npm dependency. The official
`@nomicfoundation/hardhat-ledger@3.0.10` graph was evaluated and rejected because
its legacy Ledger/native-HID graph retained unresolved high-severity advisories.
The newer official Ledger Device SDK Node HID transport was also rejected for
this boundary because it is still marked under development and does not declare
support for the repository's pinned Node 24 runtime. Neither graph was installed
or executed.

The reviewed alternative is the official immutable Foundry `cast@1.7.1` release:
<https://github.com/foundry-rs/foundry/releases/tag/v1.7.1>. It is installed
separately outside the repository after verifying the release archive checksum,
Sigstore/SLSA attestation and SBOM. The operator pins the extracted executable's
SHA-256 in the external deployment environment. CipherDEX requires the absolute
path, exact `1.7.1` version and digest, rejects repository/runtime-local binaries,
and rechecks the canonical path and executable bytes before every Ledger access.
The tool returns a signed raw transaction only; CipherDEX validates every bound
field and durably journals it before using the ordinary RPC broadcast boundary.

## Required verification

`npm run verify` fails unless all of the following pass:

1. production-only audit at every severity;
2. full operational dependency audit at every severity;
3. complete dependency-graph validation;
4. source-boundary, privacy-boundary, and security-boundary checks;
5. TypeScript type checking and Solidity compilation;
6. the complete local test suite.

Do not use `npm audit fix --force`, suppress an advisory, broaden an override, or
weaken a security check to make verification pass. A new advisory blocks release
until its exact path, reachability, and compatible remediation are reviewed.
