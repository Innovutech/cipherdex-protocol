import {
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  isAddress,
} from "ethers";
import { artifacts } from "../hardhat/runtime.js";

const COTI_NETWORKS = new Map<bigint, string>([
  [7_082_400n, "coti-testnet"],
  [2_632_500n, "coti-mainnet"],
]);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAddress(name: string): string {
  const value = requiredEnvironment(name);
  if (!isAddress(value) || getAddress(value) === ZeroAddress) {
    throw new Error(`${name} must be a nonzero address`);
  }
  return getAddress(value);
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnvironment("COTI_RPC_URL");
  const privateKey = requiredEnvironment("DEPLOYER_PRIVATE_KEY");
  const factory = requiredAddress("PUBLIC_CPMM_FACTORY_ADDRESS");
  const bestExecutionRouter = requiredAddress(
    "PUBLIC_BEST_EXECUTION_ROUTER_ADDRESS",
  );
  const wrappedNative = requiredAddress("PUBLIC_WRAPPED_NATIVE_ADDRESS");

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const networkName = COTI_NETWORKS.get(network.chainId);
  if (!networkName) {
    throw new Error(
      `public native best-execution deployment supports only COTI testnet/mainnet; got chain ${network.chainId}`,
    );
  }
  for (const [name, address] of [
    ["PUBLIC_CPMM_FACTORY_ADDRESS", factory],
    ["PUBLIC_BEST_EXECUTION_ROUTER_ADDRESS", bestExecutionRouter],
    ["PUBLIC_WRAPPED_NATIVE_ADDRESS", wrappedNative],
  ] as const) {
    if ((await provider.getCode(address)) === "0x") {
      throw new Error(`${name} has no deployed code`);
    }
  }

  const wallet = new Wallet(privateKey, provider);
  const artifact = await artifacts.readArtifact(
    "PublicBestExecutionNativeRouter",
  );
  const contract = await new ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet,
  ).deploy(factory, bestExecutionRouter, wrappedNative);
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error("deployment transaction was not created");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("deployment did not mine successfully");
  }
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const [boundFactory, boundRouter, boundWrapped, protocolVersion, bitmap] =
    await Promise.all([
      contract.getFunction("factory").staticCall(),
      contract.getFunction("bestExecutionRouter").staticCall(),
      contract.getFunction("wrappedNative").staticCall(),
      contract.getFunction("PROTOCOL_VERSION").staticCall(),
      contract.getFunction("ALL_CANDIDATE_BITMAP").staticCall(),
    ]);
  if (
    getAddress(String(boundFactory)) !== factory ||
    getAddress(String(boundRouter)) !== bestExecutionRouter ||
    getAddress(String(boundWrapped)) !== wrappedNative ||
    BigInt(String(protocolVersion)) !== 1n ||
    BigInt(String(bitmap)) !== 7n
  ) throw new Error("deployed public native best-execution binding mismatch");

  console.log(`network=${networkName}`);
  console.log(`chainId=${network.chainId}`);
  console.log(`deployer=${await wallet.getAddress()}`);
  console.log(`publicCPMMFactory=${factory}`);
  console.log(`publicBestExecutionRouter=${bestExecutionRouter}`);
  console.log(`wrappedNative=${wrappedNative}`);
  console.log(`publicBestExecutionNativeRouter=${address}`);
  console.log(`publicBestExecutionNativeRouterDeploymentTx=${transaction.hash}`);
  console.log(`publicBestExecutionNativeRouterConstructorArgs=${JSON.stringify([
    factory,
    bestExecutionRouter,
    wrappedNative,
  ])}`);
}

void main().catch((error: unknown) => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = [
    process.env.DEPLOYER_PRIVATE_KEY?.trim(),
    process.env.COTI_RPC_URL?.trim(),
  ].reduce<string>(
    (message, secret) => secret ? message.replaceAll(secret, "[redacted]") : message,
    rawMessage,
  );
  console.error(`Public native best-execution deployment failed: ${safeMessage}`);
  process.exitCode = 1;
});
