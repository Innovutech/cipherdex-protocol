# Testnet Deployment

This repository intentionally exposes only the COTI testnet Hardhat network. There
is no mainnet deployment script or mainnet network entry.

1. Copy `.env.example` to `.env`.
2. Set `COTI_TESTNET_PRIVATE_KEY` for a funded testnet deployer.
3. Keep the two official COTI PrivateERC20-compatible token addresses and public
   decimals available for the separate scenario runner. The core deployment does
   not require token addresses because pool creation is permissionless.
4. Run `npm ci --ignore-scripts` after reviewing the lockfile.
5. Run `npm run verify`.
6. Run `npm run deploy:testnet`. This deploys the confidential permissionless
   factory, its pool-bound LP-token deployer, the atomic encrypted launchpad
   migrator, and the public factory/quoter/router. It does not create a pool or
   move tokens.
7. Record every printed public address, deployment transaction hash, gas value,
   compiler settings, and testnet RPC in a local release record. Do not commit
   private keys or private ciphertexts.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys, create a pool, or manufacture encrypted inputs. Use the
official COTI SDK and the documented scenario/launchpad harness for those operations.
