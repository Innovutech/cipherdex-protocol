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

async function deploy(
  name: string,
  constructorArguments: readonly unknown[],
  wallet: Wallet,
) {
  const artifact = await artifacts.readArtifact(name);
  const contract = await new ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet,
  ).deploy(...constructorArguments);
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`${name} deployment transaction was not created`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${name} deployment did not mine successfully`);
  }
  await contract.waitForDeployment();
  return { contract, transaction };
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnvironment("COTI_RPC_URL");
  const privateKey = requiredEnvironment("DEPLOYER_PRIVATE_KEY");
  const canonicalFactory = requiredAddress("PUBLIC_CPMM_FACTORY_ADDRESS");
  const bestExecutionRouter = requiredAddress(
    "PUBLIC_BEST_EXECUTION_ROUTER_ADDRESS",
  );
  const wrappedNative = requiredAddress("PUBLIC_WRAPPED_NATIVE_ADDRESS");
  const surplusBeneficiary = requiredAddress(
    "PUBLIC_LIMIT_ORDER_SURPLUS_BENEFICIARY",
  );

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const networkName = COTI_NETWORKS.get(network.chainId);
  if (!networkName) {
    throw new Error(
      `public limit-order deployment supports only COTI testnet/mainnet; got chain ${network.chainId}`,
    );
  }
  for (const [name, address] of [
    ["PUBLIC_CPMM_FACTORY_ADDRESS", canonicalFactory],
    ["PUBLIC_BEST_EXECUTION_ROUTER_ADDRESS", bestExecutionRouter],
    ["PUBLIC_WRAPPED_NATIVE_ADDRESS", wrappedNative],
  ] as const) {
    if ((await provider.getCode(address)) === "0x") {
      throw new Error(`${name} has no deployed code`);
    }
  }

  const deployer = new Wallet(privateKey, provider);
  const orderBookDeployment = await deploy(
    "PublicCPMMLimitOrderBook",
    [canonicalFactory, bestExecutionRouter, wrappedNative, surplusBeneficiary],
    deployer,
  );
  const orderBookAddress = await orderBookDeployment.contract.getAddress();

  const boundOrderBookFactory = await orderBookDeployment.contract
    .getFunction("factory").staticCall();
  const boundOrderBookRouter = await orderBookDeployment.contract
    .getFunction("bestExecutionRouter").staticCall();
  const boundWrappedNative = await orderBookDeployment.contract
    .getFunction("wrappedNative").staticCall();
  const boundSurplusBeneficiary = await orderBookDeployment.contract
    .getFunction("surplusBeneficiary").staticCall();
  if (
    getAddress(String(boundOrderBookFactory)) !== canonicalFactory ||
    getAddress(String(boundOrderBookRouter)) !== bestExecutionRouter ||
    getAddress(String(boundWrappedNative)) !== wrappedNative ||
    getAddress(String(boundSurplusBeneficiary)) !== surplusBeneficiary
  ) throw new Error("deployed public limit-order binding mismatch");

  console.log(`network=${networkName}`);
  console.log(`chainId=${network.chainId}`);
  console.log(`deployer=${await deployer.getAddress()}`);
  console.log(`publicCPMMFactory=${canonicalFactory}`);
  console.log(`publicBestExecutionRouter=${bestExecutionRouter}`);
  console.log(`wrappedNative=${wrappedNative}`);
  console.log(`publicCPMMLimitOrderBook=${orderBookAddress}`);
  console.log(`publicCPMMLimitOrderBookDeploymentTx=${orderBookDeployment.transaction.hash}`);
  console.log(`publicCPMMLimitOrderBookConstructorArgs=${JSON.stringify([
    canonicalFactory,
    bestExecutionRouter,
    wrappedNative,
    surplusBeneficiary,
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
  console.error(`Public limit-order deployment failed: ${safeMessage}`);
  process.exitCode = 1;
});
