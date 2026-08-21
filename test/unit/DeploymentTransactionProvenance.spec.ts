import { expect } from "chai";
import { artifacts, ethers } from "../../hardhat/runtime.js";

import { verifyDeploymentTransactionEvidence } from "../../scripts/deployment-transaction-provenance";

describe("deployment transaction provenance", function () {
  async function expectRejected(
    operation: Promise<unknown>,
    expectedMessage: string,
  ): Promise<void> {
    let message = "";
    try {
      await operation;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.include(expectedMessage);
  }

  async function fixture(): Promise<Record<string, any>> {
    const [deployer] = await ethers.getSigners();
    const transactions: Record<string, any>[] = [];
    const deployed = async (
      key: string,
      contractName: string,
      constructorArgs: unknown[],
      ...args: unknown[]
    ): Promise<any> => {
      const factory = await ethers.getContractFactory(contractName);
      const contract = await factory.deploy(...args);
      const receipt = await contract.deploymentTransaction()!.wait();
      if (!receipt?.contractAddress) throw new Error(`${contractName} deployment receipt missing`);
      transactions.push({
        label: `${contractName} deployment`,
        transactionHash: receipt.hash,
        outcome: "mined-success",
        gasUsed: receipt.gasUsed.toString(),
        contractAddress: receipt.contractAddress,
      });
      return {
        key,
        contract,
        record: {
          address: receipt.contractAddress,
          deploymentTx: receipt.hash,
          gasUsed: receipt.gasUsed.toString(),
          constructorArgs,
        },
      };
    };
    const bound = async (
      label: string,
      key: string,
      target: any,
      functionName: string,
      args: unknown[],
    ): Promise<Record<string, any>> => {
      const transaction = await target[functionName](...args);
      const receipt = await transaction.wait();
      if (!receipt) throw new Error(`${label} receipt missing`);
      transactions.push({
        label,
        transactionHash: receipt.hash,
        outcome: "mined-success",
        gasUsed: receipt.gasUsed.toString(),
      });
      return {
        address: String(args[0]),
        target: await target.getAddress(),
        function: functionName,
        args,
        transaction: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    };

    const vault = await deployed(
      "feeVault",
      "CipherDEXFeeVault",
      [deployer.address],
      deployer.address,
    );
    vault.record.beneficiary = deployer.address;
    const lpFactory = await deployed(
      "confidentialLpTokenFactory",
      "PrivateLPTokenFactory",
      [],
    );
    const strategyArtifact = await artifacts.readArtifact(
      "ConfidentialLaunchInitializationStrategy",
    );
    const reviewedStrategyCodehash = ethers.keccak256(
      strategyArtifact.deployedBytecode,
    );
    const strategyRegistry = await deployed(
      "confidentialInitializationStrategyRegistry",
      "ConfidentialInitializationStrategyRegistry",
      [[reviewedStrategyCodehash]],
      [reviewedStrategyCodehash],
    );
    strategyRegistry.record.reviewedStrategyCodehashes = [reviewedStrategyCodehash];
    strategyRegistry.record.runtimeCodehash = ethers.keccak256(
      await ethers.provider.getCode(strategyRegistry.record.address),
    );
    const poolDeployer = await deployed(
      "confidentialPoolDeployer",
      "ConfidentialCPMMDeployer",
      [],
    );
    poolDeployer.record.runtimeCodehash = ethers.keccak256(
      await ethers.provider.getCode(poolDeployer.record.address),
    );
    const confidentialFactory = await deployed(
      "confidentialFactory",
      "ConfidentialCPMMFactory",
      [
        vault.record.address,
        lpFactory.record.address,
        poolDeployer.record.address,
        poolDeployer.record.runtimeCodehash,
        strategyRegistry.record.address,
        strategyRegistry.record.runtimeCodehash,
      ],
      vault.record.address,
      lpFactory.record.address,
      poolDeployer.record.address,
      poolDeployer.record.runtimeCodehash,
      strategyRegistry.record.address,
      strategyRegistry.record.runtimeCodehash,
    );
    const vaultBinding = await bound(
      "confidential fee-vault factory binding",
      "confidentialFeeVaultBinding",
      vault.contract,
      "setConfidentialFactory",
      [confidentialFactory.record.address],
    );
    const poolDeployerBinding = await bound(
      "confidential pool-deployer factory binding",
      "confidentialPoolDeployerBinding",
      poolDeployer.contract,
      "bindFactory",
      [confidentialFactory.record.address],
    );
    const strategyRegistryBinding = await bound(
      "confidential strategy-registry factory binding",
      "confidentialStrategyRegistryBinding",
      strategyRegistry.contract,
      "bindFactory",
      [confidentialFactory.record.address],
    );
    const launchStrategy = await deployed(
      "confidentialLaunchInitializationStrategy",
      "ConfidentialLaunchInitializationStrategy",
      [
        confidentialFactory.record.address,
        strategyRegistry.record.address,
        deployer.address,
      ],
      confidentialFactory.record.address,
      strategyRegistry.record.address,
      deployer.address,
    );
    launchStrategy.record.launchAuthority = deployer.address;
    const migratorAddress = await launchStrategy.contract.migrator();
    const migrator = {
      record: {
        address: migratorAddress,
        deploymentTx: launchStrategy.record.deploymentTx,
        gasUsed: launchStrategy.record.gasUsed,
        constructorArgs: [
          confidentialFactory.record.address,
          launchStrategy.record.address,
        ],
        creationKind: "strategy-constructor-child",
        creationParent: launchStrategy.record.address,
        runtimeCodehash: ethers.keccak256(
          await ethers.provider.getCode(migratorAddress),
        ),
      },
    };
    const strategyRegistration = await bound(
      "confidential initialization-strategy registration",
      "confidentialStrategyRegistration",
      strategyRegistry.contract,
      "registerInitializationStrategy",
      [launchStrategy.record.address],
    );
    const strategyRegistryFinalization = await bound(
      "confidential strategy-registry finalization",
      "confidentialStrategyRegistryFinalization",
      strategyRegistry.contract,
      "finalize",
      [],
    );
    const confidentialRouter = await deployed(
      "confidentialBestExecutionRouter",
      "ConfidentialBestExecutionRouter",
      [confidentialFactory.record.address],
      confidentialFactory.record.address,
    );
    const routerBinding = await bound(
      "confidential best-execution router binding",
      "bestExecutionRouterBinding",
      confidentialFactory.contract,
      "setBestExecutionRouter",
      [confidentialRouter.record.address],
    );
    const publicFactory = await deployed(
      "publicFactory",
      "PublicCPMMFactory",
      [vault.record.address],
      vault.record.address,
    );
    const publicVaultBinding = await bound(
      "public fee-vault factory binding",
      "publicFeeVaultBinding",
      vault.contract,
      "setPublicFactory",
      [publicFactory.record.address],
    );
    const publicQuoter = await deployed(
      "publicQuoter",
      "PublicCPMMQuoter",
      [publicFactory.record.address],
      publicFactory.record.address,
    );
    const publicRouter = await deployed(
      "publicRouter",
      "PublicCPMMRouter",
      [publicFactory.record.address],
      publicFactory.record.address,
    );

    return {
      contracts: {
        feeVault: vault.record,
        confidentialLpTokenFactory: lpFactory.record,
        confidentialInitializationStrategyRegistry: strategyRegistry.record,
        confidentialPoolDeployer: poolDeployer.record,
        confidentialFactory: confidentialFactory.record,
        confidentialFeeVaultBinding: vaultBinding,
        confidentialPoolDeployerBinding: poolDeployerBinding,
        confidentialStrategyRegistryBinding: strategyRegistryBinding,
        confidentialLaunchInitializationStrategy: launchStrategy.record,
        confidentialBestExecutionRouter: confidentialRouter.record,
        bestExecutionRouterBinding: routerBinding,
        launchpadMigrator: migrator.record,
        confidentialStrategyRegistration: strategyRegistration,
        confidentialStrategyRegistryFinalization: strategyRegistryFinalization,
        publicFactory: publicFactory.record,
        publicFeeVaultBinding: publicVaultBinding,
        publicQuoter: publicQuoter.record,
        publicRouter: publicRouter.record,
      },
      transactions,
    };
  }

  it("proves every deployment, binding, constructor and resulting relationship", async function () {
    const record = await fixture();
    await verifyDeploymentTransactionEvidence(record, ethers.provider);
  });

  it("rejects a manifest whose canonical constructor relationships were rewritten", async function () {
    const record = await fixture();
    record.contracts.publicRouter.constructorArgs = [record.contracts.feeVault.address];
    await expectRejected(
      verifyDeploymentTransactionEvidence(record, ethers.provider),
      "canonical deployment relationships",
    );
  });

  it("rejects duplicate transaction evidence", async function () {
    const record = await fixture();
    record.transactions[1].transactionHash = record.transactions[0].transactionHash;
    await expectRejected(
      verifyDeploymentTransactionEvidence(record, ethers.provider),
      "transaction hashes must be unique",
    );
  });

  it("rejects a successful binding transaction against a lookalike deployment", async function () {
    const record = await fixture();
    const lookalike = await (
      await ethers.getContractFactory("CipherDEXFeeVault")
    ).deploy(record.contracts.feeVault.beneficiary);
    const lookalikeFactory = await (
      await ethers.getContractFactory("PublicCPMMFactory")
    ).deploy(await lookalike.getAddress());
    const binding = await lookalike.setPublicFactory(await lookalikeFactory.getAddress());
    const receipt = await binding.wait();
    expect(receipt?.status).to.equal(1);

    const original = record.transactions.find(
      (transaction: Record<string, unknown>) =>
        transaction.label === "public fee-vault factory binding",
    );
    expect(original).to.not.equal(undefined);
    original!.transactionHash = binding.hash;
    original!.gasUsed = receipt!.gasUsed.toString();
    record.contracts.publicFeeVaultBinding = {
      target: await lookalike.getAddress(),
      function: "setPublicFactory",
      args: [await lookalikeFactory.getAddress()],
      transaction: binding.hash,
      gasUsed: receipt!.gasUsed.toString(),
    };

    await expectRejected(
      verifyDeploymentTransactionEvidence(record, ethers.provider),
      "target does not match the canonical deployment",
    );
  });
});
