import { expect } from "chai";
import { ethers } from "../../hardhat/runtime.js";
import {
  configureConfidentialLaunch,
  deployConfidentialFactory,
} from "../helpers/deployConfidentialFactory";

const migrationTypes = {
  Migration: [
    { name: "launchId", type: "bytes32" },
    { name: "initializationStrategy", type: "address" },
    { name: "creator", type: "address" },
    { name: "tokenA", type: "address" },
    { name: "tokenB", type: "address" },
    { name: "decimalsA", type: "uint8" },
    { name: "decimalsB", type: "uint8" },
    { name: "feeBps", type: "uint256" },
    { name: "encryptedInputsHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "withDisposition", type: "bool" },
    { name: "disposition", type: "uint8" },
    { name: "unlockTime", type: "uint64" },
  ],
};

const input = (high: bigint, low: bigint, signature: string) => ({
  ciphertext: { ciphertextHigh: high, ciphertextLow: low },
  signature,
});

function inputCommitment(value: ReturnType<typeof input>) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32"],
      [
        value.ciphertext.ciphertextHigh,
        value.ciphertext.ciphertextLow,
        ethers.keccak256(value.signature),
      ],
    ),
  );
}

describe("ConfidentialLaunchpadMigrator", function () {
  async function fixture() {
    const [creator, other] = await ethers.getSigners();
    const deployment = await deployConfidentialFactory();
    const launch = await configureConfidentialLaunch(deployment);
    const amount0 = input(1n << 200n, (1n << 220n) + 2n, "0x1234");
    const amount1 = input(3n, 4n, "0x5678");
    const minShares = input(5n, 6n, "0x9abc");
    const minPriceX18 = input(7n, 8n, "0xdef0");
    const maxPriceX18 = input(9n, 10n, "0x1122");
    const encryptedInputsHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
        [
          inputCommitment(amount0),
          inputCommitment(amount1),
          inputCommitment(minShares),
          inputCommitment(minPriceX18),
          inputCommitment(maxPriceX18),
        ],
      ),
    );
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("Latest block unavailable");
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "CipherDEX Launchpad Migrator",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await launch.migrator.getAddress(),
    };
    const values = {
      launchId: ethers.id("committed-launch"),
      initializationStrategy: await launch.strategy.getAddress(),
      creator: creator.address,
      tokenA: "0x0000000000000000000000000000000000000011",
      tokenB: "0x0000000000000000000000000000000000000022",
      decimalsA: 18,
      decimalsB: 6,
      feeBps: 30,
      encryptedInputsHash,
      deadline: BigInt(latest.timestamp + 600),
      withDisposition: false,
      disposition: 0,
      unlockTime: 0n,
    };
    const authorization = await creator.signTypedData(
      domain,
      migrationTypes,
      values,
    );
    const request = {
      launchId: values.launchId,
      tokenA: values.tokenA,
      tokenB: values.tokenB,
      decimalsA: values.decimalsA,
      decimalsB: values.decimalsB,
      feeBps: values.feeBps,
      amount0,
      amount1,
      minShares,
      minPriceX18,
      maxPriceX18,
      deadline: values.deadline,
      authorization,
    };
    return {
      creator,
      deployment,
      domain,
      launch,
      migrationValues: values,
      network,
      other,
      request,
    };
  }

  it("binds immutably to the v3 factory and reviewed strategy", async function () {
    const { deployment, launch, other } = await fixture();
    const migratorFactory = await ethers.getContractFactory(
      "ConfidentialLaunchpadMigrator",
    );

    expect(await launch.migrator.PROTOCOL_VERSION()).to.equal(4n);
    expect(await launch.migrator.factory()).to.equal(
      await deployment.factory.getAddress(),
    );
    expect(await launch.migrator.initializationStrategy()).to.equal(
      await launch.strategy.getAddress(),
    );
    expect(await deployment.factory.feeVault()).to.equal(
      await deployment.vault.getAddress(),
    );
    await expect(
      migratorFactory.deploy(ethers.ZeroAddress, await launch.strategy.getAddress()),
    ).to.be.revertedWithCustomError(migratorFactory, "InvalidFactory");
    await expect(
      migratorFactory.deploy(other.address, await launch.strategy.getAddress()),
    ).to.be.revertedWithCustomError(migratorFactory, "InvalidFactory");
    await expect(
      migratorFactory.deploy(
        await deployment.factory.getAddress(),
        ethers.ZeroAddress,
      ),
    ).to.be.revertedWithCustomError(
      migratorFactory,
      "InvalidInitializationStrategy",
    );
  });

  it("binds launch identity, strategy and opaque MPC inputs in EIP-712", async function () {
    const { creator, domain, launch, migrationValues, other } = await fixture();
    const authorization = await creator.signTypedData(
      domain,
      migrationTypes,
      migrationValues,
    );
    expect(ethers.TypedDataEncoder.hash(domain, migrationTypes, migrationValues))
      .to.match(/^0x[0-9a-f]{64}$/);
    expect(await launch.migrator.MIGRATION_TYPEHASH()).to.equal(
      ethers.id(
        "Migration(bytes32 launchId,address initializationStrategy,address creator,address tokenA,address tokenB,uint8 decimalsA,uint8 decimalsB,uint256 feeBps,bytes32 encryptedInputsHash,uint64 deadline,bool withDisposition,uint8 disposition,uint64 unlockTime)",
      ),
    );
    expect(authorization).to.match(/^0x[0-9a-f]{130}$/);
    expect(other.address).to.not.equal(creator.address);
  });

  it("rejects caller, domain, launch and disposition mismatches before MPC", async function () {
    const {
      creator,
      deployment,
      domain,
      launch,
      migrationValues,
      network,
      other,
      request,
    } = await fixture();

    await expect(launch.migrator.connect(other).migrate(request))
      .to.be.revertedWithCustomError(launch.migrator, "InvalidAuthorization");

    const wrongDomainAuthorization = await creator.signTypedData(
      { ...domain, chainId: network.chainId + 1n },
      migrationTypes,
      migrationValues,
    );
    await expect(
      launch.migrator.migrate({
        ...request,
        authorization: wrongDomainAuthorization,
      }),
    ).to.be.revertedWithCustomError(launch.migrator, "InvalidAuthorization");

    const wrongContractAuthorization = await creator.signTypedData(
      { ...domain, verifyingContract: await deployment.factory.getAddress() },
      migrationTypes,
      migrationValues,
    );
    await expect(
      launch.migrator.migrate({
        ...request,
        authorization: wrongContractAuthorization,
      }),
    ).to.be.revertedWithCustomError(launch.migrator, "InvalidAuthorization");

    await expect(
      launch.migrator.migrate({ ...request, feeBps: request.feeBps + 1 }),
    ).to.be.revertedWithCustomError(launch.migrator, "InvalidAuthorization");
    await expect(
      launch.migrator.migrate({
        ...request,
        launchId: ethers.id("other-launch"),
      }),
    ).to.be.revertedWithCustomError(launch.migrator, "InvalidAuthorization");
    await expect(launch.migrator.migrateWithDisposition(request, 2, 0))
      .to.be.revertedWithCustomError(launch.migrator, "InvalidAuthorization");

    await expect(launch.migrator.migrate(request))
      .to.be.revertedWithCustomError(deployment.factory, "UnsupportedPrivateToken");
    const protectedKey = await deployment.factory.poolKey(
      request.tokenA,
      request.tokenB,
      request.decimalsA,
      request.decimalsB,
      request.feeBps,
      await launch.strategy.getAddress(),
    );
    expect(await deployment.factory.getPool(protectedKey)).to.equal(ethers.ZeroAddress);
    expect((await launch.strategy.getLaunch(request.launchId)).status).to.equal(0n);
  });

  it("accepts ERC-1271 creator authorization before launch-state validation", async function () {
    const { creator, deployment, domain, launch, migrationValues, request } = await fixture();
    const wallet = await (
      await ethers.getContractFactory("MockERC1271Wallet")
    ).deploy(creator.address);
    await wallet.waitForDeployment();
    const contractCreatorValues = {
      ...migrationValues,
      creator: await wallet.getAddress(),
    };
    const authorization = await creator.signTypedData(
      domain,
      migrationTypes,
      contractCreatorValues,
    );
    const call = launch.migrator.interface.encodeFunctionData("migrate", [{
      ...request,
      authorization,
    }]);

    await expect(
      wallet.connect(creator).execute(await launch.migrator.getAddress(), call),
    ).to.be.revertedWithCustomError(deployment.factory, "UnsupportedPrivateToken");
  });
});
