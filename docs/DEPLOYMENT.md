# Testnet Deployment

This repository intentionally exposes only the COTI testnet Hardhat network. There
is no mainnet deployment script or mainnet network entry.

1. Copy `.env.example` to a regular file in a dedicated directory outside this
   repository. Restrict the directory and file to the current OS identity plus
   the platform's SYSTEM/administrator identities before writing secrets. POSIX
   deployments require mode `0700` on the directory and `0600` on the file.
   Windows deployments must disable inheritance and grant full control only to
   the current SID, SYSTEM and Administrators. The funded launcher independently
   verifies ownership, ACL/mode, regular-file type, size and single-link status.
   Repository-local `.env` files are refused.
2. In that external file, set `COTI_TESTNET_PRIVATE_KEY` for a funded testnet
   deployer.
3. Set `CIPHERDEX_FEE_BENEFICIARY` to the dedicated testnet fee recipient. The
   deployment creates one immutable `CipherDEXFeeVault` and binds both factories
   to it. A production beneficiary should be a reviewed multisig; it cannot be
   changed for deployed pools.
   Set `CIPHERDEX_LAUNCH_AUTHORITY` to a distinct immutable launch-review
   authority. It must not be the deployer/creator identity used by funded launch
   tests.
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
6. Run `npm ci --ignore-scripts` after reviewing the lockfile, then run
   `npm run verify` and commit the complete reviewed source.
7. Extract `scripts/operator-funded-launcher.mjs` from that exact full commit
   with trusted system Git into an owner-only directory outside the repository.
   Verify the installed file's Git blob hash against
   `<commit>:scripts/operator-funded-launcher.mjs`. Do not run a launcher copied
   from the mutable working tree and do not expose funded secrets through ambient
   process variables.

   Every funded target uses this form (replace angle-bracket placeholders):

   ```text
   node <external-launcher> --repository <repository> --commit <40-hex-commit> --environment <absolute-private-env> --target <script.ts> -- --network cotiTestnet
   ```

   The external launcher uses built-ins and trusted system Git to authenticate
   the commit before importing repository code. It creates a fresh private
   checkout, runs `npm ci --ignore-scripts`, compiles without secrets, resolves
   internal package links into regular files, recursively validates owner-only
   storage, records a v2 build measurement, and only then permits the private
   runner to read the external environment. The private runner always uses
   `hardhat run --no-compile`. The runtime is deleted on success or failure.
8. Run the launcher with target `scripts/testnet-preflight.ts`. The preflight intentionally skips contract
   compilation so missing configuration fails immediately. It verifies the configured chain, native
   testnet gas, token contract code/decimals, and caller-encrypted balance
   read/decrypt paths for the primary LP and second LP, plus the separate quote
   probe identity. It does
   not print balances, ciphertexts, keys, or raw RPC payloads.
   `publicAmountsEnabled` is reported for awareness but is not a
   compatibility gate: the protocol uses COTI's encrypted token methods.
9. Run the launcher with target `scripts/deploy-testnet.ts`. This deploys the fee vault, attesting LP-token
   factory, factory-bound CREATE2 pool deployer, reviewed initialization-strategy
   registry, confidential factory, launch initialization strategy, launchpad
   migrator and bounded confidential best-execution router. It binds the vault,
   pool deployer and strategy registry to the factory; binds the migrator to the
   factory/strategy; registers the exact strategy runtime codehash; finalizes the
   registry; and finally binds the router. It then deploys the public
   factory/quoter/router. It does not
   create a pool or move tokens. Pool GT quote/settlement hooks remain inaccessible
   until the canonical router binding succeeds, and bootstrap hooks remain
   disabled until the strategy pins its migrator and the reviewed registry is
   finalized. The script fails before
    connecting or sending a transaction unless the Git worktree is clean and
    `HEAD` is a full commit.

Never invoke funded targets through `npm`, repository-local Node entry points or
`hardhat` directly. Those entry points are intentionally absent or fail closed.
Only schema-valid commit-bound deployment/evidence JSON crosses from the private
runtime into the public checkout, using bounded no-follow reads, exclusive
temporary files, fsync, atomic rename and descriptor-bound read-back validation.
Repository and signer/chain execution leases prevent concurrent funded runs,
and signer-global nonce reservations must reconcile every nonterminal local
transaction hash before another operation may be signed. A mined transaction is
terminal only after its sender, nonce, chain, hash, receipt, canonical block and
minimum confirmation depth are all independently corroborated.

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
    `COTI_BEST_EXECUTION_ROUTER` from that reviewed record and invoke the external
    launcher, in order, for `scripts/testnet-best-execution-feasibility.ts`,
    `scripts/testnet-best-execution.ts`, `scripts/testnet-fee-collection.ts`, and
    `scripts/testnet-launchpad.ts`. All four runners reject a dirty worktree,
    untracked or modified evidence, a record whose source commit is not an
    ancestor of `HEAD`, any post-source path other than the deployment record and
    verification report, and token instances absent from the reviewed record.
    They independently verify creation transactions, binding calls,
    compiler/runtime provenance and current on-chain relationships before any
    funded probe deployment or disposable canonical test-pool creation. The
    production-router runner deploys and cleans a separate runtime-verified
    stack; it never creates pools in or mutates the reviewed deployment. Each
    runner locally populates and signs every funded transaction, persists its
    deterministic hash and signed payload to an authenticated encrypted recovery
    journal in private OS-protected storage before the exact payload is handed to
    the RPC, and never automatically re-signs an uncertain operation. The
    signer-global coordinator stores only hash, nonce and status, never replayable
    signed bytes. Public evidence excludes signed payloads. Disposable
    resource creation is bound to the exact deployment manifest and owner-created
    receipt. A resource is recovered only after the journal identifies its mined
    cleanup transaction and a live chain read proves the terminal pool/probe
    state; launchpad allowance cleanup additionally requires exact private zero
    checks by the funded runner. Evidence is produced only after every resource
    and transaction outcome is reconciled. Private-token allowance grants are
    durable recovery obligations recorded before mutation and cannot be omitted
    from cleanup or evidence finalization. Deployments and one-time binding calls
    use the same local-hash-before-broadcast boundary.

13. Invoke the external launcher for `scripts/finalize-funded-evidence.ts` and
    then `scripts/verify-funded-suite-evidence.ts`. The suite
    requires exactly the feasibility, best-execution, fee-collection and
    launchpad records from the same source commit, chain, owner and deployment
    manifest. It rejects duplicate transaction hashes, changed runner source,
    unreviewed senders or targets, unresolved outcomes, and runtime-provenance
    mismatches.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys, create a pool, or manufacture encrypted inputs. Use the
official COTI SDK and the documented scenario/launchpad harness for those operations.

Public pools/factory report protocol version 2; confidential pools/factory report
version 3; the confidential best-execution router reports version 2; the
launchpad migrator reports version 4; and the pool deployer, strategy registry
and launch strategy report version 1. Integration allowlists must pin the
deployed factory, fee vault, pool deployer/codehash, finalized strategy registry,
registered strategy/codehash, migrator, configured router, all versions and the
complete canonical pool mapping. They should also verify that each confidential
token's current runtime codehash is approved by that exact factory and that every
pool LP token was issued by the recorded reviewed helper for that pool and
canonical factory.
