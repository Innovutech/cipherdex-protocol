import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFeeVault } from "../helpers/deployFeeVault";

describe("ConfidentialLaunchpadMigrator", function () {
  it("keeps the factory binding immutable and rejects a zero factory", async function () {
    const vault = await deployFeeVault();
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy(await vault.getAddress());
    await factory.waitForDeployment();

    const migratorFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
    const migrator = await migratorFactory.deploy(await factory.getAddress());
    await migrator.waitForDeployment();

    expect(await migrator.PROTOCOL_VERSION()).to.equal(2n);
    expect(await migrator.factory()).to.equal(await factory.getAddress());
    expect(await factory.feeVault()).to.equal(await vault.getAddress());
    expect(await factory.isApprovedFeeTier(30)).to.equal(true);
    expect(await factory.isApprovedFeeTier(25)).to.equal(false);
    await expect(migratorFactory.deploy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(migrator, "InvalidFactory");
  });

  it("binds the creator, migration context and opaque MPC input commitments", async function () {
    const [creator, other] = await ethers.getSigners();
    const vault = await deployFeeVault();
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy(await vault.getAddress());
    await factory.waitForDeployment();
    const migratorFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
    const migrator = await migratorFactory.deploy(await factory.getAddress());
    await migrator.waitForDeployment();

    const input = (high: bigint, low: bigint, signature: string) => ({
      ciphertext: { ciphertextHigh: high, ciphertextLow: low },
      signature,
    });
    const amount0 = input(1n, 2n, "0x1234");
    const amount1 = input(3n, 4n, "0x5678");
    const minShares = input(5n, 6n, "0x9abc");
    const minPriceX18 = input(7n, 8n, "0xdef0");
    const maxPriceX18 = input(9n, 10n, "0x1122");
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "CipherDEX Launchpad Migrator",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await migrator.getAddress(),
    };
    const types = {
      Migration: [
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
    const commitment = (value: typeof amount0) => ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "bytes32"],
        [value.ciphertext.ciphertextHigh, value.ciphertext.ciphertextLow, ethers.keccak256(value.signature)],
      ),
    );
    const values = {
      creator: await creator.getAddress(),
      tokenA: "0x0000000000000000000000000000000000000011",
      tokenB: "0x0000000000000000000000000000000000000022",
      decimalsA: 18,
      decimalsB: 6,
      feeBps: 30,
      encryptedInputsHash: ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
          [
            commitment(amount0),
            commitment(amount1),
            commitment(minShares),
            commitment(minPriceX18),
            commitment(maxPriceX18),
          ],
        ),
      ),
      deadline: 2_000_000_000n,
      withDisposition: false,
      disposition: 0,
      unlockTime: 0n,
    };
    const authorization = await creator.signTypedData(domain, types, values);
    expect(ethers.TypedDataEncoder.hash(domain, types, values)).to.match(/^0x[0-9a-f]{64}$/);
    expect(await migrator.MIGRATION_TYPEHASH()).to.equal(
      ethers.id("Migration(address creator,address tokenA,address tokenB,uint8 decimalsA,uint8 decimalsB,uint256 feeBps,bytes32 encryptedInputsHash,uint64 deadline,bool withDisposition,uint8 disposition,uint64 unlockTime)"),
    );
    expect(authorization).to.match(/^0x[0-9a-f]{130}$/);
    expect(await other.getAddress()).to.not.equal(await creator.getAddress());
  });

  it("rejects caller, domain, payload and disposition authorization mismatches before MPC", async function () {
    const [creator, other] = await ethers.getSigners();
    const vault = await deployFeeVault();
    const factoryFactory = await ethers.getContractFactory("ConfidentialCPMMFactory");
    const factory = await factoryFactory.deploy(await vault.getAddress());
    await factory.waitForDeployment();
    const migratorFactory = await ethers.getContractFactory("ConfidentialLaunchpadMigrator");
    const migrator = await migratorFactory.deploy(await factory.getAddress());
    await migrator.waitForDeployment();

    const input = (high: bigint, low: bigint, signature: string) => ({
      ciphertext: { ciphertextHigh: high, ciphertextLow: low },
      signature,
    });
    // COTI's ctUint128 words are represented by uint256 Solidity values.
    // Keep this fixture above 128 bits so the off-chain commitment cannot
    // regress to an incorrectly narrowed ABI type.
    const amount0 = input(1n << 200n, (1n << 220n) + 2n, "0x1234");
    const amount1 = input(3n, 4n, "0x5678");
    const minShares = input(5n, 6n, "0x9abc");
    const minPriceX18 = input(7n, 8n, "0xdef0");
    const maxPriceX18 = input(9n, 10n, "0x1122");
    const commitment = (value: typeof amount0) => ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "bytes32"],
        [
          value.ciphertext.ciphertextHigh,
          value.ciphertext.ciphertextLow,
          ethers.keccak256(value.signature),
        ],
      ),
    );
    const encryptedInputsHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
        [
          commitment(amount0),
          commitment(amount1),
          commitment(minShares),
          commitment(minPriceX18),
          commitment(maxPriceX18),
        ],
      ),
    );
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "CipherDEX Launchpad Migrator",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await migrator.getAddress(),
    };
    const types = {
      Migration: [
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
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const values = {
      creator: await creator.getAddress(),
      tokenA: "0x0000000000000000000000000000000000000011",
      tokenB: "0x0000000000000000000000000000000000000022",
      decimalsA: 18,
      decimalsB: 6,
      feeBps: 30,
      encryptedInputsHash,
      deadline,
      withDisposition: false,
      disposition: 0,
      unlockTime: 0n,
    };
    const authorization = await creator.signTypedData(domain, types, values);
    const request = {
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
      deadline,
      authorization,
    };

    await expect(migrator.connect(other).migrate(request))
      .to.be.revertedWithCustomError(migrator, "InvalidAuthorization");

    const wrongDomainAuthorization = await creator.signTypedData(
      { ...domain, chainId: network.chainId + 1n },
      types,
      values,
    );
    await expect(migrator.migrate({ ...request, authorization: wrongDomainAuthorization }))
      .to.be.revertedWithCustomError(migrator, "InvalidAuthorization");

    const wrongContractAuthorization = await creator.signTypedData(
      { ...domain, verifyingContract: await factory.getAddress() },
      types,
      values,
    );
    await expect(migrator.migrate({ ...request, authorization: wrongContractAuthorization }))
      .to.be.revertedWithCustomError(migrator, "InvalidAuthorization");

    await expect(migrator.migrate({ ...request, feeBps: request.feeBps + 1 }))
      .to.be.revertedWithCustomError(migrator, "InvalidAuthorization");

    await expect(migrator.migrateWithDisposition(request, 2, 0))
      .to.be.revertedWithCustomError(migrator, "InvalidAuthorization");
  });
});
