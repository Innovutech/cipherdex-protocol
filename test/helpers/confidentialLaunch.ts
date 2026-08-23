import { ethers } from "../../hardhat/runtime.js";

export async function prepareLaunchAsPinnedMigrator(args: {
  creator: string;
  feeBps?: bigint;
  launchId?: string;
  migrator: { getAddress(): Promise<string> };
  strategy: {
    connect(signer: unknown): {
      prepareLaunch(
        launchId: string,
        creator: string,
        tokenA: string,
        tokenB: string,
        decimalsA: number,
        decimalsB: number,
        feeBps: bigint,
        migrationDeadline: bigint,
        authorizationHash: string,
      ): Promise<{ wait(): Promise<unknown> }>;
    };
  };
  tokenA: string;
  tokenB: string;
  decimalsA: number;
  decimalsB: number;
  migrationDeadline?: bigint;
  authorizationHash?: string;
}) {
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Latest block unavailable");
  const migratorAddress = await args.migrator.getAddress();
  const launchId = args.launchId ?? ethers.id(`launch:${args.tokenA}:${args.tokenB}`);
  const authorizationHash = args.authorizationHash ?? ethers.id(`authorization:${launchId}`);
  const migrationDeadline =
    args.migrationDeadline ?? BigInt(latest.timestamp + 3_600);

  await ethers.provider.send("hardhat_setBalance", [
    migratorAddress,
    "0x1000000000000000000",
  ]);
  await ethers.provider.send("hardhat_impersonateAccount", [migratorAddress]);
  const signer = await ethers.getSigner(migratorAddress);
  try {
    const transaction = await args.strategy.connect(signer).prepareLaunch(
      launchId,
      args.creator,
      args.tokenA,
      args.tokenB,
      args.decimalsA,
      args.decimalsB,
      args.feeBps ?? 30n,
      migrationDeadline,
      authorizationHash,
    );
    return { authorizationHash, launchId, migrationDeadline, transaction };
  } finally {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [migratorAddress]);
  }
}
