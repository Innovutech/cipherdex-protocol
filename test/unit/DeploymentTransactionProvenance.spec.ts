import { expect } from "chai";
import { ethers } from "hardhat";

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
    const privateCodehash = `0x${"11".repeat(32)}`;
    const confidentialFactory = await deployed(
      "confidentialFactory",
      "ConfidentialCPMMFactory",
      [vault.record.address, lpFactory.record.address, [privateCodehash]],
      vault.record.address,
      lpFactory.record.address,
      [privateCodehash],
    );
    confidentialFactory.record.approvedPrivateTokenCodehashes = [privateCodehash];
    const vaultBinding = await bound(
      "confidential fee-vault factory binding",
      "confidentialFeeVaultBinding",
      vault.contract,
      "setConfidentialFactory",
      [confidentialFactory.record.address],
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
    const migrator = await deployed(
      "launchpadMigrator",
      "ConfidentialLaunchpadMigrator",
      [confidentialFactory.record.address],
      confidentialFactory.record.address,
    );
    const adapterBinding = await bound(
      "launchpad adapter binding",
      "bootstrapAdapterBinding",
      confidentialFactory.contract,
      "setBootstrapAdapter",
      [migrator.record.address],
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
        confidentialFactory: confidentialFactory.record,
        confidentialFeeVaultBinding: vaultBinding,
        confidentialBestExecutionRouter: confidentialRouter.record,
        bestExecutionRouterBinding: routerBinding,
        launchpadMigrator: migrator.record,
        bootstrapAdapterBinding: adapterBinding,
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
});
