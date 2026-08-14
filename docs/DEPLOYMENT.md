# Testnet Deployment

This repository intentionally exposes only the COTI testnet Hardhat network. There
is no mainnet deployment script or mainnet network entry.

1. Copy `.env.example` to `.env`.
2. Set `COTI_TESTNET_PRIVATE_KEY` for a funded testnet deployer.
3. Set two deployed official COTI PrivateERC20-compatible token addresses and their
   public decimals.
4. Run `npm ci --ignore-scripts` after reviewing the lockfile.
5. Run `npm run verify`.
6. Run `npm run deploy:testnet`.
7. Record the pool address, compiler settings, deployment transaction hash, gas and
   testnet RPC used in a local release record. Do not commit private keys or private
   ciphertexts.

The deploy script prints only public contract configuration. It does not onboard
accounts, handle AES keys or manufacture encrypted inputs. Use the official COTI
SDK and a separate reviewed test harness for those operations.

