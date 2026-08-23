import { getBytes, Wallet } from "ethers";

import { ethers } from "../hardhat/runtime.js";
import {
  DEPLOYMENT_MAX_GAS_UNITS,
  requireCleanSourceCommit,
  requiredDeploymentRecordPath,
} from "./deploy-protocol";
import { resolveNewDeploymentRecordPath } from "./deployment-record";
import { CastLedgerWallet, type ReviewedCastLedgerConfiguration } from "./cast-ledger-wallet";
import { REVIEWED_MAX_FEE_PER_GAS_WEI } from "./funded-transaction-wallet";

const COTI_MAINNET_CHAIN_ID = 2_632_500n;

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  return ethers.getAddress(value);
}

function requiredRecoveryKey(): void {
  const value = process.env.CIPHERDEX_DEPLOYMENT_RECOVERY_KEY?.trim();
  if (!value || getBytes(value).length !== 32) {
    throw new Error("CIPHERDEX_DEPLOYMENT_RECOVERY_KEY must contain exactly 32 bytes");
  }
}

async function main(): Promise<void> {
  if (process.env.COTI_TESTNET_PRIVATE_KEY?.trim()) {
    throw new Error("mainnet preflight refuses COTI_TESTNET_PRIVATE_KEY");
  }
  const sourceCommit = await requireCleanSourceCommit();
  if (process.env.CIPHERDEX_MAINNET_APPROVED_COMMIT?.trim().toLowerCase() !== sourceCommit) {
    throw new Error("CIPHERDEX_MAINNET_APPROVED_COMMIT must equal the reviewed source commit");
  }
  resolveNewDeploymentRecordPath(
    requiredDeploymentRecordPath(),
    sourceCommit,
    process.cwd(),
    "coti-mainnet",
  );
  requiredRecoveryKey();

  const rpcUrl = process.env.COTI_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("COTI_MAINNET_RPC_URL is required");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== COTI_MAINNET_CHAIN_ID) {
    throw new Error(`unexpected COTI mainnet chain id: ${network.chainId}`);
  }

  const feeBeneficiary = requiredAddress("CIPHERDEX_FEE_BENEFICIARY");
  const configuredLedgerAddress = process.env.CIPHERDEX_LEDGER_ADDRESS?.trim();
  const mainnetPrivateKey = process.env.COTI_MAINNET_PRIVATE_KEY?.trim();
  if (Boolean(configuredLedgerAddress) === Boolean(mainnetPrivateKey)) {
    throw new Error(
      "configure exactly one mainnet signer: CIPHERDEX_LEDGER_ADDRESS or COTI_MAINNET_PRIVATE_KEY",
    );
  }
  let deployerAddress: string;
  let signerSummary: string;
  if (configuredLedgerAddress) {
    const ledgerAddress = requiredAddress("CIPHERDEX_LEDGER_ADDRESS");
    const configuration: ReviewedCastLedgerConfiguration = Object.freeze({
      executable: process.env.CIPHERDEX_CAST_PATH?.trim() ?? "",
      executableSha256: process.env.CIPHERDEX_CAST_SHA256?.trim() ?? "",
      ledgerAddress,
      derivationPath:
        process.env.CIPHERDEX_LEDGER_DERIVATION_PATH?.trim() ?? "m/44'/60'/0'/0/0",
      rpcUrl,
    });
    const ledger = await CastLedgerWallet.create(configuration, ethers.provider);
    await ledger.verifyDeviceAddress();
    deployerAddress = ledgerAddress;
    signerSummary = `ledger; cast=${ledger.castIdentity.version}`;
  } else {
    const wallet = new Wallet(mainnetPrivateKey!);
    deployerAddress = wallet.address;
    signerSummary = "external private key";
  }

  const [balance, feeData] = await Promise.all([
    ethers.provider.getBalance(deployerAddress),
    ethers.provider.getFeeData(),
  ]);
  const currentMaximumFee = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!currentMaximumFee || currentMaximumFee > REVIEWED_MAX_FEE_PER_GAS_WEI) {
    throw new Error("COTI mainnet RPC fee exceeds the reviewed deployment cap");
  }
  const maximumDeploymentCost = DEPLOYMENT_MAX_GAS_UNITS * REVIEWED_MAX_FEE_PER_GAS_WEI;
  if (balance < maximumDeploymentCost) {
    throw new Error("mainnet deployer has insufficient native COTI for the reviewed gas caps");
  }

  console.log(
    `COTI mainnet deployment preflight passed for ${deployerAddress}; ` +
      `commit=${sourceCommit}; signer=${signerSummary}; no transaction was signed or sent`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`COTI mainnet deployment preflight failed: ${message}`);
  process.exitCode = 1;
});
