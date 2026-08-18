import { definePlugin } from "hardhat/plugins";

export default definePlugin({
  id: "cipherdex:solidity-build-boundary",
  hookHandlers: {
    solidity: () => import("./solidity-hooks.js"),
  },
});
