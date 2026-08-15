# Testnet Deployment

This repository intentionally exposes only the COTI testnet Hardhat network. There
is no mainnet deployment script or mainnet network entry.

1. Copy `.env.example` to `.env`.
2. Set `COTI_TESTNET_PRIVATE_KEY` for a funded testnet deployer.
3. Set `CIPHERDEX_FEE_BENEFICIARY` to the dedicated testnet fee recipient. The
   deployment creates one immutable `CipherDEXFeeVault` and binds both factories
   to it. A production beneficiary should be a reviewed multisig; it cannot be
   changed for deployed v1 pools.
4. Keep the two official COTI PrivateERC20-compatible token addresses and public
   decimals available for the separate scenario runner. The core deployment does
   not require token addresses because pool creation is permissionless.
5. Run `npm ci --ignore-scripts` after reviewing the lockfile.
6. Run `npm run verify`.
7. Run `npm run testnet:preflight`. The preflight intentionally skips contract
   compilation so missing configuration fails immediately. It verifies the configured chain, native
   testnet gas, token contract code/decimals, and caller-encrypted balance
   read/decrypt paths for the primary LP, second LP and quote identity. It does
   not print balances, ciphertexts, keys, or raw RPC payloads.
   `publicAmountsEnabled` is reported for awareness but is not a
   compatibility gate: the protocol uses COTI's encrypted token methods.
8. Run `npm run deploy:testnet`. This deploys the fee vault, confidential permissionless
   factory, its pool-bound LP-token deployer, the atomic encrypted launchpad
   migrator, binds that migrator as the factory's one-time bootstrap adapter,
   and deploys the public factory/quoter/router. It does not create a pool or
   move tokens. The factory bootstrap hooks remain disabled until that one-time
   adapter binding succeeds.
9. Set `COTI_DEPLOYMENT_RECORD=deployments/coti-testnet-latest.json` to have the
   script write an ignored JSON record containing public addresses, deployment
   transaction hashes, gas values, compiler settings, source commit and explicit
   limitations. The path is restricted to `deployments/*.json`. Do not commit
   private keys or private ciphertexts.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys, create a pool, or manufacture encrypted inputs. Use the
official COTI SDK and the documented scenario/launchpad harness for those operations.
