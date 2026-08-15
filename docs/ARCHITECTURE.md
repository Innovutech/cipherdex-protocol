# Architecture

## Layers

- `contracts/ConfidentialCPMM.sol`: immutable pair, fee policy, private reserve
  math, swap execution and private LP share accounting.
- `contracts/ConfidentialCPMMFactory.sol`: permissionless deterministic pool
  creation and public pool discovery.
- `contracts/PrivateLPToken.sol`: pool-bound encrypted LP-share token using the
  official COTI `PrivateERC20` implementation.
- `contracts/PrivateLPTokenFactory.sol`: factory-owned deployer that keeps the
  COTI token creation bytecode out of the canonical CPMM factory runtime.
- `contracts/PublicCPMM.sol`: ordinary public/public ERC-20 CPMM with public
  amounts, fees, swaps, liquidity accounting and locks.
- `contracts/PublicCPMMFactory.sol`: separate public/public pool registry.
- `contracts/PublicCPMMQuoter.sol`: factory-gated read-only quotes for public
  pools.
- `contracts/PublicCPMMRouter.sol`: factory-gated exact-input routing for
  public pools only.
- `contracts/ConfidentialLaunchpadMigrator.sol`: atomic creator-signed pool
  creation/selection, encrypted allowance pulls and price-bounded bootstrap.
- `contracts/interfaces/`: stable ABI surface for clients and future factory/router
  work.
- `sdk/`: dependency-free ABI fragments and privacy-minimal discovery types for
  dashboards, launchpads and third-party integrations.
- `scripts/`: explicit COTI testnet deployment only.
- `test/`: construction/ABI guards plus a clearly gated COTI integration harness.
- `docs/`: privacy, threat, dependency and operational constraints.

## Pool model

The on-chain `PRIVACY_MODE` constant and SDK discovery field make disclosure
explicit: `0` is the transparent public/public mode and `1` is the
amount-confidential/private-LP mode. A future fully confidential mode is not
represented as an enabled value; recipient and participant addresses remain
public under the official PrivateERC20 interface.

The pool is a non-custodial pair of official COTI PrivateERC20-compatible assets.
It reads actual pool balances as MPC values rather than maintaining a second public
reserve ledger. This avoids a public duplicate of confidential reserves.
The first ordinary liquidity add requires both pre-existing reserves to be zero,
and launchpad bootstrap requires the post-transfer balances to equal the signed
seed values exactly; unsolicited private-token donations cannot alter the initial
share or price relationship.

The swap formula is:

`netIn = floor(amountIn * (10000 - feeBps) / 10000)`

`newReserveOut = ceil(reserveIn * reserveOut / (reserveIn + netIn))`

`amountOut = reserveOut - newReserveOut`

Every intermediate value is an MPC value. The retained reserve rounds upward so
the output rounds down and cannot create value through integer rounding. Checked
operations reject overflow or underflow via boolean outcomes; no amount is
decrypted for validation. State-changing operations also carry a caller-chosen
deadline to prevent stale encrypted quotes from executing.

Pool construction also verifies each token's public `decimals()` response and
rejects non-contract or incompatible metadata before storing normalization
scales. The factory remains permissionless, but it cannot create a pool whose
declared decimals silently disagree with the token contract.

## LP accounting

LP shares are ciphertext stored in aggregate by the pool. Factory-created pools
also mint a pool-bound `PrivateLPToken` for each provider, so the encrypted share
position can use the official COTI transfer and approval paths. The pool remains
the only minter/burner. Directly deployed pools retain the internal ledger as a
backward-compatible deployment mode. Initial liquidity is required to be balanced
after decimal normalization. Subsequent deposits mint the minimum proportional
share and transfer only the exact proportional amounts, so surplus input is not
silently donated. Full exits withdraw the full private reserve values to avoid
rounding dust.

The share formula is intentionally conservative and should not be treated as a
finished economic design until testnet benchmarks and independent review confirm
its rounding and fairness properties.

LP shares can be moved into a pool-enforced timelock or irreversible permanent
lock. Lock metadata is public, but the locked share amount remains ciphertext. A
permanent lock is excluded from provider balances and cannot be released by an
administrator or the original provider.

The LP token deliberately does not expose a public circulating supply: the base
COTI `PrivateERC20` implementation returns zero for aggregate `totalSupply()`.
Dashboards must not infer private TVL or aggregate LP supply from that method.

## Explicit non-goals

- no concentrated liquidity in the first protocol version;
- no assumption that public/public and confidential pools share event or balance
  disclosure; their pool kinds are explicit in discovery metadata;
- no COTI PoD assets in the synchronous pool;
- no mainnet deployment;
- no admin withdrawal or mutable fee authority;
- no dependency on CipherTools, CipherTrade, a centralized API or an indexer;
- no promise of hidden recipient addresses under the standard PrivateERC20 events.

## Router boundary

`PublicCPMMRouter` is intentionally limited to factory-registered ordinary
ERC-20 pools. It temporarily holds the caller's public input, calls the pool,
and forwards the public output; it has no admin withdrawal or token rescue path.
The public quoter applies the same factory gate.

Confidential pools are still called directly. COTI authenticated `itUint256`
inputs bind the sender, target contract and function selector. A generic router
that simply forwards an input would change `msg.sender` at the pool and
invalidate the signature; a router that accepts the original user as an
unchecked parameter would weaken that binding. Private routing therefore needs
an official, reviewed delegation primitive, not a forwarding wrapper.

## Launchpad migration boundary

The launchpad path does not forward authenticated inputs. The creator signs all
five encrypted values for the migrator's exact selector. The migrator validates
them, calls the official `transferFromGT` function under explicit encrypted
allowances, and then calls the factory's pool bootstrap hook with the resulting MPC
values. The pool verifies its actual private balances and encrypted normalized
price bounds before setting its initial reserves/shares. Any failure reverts the
whole transaction, including the token pulls.

The bootstrap path is restricted to factory-created empty pools and cannot be used
to withdraw or mutate an initialized pool. The initial share unit is the minimum
of the normalized private deposits, while full exit remains reserve-complete.
The launchpad can select creator-held, timed-lock, or permanent-lock disposition
as part of the same bootstrap transaction. A locked bootstrap records the private
share amount directly in the pool lock and does not mint it to the creator; timed
unlock later mints the amount, while permanent disposition never does.

## Public/public boundary

`PublicCPMM` uses standard ERC-20 transfers and exposes public settlement amounts.
It requires exact proportional deposits after measuring the actual received token
amounts, which rejects fee-on-transfer mismatch instead of silently donating
assets. It uses OpenZeppelin full-precision multiplication/division and rounds
the retained reserve upward, matching the confidential invariant convention.
