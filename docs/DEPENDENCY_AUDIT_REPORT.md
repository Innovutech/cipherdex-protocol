# Dependency Audit Report

Date: 2026-08-16

## Baseline

- Node: `v24.16.0`
- npm: `11.13.0`
- install procedure: `npm ci --ignore-scripts`
- production audit: `0` vulnerabilities (`npm audit --omit=dev --audit-level=high`)
- production dependency graph: `npm ls --omit=dev --all` passes
- full graph audit: `46` findings (`0` critical, `17` high, `10` moderate,
  `19` low)

## Production disposition

The production graph contains only the official COTI contracts/runtime dependency
tree, OpenZeppelin contracts and dotenv. No production critical or high advisory
was reported. The vulnerable packages listed below are development-only Hardhat,
coverage, verification or compiler tooling and are not bundled into deployed
contracts or the testnet deployment runtime.

This is not an ignore file. The findings remain visible in the full audit and are
re-evaluated by the production audit on every verification run.

## High findings in the development graph

| Surface | Path / advisory evidence | Disposition |
| --- | --- | --- |
| `hardhat@2.29.0` | Old Hardhat graph includes `adm-zip` (`GHSA-xcpc-8h2w-3j85`), `undici` high advisories, `uuid` range, and `solc -> tmp` (`GHSA-ph9p-34f9-6g65`) | Dev/build-only; no forced major upgrade. Migrate to Hardhat 3 only as a separate compatibility project. |
| `@nomicfoundation/hardhat-toolbox@5.0.0` | Pulls the vulnerable Hardhat plugin set and `hardhat-gas-reporter`/`solidity-coverage` | Dev/test-only. No runtime import. |
| `@nomicfoundation/hardhat-chai-matchers` | High surfaced through the old Hardhat plugin graph | Dev/test-only; covered by the Hardhat 3 migration decision. |
| `@nomicfoundation/hardhat-ethers` | High surfaced through the old Hardhat plugin graph | Dev/test-only; no application runtime use. |
| `@nomicfoundation/hardhat-ignition` and `@nomicfoundation/hardhat-ignition-ethers` | High surfaced through the old Hardhat/verification graph | Not imported by this repository; retained only by the toolbox dependency set. |
| `@nomicfoundation/hardhat-network-helpers` | High surfaced through the legacy EthereumJS helper graph | Test-only; not used in deployment runtime. |
| `@nomicfoundation/hardhat-verify` | High surfaced through old `undici` and legacy ethers packages | Not enabled in the project config; dev-only transitive package. |
| `@typechain/hardhat` | High surfaced through the toolbox graph | Type generation only; not runtime. |
| `adm-zip` | `GHSA-xcpc-8h2w-3j85`, crafted archive memory allocation; reachable through Hardhat | Hardhat build tooling only; do not process untrusted archives in build jobs. |
| `hardhat-gas-reporter` | High surfaced by the old toolbox graph | Not configured or used. Dev-only. |
| `lodash` | `GHSA-r5fr-rjxr-66jc` plus prototype-pollution advisories through Ignition | Dev-only transitive dependency. No untrusted input reaches the protocol build. |
| `serialize-javascript` | `GHSA-5c6j-r48x-rmvq` through Mocha/coverage | Test-only; tests do not serialize untrusted input. |
| `solidity-coverage` | High surfaced by old coverage/toolbox dependencies | Not configured or run. Dev-only. |
| `tmp` | `GHSA-ph9p-34f9-6g65` through `solc` | Compiler/build-only; `npm ci --ignore-scripts` and isolated build environment are required. |
| `undici` | `GHSA-vrm6-8vpv-qv8q`, `GHSA-v9p9-hfj2-hcw8`, `GHSA-vxpw-j846-p89q` and related advisories | Hardhat verification/build tooling only; not the protocol runtime. |
| `ws` | `GHSA-96hv-2xvq-fx4p` on nested legacy ethers provider | Vulnerable copy is dev-only. The production graph resolves `ws@8.21.0`. |

The audit's package-level high count is therefore not evidence that deployed pool
bytecode contains these JavaScript packages. It is still a release-process risk,
which is why the build must run with lifecycle scripts disabled and the full graph
must remain recorded rather than hidden.

## Lifecycle and native binary review

The installed graph was inspected without executing lifecycle scripts. The only
`install` scripts found were:

- `keccak@3.0.4`: `node-gyp-build || exit 0`
- `secp256k1@4.0.5`: `node-gyp-build || exit 0`

They are development-only transitive packages. The mandated install command is
`npm ci --ignore-scripts`; no package's postinstall/preinstall is needed by the
protocol build. No GitHub dependency or downloaded external build tool is present
in the manifest.

## Remediation policy

No broad override or advisory suppression was added. A future Hardhat 3 migration
must be reviewed separately because it changes the configuration/plugin model and
would affect the build toolchain. Production deployment remains blocked if the
production-only audit reports a new critical or high advisory.
