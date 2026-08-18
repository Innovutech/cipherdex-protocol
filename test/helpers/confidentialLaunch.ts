import type { Signer } from "ethers";
import { ethers } from "../../hardhat/runtime.js";

export const launchCommitmentTypes = {
  LaunchCommitment: [
    { name: "launchId", type: "bytes32" },
    { name: "creator", type: "address" },
    { name: "token0", type: "address" },
    { name: "token1", type: "address" },
    { name: "decimals0", type: "uint8" },
    { name: "decimals1", type: "uint8" },
    { name: "feeBps", type: "uint256" },
    { name: "privacyMode", type: "uint8" },
    { name: "poolVersion", type: "uint256" },
    { name: "factory", type: "address" },
    { name: "migrator", type: "address" },
    { name: "initializationStrategy", type: "address" },
    { name: "launchAuthority", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "authorizationDeadline", type: "uint64" },
    { name: "migrationDeadline", type: "uint64" },
  ],
};

export async function signLaunchCommitment(args: {
  authority: Signer;
  creator: Signer;
  factory: { getAddress(): Promise<string> };
  feeBps?: bigint;
  launchId?: string;
  migrator: { getAddress(): Promise<string> };
  strategy: { getAddress(): Promise<string> };
  tokenA: string;
  tokenB: string;
  decimalsA: number;
  decimalsB: number;
  authorizationDeadline?: bigint;
  migrationDeadline?: bigint;
}) {
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Latest block unavailable");
  const network = await ethers.provider.getNetwork();
  const creator = await args.creator.getAddress();
  const launchAuthority = await args.authority.getAddress();
  const factory = await args.factory.getAddress();
  const migrator = await args.migrator.getAddress();
  const initializationStrategy = await args.strategy.getAddress();
  const [token0, token1, decimals0, decimals1] =
    args.tokenA.toLowerCase() < args.tokenB.toLowerCase()
      ? [args.tokenA, args.tokenB, args.decimalsA, args.decimalsB]
      : [args.tokenB, args.tokenA, args.decimalsB, args.decimalsA];
  const commitment = {
    launchId:
      args.launchId ??
      ethers.keccak256(ethers.toUtf8Bytes(`launch:${token0}:${token1}`)),
    creator,
    token0,
    token1,
    decimals0,
    decimals1,
    feeBps: args.feeBps ?? 30n,
    privacyMode: 1,
    poolVersion: 3n,
    factory,
    migrator,
    initializationStrategy,
    launchAuthority,
    chainId: network.chainId,
    authorizationDeadline:
      args.authorizationDeadline ?? BigInt(latest.timestamp + 3_600),
    migrationDeadline:
      args.migrationDeadline ?? BigInt(latest.timestamp + 7_200),
  };
  const domain = {
    name: "CipherDEX Launch Initialization",
    version: "1",
    chainId: network.chainId,
    verifyingContract: initializationStrategy,
  };
  return {
    commitment,
    creatorAuthorization: await args.creator.signTypedData(
      domain,
      launchCommitmentTypes,
      commitment,
    ),
    authorityAuthorization: await args.authority.signTypedData(
      domain,
      launchCommitmentTypes,
      commitment,
    ),
  };
}
