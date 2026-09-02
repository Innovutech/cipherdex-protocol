export type FeeSide = 0 | 1;

export type RetiredGlobalRemainder = Readonly<{
  generation: bigint;
  numerator: bigint;
  denominator: bigint;
}>;

export type FeeAudit = Readonly<{
  accrued: bigint;
  paid: bigint;
  outstanding: bigint;
  explicitDust: bigint;
  dustUpperBound: bigint;
  liability: bigint;
  activeReserve: bigint;
  protocolFees: bigint;
  custody: bigint;
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
  checkpoint: [bigint, bigint];
  carry: [bigint, bigint];
  claimable: [bigint, bigint];
};

type SideState = {
  growth: bigint;
  globalRemainder: bigint;
  accrued: bigint;
  paid: bigint;
  liability: bigint;
  activeReserve: bigint;
  protocolFees: bigint;
  custody: bigint;
  retiredRemainders: RetiredGlobalRemainder[];
};

function positive(value: bigint, name: string): void {
  if (value <= 0n) throw new Error(`${name} must be positive`);
}

function nonNegative(value: bigint, name: string): void {
  if (value < 0n) throw new Error(`${name} must not be negative`);
}

function ceilDiv(value: bigint, denominator: bigint): bigint {
  if (value === 0n) return 0n;
  return (value + denominator - 1n) / denominator;
}

/**
 * Dependency-free reference model for pool-bound fungible LP accounting.
 * SCALE is deliberately configurable; this model does not select Q128.
 */
export class FungibleLpFeeModel {
  readonly scale: bigint;
  readonly poolAuthority: string;

  private total = 0n;
  private generation = 0n;
  private readonly holders = new Map<string, HolderState>();
  private readonly allowances = new Map<string, Map<string, bigint>>();
  private readonly locks = new Map<string, LockRecord>();
  private readonly sides: [SideState, SideState] = [this.newSide(), this.newSide()];

  constructor(scale: bigint, poolAuthority = "pool") {
    positive(scale, "scale");
    this.scale = scale;
    this.poolAuthority = poolAuthority;
  }

  totalShares(): bigint {
    return this.total;
  }

  generationId(): bigint {
    return this.generation;
  }

  balanceOf(account: string): bigint {
    return this.holder(account).balance;
  }

  lockedOf(account: string): bigint {
    let locked = 0n;
    for (const record of this.locks.values()) {
      if (record.active && record.owner === account) locked += record.amount;
    }
    return locked;
  }

  unlockedOf(account: string): bigint {
    return this.balanceOf(account) - this.lockedOf(account);
  }

  claimableOf(account: string, side: FeeSide): bigint {
    this.settle(account);
    return this.holder(account).claimable[side];
  }

  checkpointOf(account: string, side: FeeSide): bigint {
    return this.holder(account).checkpoint[side];
  }

  carryOf(account: string, side: FeeSide): bigint {
    this.settle(account);
    return this.holder(account).carry[side];
  }

  approve(owner: string, spender: string, amount: bigint): void {
    nonNegative(amount, "allowance");
    let ownerAllowances = this.allowances.get(owner);
    if (!ownerAllowances) {
      ownerAllowances = new Map<string, bigint>();
      this.allowances.set(owner, ownerAllowances);
    }
    ownerAllowances.set(spender, amount);
  }

  allowance(owner: string, spender: string): bigint {
    return this.allowances.get(owner)?.get(spender) ?? 0n;
  }

  mint(caller: string, account: string, amount: bigint): void {
    this.requirePool(caller);
    positive(amount, "mint amount");
    this.settle(account);
    if (this.total + amount > this.scale) {
      throw new Error("total shares exceed the modeled SCALE bound");
    }
    this.holder(account).balance += amount;
    this.total += amount;
  }

  burn(caller: string, account: string, amount: bigint): void {
    this.requirePool(caller);
    positive(amount, "burn amount");
    this.settle(account);
    this.requireUnlocked(account, amount);
    const holder = this.holder(account);
    holder.balance -= amount;
    this.total -= amount;
    if (this.total === 0n) this.retireZeroSupplyRemainders();
  }

  transfer(sender: string, recipient: string, amount: bigint): void {
    this.move(sender, recipient, amount);
  }

  transferFrom(spender: string, owner: string, recipient: string, amount: bigint): void {
    positive(amount, "transfer amount");
    const current = this.allowance(owner, spender);
    if (current < amount) throw new Error("insufficient allowance");
    this.allowances.get(owner)!.set(spender, current - amount);
    this.move(owner, recipient, amount);
  }

  lock(
    caller: string,
    lockId: string,
    owner: string,
    amount: bigint,
    unlockAt: bigint,
    permanent: boolean,
  ): void {
    this.requirePool(caller);
    positive(amount, "lock amount");
    nonNegative(unlockAt, "unlock time");
    if (this.locks.has(lockId)) throw new Error("lock already exists");
    this.settle(owner);
    this.requireUnlocked(owner, amount);
    this.locks.set(lockId, { owner, amount, unlockAt, permanent, active: true });
  }

  unlock(caller: string, lockId: string, now: bigint): void {
    this.requirePool(caller);
    nonNegative(now, "current time");
    const record = this.locks.get(lockId);
    if (!record?.active) throw new Error("unknown lock");
    if (record.permanent) throw new Error("permanent lock");
    if (now < record.unlockAt) throw new Error("lock not matured");
    record.active = false;
  }

  creditPrincipal(caller: string, side: FeeSide, amount: bigint): void {
    this.requirePool(caller);
    nonNegative(amount, "principal amount");
    const state = this.sides[side];
    state.activeReserve += amount;
    state.custody += amount;
  }

  recordSwapFees(
    caller: string,
    side: FeeSide,
    netInput: bigint,
    protocolFee: bigint,
    lpFee: bigint,
  ): void {
    this.requirePool(caller);
    nonNegative(netInput, "net input");
    nonNegative(protocolFee, "protocol fee");
    nonNegative(lpFee, "LP fee");
    if (lpFee > 0n && this.total === 0n) {
      throw new Error("cannot accrue LP fees with zero shares");
    }

    const state = this.sides[side];
    state.activeReserve += netInput;
    state.protocolFees += protocolFee;
    state.custody += netInput + protocolFee + lpFee;
    if (lpFee === 0n) return;

    const globalNumerator = lpFee * this.scale + state.globalRemainder;
    const growthDelta = globalNumerator / this.total;
    state.globalRemainder = globalNumerator % this.total;
    state.growth += growthDelta;
    state.accrued += lpFee;
    state.liability += lpFee;
  }

  consumeClaim(caller: string, owner: string, side: FeeSide): bigint {
    this.requirePool(caller);
    this.settle(owner);
    const holder = this.holder(owner);
    const amount = holder.claimable[side];
    holder.claimable[side] = 0n;
    const state = this.sides[side];
    if (amount > state.liability) throw new Error("claim exceeds LP liability");
    state.liability -= amount;
    state.paid += amount;
    state.custody -= amount;
    return amount;
  }

  retiredRemainders(side: FeeSide): readonly RetiredGlobalRemainder[] {
    return Object.freeze([...this.sides[side].retiredRemainders]);
  }

  audit(side: FeeSide): FeeAudit {
    for (const account of this.holders.keys()) this.settle(account);
    const state = this.sides[side];
    let outstanding = 0n;
    let carryUpperBound = 0n;
    for (const holder of this.holders.values()) {
      outstanding += holder.claimable[side];
      if (holder.carry[side] !== 0n) carryUpperBound += 1n;
    }
    const activeGlobalBound = ceilDiv(state.globalRemainder, this.scale);
    const retiredGlobalBound = state.retiredRemainders.reduce(
      (sum, remainder) => sum + ceilDiv(remainder.numerator, this.scale),
      0n,
    );
    if (state.paid + outstanding > state.accrued) {
      throw new Error("paid plus outstanding exceeds accrued LP fees");
    }
    const explicitDust = state.accrued - state.paid - outstanding;
    const dustUpperBound = carryUpperBound + activeGlobalBound + retiredGlobalBound;
    if (explicitDust > dustUpperBound) {
      throw new Error("LP fee dust exceeds its explicit bound");
    }
    if (state.liability !== outstanding + explicitDust) {
      throw new Error("LP liability is not conserved");
    }
    if (state.custody !== state.activeReserve + state.protocolFees + state.liability) {
      throw new Error("custody, reserves and liabilities diverged");
    }
    return Object.freeze({
      accrued: state.accrued,
      paid: state.paid,
      outstanding,
      explicitDust,
      dustUpperBound,
      liability: state.liability,
      activeReserve: state.activeReserve,
      protocolFees: state.protocolFees,
      custody: state.custody,
    });
  }

  private newSide(): SideState {
    return {
      growth: 0n,
      globalRemainder: 0n,
      accrued: 0n,
      paid: 0n,
      liability: 0n,
      activeReserve: 0n,
      protocolFees: 0n,
      custody: 0n,
      retiredRemainders: [],
    };
  }

  private holder(account: string): HolderState {
    let holder = this.holders.get(account);
    if (!holder) {
      holder = {
        balance: 0n,
        checkpoint: [this.sides[0].growth, this.sides[1].growth],
        carry: [0n, 0n],
        claimable: [0n, 0n],
      };
      this.holders.set(account, holder);
    }
    return holder;
  }

  private settle(account: string): void {
    const holder = this.holder(account);
    for (const side of [0, 1] as const) {
      const state = this.sides[side];
      const delta = state.growth - holder.checkpoint[side];
      if (delta < 0n) throw new Error("fee growth moved backwards");
      const holderNumerator = holder.balance * delta + holder.carry[side];
      const newClaim = holderNumerator / this.scale;
      holder.carry[side] = holderNumerator % this.scale;
      holder.claimable[side] += newClaim;
      holder.checkpoint[side] = state.growth;
    }
  }

  private move(sender: string, recipient: string, amount: bigint): void {
    positive(amount, "transfer amount");
    if (sender === recipient) throw new Error("self transfer");
    this.settle(sender);
    this.settle(recipient);
    this.requireUnlocked(sender, amount);
    this.holder(sender).balance -= amount;
    this.holder(recipient).balance += amount;
  }

  private requireUnlocked(account: string, amount: bigint): void {
    if (amount > this.unlockedOf(account)) {
      throw new Error("locked principal is unavailable");
    }
  }

  private retireZeroSupplyRemainders(): void {
    for (const state of this.sides) {
      if (state.globalRemainder !== 0n) {
        state.retiredRemainders.push(Object.freeze({
          generation: this.generation,
          numerator: state.globalRemainder,
          denominator: this.scale,
        }));
      }
      state.globalRemainder = 0n;
    }
    this.generation += 1n;
  }

  private requirePool(caller: string): void {
    if (caller !== this.poolAuthority) throw new Error("pool authority required");
  }
}
