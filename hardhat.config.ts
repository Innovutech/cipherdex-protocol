import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatTypechain from "@nomicfoundation/hardhat-typechain";
import { defineConfig } from "hardhat/config";
import { createRequire } from "node:module";
import cipherdexSolidityBuildBoundary from "./hardhat/cipherdex-plugin";

const require = createRequire(import.meta.url);
const solcPath = require.resolve("solc/soljson.js");

function compilerSettings(runs: number, viaIR = true) {
  return {
    version: "0.8.28",
    path: solcPath,
    settings: {
      evmVersion: "paris",
      viaIR,
      optimizer: {
        enabled: true,
        runs,
      },
      metadata: {
        bytecodeHash: "none",
      },
    },
  } as const;
}

const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
const accounts = privateKey ? [privateKey] : [];
const cotiTestnetGasLimit = Number(process.env.COTI_TESTNET_GAS_LIMIT ?? "30000000");
if (!Number.isSafeInteger(cotiTestnetGasLimit) || cotiTestnetGasLimit <= 0) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive safe integer");
}

const cotiMainnetGasLimit = Number(process.env.COTI_MAINNET_GAS_LIMIT ?? "30000000");
if (!Number.isSafeInteger(cotiMainnetGasLimit) || cotiMainnetGasLimit <= 0) {
  throw new Error("COTI_MAINNET_GAS_LIMIT must be a positive safe integer");
}

export default defineConfig({
  plugins: [
    cipherdexSolidityBuildBoundary,
    hardhatEthers,
    hardhatEthersChaiMatchers,
    hardhatMocha,
    hardhatTypechain,
  ],
  solidity: {
    compilers: [compilerSettings(200)],
    overrides: {
      "contracts/ConfidentialCPMM.sol": compilerSettings(201),
      "contracts/ConfidentialCPMMFactory.sol": compilerSettings(1),
      // The migrator can only be created by the launch strategy constructor.
      // Match that compilation job so its canonical artifact is byte-identical
      // to the constructor-created runtime verified during deployment.
      "contracts/ConfidentialLaunchpadMigrator.sol": compilerSettings(1),
      "contracts/ConfidentialCPMMDeployer.sol": compilerSettings(1),
      "contracts/ConfidentialLaunchInitializationStrategy.sol": compilerSettings(1),
      "contracts/ConfidentialInitializationStrategyRegistry.sol": compilerSettings(1),
      "contracts/ConfidentialBestExecutionRouter.sol": compilerSettings(211),
      "contracts/ObservableConfidentialCPMM.sol": compilerSettings(1),
      "contracts/ObservableConfidentialCPMMFactory.sol": compilerSettings(2),
      "contracts/ObservableConfidentialCPMMDeployer.sol": compilerSettings(1),
      "contracts/ObservableConfidentialLaunchpadMigrator.sol": compilerSettings(2),
      "contracts/ObservableConfidentialLaunchInitializationStrategy.sol": compilerSettings(2),
      "contracts/ObservableConfidentialInitializationStrategyRegistry.sol": compilerSettings(2),
      "contracts/ObservableConfidentialBestExecutionRouter.sol": compilerSettings(213),
      "contracts/CipherDEXConfidentialFeeVault.sol": compilerSettings(2),
      "contracts/PrivateLPToken.sol": compilerSettings(204),
      "contracts/PrivateLPTokenFactory.sol": compilerSettings(205),
      "contracts/PublicCPMM.sol": compilerSettings(200, false),
      "contracts/PublicCPMMFactory.sol": compilerSettings(200, false),
      "contracts/PublicLPToken.sol": compilerSettings(200, false),
      "contracts/PublicLPTokenFactory.sol": compilerSettings(200, false),
      "contracts/PublicCPMMQuoter.sol": compilerSettings(206, false),
      "contracts/PublicCPMMRouter.sol": compilerSettings(207, false),
      "contracts/PublicBestExecutionRouter.sol": compilerSettings(207),
      "contracts/PublicCPMMLimitOrderBook.sol": compilerSettings(200),
      "contracts/PublicCPMMLiquidityRouter.sol": compilerSettings(208),
      "contracts/WrappedNativeToken.sol": compilerSettings(200, false),
      "contracts/PublicCPMMNativeRouter.sol": compilerSettings(209),
      "contracts/interfaces/IPublicCPMM.sol": compilerSettings(200, false),
      "contracts/interfaces/IPublicCPMMFactory.sol": compilerSettings(200, false),
      "contracts/interfaces/IPublicCPMMRouter.sol": compilerSettings(200, false),
      "contracts/interfaces/IPublicBestExecutionRouter.sol": compilerSettings(200, false),
      "contracts/interfaces/IPublicCPMMLiquidityRouter.sol": compilerSettings(200, false),
      "contracts/interfaces/IPublicLPToken.sol": compilerSettings(200, false),
      "contracts/interfaces/IPublicLPTokenFactory.sol": compilerSettings(200, false),
      "contracts/interfaces/IWrappedNativeToken.sol": compilerSettings(200, false),
      "contracts/mocks/MockERC20.sol": compilerSettings(200, false),
      "contracts/mocks/MockPermitERC20.sol": compilerSettings(200, false),
      "contracts/mocks/MockTokenMetadata.sol": compilerSettings(200, false),
      "contracts/mocks/MpcQuoteCallProbe.sol": compilerSettings(208),
      "contracts/mocks/MpcObservablePriceProbe.sol": compilerSettings(208),
      "contracts/mocks/MpcBestExecutionPoolProbe.sol": compilerSettings(209),
      "contracts/mocks/MpcBestExecutionRouterProbe.sol": compilerSettings(210),
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    cotiTestnet: {
      type: "http",
      chainType: "generic",
      url: process.env.COTI_TESTNET_RPC_URL ?? "https://testnet.coti.io/rpc",
      chainId: 7082400,
      accounts,
      // COTI testnet intermittently rejects pending-block lookups while
      // populating transactions. Receipts still report actual gas consumed.
      gas: cotiTestnetGasLimit,
    },
    cotiMainnet: {
      type: "http",
      chainType: "generic",
      url: process.env.COTI_MAINNET_RPC_URL ?? "https://mainnet.coti.io/rpc",
      chainId: 2632500,
      accounts: [],
      gas: cotiMainnetGasLimit,
    },
  },
  test: {
    mocha: {
      timeout: 120_000,
    },
  },
  typechain: {
    outDir: "typechain-types",
  },
});
