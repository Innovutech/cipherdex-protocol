export type FeeSide = 0 | 1;

export const UINT256_MAX = (1n << 256n) - 1n;
export const FEE_GROWTH_SCALE = 1n << 128n;
export const MAX_TOTAL_SHARES = FEE_GROWTH_SCALE - 1n;
export const MAX_RESERVE_OPERAND = FEE_GROWTH_SCALE - 1n;
export const MAX_LP_FEE_OPERAND = FEE_GROWTH_SCALE - 1n;

export type FeeGrowthPoint = Readonly<{ whole: bigint; fraction: bigint }>;
export type FeeGrowthState = Readonly<{
  growth: FeeGrowthPoint;
  globalRemainder: bigint;
  lifetimeAccrued: bigint;
}>;
export type HolderGrowthState = Readonly<{
  checkpoint: FeeGrowthPoint;
  carry: bigint;
  newClaim: bigint;
}>;
export type FeeAudit = Readonly<{
  accrued: bigint;
  lifetimeAccrued: bigint;
  paid: bigint;
  outstanding: bigint;
  liability: bigint;
  activeReserve: bigint;
  protocolFees: bigint;
  custody: bigint;
  ownerCarryScaled: bigint;
  unallocatedGlobalRemainder: bigint;
  fractionalLiabilityScaled: bigint;
}>;
export type ModelSnapshot = Readonly<{
  totalShares: bigint;
  generation: bigint;
  holders: readonly Readonly<{
    account: string;
    balance: bigint;
    checkpoint: readonly [FeeGrowthPoint, FeeGrowthPoint];
    carry: readonly [bigint, bigint];
    claimable: readonly [bigint, bigint];
  }>[];
  allowances: readonly Readonly<{ owner: string; spender: string; amount: bigint }>[];
  locks: readonly Readonly<{
    id: string;
    owner: string;
    amount: bigint;
    unlockAt: bigint;
    permanent: boolean;
    active: boolean;
  }>[];
  sides: readonly Readonly<{
    growth: FeeGrowthPoint;
    globalRemainder: bigint;
    lifetimeAccrued: bigint;
    accrued: bigint;
    paid: bigint;
    liability: bigint;
    activeReserve: bigint;
    protocolFees: bigint;
    custody: bigint;
  }>[];
}>;

type LockRecord = {
  owner: string;
  amount: bigint;
  unlockAt: bigint;
  permanent: boolean;
  active: boolean;
};
type HolderState = {
  balance: bigint;
  checkpoint: [FeeGrowthPoint, FeeGrowthPoint];
  carry: [bigint, bigint];
  claimable: [bigint, bigint];
};
type SideState = {
  growth: FeeGrowthPoint;
  globalRemainder: bigint;
  lifetimeAccrued: bigint;
  accrued: bigint;
  paid: bigint;
  liability: bigint;
  activeReserve: bigint;
  protocolFees: bigint;
  custody: bigint;
};
type MutableSnapshot = {
  total: bigint;
  generation: bigint;
  holders: Map<string, HolderState>;
  allowances: Map<string, Map<string, bigint>>;
  locks: Map<string, LockRecord>;
  sides: [SideState, SideState];
};

function requireRange(value: bigint, minimum: bigint, maximum: bigint, name: string): void {
  if (value < minimum || value > maximum) throw new Error(`${name} is outside its proved range`);
}

function checkedAdd(left: bigint, right: bigint, name: string): bigint {
  requireRange(left, 0n, UINT256_MAX, `${name} left operand`);
  requireRange(right, 0n, UINT256_MAX, `${name} right operand`);
  const result = left + right;
  if (result > UINT256_MAX) throw new Error(`${name} overflow`);
  return result;
}

function checkedMul(left: bigint, right: bigint, name: string): bigint {
  requireRange(left, 0n, UINT256_MAX, `${name} left operand`);
  requireRange(right, 0n, UINT256_MAX, `${name} right operand`);
  const result = left * right;
  if (result > UINT256_MAX) throw new Error(`${name} overflow`);
  return result;
}

function growthBefore(left: FeeGrowthPoint, right: FeeGrowthPoint): boolean {
  return left.whole < right.whole ||
    (left.whole === right.whole && left.fraction < right.fraction);
}

function cloneGrowth(value: FeeGrowthPoint): FeeGrowthPoint {
  return { whole: value.whole, fraction: value.fraction };
}

/**
 * Advances cumulative per-share growth without constructing lpFee * SCALE.
 * The only product is feeRemainder * SCALE, where feeRemainder < totalShares
 * and totalShares <= 2^128 - 1.
 */
export function advanceFeeGrowth(
  state: FeeGrowthState,
  lpFee: bigint,
  totalShares: bigint,
): FeeGrowthState {
  requireRange(totalShares, 1n, MAX_TOTAL_SHARES, "total shares");
  requireRange(lpFee, 1n, MAX_LP_FEE_OPERAND, "LP fee");
  requireRange(state.growth.whole, 0n, UINT256_MAX, "whole growth");
  requireRange(state.growth.fraction, 0n, FEE_GROWTH_SCALE - 1n, "fractional growth");
  requireRange(state.globalRemainder, 0n, FEE_GROWTH_SCALE - 1n, "global remainder");
  requireRange(state.lifetimeAccrued, 0n, UINT256_MAX, "lifetime accrued fees");

  const feeWhole = lpFee / totalShares;
  const feeRemainder = lpFee % totalShares;
  const fractionalNumerator = checkedAdd(
    checkedMul(feeRemainder, FEE_GROWTH_SCALE, "fractional fee numerator"),
    state.globalRemainder,
    "fractional fee numerator",
  );
  const fractionIncrement = fractionalNumerator / totalShares;
  const globalRemainder = fractionalNumerator % totalShares;
  const combinedFraction = state.growth.fraction + fractionIncrement;
  if (combinedFraction >= FEE_GROWTH_SCALE * 2n) {
    throw new Error("fractional growth normalization bound failed");
  }
  const growth = Object.freeze({
    whole: checkedAdd(
      checkedAdd(state.growth.whole, feeWhole, "whole growth"),
      combinedFraction / FEE_GROWTH_SCALE,
      "whole growth",
    ),
    fraction: combinedFraction % FEE_GROWTH_SCALE,
  });
  const lifetimeAccrued = checkedAdd(state.lifetimeAccrued, lpFee, "lifetime accrued fees");
  if (growth.whole > lifetimeAccrued) {
    throw new Error("per-share whole growth exceeds lifetime fees");
  }
  return Object.freeze({ growth, globalRemainder, lifetimeAccrued });
}

/**
 * Settles one holder from a two-limb growth checkpoint. The whole product is
 * safe for reachable states because balance is constant between checkpoints
 * and cannot exceed supply during any included accrual.
 */
export function settleFeeGrowth(
  balance: bigint,
  checkpoint: FeeGrowthPoint,
  carry: bigint,
  growth: FeeGrowthPoint,
): HolderGrowthState {
  requireRange(balance, 0n, MAX_TOTAL_SHARES, "holder balance");
  requireRange(carry, 0n, FEE_GROWTH_SCALE - 1n, "holder carry");
  requireRange(checkpoint.whole, 0n, UINT256_MAX, "checkpoint whole growth");
  requireRange(checkpoint.fraction, 0n, FEE_GROWTH_SCALE - 1n, "checkpoint fraction");
  requireRange(growth.whole, 0n, UINT256_MAX, "whole growth");
  requireRange(growth.fraction, 0n, FEE_GROWTH_SCALE - 1n, "fractional growth");
  if (growthBefore(growth, checkpoint)) throw new Error("fee growth moved backwards");

  let wholeDelta = growth.whole - checkpoint.whole;
  let fractionDelta: bigint;
  if (growth.fraction >= checkpoint.fraction) {
    fractionDelta = growth.fraction - checkpoint.fraction;
  } else {
    if (wholeDelta === 0n) throw new Error("fee growth borrow underflow");
    wholeDelta -= 1n;
    fractionDelta = FEE_GROWTH_SCALE + growth.fraction - checkpoint.fraction;
  }
  const wholeClaim = checkedMul(balance, wholeDelta, "holder whole claim");
  const fractionalNumerator = checkedAdd(
    checkedMul(balance, fractionDelta, "holder fractional numerator"),
    carry,
    "holder fractional numerator",
  );
  return Object.freeze({
    checkpoint: cloneGrowth(growth),
    carry: fractionalNumerator % FEE_GROWTH_SCALE,
    newClaim: checkedAdd(
      wholeClaim,
      fractionalNumerator / FEE_GROWTH_SCALE,
      "holder claim",
    ),
  });
}

/**
 * Dependency-free transactional reference model. Every public mutation
 * snapshots and rolls back on failure to reproduce EVM transaction semantics.
 */
export class FungibleLpFeeModel {
  readonly poolAuthority: string;

  private total = 0n;
  private generation = 0n;
  private holders = new Map<string, HolderState>();
  private allowances = new Map<string, Map<string, bigint>>();
  private locks = new Map<string, LockRecord>();
  private sides: [SideState, SideState] = [this.newSide(), this.newSide()];

  constructor(poolAuthority = "pool") {
    this.poolAuthority = poolAuthority;
  }

  totalShares(): bigint { return this.total; }
  generationId(): bigint { return this.generation; }
  balanceOf(account: string): bigint { return this.holders.get(account)?.balance ?? 0n; }

  lockedOf(account: string): bigint {
    let locked = 0n;
    for (const record of this.locks.values()) {
      if (record.active && record.owner === account) locked += record.amount;
    }
    return locked;
  }

  unlockedOf(account: string): bigint { return this.balanceOf(account) - this.lockedOf(account); }

  claimableOf(account: string, side: FeeSide): bigint {
    return this.transact(() => {
      this.settle(account);
      return this.ensureHolder(account).claimable[side];
    });
  }

  checkpointOf(account: string, side: FeeSide): FeeGrowthPoint {
    return cloneGrowth(this.holders.get(account)?.checkpoint[side] ?? this.sides[side].growth);
  }

  carryOf(account: string, side: FeeSide): bigint {
    return this.transact(() => {
      this.settle(account);
      return this.ensureHolder(account).carry[side];
    });
  }

  growthOf(side: FeeSide): FeeGrowthPoint { return cloneGrowth(this.sides[side].growth); }
  globalRemainderOf(side: FeeSide): bigint { return this.sides[side].globalRemainder; }
  lifetimeAccruedOf(side: FeeSide): bigint { return this.sides[side].lifetimeAccrued; }

  approve(owner: string, spender: string, amount: bigint): void {
    this.transact(() => {
      requireRange(amount, 0n, UINT256_MAX, "allowance");
      let values = this.allowances.get(owner);
      if (!values) {
        values = new Map<string, bigint>();
        this.allowances.set(owner, values);
      }
      values.set(spender, amount);
    });
  }

  allowance(owner: string, spender: string): bigint {
    return this.allowances.get(owner)?.get(spender) ?? 0n;
  }

  mint(caller: string, account: string, amount: bigint): void {
    this.transact(() => {
      this.requirePool(caller);
      requireRange(amount, 1n, MAX_TOTAL_SHARES, "mint amount");
      this.settle(account);
      if (this.total + amount > MAX_TOTAL_SHARES) throw new Error("total shares exceed the proved cap");
      this.ensureHolder(account).balance += amount;
      this.total += amount;
    });
  }

  burn(caller: string, account: string, amount: bigint): void {
    this.transact(() => {
      this.requirePool(caller);
      requireRange(amount, 1n, MAX_TOTAL_SHARES, "burn amount");
      this.settle(account);
      this.requireUnlocked(account, amount);
      this.ensureHolder(account).balance -= amount;
      this.total -= amount;
      if (this.total === 0n) this.generation += 1n;
    });
  }

  transfer(sender: string, recipient: string, amount: bigint): void {
    this.transact(() => this.move(sender, recipient, amount));
  }

  transferFrom(spender: string, owner: string, recipient: string, amount: bigint): void {
    this.transact(() => {
      requireRange(amount, 1n, MAX_TOTAL_SHARES, "transfer amount");
      const current = this.allowance(owner, spender);
      if (current < amount) throw new Error("insufficient allowance");
      this.allowances.get(owner)!.set(spender, current - amount);
      this.move(owner, recipient, amount);
    });
  }

  lock(
    caller: string,
    lockId: string,
    owner: string,
    amount: bigint,
    unlockAt: bigint,
    permanent: boolean,
  ): void {
    this.transact(() => {
      this.requirePool(caller);
      requireRange(amount, 1n, MAX_TOTAL_SHARES, "lock amount");
      requireRange(unlockAt, 0n, (1n << 64n) - 1n, "unlock time");
      if (this.locks.has(lockId)) throw new Error("lock already exists");
      this.settle(owner);
      this.requireUnlocked(owner, amount);
      this.locks.set(lockId, { owner, amount, unlockAt, permanent, active: true });
    });
  }

  unlock(caller: string, lockId: string, now: bigint): void {
    this.transact(() => {
      this.requirePool(caller);
      requireRange(now, 0n, UINT256_MAX, "current time");
      const record = this.locks.get(lockId);
      if (!record?.active) throw new Error("unknown lock");
      if (record.permanent) throw new Error("permanent lock");
      if (now < record.unlockAt) throw new Error("lock not matured");
      record.active = false;
    });
  }

  creditPrincipal(caller: string, side: FeeSide, amount: bigint): void {
    this.transact(() => {
      this.requirePool(caller);
      requireRange(amount, 0n, MAX_RESERVE_OPERAND, "principal amount");
      const state = this.sides[side];
      const nextReserve = state.activeReserve + amount;
      if (nextReserve > MAX_RESERVE_OPERAND) throw new Error("active reserve exceeds cap");
      state.activeReserve = nextReserve;
      state.custody = checkedAdd(state.custody, amount, "custody");
    });
  }

  recordSwapFees(
    caller: string,
    side: FeeSide,
    netInput: bigint,
    protocolFee: bigint,
    lpFee: bigint,
  ): void {
    this.transact(() => {
      this.requirePool(caller);
      requireRange(netInput, 0n, MAX_RESERVE_OPERAND, "net input");
      requireRange(protocolFee, 0n, MAX_LP_FEE_OPERAND, "protocol fee");
      requireRange(lpFee, 0n, MAX_LP_FEE_OPERAND, "LP fee");
      if (lpFee > 0n && this.total === 0n) throw new Error("cannot accrue LP fees with zero shares");
      const state = this.sides[side];
      const nextReserve = state.activeReserve + netInput;
      if (nextReserve > MAX_RESERVE_OPERAND) throw new Error("active reserve exceeds cap");
      state.activeReserve = nextReserve;
      state.protocolFees = checkedAdd(state.protocolFees, protocolFee, "protocol fees");
      state.custody = checkedAdd(
        state.custody,
        checkedAdd(checkedAdd(netInput, protocolFee, "swap credit"), lpFee, "swap credit"),
        "custody",
      );
      if (lpFee === 0n) return;
      const nextGrowth = advanceFeeGrowth({
        growth: state.growth,
        globalRemainder: state.globalRemainder,
        lifetimeAccrued: state.lifetimeAccrued,
      }, lpFee, this.total);
      state.growth = nextGrowth.growth;
      state.globalRemainder = nextGrowth.globalRemainder;
      state.lifetimeAccrued = nextGrowth.lifetimeAccrued;
      state.accrued = checkedAdd(state.accrued, lpFee, "accrued LP fees");
      state.liability = checkedAdd(state.liability, lpFee, "LP fee liability");
    });
  }

  consumeClaim(caller: string, owner: string, side: FeeSide): bigint {
    return this.transact(() => {
      this.requirePool(caller);
      this.settle(owner);
      const holder = this.ensureHolder(owner);
      const amount = holder.claimable[side];
      if (amount > this.sides[side].liability) throw new Error("claim exceeds LP liability");
      holder.claimable[side] = 0n;
      const state = this.sides[side];
      state.liability -= amount;
      state.paid = checkedAdd(state.paid, amount, "paid LP fees");
      state.custody -= amount;
      return amount;
    });
  }

  audit(side: FeeSide): FeeAudit {
    return this.transact(() => {
      for (const account of this.holders.keys()) this.settle(account);
      const state = this.sides[side];
      let outstanding = 0n;
      let ownerCarryScaled = 0n;
      for (const holder of this.holders.values()) {
        outstanding = checkedAdd(outstanding, holder.claimable[side], "outstanding claims");
        ownerCarryScaled += holder.carry[side];
      }
      if (state.paid + outstanding > state.accrued) {
        throw new Error("paid plus outstanding exceeds accrued LP fees");
      }
      if (state.liability !== state.accrued - state.paid) {
        throw new Error("LP liability diverged from accrued minus paid");
      }
      const fractionalLiabilityScaled = (state.liability - outstanding) * FEE_GROWTH_SCALE;
      if (ownerCarryScaled + state.globalRemainder !== fractionalLiabilityScaled) {
        throw new Error("fractional LP liability is not exactly conserved");
      }
      if (state.custody !== state.activeReserve + state.protocolFees + state.liability) {
        throw new Error("custody, reserves and liabilities diverged");
      }
      return Object.freeze({
        accrued: state.accrued,
        lifetimeAccrued: state.lifetimeAccrued,
        paid: state.paid,
        outstanding,
        liability: state.liability,
        activeReserve: state.activeReserve,
        protocolFees: state.protocolFees,
        custody: state.custody,
        ownerCarryScaled,
        unallocatedGlobalRemainder: state.globalRemainder,
        fractionalLiabilityScaled,
      });
    });
  }

  inspect(): ModelSnapshot {
    const holders = [...this.holders.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([account, holder]) => Object.freeze({
        account,
        balance: holder.balance,
        checkpoint: Object.freeze([
          cloneGrowth(holder.checkpoint[0]),
          cloneGrowth(holder.checkpoint[1]),
        ]) as readonly [FeeGrowthPoint, FeeGrowthPoint],
        carry: Object.freeze([...holder.carry]) as readonly [bigint, bigint],
        claimable: Object.freeze([...holder.claimable]) as readonly [bigint, bigint],
      }));
    const allowances = [...this.allowances.entries()]
      .flatMap(([owner, values]) => [...values.entries()].map(([spender, amount]) => ({
        owner, spender, amount,
      })))
      .sort((left, right) =>
        `${left.owner}:${left.spender}`.localeCompare(`${right.owner}:${right.spender}`)
      )
      .map((value) => Object.freeze(value));
    const locks = [...this.locks.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => Object.freeze({ id, ...record }));
    const sides = this.sides.map((state) => Object.freeze({
      growth: cloneGrowth(state.growth),
      globalRemainder: state.globalRemainder,
      lifetimeAccrued: state.lifetimeAccrued,
      accrued: state.accrued,
      paid: state.paid,
      liability: state.liability,
      activeReserve: state.activeReserve,
      protocolFees: state.protocolFees,
      custody: state.custody,
    }));
    return Object.freeze({
      totalShares: this.total,
      generation: this.generation,
      holders: Object.freeze(holders),
      allowances: Object.freeze(allowances),
      locks: Object.freeze(locks),
      sides: Object.freeze(sides),
    });
  }

  private newSide(): SideState {
    return {
      growth: { whole: 0n, fraction: 0n },
      globalRemainder: 0n,
      lifetimeAccrued: 0n,
      accrued: 0n,
      paid: 0n,
      liability: 0n,
      activeReserve: 0n,
      protocolFees: 0n,
      custody: 0n,
    };
  }

  private ensureHolder(account: string): HolderState {
    let holder = this.holders.get(account);
    if (!holder) {
      holder = {
        balance: 0n,
        checkpoint: [cloneGrowth(this.sides[0].growth), cloneGrowth(this.sides[1].growth)],
        carry: [0n, 0n],
        claimable: [0n, 0n],
      };
      this.holders.set(account, holder);
    }
    return holder;
  }

  private settle(account: string): void {
    const holder = this.ensureHolder(account);
    for (const side of [0, 1] as const) {
      const settled = settleFeeGrowth(
        holder.balance,
        holder.checkpoint[side],
        holder.carry[side],
        this.sides[side].growth,
      );
      holder.checkpoint[side] = settled.checkpoint;
      holder.carry[side] = settled.carry;
      holder.claimable[side] = checkedAdd(
        holder.claimable[side], settled.newClaim, "holder claimable balance",
      );
    }
  }

  private move(sender: string, recipient: string, amount: bigint): void {
    requireRange(amount, 1n, MAX_TOTAL_SHARES, "transfer amount");
    if (sender === recipient) throw new Error("self transfer");
    this.settle(sender);
    this.settle(recipient);
    this.requireUnlocked(sender, amount);
    this.ensureHolder(sender).balance -= amount;
    this.ensureHolder(recipient).balance += amount;
  }

  private requireUnlocked(account: string, amount: bigint): void {
    if (amount > this.unlockedOf(account)) throw new Error("locked principal is unavailable");
  }

  private requirePool(caller: string): void {
    if (caller !== this.poolAuthority) throw new Error("pool authority required");
  }

  private transact<T>(operation: () => T): T {
    const snapshot = this.mutableSnapshot();
    try {
      return operation();
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private mutableSnapshot(): MutableSnapshot {
    return {
      total: this.total,
      generation: this.generation,
      holders: new Map([...this.holders.entries()].map(([account, holder]) => [account, {
        balance: holder.balance,
        checkpoint: [cloneGrowth(holder.checkpoint[0]), cloneGrowth(holder.checkpoint[1])],
        carry: [...holder.carry] as [bigint, bigint],
        claimable: [...holder.claimable] as [bigint, bigint],
      }])),
      allowances: new Map([...this.allowances.entries()].map(([owner, values]) => [
        owner, new Map(values),
      ])),
      locks: new Map([...this.locks.entries()].map(([id, record]) => [id, { ...record }])),
      sides: this.sides.map((state) => ({
        ...state, growth: cloneGrowth(state.growth),
      })) as [SideState, SideState],
    };
  }

  private restore(snapshot: MutableSnapshot): void {
    this.total = snapshot.total;
    this.generation = snapshot.generation;
    this.holders = snapshot.holders;
    this.allowances = snapshot.allowances;
    this.locks = snapshot.locks;
    this.sides = snapshot.sides;
  }
}
