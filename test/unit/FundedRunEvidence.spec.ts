import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "../../hardhat/runtime.js";
import { Interface, TypedDataEncoder, Wallet, ZeroAddress, keccak256 } from "ethers";

import { FundedRecoveryJournal } from "../../scripts/funded-recovery-journal";
import {
  readFundedRunEvidence,
  requireFeeCollectionMaturityEvidence,
  requireProtectedPoolLifecycleOrder,
  validateFundedRunEvidence,
  requireOnchainSemanticBindings,
  verifyFundedRunEvidence,
  writeFundedRunEvidence,
  writePreparedFundedRunEvidence,
} from "../../scripts/funded-run-evidence";
import {
  CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI,
  CONFIDENTIAL_CPMM_ABI,
  CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI,
  LAUNCH_COMMITMENT_EIP712_TYPES,
  LAUNCH_INITIALIZATION_EIP712_DOMAIN,
} from "../../sdk/src/index";
import { verifyDeployedRuntimeArtifactWithProvenance } from "../../scripts/runtime-artifact";

const RECOVERY_KEY = `0x${"dd".repeat(32)}`;

describe("funded run evidence", function () {
  let directory: string;

  beforeEach(function () {
    directory = mkdtempSync(join(tmpdir(), "cipherdex-funded-evidence-"));
  });

  afterEach(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires replay and caller-isolation failures to match successful controls", function () {
    const router = `0x${"10".repeat(20)}`;
    const tokenA = `0x${"20".repeat(20)}`;
    const tokenB = `0x${"30".repeat(20)}`;
    const caller = `0x${"40".repeat(20)}`;
    const otherCaller = `0x${"50".repeat(20)}`;
    const pool5 = `0x${"60".repeat(20)}`;
    const pool30 = `0x${"70".repeat(20)}`;
    const pool100 = `0x${"80".repeat(20)}`;
    const strategy = `0x${"90".repeat(20)}`;
    const iface = new Interface(CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI);
    const bitmap = 0b001_010_001;
    const encrypted = (seed: bigint) => [[seed, seed + 1n], `0x${seed.toString(16).padStart(2, "0")}`];
    const requestId = (seed: string) => `0x${seed.repeat(64)}`;
    const quoteData = (input: unknown, id: string, deadline: bigint) =>
      iface.encodeFunctionData("requestBestQuoteExactInputWithCandidates", [
        tokenA,
        tokenB,
        input,
        bitmap,
        id,
        deadline,
      ]);
    const resultLog = (eventCaller: string, id: string) => {
      const encoded = iface.encodeEventLog(
        iface.getEvent("ConfidentialBestQuoteResult")!,
        [eventCaller, id, pool100, 100, ZeroAddress, bitmap, true, [1n, 2n]],
      );
      return { address: router, topics: encoded.topics, data: encoded.data };
    };
    const tx = (
      label: string,
      status: 0 | 1,
      from: string,
      data: string,
      blockNumber: number,
      logs: readonly { address: string; topics: readonly string[]; data: string }[] = [],
      blockTimestamp = 100,
      transactionIndex = 0,
    ) => ({
      label,
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      status,
      from,
      to: router,
      data,
      contractAddress: null,
      blockNumber,
      transactionIndex,
      blockTimestamp,
      logs,
    }) as const;

    const referenceInput = encrypted(1n);
    const referenceId = requestId("1");
    const callerInput = encrypted(4n);
    const callerId = requestId("4");
    const transactions = [
      tx(
        "two-candidate quote with uninitialized tier",
        1,
        caller,
        quoteData(referenceInput, referenceId, 200n),
        1,
        [resultLog(caller, referenceId)],
      ),
      tx("best quote request-id replay", 0, caller, quoteData(encrypted(2n), referenceId, 200n), 2),
      tx("best quote ciphertext replay", 0, caller, quoteData(referenceInput, requestId("2"), 200n), 3),
      tx("best quote expired deadline", 0, caller, quoteData(encrypted(3n), requestId("3"), 99n), 4),
      tx("caller-bound ciphertext isolation", 0, otherCaller, quoteData(callerInput, callerId, 200n), 5),
      tx(
        "caller-bound ciphertext primary control",
        1,
        caller,
        quoteData(callerInput, callerId, 200n),
        6,
        [resultLog(caller, callerId)],
      ),
    ];
    const configuration = {
      candidateBitmap: bitmap,
      tokenA,
      tokenB,
    };
    const artifacts = [
      { label: "5 bps standard canonical pool", address: pool5 },
      { label: "30 bps launch-protected canonical pool", address: pool30 },
      { label: "100 bps standard canonical pool", address: pool100 },
      { label: "disposable launch initialization strategy", address: strategy },
    ];

    expect(() => requireOnchainSemanticBindings(
      "best-execution",
      configuration,
      transactions,
      artifacts,
      [caller, otherCaller],
    )).not.to.throw();

    const unrelatedControl = transactions.map((transaction) =>
      transaction.label === "caller-bound ciphertext primary control"
        ? { ...transaction, data: quoteData(encrypted(9n), callerId, 200n) }
        : transaction
    );
    expect(() => requireOnchainSemanticBindings(
      "best-execution",
      configuration,
      unrelatedControl,
      artifacts,
      [caller, otherCaller],
    )).to.throw("lacks its successful control");

    const reversedSameBlockReplay = transactions.map((transaction) => {
      if (transaction.label === "two-candidate quote with uninitialized tier") {
        return { ...transaction, blockNumber: 7, transactionIndex: 2 };
      }
      if (transaction.label === "best quote request-id replay") {
        return { ...transaction, blockNumber: 7, transactionIndex: 1 };
      }
      return transaction;
    });
    expect(() => requireOnchainSemanticBindings(
      "best-execution",
      configuration,
      reversedSameBlockReplay,
      artifacts,
      [caller, otherCaller],
    )).to.throw("request-id replay is not correlated");
  });

  it("requires a mined premature fee rejection before collection readiness", function () {
    const pool = `0x${"91".repeat(20)}`;
    const caller = `0x${"92".repeat(20)}`;
    const iface = new Interface(CONFIDENTIAL_CPMM_ABI);
    const data = iface.encodeFunctionData("collectProtocolFees", [true, true]);
    const transaction = (
      label: string,
      status: 0 | 1,
      blockNumber: number,
      blockTimestamp: number,
    ) => ({
      label,
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      status,
      from: caller,
      to: pool,
      data,
      contractAddress: null,
      blockNumber,
      transactionIndex: 0,
      blockTimestamp,
      logs: [],
    }) as const;
    const premature = transaction(
      "premature confidential protocol fee collection",
      0,
      10,
      1_099,
    );
    const mature = transaction(
      "mature confidential protocol fee collection",
      1,
      11,
      1_100,
    );

    expect(() => requireFeeCollectionMaturityEvidence(
      { collectionReadyAt: 1_100 },
      pool,
      premature,
      mature,
    )).not.to.throw();
    expect(() => requireFeeCollectionMaturityEvidence(
      { collectionReadyAt: 1_100 },
      pool,
      { ...premature, blockTimestamp: 1_100 },
      mature,
    )).to.throw("not chain-ordered around readyAt");
    expect(() => requireFeeCollectionMaturityEvidence(
      { collectionReadyAt: 1_100 },
      pool,
      premature,
      { ...mature, status: 0 },
    )).to.throw("not chain-ordered around readyAt");
  });

  it("requires the complete protected-pool lifecycle to be chain ordered", function () {
    const pool = `0x${"93".repeat(20)}`;
    const actor = `0x${"94".repeat(20)}`;
    const transaction = (
      label: string,
      blockNumber: number,
      transactionIndex: number,
      to = pool,
    ) => ({
      label,
      hash: `0x${(blockNumber * 10 + transactionIndex).toString(16).padStart(64, "0")}`,
      status: 1 as const,
      from: actor,
      to,
      data: "0x12345678",
      contractAddress: null,
      blockNumber,
      transactionIndex,
      blockTimestamp: 1_000 + blockNumber,
      logs: [],
    });
    const lifecycle = {
      poolAddress: pool,
      commitment: transaction("commit", 10, 0, `0x${"95".repeat(20)}`),
      rejectedProbe: { ...transaction("reject", 10, 1, `0x${"96".repeat(20)}`), status: 0 as const },
      migration: transaction("migration", 11, 0, `0x${"96".repeat(20)}`),
      replay: { ...transaction("replay", 11, 1, `0x${"96".repeat(20)}`), status: 0 as const },
      firstExit: transaction("first exit", 12, 0),
      reseed: transaction("reseed", 12, 1),
      finalExit: transaction("final exit", 13, 0),
    };

    expect(() => requireProtectedPoolLifecycleOrder(lifecycle)).not.to.throw();
    expect(() => requireProtectedPoolLifecycleOrder({
      ...lifecycle,
      reseed: { ...lifecycle.reseed, transactionIndex: 0 },
    })).to.throw("not strictly commit/reject/migrate/replay/exit/reseed/exit ordered");
    expect(() => requireProtectedPoolLifecycleOrder({
      ...lifecycle,
      finalExit: { ...lifecycle.finalExit, to: `0x${"97".repeat(20)}` },
    })).to.throw("not strictly commit/reject/migrate/replay/exit/reseed/exit ordered");
  });

  it("binds every funded best-execution tier, direction, and protected launch authorization", async function () {
    const creator = Wallet.createRandom();
    const authority = Wallet.createRandom();
    const otherCaller = Wallet.createRandom();
    const router = `0x${"10".repeat(20)}`;
    const tokenA = `0x${"20".repeat(20)}`;
    const tokenB = `0x${"30".repeat(20)}`;
    const pool5 = `0x${"60".repeat(20)}`;
    const pool30 = `0x${"70".repeat(20)}`;
    const pool100 = `0x${"80".repeat(20)}`;
    const strategy = `0x${"90".repeat(20)}`;
    const factory = `0x${"a0".repeat(20)}`;
    const migrator = `0x${"b0".repeat(20)}`;
    const chainId = 7_082_400n;
    const bitmap = 0b001_010_001;
    const mixedTwoBitmap = bitmap & ~1;
    const routerInterface = new Interface(CONFIDENTIAL_BEST_EXECUTION_ROUTER_ABI);
    const strategyInterface = new Interface(CONFIDENTIAL_INITIALIZATION_STRATEGY_ABI);
    const encrypted = (seed: bigint) => [
      [seed, seed + 1n],
      `0x${seed.toString(16).padStart(2, "0")}`,
    ];
    const requestId = (seed: number) =>
      `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
    const quoteData = (
      tokenIn: string,
      tokenOut: string,
      input: unknown,
      candidateBitmap: number,
      id: string,
      deadline: bigint,
    ) => routerInterface.encodeFunctionData("requestBestQuoteExactInputWithCandidates", [
      tokenIn,
      tokenOut,
      input,
      candidateBitmap,
      id,
      deadline,
    ]);
    const swapData = (
      tokenIn: string,
      tokenOut: string,
      input: unknown,
      minimum: unknown,
      candidateBitmap: number,
      id: string,
      deadline: bigint,
    ) => routerInterface.encodeFunctionData("swapBestExactInputWithCandidates", [
      tokenIn,
      tokenOut,
      input,
      minimum,
      candidateBitmap,
      id,
      deadline,
    ]);
    const resultLog = (
      eventName: "ConfidentialBestQuoteResult" | "ConfidentialBestSwapResult",
      caller: string,
      id: string,
      feeBps: 5 | 30 | 100,
      candidateBitmap: number,
      zeroForOne: boolean,
    ) => {
      const selectedPool = feeBps === 5 ? pool5 : feeBps === 30 ? pool30 : pool100;
      const encoded = routerInterface.encodeEventLog(routerInterface.getEvent(eventName)!, [
        caller,
        id,
        selectedPool,
        feeBps,
        feeBps === 30 ? strategy : ZeroAddress,
        candidateBitmap,
        zeroForOne,
        [1n, 2n],
      ]);
      return { address: router, topics: encoded.topics, data: encoded.data };
    };
    let transactionSeed = 1;
    const transaction = (
      label: string,
      status: 0 | 1,
      from: string,
      to: string,
      data: string,
      logs: readonly { address: string; topics: readonly string[]; data: string }[] = [],
      blockTimestamp = 100,
    ) => {
      const blockNumber = transactionSeed;
      transactionSeed += 1;
      return {
        label,
        hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
        status,
        from,
        to,
        data,
        contractAddress: null,
        blockNumber,
        transactionIndex: 0,
        blockTimestamp,
        logs,
      } as const;
    };

    const commitment = {
      launchId: requestId(240),
      creator: creator.address,
      token0: tokenA,
      token1: tokenB,
      decimals0: 18,
      decimals1: 6,
      feeBps: 30n,
      privacyMode: 1,
      poolVersion: 3n,
      factory,
      migrator,
      initializationStrategy: strategy,
      launchAuthority: authority.address,
      chainId,
      authorizationDeadline: 10_000n,
      migrationDeadline: 10_000n,
    } as const;
    const launchDomain = {
      ...LAUNCH_INITIALIZATION_EIP712_DOMAIN,
      chainId,
      verifyingContract: strategy,
    } as const;
    const launchTypes = { LaunchCommitment: [...LAUNCH_COMMITMENT_EIP712_TYPES] };
    const [creatorAuthorization, authorityAuthorization] = await Promise.all([
      creator.signTypedData(launchDomain, launchTypes, commitment),
      authority.signTypedData(launchDomain, launchTypes, commitment),
    ]);
    const commitmentHash = TypedDataEncoder.hash(launchDomain, launchTypes, commitment);
    const committed = strategyInterface.encodeEventLog(
      strategyInterface.getEvent("LaunchCommitted")!,
      [commitment.launchId, requestId(241), pool30, creator.address, 10_000n, commitmentHash],
    );
    const transactions = [
      transaction(
        "commit protected 30 bps launch",
        1,
        creator.address,
        strategy,
        strategyInterface.encodeFunctionData("commitLaunch", [
          commitment,
          creatorAuthorization,
          authorityAuthorization,
        ]),
        [{ address: strategy, topics: committed.topics, data: committed.data }],
      ),
    ];
    const addQuote = (
      label: string,
      feeBps: 5 | 30 | 100,
      candidateBitmap: number,
      tokenIn = tokenB,
      tokenOut = tokenA,
    ) => {
      const id = requestId(transactionSeed + 20);
      transactions.push(transaction(
        label,
        1,
        creator.address,
        router,
        quoteData(tokenIn, tokenOut, encrypted(BigInt(transactionSeed)), candidateBitmap, id, 1_000n),
        [resultLog(
          "ConfidentialBestQuoteResult",
          creator.address,
          id,
          feeBps,
          candidateBitmap,
          tokenIn.toLowerCase() < tokenOut.toLowerCase(),
        )],
      ));
    };
    const addSwap = (
      label: string,
      feeBps: 5 | 30 | 100,
      candidateBitmap: number,
      tokenIn = tokenB,
      tokenOut = tokenA,
    ) => {
      const id = requestId(transactionSeed + 40);
      transactions.push(transaction(
        label,
        1,
        creator.address,
        router,
        swapData(
          tokenIn,
          tokenOut,
          encrypted(BigInt(transactionSeed)),
          encrypted(BigInt(transactionSeed + 100)),
          candidateBitmap,
          id,
          1_000n,
        ),
        [resultLog(
          "ConfidentialBestSwapResult",
          creator.address,
          id,
          feeBps,
          candidateBitmap,
          tokenIn.toLowerCase() < tokenOut.toLowerCase(),
        )],
      ));
    };

    addQuote("two-candidate quote with absent tier", 100, mixedTwoBitmap);
    const referenceInput = encrypted(50n);
    const referenceId = requestId(50);
    transactions.push(transaction(
      "two-candidate quote with uninitialized tier",
      1,
      creator.address,
      router,
      quoteData(tokenB, tokenA, referenceInput, bitmap, referenceId, 1_000n),
      [resultLog("ConfidentialBestQuoteResult", creator.address, referenceId, 100, bitmap, false)],
    ));
    transactions.push(transaction(
      "best quote request-id replay",
      0,
      creator.address,
      router,
      quoteData(tokenB, tokenA, encrypted(51n), bitmap, referenceId, 1_000n),
    ));
    transactions.push(transaction(
      "best quote ciphertext replay",
      0,
      creator.address,
      router,
      quoteData(tokenB, tokenA, referenceInput, bitmap, requestId(51), 1_000n),
    ));
    transactions.push(transaction(
      "best quote expired deadline",
      0,
      creator.address,
      router,
      quoteData(tokenB, tokenA, encrypted(52n), bitmap, requestId(52), 99n),
    ));
    const callerInput = encrypted(53n);
    const callerId = requestId(53);
    transactions.push(transaction(
      "caller-bound ciphertext isolation",
      0,
      otherCaller.address,
      router,
      quoteData(tokenB, tokenA, callerInput, bitmap, callerId, 1_000n),
    ));
    transactions.push(transaction(
      "caller-bound ciphertext primary control",
      1,
      creator.address,
      router,
      quoteData(tokenB, tokenA, callerInput, bitmap, callerId, 1_000n),
      [resultLog("ConfidentialBestQuoteResult", creator.address, callerId, 100, bitmap, false)],
    ));
    addSwap("two-candidate quote-plus-swap", 100, bitmap);
    addQuote("three-candidate quote", 5, bitmap);
    addSwap("three-candidate quote-plus-swap", 5, bitmap);
    addQuote("post-tie 30 bps selection quote", 30, bitmap);
    addSwap("post-tie 30 bps quote-plus-swap", 30, bitmap);
    addQuote("encrypted-invalid candidate isolation quote", 100, bitmap);
    addQuote("reverse three-candidate quote", 30, bitmap, tokenA, tokenB);
    addSwap("reverse three-candidate quote-plus-swap", 30, bitmap, tokenA, tokenB);

    const configuration = {
      candidateBitmap: bitmap,
      chainId: Number(chainId),
      confidentialPoolVersion: 3,
      privacyMode: 1,
      tokenA,
      tokenB,
    };
    const artifacts = [
      { label: "5 bps standard canonical pool", address: pool5 },
      { label: "30 bps launch-protected canonical pool", address: pool30 },
      { label: "100 bps standard canonical pool", address: pool100 },
      { label: "disposable launch initialization strategy", address: strategy },
      { label: "disposable confidential factory", address: factory },
      { label: "disposable launchpad migrator", address: migrator },
    ];
    const participants = [creator.address, authority.address, otherCaller.address];
    expect(() => requireOnchainSemanticBindings(
      "best-execution",
      configuration,
      transactions,
      artifacts,
      participants,
    )).not.to.throw();

    const tampered = transactions.map((candidate) =>
      candidate.label === "post-tie 30 bps quote-plus-swap"
        ? { ...candidate, logs: [] }
        : candidate
    );
    expect(() => requireOnchainSemanticBindings(
      "best-execution",
      configuration,
      tampered,
      artifacts,
      participants,
    )).to.throw("result event is missing or ambiguous");
  });

  it("binds public run evidence to source, receipts, blocks, and runtime artifacts", async function () {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockERC20");
    const contract = await factory.deploy("Evidence Token", "EVD", 18);
    const transaction = contract.deploymentTransaction();
    expect(transaction).to.not.equal(null);
    const receipt = await transaction!.wait();
    expect(receipt?.status).to.equal(1);
    const address = await contract.getAddress();
    const sourceCommit = "a".repeat(40);
    const deployment = {
      recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
      recordSha256: "b".repeat(64),
      manifestCommit: "c".repeat(40),
      sourceCommit,
    } as const;
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    journal.recordObservedMinedTransaction(
      "mock deployment",
      transaction!.hash,
      receipt!.blockNumber,
    );
    journal.recordResource({
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction!.hash,
      metadata: { contractName: "MockERC20" },
    });
    journal.markRecovered("mock-contract", [transaction!.hash]);
    const evidencePlan = {
      participants: [owner.address],
      configuration: {
        chainId: 31_337,
        protocolVersion: 1,
        privacyMode: "test",
      },
      artifacts: [{
        label: "mock token",
        contractName: "MockERC20",
        address,
        creationTransactionHash: transaction!.hash,
        constructorArguments: ["Evidence Token", "EVD", 18],
      }],
      assertions: ["deployment mined", "resource recovered"],
    } as const;
    journal.prepareEvidence(evidencePlan);

    let constructorError: unknown;
    try {
      await writeFundedRunEvidence({
        journal,
        provider: ethers.provider,
        attestationSigner: owner,
        ...evidencePlan,
        artifacts: [{
          ...evidencePlan.artifacts[0],
          constructorArguments: ["Evidence Token", "BAD", 18],
        }],
        directory: join(directory, "invalid-evidence"),
      });
    } catch (error) {
      constructorError = error;
    }
    expect(constructorError).to.be.instanceOf(Error);
    expect((constructorError as Error).message).to.contain(
      "constructor calldata is invalid",
    );

    const result = await writeFundedRunEvidence({
      journal,
      provider: ethers.provider,
      attestationSigner: owner,
      ...evidencePlan,
      directory: join(directory, "evidence"),
    });

    const evidence = readFundedRunEvidence(result.path);
    expect(evidence.sourceCommit).to.equal(sourceCommit);
    expect(evidence.transactions).to.have.length(1);
    expect(evidence.transactions[0].blockHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(evidence.artifacts[0].runtimeCodehash).to.match(/^0x[0-9a-f]{64}$/);
    expect(evidence.recoveredResources).to.deep.equal([{
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction!.hash,
      recoveryTransactionHashes: [transaction!.hash],
      metadata: { contractName: "MockERC20" },
    }]);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).to.deep.equal(evidence);
    await verifyFundedRunEvidence(evidence, ethers.provider);
  });

  it("reports immutable slots so evidence cannot silently treat them as ordinary bytes", async function () {
    const [owner] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("CipherDEXFeeVault"))
      .deploy(owner.address);
    await vault.waitForDeployment();
    const provenance = await verifyDeployedRuntimeArtifactWithProvenance(
      "CipherDEXFeeVault",
      await vault.getAddress(),
    );
    expect(provenance.immutableReferenceCount).to.be.greaterThan(0);
  });

  it("refuses evidence while any transaction outcome remains unresolved", async function () {
    const [owner] = await ethers.getSigners();
    const journal = FundedRecoveryJournal.open({
      runner: "unresolved-test",
      sourceCommit: "b".repeat(40),
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${"b".repeat(40)}.json`,
        recordSha256: "c".repeat(64),
        manifestCommit: "d".repeat(40),
        sourceCommit: "b".repeat(40),
      },
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    const signedTransaction = "0x12";
    const transactionHash = keccak256(signedTransaction);
    journal.recordPreparedTransaction("unknown transaction", transactionHash, signedTransaction);
    journal.recordBroadcast("unknown transaction", transactionHash);
    let error: unknown;
    try {
      journal.prepareEvidence({
        participants: [owner.address],
        configuration: { chainId: 31_337 },
        artifacts: [{
          label: "unavailable artifact",
          contractName: "MockERC20",
          address: owner.address,
        }],
        assertions: ["must not write"],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("terminal transactions");
  });

  it("refuses evidence before the journal is passed even after recovery", async function () {
    const [owner] = await ethers.getSigners();
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit: "d".repeat(40),
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${"d".repeat(40)}.json`,
        recordSha256: "e".repeat(64),
        manifestCommit: "f".repeat(40),
        sourceCommit: "d".repeat(40),
      },
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    let error: unknown;
    try {
      await writeFundedRunEvidence({
        journal,
        provider: ethers.provider,
        attestationSigner: owner,
        participants: [owner.address],
        configuration: { chainId: 31_337, privacyMode: "test", protocolVersion: 1 },
        artifacts: [],
        assertions: ["deployment mined", "resource recovered"],
        directory: join(directory, "evidence"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("durable pending evidence plan");
  });

  it("refuses evidence while a locally signed transaction remains unresolved", async function () {
    const [owner] = await ethers.getSigners();
    const sourceCommit = "e".repeat(40);
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
        recordSha256: "1".repeat(64),
        manifestCommit: "2".repeat(40),
        sourceCommit,
      },
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    const signedTransaction = "0x34";
    journal.recordPreparedTransaction(
      "unresolved operation",
      keccak256(signedTransaction),
      signedTransaction,
    );
    let error: unknown;
    try {
      journal.prepareEvidence({
        participants: [owner.address],
        configuration: { chainId: 31_337, privacyMode: "test", protocolVersion: 1 },
        artifacts: [],
        assertions: ["deployment mined", "resource recovered"],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain("terminal transactions");
  });

  it("rejects tampered participants, targets, and semantic assertions", async function () {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockERC20");
    const contract = await factory.deploy("Evidence Token", "EVD", 18);
    const transaction = contract.deploymentTransaction()!;
    const receipt = await transaction.wait();
    const address = await contract.getAddress();
    const sourceCommit = "1".repeat(40);
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment: {
        recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
        recordSha256: "2".repeat(64),
        manifestCommit: "3".repeat(40),
        sourceCommit,
      },
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    journal.recordObservedMinedTransaction(
      "mock deployment",
      transaction.hash,
      receipt!.blockNumber,
    );
    journal.recordResource({
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction.hash,
      metadata: { contractName: "MockERC20" },
    });
    journal.markRecovered("mock-contract", [transaction.hash]);
    const evidencePlan = {
      participants: [owner.address],
      configuration: { chainId: 31_337, privacyMode: "test", protocolVersion: 1 },
      artifacts: [{
        label: "mock token",
        contractName: "MockERC20",
        address,
        creationTransactionHash: transaction.hash,
        constructorArguments: ["Evidence Token", "EVD", 18],
      }],
      assertions: ["deployment mined", "resource recovered"],
    } as const;
    journal.prepareEvidence(evidencePlan);
    const { evidence } = await writeFundedRunEvidence({
      journal,
      provider: ethers.provider,
      attestationSigner: owner,
      ...evidencePlan,
      directory: join(directory, "evidence"),
    });
    const clone = () => JSON.parse(JSON.stringify(evidence));

    const unreviewedSender = clone();
    unreviewedSender.transactions[0].from = `0x${"44".repeat(20)}`;
    expect(() => validateFundedRunEvidence(unreviewedSender)).to.throw(
      "sender is not a reviewed participant",
    );

    const relabeledWrongSelector = clone();
    relabeledWrongSelector.transactions[0].selector = "0x12345678";
    expect(() => validateFundedRunEvidence(relabeledWrongSelector)).to.throw(
      "lacks a selector-bound semantic transaction",
    );

    const rightSelectorWrongTarget = clone();
    rightSelectorWrongTarget.transactions[0].to = `0x${"55".repeat(20)}`;
    rightSelectorWrongTarget.transactions[0].contractAddress = null;
    expect(() => validateFundedRunEvidence(rightSelectorWrongTarget)).to.throw(
      "lacks a selector-bound semantic transaction",
    );

    const assertions = clone();
    assertions.assertions = ["deployment mined", "unreviewed claim"];
    expect(() => validateFundedRunEvidence(assertions)).to.throw(
      "assertions do not match runner policy",
    );

    const signature = clone();
    signature.attestation.signature = `0x${"11".repeat(65)}`;
    expect(() => validateFundedRunEvidence(signature)).to.throw(
      "owner attestation is invalid",
    );
  });

  it("resumes failed evidence generation without repeating paid execution", async function () {
    const [owner] = await ethers.getSigners();
    const contract = await (await ethers.getContractFactory("MockERC20"))
      .deploy("Evidence Token", "EVD", 18);
    const transaction = contract.deploymentTransaction()!;
    const receipt = await transaction.wait();
    const address = await contract.getAddress();
    const sourceCommit = "9".repeat(40);
    const deployment = {
      recordPath: `deployments/coti-testnet-${sourceCommit}.json`,
      recordSha256: "8".repeat(64),
      manifestCommit: "7".repeat(40),
      sourceCommit,
    } as const;
    const journal = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    journal.recordObservedMinedTransaction("mock deployment", transaction.hash, receipt!.blockNumber);
    journal.recordResource({
      id: "mock-contract",
      kind: "disposable-contract",
      address,
      creationTransactionHash: transaction.hash,
      metadata: { contractName: "MockERC20" },
    });
    journal.markRecovered("mock-contract", [transaction.hash]);
    journal.prepareEvidence({
      participants: [owner.address],
      configuration: { chainId: 31_337, privacyMode: "test", protocolVersion: 1 },
      artifacts: [{
        label: "mock token",
        contractName: "MockERC20",
        address,
        creationTransactionHash: transaction.hash,
        constructorArguments: ["Evidence Token", "EVD", 18],
      }],
      assertions: ["deployment mined", "resource recovered"],
    });
    const transactionCount = journal.transactions.length;
    const failingProvider = {
      ...ethers.provider,
      getCode: async () => { throw new Error("temporary evidence backend failure"); },
    } as unknown as Parameters<typeof writePreparedFundedRunEvidence>[0]["provider"];
    let firstFailure: unknown;
    try {
      await writePreparedFundedRunEvidence({
        journal,
        provider: failingProvider,
        attestationSigner: owner,
        directory: join(directory, "evidence"),
      });
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).to.be.instanceOf(Error);
    expect(journal.runStatus).to.equal("evidence-failed");

    const resumed = FundedRecoveryJournal.open({
      runner: "evidence-test",
      sourceCommit,
      chainId: 31_337,
      owner: owner.address,
      deployment,
      recoveryKey: RECOVERY_KEY,
      directory,
    });
    const result = await writePreparedFundedRunEvidence({
      journal: resumed,
      provider: ethers.provider,
      attestationSigner: owner,
      directory: join(directory, "evidence"),
    });
    expect(result.evidence.outcome).to.equal("passed");
    expect(resumed.runStatus).to.equal("passed");
    expect(resumed.transactions).to.have.length(transactionCount);
  });
});
