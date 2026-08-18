export function restrictPrivateDirectory(path: string): string;
export function restrictPrivateFile(path: string): string;
export function assertPrivateDirectory(path: string): string;
export function assertPrivateFile(path: string, operation?: "read" | "write"): string;
export function readPrivateEnvironmentFile(path: string): string;
