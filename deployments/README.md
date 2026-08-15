# Deployments

This directory is reserved for public, reviewed deployment records.

Do not commit private keys, AES keys, encrypted inputs, signatures, local
environment files, or unverified addresses here. Testnet deployment scripts
live under `scripts/` and print public addresses, transaction hashes, gas and
latency only. A release record should include:

- network and chain ID;
- compiler version, EVM target and optimizer settings;
- factory, pool, LP-token factory, launchpad migrator, public factory, quoter
  and router addresses;
- deployment transaction hashes and gas used;
- ABI/schema version and source commit;
- known limitations and independent-review status.

Generated deployment records remain ignored until they have been reviewed and
sanitized for publication.
