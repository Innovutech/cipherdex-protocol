import type { SolidityHooks } from "hardhat/types/hooks";

export default async (): Promise<Partial<SolidityHooks>> => ({
  build: async (context, rootFilePaths, options, next) => {
    const filteredRoots = rootFilePaths.filter((rootPath) => {
      const normalized = rootPath.replaceAll("\\", "/");
      return !normalized.includes("/contracts/interfaces/");
    });

    return next(context, filteredRoots, options);
  },
});
