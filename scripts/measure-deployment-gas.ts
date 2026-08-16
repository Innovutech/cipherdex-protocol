import { BaseContract, ContractFactory } from "ethers";
import { ethers } from "hardhat";
import { resolvePrivateTokenCodehashes } from "./private-token-codehashes";

async function deployAndMeasure(
  label: string,
  factory: ContractFactory,
  ...args: unknown[]
): Promise<BaseContract> {
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const transaction = contract.deploymentTransaction();
  const receipt = transaction ? await transaction.wait() : null;
  if (!receipt) throw new Error(`${label} deployment receipt missing`);
  console.log(`${label}: gas=${receipt.gasUsed}`);
  return contract;
}

async function main(): Promise<void> {
  const [beneficiary] = await ethers.getSigners();
  const feeVault = await deployAndMeasure(
    "CipherDEXFeeVault",
    await ethers.getContractFactory("CipherDEXFeeVault"),
    beneficiary.address,
  );
  const privateLpTokenFactory = await deployAndMeasure(
    "PrivateLPTokenFactory",
    await ethers.getContractFactory("PrivateLPTokenFactory"),
  );
  const tokenA = await deployAndMeasure(
    "MockTokenMetadata(18)",
    await ethers.getContractFactory("MockTokenMetadata"),
    18,
  );
  const tokenB = await deployAndMeasure(
    "MockTokenMetadata(6)",
    await ethers.getContractFactory("MockTokenMetadata"),
    6,
  );
  const privateTokenCodehashes = await resolvePrivateTokenCodehashes(
    ethers.provider,
    [await tokenA.getAddress(), await tokenB.getAddress()],
  );
  const confidentialFactory = await deployAndMeasure(
    "ConfidentialCPMMFactory",
    await ethers.getContractFactory("ConfidentialCPMMFactory"),
    await feeVault.getAddress(),
    await privateLpTokenFactory.getAddress(),
    privateTokenCodehashes,
  );
  const createPoolTransaction = await (
    confidentialFactory as BaseContract & {
      createPool(
        tokenA: string,
        tokenB: string,
        decimalsA: number,
        decimalsB: number,
        feeBps: number,
      ): Promise<{ wait(): Promise<{ gasUsed: bigint } | null> }>;
    }
  ).createPool(
    await tokenA.getAddress(),
    await tokenB.getAddress(),
    18,
    6,
    30,
  );
  const createPoolReceipt = await createPoolTransaction.wait();
  if (!createPoolReceipt) throw new Error("ConfidentialCPMMFactory.createPool receipt missing");
  console.log(`ConfidentialCPMMFactory.createPool: gas=${createPoolReceipt.gasUsed}`);
  await deployAndMeasure(
    "ConfidentialLaunchpadMigrator",
    await ethers.getContractFactory("ConfidentialLaunchpadMigrator"),
    await confidentialFactory.getAddress(),
  );

  const publicFactory = await deployAndMeasure(
    "PublicCPMMFactory",
    await ethers.getContractFactory("PublicCPMMFactory"),
    await feeVault.getAddress(),
  );
  await deployAndMeasure(
    "PublicCPMMQuoter",
    await ethers.getContractFactory("PublicCPMMQuoter"),
    await publicFactory.getAddress(),
  );
  await deployAndMeasure(
    "PublicCPMMRouter",
    await ethers.getContractFactory("PublicCPMMRouter"),
    await publicFactory.getAddress(),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "deployment gas measurement failed");
  process.exitCode = 1;
});
