# Deployments

This directory is reserved for public, reviewed deployment records.

Do not commit private keys, AES keys, encrypted inputs, signatures, local
environment files, or unverified addresses here. Testnet and optional Ledger or
private-key mainnet deployment scripts live under `scripts/` and print public addresses,
transaction hashes, gas and latency only. A release record should include:

- network and chain ID;
- compiler version, EVM target and optimizer settings;
- confidential factory, its configured best-execution router, pool deployer,
  LP-token factory, finalized initialization-strategy registry, registered launch
  strategy, constructor-created launchpad migrator, public factory, quoter and
  router addresses;
- deployment transaction hashes, receipts, exact constructor arguments and gas used;
- one-time vault/factory, pool-deployer/factory, strategy-registry/factory,
  strategy registration/finalization and best-router binding targets, arguments
  and transaction hashes;
- ABI/schema version and source commit;
- known limitations and independent-review status.

New confidential-factory records contain no external-token address list or
token runtime-codehash list. Historical testnet manifests retain those fields
only because they are exact evidence for superseded factories whose constructor
did enforce that policy; rewriting their recorded constructor arguments would
invalidate the evidence. They are not a current admission policy or supported
deployment surface.

Generated deployment records remain ignored until they have been reviewed and
sanitized for publication. Funded verification commands must not trust that
mutable generated file. After review:

1. update `docs/VERIFICATION_REPORT.md` with the public deployment evidence;
2. stage only that report and the completed record with
   `git add docs/VERIFICATION_REPORT.md` and
   `git add -f deployments/coti-testnet-<commit>.json` for testnet or
   `git add -f deployments/coti-mainnet-<commit>.json` for mainnet. Public-only
   replacement records use the corresponding narrow
   `coti-<network>-public-<commit>.json` namespace;
3. create a separate evidence commit after the source commit used for
   deployment; and
4. run funded verification only from a clean checkout of that evidence commit.

The verifier requires the configured record to match the tracked blob at
`HEAD`, requires its `sourceCommit` to be an ancestor of `HEAD`, and rejects
every post-source change except that exact manifest and
`docs/VERIFICATION_REPORT.md`. This two-commit model avoids the impossible
self-reference that would result from requiring a generated manifest to be
contained in the same commit named by its `sourceCommit`.

Verification retrieves the complete manifest-declared deployment and one-time
binding transaction sets from the configured chain; it does not rely on a stale
hard-coded count. It rejects a missing, duplicate, failed or extra transaction;
mismatched gas/address/receipt; creation data that differs from the reviewed
artifact plus canonical constructor arguments; constructor-child migrator
provenance that does not match its strategy deployment; binding calldata that
differs from the expected target/function/args; or final contract relationships
that do not match the manifest.
