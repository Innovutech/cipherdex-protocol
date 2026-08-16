import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";
import { subtask } from "hardhat/config";
import {
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS,
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS,
} from "hardhat/builtin-tasks/task-names";
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

// Interfaces are compiled as dependencies of the concrete roots that import
// them. Keeping them out of the standalone root list avoids re-running the
// COTI MPC graph in separate solc-js jobs. Their source and ABI remain part of
// the concrete compilation inputs and the SDK's stable ABI surface.
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (_args, _hre, runSuper) => {
  const sourcePaths = await runSuper();
  return sourcePaths.filter((sourcePath: string) => {
    const normalized = sourcePath.replaceAll("\\", "/");
    return !normalized.includes("/contracts/interfaces/");
  });
});

// Hardhat creates a compilation job for every file in a connected component,
// including imported interface files. An interface-only COTI job repeats the
// full MPC graph and can overflow solc-js memory. Concrete jobs below still
// include all imported interfaces, so only redundant interface-only jobs are
// removed here.
subtask(TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOBS).setAction(async (args, _hre, runSuper) => {
  const result = await runSuper(args);
  return {
    ...result,
    jobs: result.jobs.filter((job: { getResolvedFiles: () => Array<{ sourceName: string }> }) =>
      job.getResolvedFiles().some(
        ({ sourceName }) =>
          sourceName.startsWith("contracts/") &&
          !sourceName.startsWith("contracts/interfaces/")
      )
    ),
  };
});

const privateKey = process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
const accounts = privateKey ? [privateKey] : [];
const cotiTestnetGasLimit = Number(process.env.COTI_TESTNET_GAS_LIMIT ?? "30000000");
if (!Number.isSafeInteger(cotiTestnetGasLimit) || cotiTestnetGasLimit <= 0) {
  throw new Error("COTI_TESTNET_GAS_LIMIT must be a positive safe integer");
}

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
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
    ],
    // Keep large COTI MPC graphs in separate solc-js jobs. The one-job graph
    // can exhaust solc-js memory; the one-step optimizer differences preserve
    // the same compiler, target, IR mode, and optimization policy while making
    // the split deterministic.
    overrides: {
      "contracts/ConfidentialCPMM.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 201,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/ConfidentialCPMMFactory.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 202,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/ConfidentialLaunchpadMigrator.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 203,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/PrivateLPToken.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 204,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/PrivateLPTokenFactory.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 205,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/PublicCPMM.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/PublicCPMMFactory.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/PublicCPMMQuoter.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 206,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/PublicCPMMRouter.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 207,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/interfaces/IPublicCPMM.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/interfaces/IPublicCPMMFactory.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/mocks/MockERC20.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/mocks/MockTokenMetadata.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: false,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
      "contracts/mocks/MpcQuoteCallProbe.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 208,
          },
          metadata: {
            bytecodeHash: "none",
          },
        },
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
      // COTI testnet intermittently rejects Hardhat's pending-block lookup while
      // auto-populating transactions. The explicit cap avoids that unsupported
      // lookup; receipts still charge and report only actual gas consumed.
      gas: cotiTestnetGasLimit,
    },
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
