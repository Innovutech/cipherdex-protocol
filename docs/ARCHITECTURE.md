# Architecture

## Layers

- `contracts/ConfidentialCPMM.sol`: immutable pair, fee policy, private reserve
  math, swap execution and private LP share accounting.
- `contracts/ConfidentialCPMMFactory.sol`: permissionless deterministic manual
  pool creation plus an adapter-only, creator-scoped launchpad pool namespace.
- `contracts/PrivateLPToken.sol`: pool-bound encrypted LP-share token using the
  official COTI `PrivateERC20` implementation.
- `contracts/PrivateLPTokenFactory.sol`: factory-owned deployer that keeps the
  COTI token creation bytecode out of the canonical CPMM factory runtime.
- `contracts/PublicCPMM.sol`: ordinary public/public ERC-20 CPMM with public
  amounts, fees, swaps, liquidity accounting and locks.
- `contracts/PublicCPMMFactory.sol`: separate public/public pool registry.
- `contracts/CipherDEXFeePolicy.sol`: immutable approved v1 total-fee tiers and
  LP/protocol split shared by both pool modes.
- `contracts/CipherDEXFeeVault.sol`: immutable protocol-fee destination with
  mode-separated public/private sweeps and delayed private aggregation.
- `contracts/PublicCPMMQuoter.sol`: factory-gated read-only quotes for public
  pools.
- `contracts/PublicCPMMRouter.sol`: factory-gated exact-input routing for
  public pools only.
- `contracts/ConfidentialLaunchpadMigrator.sol`: atomic creator-signed pool
  creation/selection, encrypted allowance pulls and price-bounded bootstrap.
- `contracts/interfaces/`: stable ABI surface for clients and future factory/router
  work.
- `periphery/`: documented boundary for routing, quoter and future adapters;
  current public periphery contracts remain under `contracts/` for shared
factory-gate compilation.

Protocol-owned public input fees are tracked per token and subtracted from raw
balances before quoting, liquidity accounting, and invariant checks. LP exits
cannot claim them, and moving them to the fixed vault leaves effective reserves
unchanged.
- `deployments/`: sanitized public deployment-record boundary; secrets and
  unreviewed generated records are excluded.
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
It maintains encrypted protocol-accounting reserves rather than a public reserve
ledger or a raw-balance price oracle. Compatible token transfers revert
atomically on failure. Unsolicited private-token donations remain outside the
accounting reserves and cannot alter price or LP claims. The first ordinary
liquidity add requires both accounting reserves to be zero; the first LP may
establish any non-zero normalized token ratio.

The swap formula is:

`netIn = floor(amountIn * (10000 - feeBps) / 10000)`

`newReserveOut = ceil(reserveIn * reserveOut / (reserveIn + netIn))`

`amountOut = reserveOut - newReserveOut`

Every intermediate value is an MPC value. The retained reserve rounds upward so
the output rounds down and cannot create value through integer rounding. Checked
operations reject overflow or underflow via boolean outcomes; no amount is
decrypted for validation. State-changing operations also carry a caller-chosen
deadline to prevent stale encrypted quotes from executing.

The fee deducted by this formula is the complete advertised swap fee. One sixth
of its integer-rounded value accrues to the protocol and the remainder stays in
effective reserves for LPs. There is no additional native-COTI swap payment.
Public pools track each token's protocol fees in public counters; confidential
pools use encrypted counters. Both collect only to an immutable fee vault, and
collection never changes effective reserves or price. See `FEE_ECONOMICS.md`.

Exact private quotes remain caller-encrypted. The core pool exposes no public
reserve, TVL, spot-price, TWAP, or exact-quote getter. Public market data would
be an intentional disclosure and therefore belongs, if ever added, in a
separately reviewed optional oracle rather than the settlement pool.

Pool construction also verifies each token's public `decimals()` response and
rejects non-contract or incompatible metadata before storing normalization
scales. The factory remains permissionless, but it cannot create a pool whose
declared decimals silently disagree with the token contract.

## LP accounting

LP shares are ciphertext stored in aggregate by the pool. Factory-created pools
also mint a pool-bound `PrivateLPToken` for each provider, so the encrypted share
position can use the official COTI transfer and approval paths. The pool remains
the only minter/burner. Directly deployed pools retain the internal ledger as a
backward-compatible deployment mode. Initial shares equal the smaller of the two
18-decimal-normalized deposits. This supports an arbitrary non-zero initial price,
avoids an overflow-prone encrypted product and square-root loop, and does not
change ownership because the first LP receives 100% of issued shares. Subsequent
deposits round shares down and accepted reserve contributions up, so a joining LP
cannot dilute existing holders. The pool transfers only those accepted
proportional amounts, so surplus input is not silently donated. Full exits
withdraw the full private reserve values to avoid rounding dust.

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
- no extra native-COTI fee on swaps and no v1 pool-creation fee;
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

Off-chain routing does not require a protocol router. A quote service may use a
dedicated onboarded COTI identity and AES key to request the same logical input
against each canonical fee-tier candidate, decrypt the results only in process,
and select the largest output. The current testnet uses encrypted transaction
result events; a compatible future RPC may execute the same MPC path under
`eth_call`. The service never holds funds or signs swaps. The user must
re-encrypt fresh amount and slippage inputs for the selected pool and execute
directly.

## Launchpad migration boundary

The launchpad path does not forward authenticated inputs. The creator signs all
five encrypted values for the migrator's exact selector and separately signs an
EIP-712 migration authorization containing their ordered ciphertext commitment
hash and public migration context. The migrator validates both layers, calls the official `transferFromGT` function under explicit encrypted
allowances, and then calls the factory's pool bootstrap hook with the resulting MPC
values. The pool verifies its actual private balances and encrypted normalized
price bounds before setting its initial reserves/shares. Any failure reverts the
whole transaction, including the token pulls.

The bootstrap path is restricted to factory-created empty pools and cannot be used
to withdraw or mutate an initialized pool. Launchpad pools use a domain-separated
key that includes the creator. Manual pool creation and another creator's launch
therefore cannot occupy the intended migration slot, while every pool remains in
the factory's common `isPool` and `allPools` discovery registries. Each launch key
is one-shot and cannot be reused after a full exit. The initial share unit is the minimum
of the normalized private deposits, while full exit remains reserve-complete.
The launchpad can select creator-held, timed-lock, or permanent-lock disposition
as part of the same bootstrap transaction. A locked bootstrap records the private
share amount directly in the pool lock and does not mint it to the creator; timed
unlock later mints the amount, while permanent disposition never does.

## Public/public boundary

`PublicCPMM` uses standard ERC-20 transfers and exposes public settlement amounts.
The first LP establishes any non-zero normalized price. Unmanaged balances sent
before initialization are swept to the immutable fee vault before the first
deposit, so a one-unit donation cannot brick or benefit the initializer.
Subsequent liquidity amounts are maxima: shares round down, accepted proportional
amounts round up, and only the accepted amounts are pulled. Incremental joins
require exact receipt so fee-on-transfer behavior cannot silently donate assets.
Swap and withdrawal minimums are checked against the recipient's measured balance
increase, including routed swaps. Every liquidity add also binds the resulting
normalized token1-per-token0 price to caller-supplied inclusive bounds, preventing
a front-run initialization from silently changing deposit economics. It uses
OpenZeppelin full-precision multiplication/division and rounds
the retained reserve upward, matching the confidential invariant convention.
