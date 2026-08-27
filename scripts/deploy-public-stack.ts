import { BaseContract, ContractTransactionResponse } from "ethers";
import { ethers } from "../hardhat/runtime.js";
import {
  DeploymentRecordWriter,
  type DeploymentJournalTransaction,
  type MinedDeploymentEvidence,
  upsertMinedDeploymentTransaction,
} from "./deployment-record";
import {
  deployAndReport,
  requireCleanSourceCommit,
  requiredDeploymentRecordPath,
  submitDeploymentTransaction,
  TESTNET_DEPLOY_GAS_LIMITS,
  type DeploymentProfileName,
  type DeploymentResult,
} from "./deploy-protocol";
import {
  verifyDeployedRuntimeArtifactWithProvenance,
  type RuntimeArtifactProvenance,
} from "./runtime-artifact";
import {
  MinedTransactionStatusError,
  transactionHashFromError,
  UnknownBroadcastOutcomeError,
} from "./testnet-transaction-evidence";
import {
  FundedWallet,
  openFundedRecoveryJournal,
  openFundedRecoveryJournalWithSecret,
} from "./funded-transaction-wallet";
import type { FundedRecoveryJournal } from "./funded-recovery-journal";
import { requiredFundedRecoveryDirectory } from "./funded-runtime-state";
import {
  CastLedgerWallet,
  type ReviewedCastLedgerConfiguration,
} from "./cast-ledger-wallet";

const PROFILES = Object.freeze({
  "coti-testnet": Object.freeze({
    network: "cotiTestnet",
    chainId: 7_082_400n,
    recordSlug: "coti-testnet-public",
    production: false,
  }),
  "coti-mainnet": Object.freeze({
    network: "cotiMainnet",
    chainId: 2_632_500n,
    recordSlug: "coti-mainnet-public",
    production: true,
  }),
});

export const PUBLIC_STACK_MAX_GAS_UNITS =
  TESTNET_DEPLOY_GAS_LIMITS.feeVault +
  TESTNET_DEPLOY_GAS_LIMITS.publicFactory +
  TESTNET_DEPLOY_GAS_LIMITS.vaultBinding +
  TESTNET_DEPLOY_GAS_LIMITS.publicQuoter +
  TESTNET_DEPLOY_GAS_LIMITS.publicRouter +
  TESTNET_DEPLOY_GAS_LIMITS.publicLiquidityRouter +
  TESTNET_DEPLOY_GAS_LIMITS.wrappedNative +
  TESTNET_DEPLOY_GAS_LIMITS.publicNativeRouter;

type FeeVaultHandle = BaseContract & {
  beneficiary(): Promise<string>;
  confidentialFactory(): Promise<string>;
  publicFactory(): Promise<string>;
  setPublicFactory(
    address: string,
    overrides?: { gasLimit: bigint },
  ): Promise<ContractTransactionResponse>;
};

type PublicFactoryHandle = BaseContract & {
  PROTOCOL_VERSION(): Promise<bigint>;
  feeVault(): Promise<string>;
  lpTokenFactory(): Promise<string>;
};

type VersionedFactoryBoundHandle = BaseContract & {
  PROTOCOL_VERSION(): Promise<bigint>;
  factory(): Promise<string>;
};

type NativeRouterHandle = VersionedFactoryBoundHandle & {
  publicRouter(): Promise<string>;
  publicLiquidityRouter(): Promise<string>;
  wrappedNative(): Promise<string>;
};

const sameAddress = (actual: string, expected: string): boolean =>
  actual.toLowerCase() === expected.toLowerCase();

async function deploymentSigner(
  profileName: DeploymentProfileName,
  sourceCommit: string,
  chainId: number,
): Promise<{
  deployer: FundedWallet | CastLedgerWallet;
  journal: FundedRecoveryJournal;
  record: Record<string, unknown>;
}> {
  if (profileName === "coti-mainnet") {
    if (process.env.COTI_TESTNET_PRIVATE_KEY?.trim()) {
      throw new Error("mainnet public deployment refuses COTI_TESTNET_PRIVATE_KEY");
    }
    const approvedCommit = process.env.CIPHERDEX_MAINNET_APPROVED_COMMIT?.trim().toLowerCase();
    if (approvedCommit !== sourceCommit.toLowerCase()) {
      throw new Error("CIPHERDEX_MAINNET_APPROVED_COMMIT must equal the deployed source commit");
    }
    const rpcUrl = process.env.COTI_MAINNET_RPC_URL?.trim();
    if (!rpcUrl) throw new Error("COTI_MAINNET_RPC_URL is required for mainnet deployment");
    const ledgerAddress = process.env.CIPHERDEX_LEDGER_ADDRESS?.trim();
    const privateKey = process.env.COTI_MAINNET_PRIVATE_KEY?.trim();
    if (Boolean(ledgerAddress) === Boolean(privateKey)) {
      throw new Error(
        "configure exactly one mainnet signer: CIPHERDEX_LEDGER_ADDRESS or COTI_MAINNET_PRIVATE_KEY",
      );
    }
    const recoverySecret = process.env.CIPHERDEX_DEPLOYMENT_RECOVERY_KEY?.trim();
    if (!recoverySecret) throw new Error("CIPHERDEX_DEPLOYMENT_RECOVERY_KEY is required");

    let deployer: FundedWallet | CastLedgerWallet;
    let record: Record<string, unknown>;
    if (ledgerAddress) {
      if (!ethers.isAddress(ledgerAddress)) {
        throw new Error("CIPHERDEX_LEDGER_ADDRESS must be a valid address");
      }
      const configuration: ReviewedCastLedgerConfiguration = Object.freeze({
        executable: process.env.CIPHERDEX_CAST_PATH?.trim() ?? "",
        executableSha256: process.env.CIPHERDEX_CAST_SHA256?.trim() ?? "",
        ledgerAddress,
        derivationPath:
          process.env.CIPHERDEX_LEDGER_DERIVATION_PATH?.trim() ?? "m/44'/60'/0'/0/0",
        rpcUrl,
      });
      deployer = await CastLedgerWallet.create(configuration, ethers.provider);
      await deployer.verifyDeviceAddress();
      record = {
        type: "ledger-via-cast",
        address: ethers.getAddress(ledgerAddress),
        derivationPath: configuration.derivationPath,
        castVersion: deployer.castIdentity.version,
        castSha256: deployer.castIdentity.executableSha256,
      };
    } else {
      deployer = new FundedWallet(privateKey!, ethers.provider);
      record = { type: "private-key", address: await deployer.getAddress() };
    }
    const owner = await deployer.getAddress();
    return {
      deployer,
      record,
      journal: openFundedRecoveryJournalWithSecret(recoverySecret, {
        runner: "public-deployment-mainnet",
        sourceCommit,
        chainId,
        owner,
        directory: requiredFundedRecoveryDirectory(),
        deployment: {
          recordPath: `deployments/coti-mainnet-public-${sourceCommit.toLowerCase()}.json`,
          recordSha256: "0".repeat(64),
          manifestCommit: sourceCommit.toLowerCase(),
          sourceCommit: sourceCommit.toLowerCase(),
        },
      }),
    };
  }

  const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("COTI_TESTNET_PRIVATE_KEY is required");
  const deployer = new FundedWallet(privateKey, ethers.provider);
  const owner = await deployer.getAddress();
  return {
    deployer,
    record: { type: "local-testnet-key", address: owner },
    journal: openFundedRecoveryJournal(privateKey, {
      runner: "public-deployment-testnet",
      sourceCommit,
      chainId,
      owner,
      directory: requiredFundedRecoveryDirectory(),
      deployment: {
        recordPath: `deployments/coti-testnet-public-${sourceCommit.toLowerCase()}.json`,
        recordSha256: "0".repeat(64),
        manifestCommit: sourceCommit.toLowerCase(),
        sourceCommit: sourceCommit.toLowerCase(),
      },
    }),
  };
}

export async function deployPublicStack(profileName: DeploymentProfileName): Promise<void> {
  const profile = PROFILES[profileName];
  const sourceCommit = await requireCleanSourceCommit();
  const outputPath = requiredDeploymentRecordPath();
  const createdAt = new Date().toISOString();
  const transactions: DeploymentJournalTransaction[] = [];
  const contracts: Record<string, unknown> = {};
  const compiler: Record<string, RuntimeArtifactProvenance> = {};
  let stage = "deployment record reservation";
  const recordWriter = await DeploymentRecordWriter.reserve(
    outputPath,
    sourceCommit,
    {
      schemaVersion: 2,
      deploymentKind: "public-stack-replacement",
      network: profile.network,
      chainId: profile.chainId.toString(),
      sourceCommit,
      createdAt,
      stage,
    },
    process.cwd(),
    profile.recordSlug,
  );

  const writeRecord = async (
    status: "in-progress" | "complete" | "failed" | "outcome-unknown",
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await recordWriter.write({
      schemaVersion: 2,
      deploymentKind: "public-stack-replacement",
      status,
      network: profile.network,
      chainId: profile.chainId.toString(),
      sourceCommit,
      createdAt,
      updatedAt: new Date().toISOString(),
      stage,
      compiler,
      contracts,
      transactions,
      ...extra,
    });
  };

  const recordTransaction = async (evidence: MinedDeploymentEvidence): Promise<void> => {
    upsertMinedDeploymentTransaction(transactions, evidence);
    await writeRecord("in-progress");
  };
  const recordDeployment = async (
    key: string,
    deployment: DeploymentResult,
    details: Record<string, unknown> = {},
  ): Promise<void> => {
    compiler[deployment.artifact.contractName] = deployment.artifact;
    contracts[key] = {
      address: deployment.address,
      runtimeCodehash: deployment.artifact.runtimeCodehash,
      deploymentTx: deployment.deploymentTx,
      gasUsed: deployment.gasUsed,
      ...details,
    };
    await writeRecord("in-progress");
  };

  try {
    stage = "network validation";
    const network = await ethers.provider.getNetwork();
    if (network.chainId !== profile.chainId) {
      throw new Error(
        `public deployment is restricted to ${profile.network} chain ${profile.chainId} ` +
          `(got chain ${network.chainId})`,
      );
    }
    const signer = await deploymentSigner(profileName, sourceCommit, Number(network.chainId));
    contracts.deploymentSigner = signer.record;
    const unresolved = await signer.journal.reconcileTransactions(ethers.provider);
    if (unresolved.length > 0) {
      throw new Error(
        `public deployment has unresolved transaction ${unresolved[0]}; ` +
          "reconcile or identically rebroadcast it before deploying again",
      );
    }
    const deployer = signer.deployer;
    const beneficiary = process.env.CIPHERDEX_FEE_BENEFICIARY?.trim();
    if (!beneficiary || !ethers.isAddress(beneficiary)) {
      throw new Error("CIPHERDEX_FEE_BENEFICIARY must be a valid dedicated fee address");
    }
    const configuredWrappedNative = process.env.CIPHERDEX_EXISTING_WRAPPED_NATIVE?.trim();
    let wrappedNative: string | undefined;
    let existingWrappedArtifact: RuntimeArtifactProvenance | undefined;
    if (configuredWrappedNative) {
      if (!ethers.isAddress(configuredWrappedNative)) {
        throw new Error("CIPHERDEX_EXISTING_WRAPPED_NATIVE must be a valid address");
      }
      wrappedNative = ethers.getAddress(configuredWrappedNative);
      existingWrappedArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
        "WrappedNativeToken",
        wrappedNative,
      );
    } else if (profile.production) {
      throw new Error("mainnet public deployment requires CIPHERDEX_EXISTING_WRAPPED_NATIVE");
    }

    stage = "CipherDEXFeeVault deployment";
    const feeVault = await deployAndReport<FeeVaultHandle>(
      "CipherDEXFeeVault",
      await ethers.getContractFactory("CipherDEXFeeVault", deployer),
      signer.journal,
      recordTransaction,
      beneficiary,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.feeVault },
    );
    await recordDeployment("feeVault", feeVault, {
      beneficiary,
      constructorArgs: [beneficiary],
      publicOnly: true,
    });

    stage = "PublicCPMMFactory deployment";
    const publicFactory = await deployAndReport<PublicFactoryHandle>(
      "PublicCPMMFactory",
      await ethers.getContractFactory("PublicCPMMFactory", deployer),
      signer.journal,
      recordTransaction,
      feeVault.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicFactory },
    );
    const lpTokenFactory = await publicFactory.contract.lpTokenFactory();
    const lpArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
      "PublicLPTokenFactory",
      lpTokenFactory,
    );
    compiler.PublicLPTokenFactory = lpArtifact;
    await recordDeployment("publicFactory", publicFactory, {
      constructorArgs: [feeVault.address],
      lpTokenFactory,
      lpTokenFactoryRuntimeCodehash: lpArtifact.runtimeCodehash,
    });

    stage = "public fee-vault factory binding";
    const binding = await submitDeploymentTransaction(stage, signer.journal, () =>
      feeVault.contract.setPublicFactory(publicFactory.address, {
        gasLimit: TESTNET_DEPLOY_GAS_LIMITS.vaultBinding,
      }),
    );
    await recordTransaction({
      label: stage,
      transactionHash: binding.transactionHash,
      gasUsed: binding.receipt.gasUsed.toString(),
    });
    contracts.publicFeeVaultBinding = {
      target: feeVault.address,
      function: "setPublicFactory",
      args: [publicFactory.address],
      transaction: binding.transactionHash,
      gasUsed: binding.receipt.gasUsed.toString(),
    };

    stage = "PublicCPMMQuoter deployment";
    const quoter = await deployAndReport<VersionedFactoryBoundHandle>(
      "PublicCPMMQuoter",
      await ethers.getContractFactory("PublicCPMMQuoter", deployer),
      signer.journal,
      recordTransaction,
      publicFactory.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicQuoter },
    );
    await recordDeployment("publicQuoter", quoter, {
      constructorArgs: [publicFactory.address],
    });

    stage = "PublicCPMMRouter deployment";
    const router = await deployAndReport<VersionedFactoryBoundHandle>(
      "PublicCPMMRouter",
      await ethers.getContractFactory("PublicCPMMRouter", deployer),
      signer.journal,
      recordTransaction,
      publicFactory.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicRouter },
    );
    await recordDeployment("publicRouter", router, {
      constructorArgs: [publicFactory.address],
    });

    stage = "PublicCPMMLiquidityRouter deployment";
    const liquidityRouter = await deployAndReport<VersionedFactoryBoundHandle>(
      "PublicCPMMLiquidityRouter",
      await ethers.getContractFactory("PublicCPMMLiquidityRouter", deployer),
      signer.journal,
      recordTransaction,
      publicFactory.address,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicLiquidityRouter },
    );
    await recordDeployment("publicLiquidityRouter", liquidityRouter, {
      constructorArgs: [publicFactory.address],
    });

    if (wrappedNative && existingWrappedArtifact) {
      compiler.WrappedNativeToken = existingWrappedArtifact;
      contracts.wrappedNative = {
        address: wrappedNative,
        runtimeCodehash: existingWrappedArtifact.runtimeCodehash,
        reused: true,
      };
      await writeRecord("in-progress");
    } else {
      stage = "WrappedNativeToken deployment";
      const wrappedDeployment = await deployAndReport(
        "WrappedNativeToken",
        await ethers.getContractFactory("WrappedNativeToken", deployer),
        signer.journal,
        recordTransaction,
        "Wrapped COTI",
        "WCOTI",
        { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.wrappedNative },
      );
      wrappedNative = wrappedDeployment.address;
      await recordDeployment("wrappedNative", wrappedDeployment, {
        constructorArgs: ["Wrapped COTI", "WCOTI"],
        reused: false,
      });
    }
    if (!wrappedNative) throw new Error("wrapped-native deployment was not resolved");

    stage = "PublicCPMMNativeRouter deployment";
    const nativeRouter = await deployAndReport<NativeRouterHandle>(
      "PublicCPMMNativeRouter",
      await ethers.getContractFactory("PublicCPMMNativeRouter", deployer),
      signer.journal,
      recordTransaction,
      publicFactory.address,
      router.address,
      liquidityRouter.address,
      wrappedNative,
      { gasLimit: TESTNET_DEPLOY_GAS_LIMITS.publicNativeRouter },
    );
    await recordDeployment("publicNativeRouter", nativeRouter, {
      constructorArgs: [
        publicFactory.address,
        router.address,
        liquidityRouter.address,
        wrappedNative,
      ],
    });

    stage = "post-deployment immutable binding verification";
    const [
      deployedBeneficiary,
      confidentialFactory,
      vaultPublicFactory,
      factoryVault,
      factoryVersion,
      quoterFactory,
      quoterVersion,
      routerFactory,
      routerVersion,
      liquidityFactory,
      liquidityVersion,
      nativeFactory,
      nativeVersion,
      nativePublicRouter,
      nativeLiquidityRouter,
      nativeWrapped,
    ] = await Promise.all([
      feeVault.contract.beneficiary(),
      feeVault.contract.confidentialFactory(),
      feeVault.contract.publicFactory(),
      publicFactory.contract.feeVault(),
      publicFactory.contract.PROTOCOL_VERSION(),
      quoter.contract.factory(),
      quoter.contract.PROTOCOL_VERSION(),
      router.contract.factory(),
      router.contract.PROTOCOL_VERSION(),
      liquidityRouter.contract.factory(),
      liquidityRouter.contract.PROTOCOL_VERSION(),
      nativeRouter.contract.factory(),
      nativeRouter.contract.PROTOCOL_VERSION(),
      nativeRouter.contract.publicRouter(),
      nativeRouter.contract.publicLiquidityRouter(),
      nativeRouter.contract.wrappedNative(),
    ]);
    if (
      !sameAddress(deployedBeneficiary, beneficiary) ||
      confidentialFactory !== ethers.ZeroAddress ||
      !sameAddress(vaultPublicFactory, publicFactory.address) ||
      !sameAddress(factoryVault, feeVault.address) ||
      factoryVersion !== 1n ||
      !sameAddress(quoterFactory, publicFactory.address) ||
      quoterVersion !== 1n ||
      !sameAddress(routerFactory, publicFactory.address) ||
      routerVersion !== 1n ||
      !sameAddress(liquidityFactory, publicFactory.address) ||
      liquidityVersion !== 1n ||
      !sameAddress(nativeFactory, publicFactory.address) ||
      nativeVersion !== 1n ||
      !sameAddress(nativePublicRouter, router.address) ||
      !sameAddress(nativeLiquidityRouter, liquidityRouter.address) ||
      !sameAddress(nativeWrapped, wrappedNative)
    ) {
      throw new Error("public stack immutable binding verification failed");
    }

    let testnetSmoke: Record<string, unknown> | undefined;
    if (!profile.production) {
      const submitSmoke = async (
        label: string,
        operation: () => Promise<ContractTransactionResponse>,
      ): Promise<string> => {
        stage = label;
        const evidence = await submitDeploymentTransaction(label, signer.journal, operation);
        await recordTransaction({
          label,
          transactionHash: evidence.transactionHash,
          gasUsed: evidence.receipt.gasUsed.toString(),
        });
        return evidence.transactionHash;
      };

      stage = "focused public token deployment";
      const publicTokenDeployment = await deployAndReport(
        "MockERC20",
        await ethers.getContractFactory("MockERC20", deployer),
        signer.journal,
        recordTransaction,
        "Focused Public Token",
        "FPT",
        6,
        { gasLimit: 2_000_000n },
      );
      await recordDeployment("focusedPublicToken", publicTokenDeployment, {
        constructorArgs: ["Focused Public Token", "FPT", 6],
        disposable: true,
      });

      const publicToken = await ethers.getContractAt(
        "MockERC20",
        publicTokenDeployment.address,
        deployer,
      );
      const wrapped = await ethers.getContractAt(
        "WrappedNativeToken",
        wrappedNative,
        deployer,
      );
      const focusedFactory = await ethers.getContractAt(
        "PublicCPMMFactory",
        publicFactory.address,
        deployer,
      );
      const focusedLiquidityRouter = await ethers.getContractAt(
        "PublicCPMMLiquidityRouter",
        liquidityRouter.address,
        deployer,
      );
      const focusedNativeRouter = await ethers.getContractAt(
        "PublicCPMMNativeRouter",
        nativeRouter.address,
        deployer,
      );
      const owner = await deployer.getAddress();
      const tokenMint = 30_000_000n;
      const initialNative = ethers.parseEther("0.01");
      const initialToken = 10_000_000n;
      const deadlineBlock = await ethers.provider.getBlock("latest");
      if (!deadlineBlock) throw new Error("focused public smoke cannot read the latest block");
      const deadline = BigInt(deadlineBlock.timestamp + 3_600);

      const mintTx = await submitSmoke("focused public token mint", () =>
        publicToken.mint(owner, tokenMint, { gasLimit: 500_000n }),
      );
      const initialApprovalTx = await submitSmoke("focused native liquidity token approval", () =>
        publicToken.approve(nativeRouter.address, initialToken, { gasLimit: 250_000n }),
      );
      const initialLiquidityTx = await submitSmoke("focused native pool creation and seed", () =>
        focusedNativeRouter.createOrAddLiquidityNative(
          publicTokenDeployment.address,
          6,
          30,
          initialToken,
          1,
          0,
          ethers.MaxUint256,
          deadline,
          owner,
          { value: initialNative, gasLimit: 12_000_000n },
        ),
      );
      const key = await focusedFactory.poolKey(
        wrappedNative,
        publicTokenDeployment.address,
        18,
        6,
        30,
      );
      const poolAddress = await focusedFactory.getPool(key);
      if (poolAddress === ethers.ZeroAddress || !(await focusedFactory.isPool(poolAddress))) {
        throw new Error("focused public smoke did not create a canonical pool");
      }
      const poolArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
        "PublicCPMM",
        poolAddress,
      );
      compiler.PublicCPMM = poolArtifact;
      const pool = await ethers.getContractAt("PublicCPMM", poolAddress, deployer);
      const lpTokenAddress = await pool.lpToken();
      const lpArtifact = await verifyDeployedRuntimeArtifactWithProvenance(
        "PublicLPToken",
        lpTokenAddress,
      );
      compiler.PublicLPToken = lpArtifact;
      contracts.focusedPublicPool = {
        address: poolAddress,
        runtimeCodehash: poolArtifact.runtimeCodehash,
        creationTransaction: initialLiquidityTx,
        disposable: true,
      };
      contracts.focusedPublicLpToken = {
        address: lpTokenAddress,
        runtimeCodehash: lpArtifact.runtimeCodehash,
        creationTransaction: initialLiquidityTx,
        disposable: true,
      };
      await writeRecord("in-progress");

      const wrappedIsToken0 = sameAddress(await pool.token0(), wrappedNative);
      const nativeProbe = ethers.parseEther("0.0001");
      const tokenProbe = 100_000n;
      const nativeQuoteBefore = await pool.quoteExactInput(nativeProbe, wrappedIsToken0);
      const tokenQuoteBefore = await pool.quoteExactInput(tokenProbe, !wrappedIsToken0);
      const reservesBeforeDonation = await pool.effectiveReserves();
      const donation = 12_345n;
      const donationTx = await submitSmoke("focused one-sided pool donation", () =>
        publicToken.transfer(poolAddress, donation, { gasLimit: 250_000n }),
      );
      const expectedSurplus = wrappedIsToken0
        ? [0n, donation]
        : [donation, 0n];
      const surplusAfterDonation = await pool.surplusBalances();
      if (
        surplusAfterDonation[0] !== expectedSurplus[0] ||
        surplusAfterDonation[1] !== expectedSurplus[1] ||
        (await pool.quoteExactInput(nativeProbe, wrappedIsToken0)) !== nativeQuoteBefore ||
        (await pool.quoteExactInput(tokenProbe, !wrappedIsToken0)) !== tokenQuoteBefore ||
        (await pool.effectiveReserves())[0] !== reservesBeforeDonation[0] ||
        (await pool.effectiveReserves())[1] !== reservesBeforeDonation[1]
      ) {
        throw new Error("focused public donation changed stored reserves or quotes");
      }
      const sweepTx = await submitSmoke("focused surplus sweep", () =>
        pool.sweepSurplus(!wrappedIsToken0, wrappedIsToken0, { gasLimit: 1_000_000n }),
      );
      const surplusAfterSweep = await pool.surplusBalances();
      if (surplusAfterSweep[0] !== 0n || surplusAfterSweep[1] !== 0n) {
        throw new Error("focused public surplus sweep left pool surplus");
      }

      const additionalNative = ethers.parseEther("0.005");
      const additionalTokenMaximum = 10_000_000n;
      const wrapTx = await submitSmoke("focused wrapped-native funding", () =>
        wrapped.deposit({ value: additionalNative, gasLimit: 500_000n }),
      );
      const wrappedApprovalTx = await submitSmoke("focused wrapped liquidity approval", () =>
        wrapped.approve(liquidityRouter.address, additionalNative, { gasLimit: 250_000n }),
      );
      const tokenApprovalTx = await submitSmoke("focused proportional token approval", () =>
        publicToken.approve(liquidityRouter.address, additionalTokenMaximum, {
          gasLimit: 250_000n,
        }),
      );
      const proportionalAddTx = await submitSmoke("focused proportional liquidity add", () =>
        focusedLiquidityRouter.createOrAddLiquidity(
          wrappedNative,
          publicTokenDeployment.address,
          18,
          6,
          30,
          additionalNative,
          additionalTokenMaximum,
          1,
          0,
          ethers.MaxUint256,
          deadline,
          { gasLimit: 4_000_000n },
        ),
      );

      const nativeSwapTx = await submitSmoke("focused native-to-token swap", () =>
        focusedNativeRouter.swapExactNativeForToken(
          poolAddress,
          1,
          deadline,
          owner,
          { value: nativeProbe, gasLimit: 3_500_000n },
        ),
      );
      const reverseApprovalTx = await submitSmoke("focused token-to-native approval", () =>
        publicToken.approve(nativeRouter.address, tokenProbe, { gasLimit: 250_000n }),
      );
      const tokenSwapTx = await submitSmoke("focused token-to-native swap", () =>
        focusedNativeRouter.swapExactTokenForNative(
          poolAddress,
          tokenProbe,
          1,
          deadline,
          owner,
          { gasLimit: 3_500_000n },
        ),
      );
      if ((await pool.protocolFees0()) === 0n || (await pool.protocolFees1()) === 0n) {
        throw new Error("focused bidirectional swaps did not accrue both protocol fee sides");
      }
      const feeCollectionTx = await submitSmoke("focused public protocol fee collection", () =>
        pool.collectProtocolFees(true, true, { gasLimit: 1_500_000n }),
      );
      if ((await pool.protocolFees0()) !== 0n || (await pool.protocolFees1()) !== 0n) {
        throw new Error("focused public fee collection left protocol claims");
      }

      const lpToken = await ethers.getContractAt("PublicLPToken", lpTokenAddress, deployer);
      const allShares = await pool.shares(owner);
      const lpApprovalTx = await submitSmoke("focused native removal LP approval", () =>
        lpToken.approve(nativeRouter.address, allShares, { gasLimit: 250_000n }),
      );
      const cleanupTx = await submitSmoke("focused native full liquidity cleanup", () =>
        focusedNativeRouter.removeLiquidityNative(
          poolAddress,
          allShares,
          0,
          0,
          deadline,
          owner,
          { gasLimit: 4_000_000n },
        ),
      );
      const finalReserves = await pool.effectiveReserves();
      const finalSurplus = await pool.surplusBalances();
      if (
        await pool.initialized() ||
        (await pool.totalShares()) !== 0n ||
        finalReserves[0] !== 0n ||
        finalReserves[1] !== 0n ||
        finalSurplus[0] !== 0n ||
        finalSurplus[1] !== 0n ||
        (await wrapped.balanceOf(poolAddress)) !== 0n ||
        (await publicToken.balanceOf(poolAddress)) !== 0n ||
        (await wrapped.balanceOf(nativeRouter.address)) !== 0n ||
        (await publicToken.balanceOf(nativeRouter.address)) !== 0n ||
        (await wrapped.balanceOf(liquidityRouter.address)) !== 0n ||
        (await publicToken.balanceOf(liquidityRouter.address)) !== 0n ||
        (await publicToken.allowance(owner, nativeRouter.address)) !== 0n ||
        (await publicToken.allowance(owner, liquidityRouter.address)) !== 0n ||
        (await wrapped.allowance(owner, liquidityRouter.address)) !== 0n ||
        (await lpToken.allowance(owner, nativeRouter.address)) !== 0n ||
        (await wrapped.allowance(nativeRouter.address, router.address)) !== 0n ||
        (await publicToken.allowance(nativeRouter.address, router.address)) !== 0n ||
        (await wrapped.allowance(liquidityRouter.address, poolAddress)) !== 0n ||
        (await publicToken.allowance(liquidityRouter.address, poolAddress)) !== 0n
      ) {
        throw new Error("focused public smoke cleanup left reserve, share, or router residue");
      }
      testnetSmoke = {
        status: "passed",
        pool: poolAddress,
        token: publicTokenDeployment.address,
        wrappedNative,
        mixedDecimals: [18, 6],
        transactions: {
          mint: mintTx,
          initialApproval: initialApprovalTx,
          initialLiquidity: initialLiquidityTx,
          donation: donationTx,
          surplusSweep: sweepTx,
          wrap: wrapTx,
          wrappedApproval: wrappedApprovalTx,
          proportionalTokenApproval: tokenApprovalTx,
          proportionalAdd: proportionalAddTx,
          nativeSwap: nativeSwapTx,
          reverseApproval: reverseApprovalTx,
          tokenSwap: tokenSwapTx,
          feeCollection: feeCollectionTx,
          lpApproval: lpApprovalTx,
          cleanup: cleanupTx,
        },
      };
      console.log("focused COTI testnet public reserve smoke passed");
    }

    stage = "deployment completion journal";
    await writeRecord("complete", {
      activePublicProtocolVersion: 1,
      feePolicy: {
        approvedTotalFeeBps: [5, 30, 100],
        protocolFeeShare: { numerator: 1, denominator: 6 },
      },
      reserveAccounting: {
        sourceOfTruth: "stored-reserves",
        positiveExternalDelta: "fixed-vault-surplus",
        negativeExternalDelta: "protocol-fee-first-loss-reconciliation",
        upwardSync: false,
      },
      ...(testnetSmoke ? { testnetSmoke } : {}),
      limitations: [
        ...(profile.production ? [] : ["testnet-only"]),
        "not externally audited",
        "exact-transfer ERC-20 behavior required unless every transfer intermediary is exempt",
        "positive rebases are protocol surplus rather than LP reserves",
      ],
    });
    console.log("public stack immutable bindings verified");
    console.log(`publicFeeVault=${feeVault.address}`);
    console.log(`publicFactory=${publicFactory.address}`);
    console.log(`publicLpTokenFactory=${lpTokenFactory}`);
    console.log(`publicQuoter=${quoter.address}`);
    console.log(`publicRouter=${router.address}`);
    console.log(`publicLiquidityRouter=${liquidityRouter.address}`);
    console.log(`wrappedNative=${wrappedNative}`);
    console.log(`publicNativeRouter=${nativeRouter.address}`);
    console.log(`deployment record: ${recordWriter.outputPath}`);
  } catch (error) {
    const transactionHash = transactionHashFromError(error);
    const outcome: DeploymentJournalTransaction["outcome"] =
      error instanceof UnknownBroadcastOutcomeError
        ? "outcome-unknown"
        : error instanceof MinedTransactionStatusError
          ? "mined-failure"
          : transactionHash
            ? "post-mined-error"
            : "local-failure";
    if (
      transactionHash &&
      !transactions.some(
        (entry) => entry.transactionHash.toLowerCase() === transactionHash.toLowerCase(),
      )
    ) {
      transactions.push(Object.freeze({
        label: stage,
        transactionHash,
        outcome,
        gasUsed: null,
      }));
    }
    await writeRecord(
      outcome === "outcome-unknown" ? "outcome-unknown" : "failed",
      {
        failure: {
          classification: outcome,
          transactionHash: transactionHash ?? null,
        },
      },
    );
    throw error;
  } finally {
    await recordWriter.close();
  }
}
