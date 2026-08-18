import { isAbsolute } from "node:path";
import { dirname } from "node:path";

import {
  readPrivateEnvironmentFile,
  restrictPrivateDirectory,
  restrictPrivateFile,
} from "./private-filesystem.mjs";

const path = process.env.CIPHERDEX_FUNDED_ENV_FILE?.trim();
if (!path || !isAbsolute(path)) {
  throw new Error("secure:funded-env requires an absolute CIPHERDEX_FUNDED_ENV_FILE");
}
restrictPrivateDirectory(dirname(path));
restrictPrivateFile(path);
readPrivateEnvironmentFile(path);
console.log("Funded environment access is restricted to the current operating-system identity.");
