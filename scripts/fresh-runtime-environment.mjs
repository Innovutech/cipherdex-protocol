import { existsSync } from "node:fs";
import { parseEnv } from "node:util";

import { readPrivateEnvironmentFile } from "./private-filesystem.mjs";

function populatedValue(environment, name) {
  const value = environment[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readReviewedEnvironment(path) {
  if (!existsSync(path)) return Object.freeze({});
  return Object.freeze(parseEnv(readPrivateEnvironmentFile(path)));
}

export function buildReviewedRuntimeEnvironment({
  ambientEnvironment,
  fileEnvironment,
  systemNames,
  configurationNames,
  allowAmbientConfiguration = true,
}) {
  const selected = { NODE_OPTIONS: "--max-old-space-size=8192" };
  for (const name of new Set(systemNames)) {
    const value = populatedValue(ambientEnvironment, name);
    if (value !== undefined) selected[name] = value;
  }
  for (const name of new Set(configurationNames)) {
    const ambientValue = allowAmbientConfiguration
      ? populatedValue(ambientEnvironment, name)
      : undefined;
    const fileValue = populatedValue(fileEnvironment, name);
    if (
      ambientValue !== undefined &&
      fileValue !== undefined &&
      ambientValue !== fileValue
    ) {
      throw new Error(`fresh Hardhat environment conflict for ${name}`);
    }
    const value = fileValue ?? ambientValue;
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}
