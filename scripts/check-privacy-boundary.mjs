import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../contracts/ConfidentialCPMM.sol", import.meta.url), "utf8");

const events = [...source.matchAll(/event\s+[^;]+;/g)].map(([event]) => event);
if (events.some((event) => /amount|reserve|share|value|input|output/i.test(event))) {
  throw new Error("Private amount-like data was added to a public event declaration.");
}

if (/emit\s+[^;]*(amount|reserve|share|value|input|output)/i.test(source)) {
  throw new Error("Private amount-like data was added to an emitted event.");
}

if (/console\s*\./.test(source)) {
  throw new Error("Debug output is forbidden in the protocol contract.");
}

for (const name of ["amount", "input", "output", "reserve", "shares", "minted"]) {
  const directDecrypt = new RegExp(`MpcCore\\.decrypt\\(\\s*${name}\\b`, "i");
  if (directDecrypt.test(source)) {
    throw new Error(`Private value ${name} is decrypted directly.`);
  }
}

console.log("Privacy boundary checks passed.");

