import {
  ContractFactory,
  JsonRpcProvider,
  Wallet,
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

async function main(): Promise<void> {
  const rpcUrl = requiredEnvironment("COTI_RPC_URL");
  const privateKey = requiredEnvironment("DEPLOYER_PRIVATE_KEY");
  const configuredFactory = requiredEnvironment("PUBLIC_CPMM_FACTORY_ADDRESS");
  if (!isAddress(configuredFactory)) {
    throw new Error("PUBLIC_CPMM_FACTORY_ADDRESS must be a valid address");
  }
  const canonicalFactory = getAddress(configuredFactory);

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const networkName = COTI_NETWORKS.get(network.chainId);
  if (!networkName) {
    throw new Error(
      `limit-order deployment supports only COTI testnet/mainnet; got chain ${network.chainId}`,
    );
  }
  if ((await provider.getCode(canonicalFactory)) === "0x") {
    throw new Error("PUBLIC_CPMM_FACTORY_ADDRESS has no deployed code");
  }

  const deployer = new Wallet(privateKey, provider);
  const artifact = await artifacts.readArtifact("PublicCPMMLimitOrderBook");
  const contractFactory = new ContractFactory(
    artifact.abi,
    artifact.bytecode,
    deployer,
  );
  const orderBook = await contractFactory.deploy(canonicalFactory);
  const deploymentTransaction = orderBook.deploymentTransaction();
  if (!deploymentTransaction) throw new Error("deployment transaction was not created");
  const receipt = await deploymentTransaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("PublicCPMMLimitOrderBook deployment did not mine successfully");
  }
  await orderBook.waitForDeployment();

  const deployedAddress = await orderBook.getAddress();
  const boundFactory = await orderBook.getFunction("factory").staticCall();
  if (getAddress(String(boundFactory)) !== canonicalFactory) {
    throw new Error("deployed limit-order book factory binding mismatch");
  }

  console.log(`network=${networkName}`);
  console.log(`chainId=${network.chainId}`);
  console.log(`deployer=${await deployer.getAddress()}`);
  console.log(`publicCPMMFactory=${canonicalFactory}`);
  console.log(`publicCPMMLimitOrderBook=${deployedAddress}`);
  console.log(`deploymentTx=${deploymentTransaction.hash}`);
  console.log(`constructorArgs=${JSON.stringify([canonicalFactory])}`);
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
  console.error(`PublicCPMMLimitOrderBook deployment failed: ${safeMessage}`);
  process.exitCode = 1;
});
