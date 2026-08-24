# Deployment

## COTI mainnet deployment

The mainnet deployment path reuses the same factories, bindings, runtime-codehash
checks, receipt reconciliation and commit-bound record writer as testnet. Hardhat
does not configure a mainnet account. The authenticated runner requires exactly
one signer mode: a Ledger through a separately installed, hash-pinned Foundry
`cast` v1.7.1 binary, or `COTI_MAINNET_PRIVATE_KEY`. Both modes populate the
transaction locally, validate signer, chain, nonce, destination, calldata, value,
gas limit and fee envelope, persist the deterministic signed transaction before
broadcast, and block blind retries after an uncertain submission. The deployer
receives no lasting protocol role.

An external audit is recommended but is not an executable deployment gate. The
deployment record explicitly retains the current review status so it cannot be
mistaken for an audited release.

1. Review and commit the exact source to deploy. Do not deploy a dirty worktree.
   Record the full 40-character commit.
2. For Ledger mode, install Foundry `v1.7.1` outside this repository from the immutable official
   release at <https://github.com/foundry-rs/foundry/releases/tag/v1.7.1>.
   Verify the release archive's published SHA-256, Sigstore/SLSA attestation and
   SBOM before extraction. Do not use `foundryup` or an unpinned latest release
   for production deployment. Compute the SHA-256 of the extracted `cast`
   executable; that executable digest is the value of `CIPHERDEX_CAST_SHA256`.
   Skip this step for private-key mode.
3. Create a new owner-only external file. The recommended Windows location is
   `C:\Users\<user>\.cipherdex\funded\coti-mainnet.env`; the recommended POSIX
   location is `$HOME/.cipherdex/funded/coti-mainnet.env`. Do not reuse the
   testnet file, place the file in this repository, use a symlink/hardlink, or
   expose these values as ambient shell variables.
4. Put only the following deployment configuration in that file:

   ```text
   COTI_MAINNET_RPC_URL=https://mainnet.coti.io/rpc
   COTI_MAINNET_GAS_LIMIT=30000000
   COTI_DEPLOYMENT_RECORD=deployments/coti-mainnet-<40-character-commit>.json
   CIPHERDEX_MAINNET_APPROVED_COMMIT=<40-character-commit>
   COTI_MAINNET_PRIVATE_KEY=
   CIPHERDEX_LEDGER_ADDRESS=
   CIPHERDEX_LEDGER_DERIVATION_PATH=m/44'/60'/0'/0/0
   CIPHERDEX_CAST_PATH=
   CIPHERDEX_CAST_SHA256=
   CIPHERDEX_DEPLOYMENT_RECOVERY_KEY=<0x-prefixed-32-byte-random-key>
   CIPHERDEX_FEE_BENEFICIARY=<dedicated-fee-vault-beneficiary>
   ```

   Fill exactly one of `COTI_MAINNET_PRIVATE_KEY` or
   `CIPHERDEX_LEDGER_ADDRESS`. In Ledger mode, also fill the derivation path and
   reviewed `cast` path/digest. In private-key mode, leave every Ledger/cast value
   empty. The fee beneficiary is the only lasting beneficiary role and should be
   a reviewed multisig where practical; it may equal the deployer but need not.
   `CIPHERDEX_DEPLOYMENT_RECOVERY_KEY` only encrypts the local durable
   transaction-recovery journal; it cannot sign or spend. Generate it with an OS
   cryptographic RNG and do not reuse a wallet private key or COTI AES key.
5. Do not add `COTI_TESTNET_PRIVATE_KEY` or a COTI AES key. Deployment does not onboard an account or construct/decrypt private
   token inputs, so AES material is neither required nor loaded. Keep any later
   confidential operational wallet configuration in a different external file.
6. Install `scripts/operator-funded-launcher.mjs` from the exact approved commit
   into owner-only storage, following the authenticated extraction procedure in
   the testnet section below. In Ledger mode, connect and unlock the Ledger and
   open its Ethereum application.
7. Run the transaction-free preflight first:

   ```text
   node <external-launcher> --repository <repository> --commit <commit> --environment <absolute-mainnet-env> --target scripts/mainnet-preflight.ts -- --network cotiMainnet
   ```

   It validates the clean approved commit, chain ID `2632500`, record path,
   selected signer identity and native COTI gas budget. Ledger mode also validates
   the external `cast` identity and device-derived address. Private-key mode only
   derives the address locally. The preflight signs and sends no transaction.
8. Only after reviewing the preflight output, run the deployment target:

   ```text
   node <external-launcher> --repository <repository> --commit <commit> --environment <absolute-mainnet-env> --target scripts/deploy-mainnet.ts -- --network cotiMainnet
   ```

   In Ledger mode, review every device screen and cancel if the chain, value, or
   operation is unexpected. An uncertain broadcast is retained in the encrypted recovery
   journal and blocks another signature; never blindly retry or start a second
   deployment.
9. Review every public address, transaction, constructor argument, binding and
   runtime codehash in `deployments/coti-mainnet-<commit>.json` against COTI Scan
   and the source. Then force-add only that record plus the public verification
   report in a separate evidence commit. Source code is never amended to
   hard-code deployed addresses.

## COTI testnet deployment and funded validation

The existing funded testnet deployment target remains supported and uses a separate
external environment. On the current Windows workstation that file is
`C:\Users\Acer\.cipherdex\funded\coti-testnet.env`; its values are intentionally
not present in `.env.example` or Git.

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
   changed for deployed pools. There is no launch-authority setting.
4. Confidential factory deployment does not require sample token addresses or an
   external-token codehash policy. Set `COTI_TOKEN0` and `COTI_TOKEN1` only for
   funded test scenarios. Pool creation accepts any deployed contract that
   reports the official COTI `IPrivateERC20` interface and valid matching
   decimals. This is structural compatibility, not protocol approval or an
   economic-safety guarantee.
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
   checkout, runs `npm ci --ignore-scripts` with its npm cache inside the
   disposable runtime, compiles without secrets, resolves
   internal package links into regular files, recursively validates owner-only
   storage, records a v2 build measurement, and only then permits the private
   runner to read the external environment. The private runner always uses
   `hardhat run --no-compile`. The launcher provisions a stable owner-only,
   repository-scoped recovery directory outside the checkout and passes it as a
   non-overridable runner boundary. The runtime is deleted on success or failure,
   while encrypted recovery journals and immutable sanitized run evidence survive
   for reconciliation, evidence retry, and asset cleanup. The launcher promotes
   only the expected schema-valid public evidence record before deleting the
   runtime and rejects private fields, links, oversized files or changed durable
   records. Do not manually delete that recovery directory while any run is
   nonterminal.
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
   private keys or private ciphertexts. The factory constructor and public record
   contain no sample-token addresses or external-token runtime codehashes. A
   reviewed, sanitized authoritative testnet record may be
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
    journal in stable private OS-protected storage outside the disposable runtime
    before the exact payload is handed to the RPC, and never automatically
    re-signs an uncertain operation. The
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

If a terminal encrypted journal predates durable evidence promotion,
`scripts/rematerialize-funded-evidence.ts` is the transaction-free recovery path.
It accepts only the immutable manifest creation commit, requires every original
funded runner to remain byte-identical to the deployed source, opens only terminal
journals, reconciles receipts and zero-residue state, and regenerates exactly the
four sanitized run records. The launcher then promotes those immutable records to
the private recovery evidence directory. The finalizer stages records from that
directory by deployment source commit. Rematerialization never signs, sends or
rebroadcasts a transaction and is not a substitute for running a missing funded
scenario.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys, create a pool, or manufacture encrypted inputs. Use the
official COTI SDK and the documented scenario/launchpad harness for those operations.

All unreleased protocol components and the discovery schema report version 1.
Development changes do not create compatibility generations. Integration
allowlists must pin the
deployed factory, fee vault, pool deployer/codehash, finalized strategy registry,
registered strategy/codehash, migrator, configured router, all versions and the
complete canonical pool mapping. They should also verify that each confidential
token passes `isCompatiblePrivateToken` on that exact factory and that every pool
LP token was issued by the recorded reviewed helper for that pool and canonical
factory. Compatibility is not token reputation; external token semantics remain
a pool-level trust decision.
