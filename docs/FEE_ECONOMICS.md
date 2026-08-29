# CipherDEX v1 Fee Economics

Date: 2026-08-15

## Decision

CipherDEX v1 charges one advertised exact-input swap fee in the input asset. It
does not charge an additional native-COTI platform payment. Native COTI is used
only for network gas.

The total swap fee is immutable per pool and must be one of these approved v1
tiers:

| Tier | Intended use | LP target share | Protocol target share |
| ---: | --- | ---: | ---: |
| 5 bps (0.05%) | correlated or unusually efficient pairs | 4.1667 bps | 0.8333 bps |
| 30 bps (0.30%) | standard CPMM pairs | 25 bps | 5 bps |
| 100 bps (1.00%) | volatile, thin, or high-adverse-selection pairs | 83.3333 bps | 16.6667 bps |

For every tier, one sixth of the integer-rounded total fee accrues to the
CipherDEX protocol and the remainder belongs to LPs. The standard 30 bps tier
therefore has the same trader/LP/protocol headline economics described by the
Uniswap v2 whitepaper: traders pay 30 bps, LPs retain 25 bps, and the protocol
receives 5 bps. Raydium's documented standard CPMM uses a 25 bps trade fee and
directs 16% of that fee to protocol and fund destinations, a similar non-LP
share. CipherDEX keeps one protocol destination and does not add Raydium's
optional separate creator fee.

The 5 and 100 bps tiers cover the low-volatility and high-adverse-selection ends
without introducing several near-duplicate defaults. The 30 bps tier stays the
default for normal pairs and preserves the protocol's existing quote convention.

## Exact arithmetic

For integer `amountIn` and immutable `feeBps`:

```text
netIn       = floor(amountIn * (10000 - feeBps) / 10000)
totalFee    = amountIn - netIn
protocolFee = floor(totalFee / 6)
lpFee       = totalFee - protocolFee
```

The curve sees `netIn`. The effective input reserve receives
`amountIn - protocolFee`, which is `netIn + lpFee`. This makes the LP share grow
the invariant while the protocol share remains excluded from LP ownership and
pricing.

Total-fee rounding follows the pre-existing net-input floor. The protocol split
rounds down, so any indivisible remainder favors LPs. Public pools may execute a
tiny trade whose nonzero total fee rounds to a zero protocol share. Confidential
pools reject that dust range in both quote and settlement math: otherwise an
attacker could use zero-accrual swaps to satisfy the public eight-swap batch gate
and isolate another user's encrypted fee in a collection window. The threshold
is denomination-relative raw units and does not add another fee. Quotes and
execution use the same arithmetic and validity rule for their pool mode.

## Public pools

`PublicCPMM` maintains separate `protocolFees0` and `protocolFees1` counters.
LP reserves are separate stored accounting state. Swaps, quotes, liquidity
joins, withdrawals, and invariant checks use only those reserves; raw balances
above reserves plus protocol fees are unpriced surplus. Direct transfers and
positive rebases therefore do not change pool price or LP ownership. Anyone may
call `sweepSurplus`, but it can move only the exact surplus to the immutable fee
vault and provides no caller-selected recipient or upward reserve synchronization.

`collectProtocolFees(collectToken0, collectToken1)` is permissionless but can
transfer only to the pool's immutable `CipherDEXFeeVault`. Each side is selected
independently, so a reverting token cannot block collection of its paired asset.
Collection requires the pool debit to equal the selected claim exactly, while the
vault records only its measured net credit. This permits a sender-taxed token
without charging LP-owned reserves or inflating the vault claim. A prior external
token loss is reconciled against protocol-owned claims before stored LP reserves.
If the loss exceeds the protocol claim, the affected reserve is reduced with a
`ReserveLossReconciled` event so the paired asset remains recoverable. A successful
collection removes the same nominal amount from raw balance and protocol claims,
so effective reserves and price do not change. A full LP exit withdraws all
stored reserves but leaves protocol-owned balances and unaccounted surplus behind.

## Confidential pools

`ConfidentialCPMM` keeps per-token protocol fees as encrypted MPC accumulators
separate from its encrypted effective reserves. Neither accumulator has a public
getter. A swap credits the effective reserve with `amountIn - protocolFee` and
adds the encrypted protocol share to the accumulator for the input token. A swap
whose rounded protocol share is zero reverts before transfer or batch accounting.

Collection is aggregate rather than per-swap:

- each token side needs at least 8 swaps in its current collection window;
- the window must be at least 1 hour old;
- collection deposits one encrypted aggregate into the immutable vault under an
  exact temporary allowance;
- no amount is decrypted, returned, or emitted;
- only a pool recognized by the vault's one-time bound canonical factory may
  deposit, and the vault verifies the pool's token side, public aggregate count,
  and exact encrypted balance delta;
- deposits for the same token are combined across pools in fixed 24-hour epochs;
- a confidential sweep processes only epochs at least two epoch numbers old,
  giving each deposit between 24 and 48 hours of residence depending on when it
  arrived, and requires at least 8 aggregate swaps across those matured epochs;
- a full LP exit deposits any terminal one-to-seven-swap encrypted accumulator
  into that same vault aggregation before clearing pool counters;
- public and confidential vault sweep methods reject the wrong token mode.

The public count and window disclose no amount beyond already-public direction
and timing. They prevent ordinary one-swap collection. They do not provide an
information-theoretic anonymity set: a fee beneficiary or active adversary that
knows most trades in a low-volume window may infer information about the
remainder after a later aggregate sweep. Fixed epochs prevent a beneficiary from
choosing arbitrary per-pool collection boundaries at the vault. They can
aggregate the same private token across several pools, but cannot guarantee that
such traffic exists. Confidential protocol fees therefore protect exact per-swap
amounts from passive observation and routine collection, not from all active
differencing attacks.

## Vault boundary

The vault beneficiary is immutable. The confidential factory is configured once
by the vault deployer and must report this exact vault; it cannot be replaced.
Pools cannot choose another collection recipient, noncanonical pools cannot
deposit, and an arbitrary caller cannot sweep vault assets. A public sweep must
debit the vault by the complete recorded claim before clearing it. It emits both
that claim and a separate measured beneficiary receipt, allowing an always-taxed
token to remain sweepable without hiding the tax. Confidential deposit and sweep
events expose token, pool, epoch and aggregate swap count, but never an amount.
Private token balances stay
under encrypted per-token/per-epoch vault accounting until a matured aggregate
sweep transfers them to the beneficiary.

The vault must be a dedicated CipherDEX deployment. The current mainnet
beneficiary is immutable and recorded in the authoritative deployment manifest;
it has no authority over pool reserves or protocol configuration. A reviewed
multisig or governed treasury remains the recommendation for a future deployment.

## LP-share alternative

Uniswap v2 mints protocol LP shares based on invariant growth instead of moving
fee tokens on each swap. CipherDEX does not use that mechanism for v1. Applying
it to confidential pools would require encrypted invariant checkpoints,
square-root and share-mint arithmetic, exact treatment across joins/exits and
locks, and a proof that rounding cannot dilute LPs or leak fee growth. It also
turns the treasury into an LP whose later withdrawal can expose aggregate pool
amounts. Direct encrypted per-token accrual is simpler to validate and preserves
the invariant and ownership boundary explicitly.

## Immutability and versioning

Pool fee tier, one-sixth split, fee vault, privacy mode, and protocol version are
constructor-bound. There is no administrator setter. Changing those economics
requires a new approved protocol version and new pool identity; an existing pool
cannot be silently repriced.

Standard and launch-protected pools have distinct complete keys because their
initialization strategies differ, but inherit exactly the same immutable fee
policy and fee vault. There is no creator-scoped parallel market namespace and
the initialization strategy cannot alter economics. A future pool-creation anti-spam fee
may be considered separately, but v1 has none. Such a fee would be a one-time
native-COTI creation charge, never part of swap quote math.

## Official references

- Uniswap v2 whitepaper, section 2.4: https://docs.uniswap.org/whitepaper.pdf
- Raydium CPMM fee model: https://docs.raydium.io/products/cpmm/fees
- Raydium CPMM accounts: https://docs.raydium.io/products/cpmm/accounts
- COTI MPC Core: https://docs.coti.io/coti-documentation/build-on-coti/tools/contracts-library/mpc-core
- COTI decryption guidance: https://docs.coti.io/coti-documentation/build-on-coti/guides/best-practices/careful-decrypting
