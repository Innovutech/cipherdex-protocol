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
9. Run `npm run deploy:testnet`. This deploys the fee vault, the stateless
   pool-bound LP-token deployer, the confidential permissionless factory with its
   immutable private-token runtime-codehash policy, the factory-bound
   confidential best-execution router, and the atomic encrypted launchpad
   migrator. It binds the router and migrator through separate one-time factory
   configuration calls and deploys the public factory/quoter/router. It does not
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
   transaction hashes, gas values, compiler settings, source commit and explicit
   limitations. Every deployed contract also records its observed runtime
   codehash. The path is restricted to `deployments/*.json`. Do not commit
   private keys or private ciphertexts. The public record includes the reviewed
   token addresses and approved runtime codehashes so integrations can audit the
   factory boundary. A reviewed, sanitized authoritative testnet record may be
   force-added to source control so SDK consumers share one provenance record;
   never add an unreviewed generated record.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys, create a pool, or manufacture encrypted inputs. Use the
official COTI SDK and the documented scenario/launchpad harness for those operations.

The public and confidential pools/factories report protocol version 2, the
confidential best-execution router reports version 1, and the launchpad migrator
reports version 3. Integration allowlists must pin the deployed factory, its
configured router, fee vault, protocol versions and canonical pool mapping. They
should also verify that each confidential token's current runtime codehash is
approved by that exact factory.
