import { artifacts, network } from "hardhat";

export { artifacts };

export const connection = await network.getOrCreate();
export const ethers = connection.ethers;
