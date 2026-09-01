# CipherDEX Protocol

Minimal, hardened COTI-native AMM protocol deployed on COTI mainnet for the
CipherDEX ecosystem.

This repository is separate from CipherTrade and CipherTools. It implements
public/public ordinary ERC-20 pools and an amount-confidential constant-product
pool over COTI `PrivateERC20` assets. The active production mainnet deployment is
bound to source commit `b99c41abc031754990d4efcaaf1baa6754b3bb1e` and recorded
in `deployments/coti-mainnet-b99c41abc031754990d4efcaaf1baa6754b3bb1e.json`.
The deployment path can sign either on a Ledger or with an explicitly configured
deployment private key. Source code alone is not deployment evidence; only a
reviewed, committed deployment record is authoritative. The contracts are
intentionally minimal and hardened, but they have not received an independent
external audit. Internal verification and security review are not represented as
one, and the deployment tooling keeps that status explicit without enforcing it
as a technical gate.

## Current boundary

`ConfidentialCPMM` keeps swap inputs/outputs, pool reserves, private LP shares and
slippage values in COTI MPC values. It exposes only public pair metadata, fee tier,
participant addresses and swap direction. The standard COTI `PrivateERC20` transfer
interface still takes public recipient addresses and emits public participant
addresses, so this phase does not claim anonymous or hidden-recipient execution.

`ConfidentialLaunchInitializationStrategy` and
`ConfidentialLaunchpadMigrator` form the atomic launch boundary. The creator signs
one EIP-712 migration authorization binding the launch ID, strategy, caller,
pair/decimals, fee tier, encrypted inputs, deadline and LP disposition. In the
same transaction, the pinned migrator prepares the distinct launch-protected pool,
pulls exact encrypted allowances, initializes the pool at the encrypted final-price
ratio and applies the selected LP disposition. Any failure rolls back launch state,
pool creation and asset movement together; there is no operator precommit or launch
authority. The ordinary standard pool remains independent. The strategy
is initialization-only and the migrator has no withdrawal authority. Each
reviewed strategy pins and authenticates its own migrator; the factory has no
global launch adapter or shared migrator authority. Both EOA and ERC-1271 launch
creators use the same end-to-end authorization boundary.

`PublicCPMM` and `PublicCPMMFactory` are a separate public/public mode. Their
public amount events and share accounting are not reused by the confidential
mode. Each canonical public pool issues one transferable EIP-2612 LP token
through the factory-owned `PublicLPTokenFactory`; the pool alone can mint, burn,
or escrow those shares. Existing timed and permanent locks remain pool-enforced.
A public/private mode will only be added where COTI MPC can settle the
private leg without decrypting it inside the contract.

Both modes use the immutable CipherDEX v1 fee policy. The advertised fee is
charged once from the swap input, one sixth of that fee accrues to the protocol,
and the remainder grows LP value. There is no extra native-COTI swap payment.
Protocol balances are excluded from effective reserves and collect only to a
fixed fee vault. Public pools also keep LP reserves as explicit state, leaving
direct transfers and positive rebases as unpriced surplus collectible only to
that vault. Confidential fees remain encrypted and are collected in
pool time/count batches, then combined by token across canonical pools in fixed
daily vault epochs. Full LP exits deposit sub-threshold terminal fee batches
before clearing pool state. See
[docs/FEE_ECONOMICS.md](docs/FEE_ECONOMICS.md).

Factory-created confidential pools bind a dedicated `PrivateLPToken` to the pool.
The canonical factory pins the exact reviewed helper runtime codehash, and both
the pool and SDK require the helper's exact `(pool, token, factory)` issuance
attestation before trusting that LP token.
Its balances and transfers use the official encrypted `PrivateERC20` paths; only
the pool can mint or burn shares when liquidity is added, removed, or locked.
Directly deployed pools cannot enter an operational lifecycle. Every usable pool
must bind the factory-issued private LP token before liquidity, swaps, locks or
fee accrual can begin. Direct user execution against canonical pools remains
available. The launchpad migrator preserves creator-held shares by default and also exposes an
atomic timed-lock or permanent-lock disposition.
After a completed protected pool later reaches a true full exit, ordinary
permissionless `addLiquidity` may re-seed it. The consumed launch ID and strategy
can never bootstrap it again.

Confidential pool creation is permissionless for deployed contracts that report
the official COTI `IPrivateERC20` interface and valid matching decimals. CipherDEX
does not curate external token addresses or runtime bytecode. Interface support
proves structural compatibility, not honest token economics; malformed or
malicious tokens remain a pool-level trust risk. Pools retain exact encrypted
balance-delta checks around every token movement as defense in depth. Exact
runtime-codehash authentication remains limited to CipherDEX-owned infrastructure.

Public pools expose a factory-gated exact-input router, gasless quoter and an
atomic create-or-add liquidity router. The liquidity router resolves or creates
the canonical pool, pulls exact maxima, mints shares directly to the user,
refunds unused proportional amounts and leaves no token balance or allowance
residue. It also removes transferable LP shares directly or through one
EIP-2612 permit. Existing direct factory and pool methods remain supported.
`WrappedNativeToken` is an immutable, administrator-free one-to-one WCOTI
wrapper built from OpenZeppelin ERC-20 primitives and established WETH
deposit/withdraw semantics. Transfers to the wrapper itself are rejected so
WCOTI cannot be accidentally stranded. Withdrawal burns before making the
native transfer, so callback reentry cannot withdraw more backing than the
receiver burns. `PublicCPMMNativeRouter` atomically wraps or unwraps
native COTI around swaps and liquidity operations while public pools remain
ERC-20-only. The standard `0xEeee...` native sentinel exists only at the SDK/UI
boundary and is never stored as a pool token.

`PublicBestExecutionRouter` searches the complete canonical public v1 namespace
for a token pair: one pool at each approved `5`, `30`, and `100` bps tier. A
caller selects tiers with a three-bit bitmap; the router skips absent or
uninitialized pools and atomically settles through the single pool returning the
largest output. It does not split or multi-hop a swap.

`PublicBestExecutionNativeRouter` composes above that selector for ordinary
native-COTI spot swaps. It wraps native exact input or unwraps WCOTI exact output
without accepting a caller-selected pool. The underlying best router re-quotes
all allowed canonical tiers during the same transaction, so a preview is
advisory while execution remains atomic. The adapter has no owner, mutable
configuration, upgrade path or recovery authority.

`PublicCPMMLimitOrderBook` is an optional public-only escrow periphery bound to
that router and the same factory. A maker escrows an exact public input, sets a
raw-unit minimum price, recipient, expiry and allowed fee tiers, and may attach
a native COTI execution bounty. Orders may be full-fill only or explicitly
permit partial fills above a maker-selected minimum. Each partial fill receives
ceiling-rounded price protection and a proportional floor-rounded bounty; the
final fill receives every remainder. The maker may amend price, recipient,
expiry, allowed tiers and partial-fill policy, reactivate an expired open order,
increase but not reduce its bounty, or cancel before or after expiry. Input
amounts and token pairs are immutable; changing either requires cancellation and
a new order. EIP-2612 creation is optional and allowance-backed creation remains
available for all supported tokens.

Native COTI is a first-class order asset at the SDK/UI boundary. The order book
wraps native input into its immutable WCOTI internally, unwraps remaining native
input on cancellation, and unwraps each native-output fill before delivery.
Ordinary token-mode orders reject WCOTI, so users never need to acquire, approve
or receive the implementation token. If a contract recipient rejects native
delivery, proceeds become an exact beneficiary-owned credit claimable to another
payable address. Claimable proceeds and execution bounties are separate native
liabilities and neither can be swept as surplus.

Bounty payments use a bounded immediate push for normal wallet UX; a rejecting
receiver gets an exact beneficiary-owned credit instead of rolling back the
fill or cancellation. `claimNativeBounty` lets that beneficiary pull its
aggregate credit to a chosen payable address. Terminal order storage is deleted
after retaining compact status and authoritative events. Permissionless surplus
sweeps can send only balances above token escrow or native bounty liabilities to
one immutable beneficiary. `canFillOrder` is a keeper-friendly view helper, not
an authorization boundary or execution reservation.
Chainlink, Gelato, thirdweb, OpenZeppelin Relayer, self-hosted bots and ordinary
users may all call the same permissionless fill function, but none is required
by the contract. The module has no owner, keeper whitelist, relayer trust, rescue
redirection, signed off-chain orders, or confidential-token support.
Its source presence does not make it part of the active mainnet deployment; only
a reviewed deployment record can establish that status.

Limit orders require exact-transfer ERC-20 behavior. Fee-on-transfer, rebasing,
callback-mutating and otherwise nonstandard tokens are unsupported and may make
order creation, filling, or cancellation revert. UIs should apply the same
token-risk policy used for direct public CPMM interactions.

The dependency-free SDK defaults token spending to exact allowances and offers an
explicit `unlimited` mode. Public and private approval planners reuse every
existing allowance that already covers the required spend. If approval is
required, the selected mode determines the new target and an insufficient
nonzero allowance emits a zero-reset step before the replacement. The private
planner returns ordered plaintext amounts for encryption with the official COTI
SDK; CipherDEX does not handle wallet AES keys or ciphertexts.
Confidential pools retain direct execution and additionally expose a
factory-bound `ConfidentialBestExecutionRouter`. Users encrypt inputs for that
router and exact function selector. A paid quote may reuse the validated MPC
value across up to all nine canonical fee/strategy slots. Atomic quote-and-swap
remains capped at three candidates because that is the largest execution path
with funded COTI gas evidence. The router privately selects the largest valid
output and offboards only the winner. If a live runtime cannot fit the requested
quote set, the SDK can partition the canonical bitmap into deterministic quote
batches; each batch still requires a fresh encrypted input and request ID.

Existing confidential LPs can request a paid encrypted liquidity preview from
one verified pool. Given one maximum token amount and a side, the pool returns
the accepted specified amount, proportional counterpart and expected shares
encrypted only for that caller. The later add remains authoritative and binds
minimum shares, price bounds and deadline, so state movement cannot silently
change the reviewed deposit.

The confidential pool also gives an LP an owner-only position lifecycle. A
verified pool can return the caller's active shares, current token claims and
normalized pool price as caller ciphertexts; preview a partial or full removal
from a fresh encrypted share input; and disclose the same current claim for an
unreleased timed or permanent lock only to that lock's owner. These are paid MPC
reads because fresh MPC remains unreliable under `eth_call`. They do not publish
reserves, TVL, protocol fees or plaintext position amounts, and settlement still
recomputes all values against current state and reviewed minima.

The unreleased current source uses protocol version 1 across every public and
confidential component and discovery schema version 1. Development changes do
not create compatibility generations. Previous testnet artifacts are disposable
and are not a supported discovery or liquidity-migration surface.

PoD assets are not accepted by this synchronous pool. PoD transfer and approval
operations are asynchronous cross-chain callback workflows and require a separate
adapter/state machine; treating them as ordinary ERC-20 calls would be incorrect.

Confidential pools deliberately expose no public reserve-derived market data:
no reserves, TVL, aggregate LP supply, spot price or TWAP. The current COTI
testnet RPC permits ciphertext-only storage reads but rejects `OnBoard` and every
tested fresh MPC path under `eth_call`, including the stored-encrypted-constant
design. Paid per-pool encrypted quote transactions are therefore the proven
exact per-pool quote transport. The paid best-quote transaction over a bounded,
factory-derived strategy/fee bitmap has also passed fresh funded mixed-class
evidence and is the preferred integration transport when its bounded candidate
model applies. Neither transport is gasless: both cost gas and wait for inclusion,
so this remains a testnet runtime limitation rather than normal gasless DEX quote
UX. Read
[docs/QUOTE_MARKET_DATA_REVIEW.md](docs/QUOTE_MARKET_DATA_REVIEW.md),
[docs/FEE_ECONOMICS.md](docs/FEE_ECONOMICS.md),
[docs/FEASIBILITY_GATE.md](docs/FEASIBILITY_GATE.md) and
[docs/LAUNCHPAD_MIGRATION.md](docs/LAUNCHPAD_MIGRATION.md) before extending the
protocol.

## Commands

```text
npm ci --ignore-scripts
npm run verify
npm run gas:measure
```

`.github/workflows/protocol-ci.yml` runs the locked install and complete
`npm run verify` gate on pushes and pull requests. It has read-only repository
permissions and never deploys contracts. COTI deployment remains an explicit,
reviewed operator action using the scripts and checklists below.

### Public limit-order deployment

Deploy only the limit-order periphery after compiling the reviewed branch:

```text
npm run compile
npm run deploy:public-limit-orders
```

The deployment process reads exactly these environment variables:

```text
PUBLIC_CPMM_FACTORY_ADDRESS=<canonical deployed public factory>
PUBLIC_BEST_EXECUTION_ROUTER_ADDRESS=<existing reviewed best-execution router>
PUBLIC_WRAPPED_NATIVE_ADDRESS=<existing reviewed WCOTI>
PUBLIC_LIMIT_ORDER_SURPLUS_BENEFICIARY=<immutable surplus recipient>
DEPLOYER_PRIVATE_KEY=<funded deployment key>
COTI_RPC_URL=<COTI testnet or mainnet RPC URL>
```

Keep the private key in the same owner-only external environment boundary used
by other funded operations; never add it to this repository. The script accepts
only COTI testnet (`7082400`) or mainnet (`2632500`), deploys only the replacement
order book, validates its immutable factory, existing router, WCOTI and
beneficiary bindings, and prints its address, transaction and constructor
arguments. Existing factories, pools, vaults, routers and WCOTI are unchanged.

Before a mainnet deployment:

1. Pin and review the exact source commit and compile from a clean locked install.
2. Use the canonical public factory from the active reviewed mainnet manifest.
3. Confirm chain `2632500`, the deployer balance and the intended RPC endpoint.
4. Record the address, deployment transaction and constructor argument in a
   reviewed deployment record.
5. Match deployed runtime code to the committed artifact and submit the retained
   compiler input for explorer verification.
6. Enable UI/indexer discovery only after the deployment record and external
   audit status have been reviewed explicitly.

Funded configuration must be stored in a regular file outside this repository
inside a dedicated owner-only directory. Repository-local `.env` files and
repository-local funded commands are refused. Install
`scripts/operator-funded-launcher.mjs` from the exact approved Git commit into
owner-only storage, then invoke that external file with explicit `--repository`,
`--commit`, `--environment` and `--target` arguments. The launcher authenticates
the full commit with trusted system Git before importing repository code, creates
a fresh private checkout, performs a locked script-disabled install and
secretless build, records the source/dependency/artifact measurement, reads the
external environment only after authentication, executes Hardhat with
`--no-compile`, atomically publishes allowed JSON, and removes the private runtime.
Encrypted recovery journals are stored in an owner-only, repository-scoped
directory outside that disposable runtime, so runtime cleanup cannot erase
replay protection, pending transaction evidence, or asset-recovery obligations.

The `scripts/deploy-testnet.ts` and `scripts/deploy-mainnet.ts` targets require a
committed source tree and a network/commit-named `COTI_DEPLOYMENT_RECORD`.
Mainnet requires exactly one signer mode: a hash-pinned external Foundry `cast`
binary plus Ledger address, or `COTI_MAINNET_PRIVATE_KEY`. Ledger mode validates
the connected address and signs each fully populated transaction on-device;
private-key mode uses the same local-hash, journal and broadcast boundary.
All four testnet funded gates run only after the reviewed
record is committed in a separate evidence commit; they reject dirty, untracked
or executable post-deployment changes and token instances absent from the
reviewed record. Every disposable asset-holding resource is journaled before use,
recovered to zero residue, and bound to its owner-created on-chain transaction.
The finalizer accepts exactly the four source/deployment-bound run records and
the verifier rechecks their transactions, blocks and runtime artifacts. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the exact sequence.

The `scripts/testnet-preflight.ts` target requires explicit values in the external reviewed environment
file for two funded,
already-onboarded COTI testnet LP wallets, a separate MPC-call probe identity,
their AES keys, and two official PrivateERC20-compatible token addresses. It
validates isolated private balance access without printing balances,
ciphertexts, keys or raw RPC payloads.

## Monorepo boundaries

- `contracts/`: protocol pools, complete-key factories, reviewed initialization
  strategy boundary, private LP token and public periphery contracts;
- `periphery/`: routing/adapter boundary and integration notes;
- `sdk/`: stable dependency-free ABI and discovery types;
- `deployments/`: sanitized public deployment-record boundary;
- `scripts/`: commit-bound Ledger/private-key mainnet deployment, testnet deployment and
  COTI scenario runners;
- `test/`: local security/property tests and the gated real-COTI integration
  placeholder;
- `docs/`: feasibility, privacy, threat, dependency and operational records.

Deployment does not require token addresses or AES material. Hardhat stores no
mainnet account; the deployer is constructed only inside the authenticated funded
runner from the single configured Ledger or private-key mode described in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The deployer receives no lasting protocol
role after deployment.
