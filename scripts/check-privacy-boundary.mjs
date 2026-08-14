import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

async function solidityFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await solidityFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".sol")) files.push(path);
  }
  return files;
}

const contractsDirectory = fileURLToPath(new URL("../contracts/", import.meta.url));
const files = await solidityFiles(contractsDirectory);
for (const file of files) {
  const source = await readFile(file, "utf8");
  const events = [...source.matchAll(/event\s+[^;]+;/g)].map(([event]) => event);
  if (events.some((event) => /amount|reserve|share|value|input|output/i.test(event))) {
    throw new Error(`Private amount-like data was added to a public event declaration: ${file}`);
  }

  if (/emit\s+[^;]*(amount|reserve|share|value|input|output)/i.test(source)) {
    throw new Error(`Private amount-like data was added to an emitted event: ${file}`);
  }

  if (/console\s*\./.test(source)) {
    throw new Error(`Debug output is forbidden in the protocol contract: ${file}`);
  }

  for (const name of ["amount", "input", "output", "reserve", "shares", "minted"]) {
    const directDecrypt = new RegExp(`MpcCore\\.decrypt\\(\\s*${name}\\b`, "i");
    if (directDecrypt.test(source)) {
      throw new Error(`Private value ${name} is decrypted directly: ${file}`);
    }
  }
}

console.log(`Privacy boundary checks passed for ${files.length} Solidity files.`);
