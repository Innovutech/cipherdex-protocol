import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";
import { subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import type { HardhatUserConfig } from "hardhat/config";

// Use the exact reviewed solc-js package instead of downloading a compiler during
// compilation. This keeps the build reproducible and avoids an unpinned binary fetch.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (args, _hre, runSuper) => {
  if (args.solcVersion === "0.8.28") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: "0.8.28",
      longVersion: "0.8.28+commit.7893614a",
    };
  }
  return runSuper();
});

const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
const accounts = privateKey ? [privateKey] : [];

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "paris",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
      metadata: {
        bytecodeHash: "none",
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    cotiTestnet: {
      url: process.env.COTI_TESTNET_RPC_URL ?? "https://testnet.coti.io/rpc",
      chainId: 7082400,
      accounts,
    },
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
