# Testnet Deployment

This repository intentionally exposes only the COTI testnet Hardhat network. There
is no mainnet deployment script or mainnet network entry.

1. Copy `.env.example` to `.env`.
2. Set `COTI_TESTNET_PRIVATE_KEY` for a funded testnet deployer.
3. Set `CIPHERDEX_FEE_BENEFICIARY` to the dedicated testnet fee recipient. The
   deployment creates one immutable `CipherDEXFeeVault` and binds both factories
   to it. A production beneficiary should be a reviewed multisig; it cannot be
   changed for deployed pools.
4. Set `COTI_TOKEN0` and `COTI_TOKEN1` to reviewed deployed COTI
   PrivateERC20-compatible implementations. The deployment derives their runtime
   codehashes and installs those hashes as the confidential factory's immutable
   token-implementation policy. `CIPHERDEX_PRIVATE_TOKEN_CODEHASHES` may add an
   explicitly reviewed comma-separated set, but it must include both configured
   token hashes. Do not approve mutable proxy or metamorphic implementations.
   Supporting a new implementation requires a reviewed fresh factory deployment;
   existing pools and factories are never mutated.
5. Set `COTI_DEPLOYMENT_RECORD=deployments/coti-testnet-<full-git-commit>.json`,
   replacing the placeholder with the exact clean 40-character `HEAD` being
   deployed. The deploy command fails before network access if the path is
   missing, escapes `deployments/`, already exists, or names a different commit.
6. Run `npm ci --ignore-scripts` after reviewing the lockfile.
7. Run `npm run verify`.
8. Run `npm run testnet:preflight`. The preflight intentionally skips contract
   compilation so missing configuration fails immediately. It verifies the configured chain, native
   testnet gas, token contract code/decimals, and caller-encrypted balance
   read/decrypt paths for the primary LP and second LP, plus the separate quote
   probe identity. It does
   not print balances, ciphertexts, keys, or raw RPC payloads.
   `publicAmountsEnabled` is reported for awareness but is not a
   compatibility gate: the protocol uses COTI's encrypted token methods.
9. Run `npm run deploy:testnet`. This deploys the fee vault, the attesting
   pool-bound LP-token deployer, the confidential permissionless factory with its
   immutable private-token runtime-codehash policy, the factory-bound
   confidential best-execution router, and the atomic encrypted launchpad
   migrator. It binds the vault to the confidential factory, then binds the
   router and migrator through separate one-time configuration calls and deploys
   the public factory/quoter/router. It does not
   create a pool or move tokens. Pool GT quote/settlement hooks remain inaccessible
   until the canonical router binding succeeds, and bootstrap hooks remain
   disabled until the adapter binding succeeds. The script fails before
    connecting or sending a transaction unless the Git worktree is clean and
    `HEAD` is a full commit.

Use the documented npm commands rather than invoking their underlying
`hardhat run --no-compile` targets directly. The commands use an allowlisted
process runner that completes `hardhat clean` and `hardhat compile` before a
separate process loads the deployment or funded-runner module. This prevents
module initialization or imported helpers from observing stale artifacts.

10. The script writes a unique commit-bound JSON record at the required
   `COTI_DEPLOYMENT_RECORD` path containing public addresses, deployment
   transaction hashes, gas values, constructor arguments, binding calldata, compiler
   settings, source commit and explicit limitations. Every deployed contract also
   records its observed runtime codehash. The verifier independently retrieves
   every transaction and receipt, matches exact reviewed creation bytecode or
   binding calldata, requires unique successful hashes and gas values, and reads
   the resulting on-chain relationships. The path is restricted to
   `deployments/*.json`. Do not commit
   private keys or private ciphertexts. The public record includes the reviewed
   token addresses and approved runtime codehashes so integrations can audit the
   factory boundary. A reviewed, sanitized authoritative testnet record may be
   force-added to source control so SDK consumers share one provenance record;
   never add an unreviewed generated record.

11. Review the complete record against the deployment output and RPC receipts.
    Update `docs/VERIFICATION_REPORT.md` with only public evidence, then create a
    separate evidence commit containing exactly those two paths. Do not amend the
    deployed source commit and do not include executable changes in the evidence
    commit.

12. Configure `COTI_FACTORY`, `COTI_FEE_VAULT` and
    `COTI_BEST_EXECUTION_ROUTER` from that reviewed record and run, in order,
    `npm run testnet:best-execution-feasibility`,
    `npm run testnet:best-execution`, `npm run testnet:fee-collection`, and
    `npm run testnet:launchpad`. All four runners reject a dirty worktree,
    untracked or modified evidence, a record whose source commit is not an
    ancestor of `HEAD`, any post-source path other than the deployment record and
    verification report, and token instances absent from the reviewed record.
    They independently verify creation transactions, binding calls,
    compiler/runtime provenance and current on-chain relationships before any
    funded probe deployment or disposable canonical test-pool creation. The
    production-router runner deploys and cleans a separate runtime-verified
    stack; it never creates pools in or mutates the reviewed deployment. Each
    runner writes a private-permission recovery journal before using disposable
    resources, binds resource creation to the exact deployment manifest and
    owner-created receipt, and produces evidence only after all resources have
    been recovered.

13. Run `npm run evidence:finalize` and `npm run evidence:verify`. The suite
    requires exactly the feasibility, best-execution, fee-collection and
    launchpad records from the same source commit, chain, owner and deployment
    manifest. It rejects duplicate transaction hashes, changed runner source,
    unreviewed senders or targets, unresolved outcomes, and runtime-provenance
    mismatches.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys, create a pool, or manufacture encrypted inputs. Use the
official COTI SDK and the documented scenario/launchpad harness for those operations.

The public and confidential pools/factories report protocol version 2, the
confidential best-execution router reports version 1, and the launchpad migrator
reports version 3. Integration allowlists must pin the deployed factory, its
configured router, fee vault, protocol versions and canonical pool mapping. They
should also verify that each confidential token's current runtime codehash is
approved by that exact factory and that every pool LP token was issued by the
recorded reviewed helper for that pool and canonical factory.
