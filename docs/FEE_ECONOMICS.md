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
rounds down, so any indivisible remainder favors LPs. A tiny valid trade can
therefore pay a nonzero total fee while its protocol share is zero. Quotes and
execution use the same arithmetic.

## Public pools

`PublicCPMM` maintains separate `protocolFees0` and `protocolFees1` counters.
Effective reserves are raw token balances minus the corresponding protocol-fee
counter. Swaps, quotes, liquidity joins, withdrawals, and invariant checks use
only effective reserves.

`collectProtocolFees()` is permissionless but can transfer only to the pool's
immutable `CipherDEXFeeVault`. Collection clears the counters and moves the same
raw balances, so effective reserves and price do not change. A full LP exit
withdraws all effective reserves but leaves protocol-owned balances behind.

## Confidential pools

`ConfidentialCPMM` keeps per-token protocol fees as encrypted MPC accumulators
separate from its encrypted effective reserves. Neither accumulator has a public
getter. A swap credits the effective reserve with `amountIn - protocolFee` and
adds the encrypted protocol share to the accumulator for the input token.

Collection is aggregate rather than per-swap:

- each token side needs at least 8 swaps in its current collection window;
- the window must be at least 1 hour old;
- collection transfers one encrypted aggregate to the immutable vault;
- no amount is decrypted, returned, or emitted;
- the vault permits confidential sweeps no more than once per token per 24 hours;
- public and confidential vault sweep methods reject the wrong token mode.

The public count and window disclose no amount beyond already-public direction
and timing. They prevent ordinary one-swap collection. They do not provide an
information-theoretic anonymity set: a fee beneficiary or active adversary that
knows most trades in a low-volume window may infer information about the
remainder after a later aggregate sweep. The 24-hour vault cadence can aggregate
the same private token across several pools, but it cannot guarantee that such
traffic exists. Confidential protocol fees therefore protect exact per-swap
amounts from passive observation and routine collection, not from all active
differencing attacks.

## Vault boundary

The vault beneficiary is immutable. Pools cannot choose another collection
recipient, and an arbitrary caller cannot sweep vault assets. Public sweeps emit
their public amount. Confidential sweeps emit only token and beneficiary
identity. Private token balances stay under the vault contract's encrypted
account until the delayed aggregate sweep transfers them to the beneficiary.

The vault must be a dedicated CipherDEX deployment. The beneficiary should be a
reviewed multisig or governed treasury before any production deployment. A v1
testnet EOA is an operational convenience, not a mainnet recommendation.

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

Manual factory creation and launchpad migration both resolve the same canonical
factory pool and therefore inherit exactly the same fee policy. A future
pool-creation anti-spam fee may be considered separately, but v1 has none. Such a
fee would be a one-time native-COTI creation charge, never part of swap quote
math.

## Official references

- Uniswap v2 whitepaper, section 2.4: https://docs.uniswap.org/whitepaper.pdf
- Raydium CPMM fee model: https://docs.raydium.io/products/cpmm/fees
- Raydium CPMM accounts: https://docs.raydium.io/products/cpmm/accounts
- COTI MPC Core: https://docs.coti.io/coti-documentation/build-on-coti/tools/contracts-library/mpc-core
- COTI decryption guidance: https://docs.coti.io/coti-documentation/build-on-coti/guides/best-practices/careful-decrypting
