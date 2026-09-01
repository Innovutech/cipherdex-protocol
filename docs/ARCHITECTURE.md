# Architecture

## Layers

- `contracts/ConfidentialCPMM.sol`: immutable pair, fee policy, private reserve
  math, swap execution and private LP share accounting.
- `contracts/ConfidentialCPMMFactory.sol`: deterministic complete-key registry
  for standard and reviewed launch-protected confidential pools, plus the
  adapter-only atomic bootstrap boundary.
- `contracts/ConfidentialCPMMDeployer.sol`: one-time factory-bound CREATE2
  deployer that keeps pool creation bytecode outside the factory runtime.
- `contracts/ConfidentialInitializationStrategyRegistry.sol`: bounded,
  finalizable registry of exact reviewed strategy runtime codehashes. Class zero
  is the standard `address(0)` strategy and at most two nonzero classes may be
  registered.
- `contracts/ConfidentialLaunchInitializationStrategy.sol`: initialization-only
  atomic launch-state policy callable only by its constructor-created,
  runtime-codehash-pinned migrator. It never receives tokens or participates in
  swaps.
- `contracts/PrivateLPToken.sol`: pool-bound encrypted LP-share token using the
  official COTI `PrivateERC20` implementation.
- `contracts/PrivateLPTokenFactory.sol`: permissionless deployer that keeps COTI
  token creation bytecode out of the canonical CPMM factory runtime and records
  the exact `(pool, token, issuer)` relationship for every token it creates.
  The canonical factory accepts only the reviewed helper runtime codehash, and a
  pool binds an LP token only when the helper attests that the canonical factory
  issued that exact token for that exact pool.
- `contracts/PublicCPMM.sol`: ordinary public/public ERC-20 CPMM with public
  amounts, fees, swaps, liquidity accounting and locks.
- `contracts/PublicCPMMFactory.sol`: separate public/public pool registry.
- `contracts/PublicLPToken.sol`: transferable EIP-2612 public LP shares whose
  immutable issuing pool is the only mint, burn, and lock-escrow authority.
- `contracts/PublicLPTokenFactory.sol`: public LP-token issuer and exact
  `(pool, token, issuer)` provenance registry owned by the public pool creation
  path.
- `contracts/CipherDEXFeePolicy.sol`: immutable approved v1 total-fee tiers and
  LP/protocol split shared by both pool modes.
- `contracts/CipherDEXFeeVault.sol`: immutable protocol-fee destination with
  public-token sweeps and canonical-pool-only encrypted deposits aggregated by
  token and fixed daily epoch before delayed confidential sweeps.
- `contracts/PublicCPMMQuoter.sol`: factory-gated read-only quotes for public
  pools.
- `contracts/PublicCPMMRouter.sol`: factory-gated exact-input routing for
  public pools only.
- `contracts/PublicBestExecutionRouter.sol`: factory-derived single-hop best
  execution across the three canonical public fee tiers. Callers choose allowed
  tiers, never pool addresses.
- `contracts/PublicBestExecutionNativeRouter.sol`: immutable native-COTI swap
  adapter over the public best-execution router. It wraps or unwraps around the
  router's atomic canonical-pool reselection and never accepts a pool address.
- `contracts/PublicCPMMLimitOrderBook.sol`: pair-level exact-transfer escrow
  orders with maker amendments, optional bounded partial fills, internal native
  COTI wrapping/unwrapping, proportional execution bounties, claimable native
  proceeds and immutable surplus recovery.
- `contracts/PublicCPMMLiquidityRouter.sol`: factory-gated atomic create-or-add
  and remove-liquidity periphery. It mints pool-bound ERC-20 shares directly to
  the recipient, refunds unused proportional token maxima, and supports
  EIP-2612 permit removal without a separate approval transaction.
- `contracts/WrappedNativeToken.sol`: immutable administrator-free WCOTI using
  one-to-one deposit/withdraw semantics. It rejects transfers to itself, burns
  before native withdrawal callbacks, and forced native transfers can only
  over-collateralize it.
- `contracts/PublicCPMMNativeRouter.sol`: factory-bound native COTI adapter for
  public swaps and liquidity. It wraps/unwraps atomically and verifies canonical
  pools and LP-token provenance before removing liquidity.
- `contracts/ConfidentialBestExecutionRouter.sol`: factory-bound, single-hop
  encrypted best quote and atomic best execution over a bounded nine-bit
  fee-tier/strategy-class namespace. Quote requests may select up to nine bits;
  atomic swap requests may select at most three. Callers never supply candidate
  addresses.
- `contracts/ConfidentialLaunchpadMigrator.sol`: atomic creator-signed encrypted
  allowance pulls, protected-pool creation, and price-bounded bootstrap. It
  requires one exact creator EIP-712 migration authorization and leaves no
  persistent precommit state on failure.
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

The pool is a non-custodial pair of technically compatible COTI private-token
assets. The canonical factory requires deployed code, the official
`IPrivateERC20` ERC-165 identifier, valid decimals no greater than 18 and exact
agreement with the supplied decimals. It does not admit assets by address,
deployer or runtime codehash. This makes pool creation permissionless for
structurally compatible implementations. Interface compatibility cannot prove
honest token semantics, so malicious or broken assets remain a pool-level trust
risk. Every pool retains exact encrypted transfer balance-delta validation.
CipherDEX-owned helpers, deployers, routers and initialization strategies keep
their exact runtime-codehash provenance boundaries.

The pool maintains encrypted protocol-accounting reserves rather than a public
reserve ledger or a raw-balance price oracle. Compatible token transfers revert
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
pools use encrypted counters. Public collection moves only a selected token
side. Public LP reserves are explicit stored accounting state, so unsolicited
token transfers and positive rebases remain unpriced surplus until anyone moves
that exact excess to the immutable fee vault. Confidential collection grants an
exact temporary allowance and deposits
the encrypted aggregate into a factory-bound vault, which combines the same
token across canonical pools and fixed daily epochs. A full LP exit deposits
even a sub-threshold terminal encrypted aggregate before clearing pool state, so
LPs cannot receive protocol-owned fees and fees cannot become stranded. Both
paths leave effective reserves and price unchanged. See `FEE_ECONOMICS.md`.

The core pool exposes no public reserve, TVL, spot-price or TWAP getter. Current
COTI testnet nodes allow ciphertext-only state reads but reject fresh MPC
precompile work in `eth_call`, including stored ciphertext onboarding. The
factory-bound router can therefore perform exact best quoting only in a paid
transaction. It validates one caller-bound encrypted input, reuses its GT value
across initialized complete-key pools, selects the largest valid output in MPC
and offboards only the winner. Fresh funded mixed-class evidence now proves both
the paid per-pool exact quote and the paid bounded best-quote router. The router
is the preferred integration transport when its candidate model applies; direct
per-pool quoting remains an exact supported path. Neither path is gasless.
Public market data would be an intentional disclosure and belongs, if
ever added, in a separately reviewed oracle or batch design rather than being
inferred from settlement state.

Pool construction also verifies each token's public `decimals()` response and
rejects non-contract or incompatible metadata before storing normalization
scales. The factory remains permissionless, but it cannot create a pool whose
declared decimals silently disagree with the token contract.

## LP accounting

Public and confidential LP representations are deliberately different. A
public pool owns one ordinary transferable `PublicLPToken` with EIP-2612 permit.
Its total supply is the public pool's `totalShares`, and holder balances are the
public `shares` view. The pool is the only supply authority. Timed or permanent
locks move shares into pool escrow; only a valid timed lock can release them.
Public liquidity periphery may pull shares with an allowance or a holder-signed
permit, but it cannot mint, recover, or redirect them.

Native COTI is not a pool asset. Public pools pair WCOTI with another ERC-20;
the native router wraps exact native input before a pool call and unwraps exact
WCOTI output afterward. It clears temporary allowances and rejects residual
balances. This follows the established wrapped-native/periphery boundary and
keeps CPMM accounting token-only. WCOTI cannot be transferred to its own
contract address, where it would otherwise become irrecoverably stranded.
For best execution, the native best-execution adapter delegates the complete
three-tier search to the existing router inside the settlement transaction.
Off-chain or `eth_call` quotes provide UI previews but do not select or pin the
executed pool.

LP shares are ciphertext stored in aggregate by the pool. Factory-created pools
also mint a pool-bound `PrivateLPToken` for each provider, so the encrypted share
position can use the official COTI transfer and approval paths. The pool remains
the only minter/burner. The helper records the creating issuer, and the pool plus
SDK both require the reviewed helper runtime and exact issuance attestation.
An arbitrary caller can ask the helper to create a token, but that token cannot
be bound to a canonical pool. Directly deployed pools cannot initialize or enter
the liquidity lifecycle; every usable pool requires the exact factory-issued LP
token binding. Direct user operations against canonical pools remain supported.
Initial shares equal the smaller of the two
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

The confidential pool includes an owner-encrypted position periphery.
An active LP may request current shares, pro-rata effective reserves and the
normalized token1/token0 price. A fresh function-bound encrypted share amount
may be used to preview a partial or full withdrawal. The owner of an unreleased
timed or permanent lock may request the equivalent locked claim. The pool emits
only caller ciphertexts and public request/lock identity. All three paths are
paid MPC transactions; they never mutate reserve/share accounting, and removal
still recomputes current amounts and enforces encrypted minima at settlement.
`myShares` remains the cheaper no-fresh-MPC active-share read.

The LP token deliberately does not expose a public circulating supply: the base
COTI `PrivateERC20` implementation returns zero for aggregate `totalSupply()`.
Dashboards must not infer private TVL or aggregate LP supply from that method.

## Explicit non-goals

- no concentrated liquidity in the first protocol version;
- no assumption that public/public and confidential pools share event or balance
  disclosure; their pool kinds are explicit in discovery metadata;
- no COTI PoD assets in the synchronous pool;
- no implicit mainnet address defaults or claim of deployment without a reviewed
  commit-bound deployment record;
- no admin withdrawal or mutable fee authority;
- no extra native-COTI fee on swaps and no v1 pool-creation fee;
- no dependency on CipherTools, CipherTrade, a centralized API or an indexer;
- no promise of hidden recipient addresses under the standard PrivateERC20 events.

## Router boundary

`PublicCPMMRouter` is intentionally limited to factory-registered ordinary
ERC-20 pools. It temporarily holds the caller's public input, calls the pool,
and forwards the public output; it has no admin withdrawal or token rescue path.
The public quoter applies the same factory gate. `PublicCPMMLiquidityRouter`
atomically resolves or creates a canonical pool, exact-pulls both desired token
maxima, grants exact temporary pool allowances, mints shares to the caller and
returns unused amounts. A revert rolls back pool creation, token movement and
allowances. Existing direct creation and liquidity methods remain compatible.

The public best-execution router searches exactly three deterministic factory
keys for the requested pair: `5`, `30`, and `100` bps. Unknown bitmap bits are
rejected, absent or uninitialized pools are skipped, and equal quotes keep the
lower-fee candidate because iteration is fee-ascending. Execution recomputes
the winner in the same transaction, grants one exact temporary allowance and
sends measured output directly to the recipient. It deliberately does not split
liquidity or route through intermediate tokens.

The limit-order book stores a price as `minimum output / input` in raw token
units. Each partial fill applies full-precision ceiling division, so splitting a
fill cannot weaken maker price protection. Native bounties use proportional
floor division and the final fill receives the remainder, preserving exact
liability conservation. Only the maker can amend mutable terms, add bounty or
cancel; expiry disables filling but does not transfer control to an outsider.
Settlement mode is immutable. Native input is wrapped into WCOTI only inside the
order book and remaining escrow is unwrapped on cancellation. Native output is
routed to the order book, measured, unwrapped and delivered or credited to the
recipient. Token-mode orders reject WCOTI. Terminal structs are deleted while
status and events remain. Direct token and forced-native surplus are not assigned
to orders: anyone may trigger a sweep, but the destination is one immutable
beneficiary and escrow, bounty and claimable-proceeds liabilities are excluded.

Confidential direct pool execution remains available. For best execution, COTI
authenticated `itUint256` inputs bind the user to the router and exact quote or
swap selector. The router validates them once. Pools never accept forwarded
`itUint256` or an unchecked original-sender parameter; instead they accept raw
transaction-scoped GT values only from the one router configured by their
canonical factory. This preserves COTI authentication while permitting safe
cross-contract GT reuse.

Candidate identity is not caller controlled. The router interprets a nine-bit
bitmap as three fee tiers multiplied by three pool classes: standard class zero
plus at most two finalized reviewed strategy classes. It rejects unknown bits.
Paid quote requests may select all nine slots; atomic swap requests reject more
than three selected slots. For each bit it derives the complete
factory key, verifies canonical pool metadata, and skips absent or uninitialized
variants. Iteration order is fee first, then class; equal encrypted outputs keep
the first candidate, so lower fee wins and the standard class wins within that
fee. The default bitmap selects the three standard fee tiers. The quote path
changes only router replay state and emits one caller-encrypted winner. It does
not move funds or mutate any pool.

Atomic execution privately repeats selection, pulls the exact input into router
escrow, grants an exact allowance only to the selected pool and settles directly
to the user. The pool independently recomputes fee/quote/slippage, updates
effective reserves and protocol fees, and enforces exact private-token deltas.
Success requires quote/settlement parity, starting router balances restored and
all candidate allowances zero. Any failure reverts selection state, escrow,
allowance and pool accounting together.

Public pools use ordinary read-only quote calls. Confidential exact best quotes
are explicitly paid transactions on the tested runtime, not gasless calls. A
future runtime may replace only the quote transport after parity and privacy
review; any oracle or snapshot alternative requires a separate leakage and
manipulation review.

The nine-slot quote cap bounds the complete v1 canonical namespace rather than
silently dropping pools. Its source and arithmetic are unit/invariant tested;
funded COTI evidence currently covers up to three candidates. Integrations must
measure the deployed runtime before enabling larger quote sets. The SDK provides
deterministic bitmap partitioning when a quote set must be split, but every
partition is a separate paid request with fresh authenticated ciphertext.

## Launchpad migration boundary

The complete confidential pool key is:

`ordered token pair + fee tier + privacy mode + protocol version + initialization strategy`

Decimals are verified against each token and are immutable token metadata; they
are not a separate market namespace. `address(0)` is the standard permissionless
strategy. A nonzero strategy is legitimate only when its exact runtime codehash,
interface, factory/migrator binding and registration are authenticated by the
finalized bounded registry. One pool may exist for each complete key, so a
standard and launch-protected pool can coexist without creator-specific ad hoc
namespaces. Resolving an existing protected key revalidates the complete immutable
pool metadata, including both token decimal values; the signed migration cannot
be silently bound to an earlier incompatible pool.

At graduation, the creator authorizes all five encrypted migration values and
the full public migration envelope in one EIP-712 signature for the exact
migrator selector. The pinned migrator validates that authorization and asks the
strategy to create or resolve the empty protected pool inside the same
transaction. The migrator then pulls exact amounts into transaction-scoped escrow
and grants exact pool allowances. The factory calls
the strategy's factory-only one-shot authorization and then invokes the pool
bootstrap. The pool verifies logical empty reserves, encrypted final-price bounds,
minimum shares, LP disposition and exact transfer deltas. Any failure reverts
launch state, pool creation, authorization consumption, escrow, approvals,
reserve state and token pulls. There is no launch authority or persistent
precommit to block automated launchpads.
Each registered strategy carries its own one-time pinned migrator address and
runtime codehash. The factory authenticates that strategy-specific caller and has
no global launch-adapter authority, so the two reviewed strategy classes can use
independent migrators.

After initialization the strategy has no callback, asset, fee, LP, reserve or
withdrawal authority; the protected pool behaves like a standard confidential
CPMM and remains distinguishable by its public strategy metadata. The initial
share unit is the minimum normalized private deposit, and the same creator-held,
timed-lock and permanent-lock dispositions apply atomically.
If every removable LP share later exits, the pool records that protected
initialization has already completed. It may then be re-seeded through ordinary
permissionless liquidity addition, but the launch strategy remains consumed and
cannot initialize it again.

## Public/public boundary

`PublicCPMM` uses standard ERC-20 transfers and exposes public settlement amounts.
The first LP establishes any non-zero normalized price. Unmanaged balances sent
before initialization are swept to the immutable fee vault before the first
deposit, so a one-unit donation cannot brick or benefit the initializer.
After initialization, stored LP reserves rather than raw token balances drive
quotes, swaps, joins and exits. Direct transfers and positive rebases therefore
cannot change pool price, minting ratios or LP withdrawals. `surplusBalances`
reports that unaccounted excess, and permissionless `sweepSurplus` can move it
only to the immutable fee vault. There is deliberately no upward `sync` path.
If an external token destroys pool balance, protocol-owned fees absorb the loss
first; any remaining LP-reserve loss is reconciled downward with an explicit
event so the healthy paired reserve and LP shares do not become permanently
locked.
Subsequent liquidity amounts are maxima: shares round down, accepted proportional
amounts round up, and only the accepted amounts are pulled. Incremental joins
require exact receipt so fee-on-transfer behavior cannot silently donate assets.
Swap and withdrawal minimums are checked against the recipient's measured balance
increase, including routed swaps. Every liquidity add also binds the resulting
normalized token1-per-token0 price to caller-supplied inclusive bounds, preventing
a front-run initialization from silently changing deposit economics. It uses
OpenZeppelin full-precision multiplication/division and rounds
the retained reserve upward, matching the confidential invariant convention.

Confidential incremental joins preserve the same proportional economics without
publishing the pool ratio. A paid `requestAddLiquidityQuote` accepts one encrypted
maximum side and returns caller-encrypted accepted specified amount, counterpart
amount and expected shares. This is a preview, not an authorization: the later
`addLiquidity` call independently enforces fresh encrypted maxima, minimum shares,
normalized price bounds and deadline against current pool state.
