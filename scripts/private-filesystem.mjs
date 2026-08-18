import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_SECRET_FILE_BYTES = 1_000_000;
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_ICACLS = "C:\\Windows\\System32\\icacls.exe";

function runWindowsPowerShell(script, path, failure) {
  const result = spawnSync(WINDOWS_POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", `$path=$env:CIPHERDEX_PRIVATE_PATH\n${script}`,
  ], {
    encoding: "utf8",
    env: { ...process.env, CIPHERDEX_PRIVATE_PATH: resolve(path) },
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = result.error?.message ?? result.stderr.trim();
    throw new Error(diagnostic ? `${failure}: ${diagnostic}` : failure);
  }
  return result.stdout.trim();
}

function windowsAcl(path, operation, directory) {
  // Secret reads require integrity as well as confidentiality. A principal that
  // cannot read the file but can replace it or rewrite its ACL is still outside
  // the funded trust boundary.
  const maskExpression =
    "[int64]([System.Security.AccessControl.FileSystemRights]::ReadData -bor " +
    "[System.Security.AccessControl.FileSystemRights]::WriteData -bor " +
    "[System.Security.AccessControl.FileSystemRights]::AppendData -bor " +
    "[System.Security.AccessControl.FileSystemRights]::Delete -bor " +
    "[System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor " +
    "[System.Security.AccessControl.FileSystemRights]::TakeOwnership)";
  const script = [
    "$ErrorActionPreference='Stop'",
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$current=$identity.User.Value",
    "$allowed=@($current,'S-1-5-18','S-1-5-32-544')",
    directory
      ? "$acl=[System.IO.Directory]::GetAccessControl($path)"
      : "$acl=[System.IO.File]::GetAccessControl($path)",
    "$owner=($acl.Owner | ForEach-Object { (New-Object System.Security.Principal.NTAccount($_)).Translate([System.Security.Principal.SecurityIdentifier]).Value })",
    `$mask=${maskExpression}`,
    "$bad=@($acl.Access | Where-Object {",
    "  $sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and",
    "    $allowed -notcontains $sid -and (([int64]$_.FileSystemRights -band $mask) -ne 0)",
    "} | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)",
    "[pscustomobject]@{CurrentSid=$current;OwnerSid=$owner;Protected=$acl.AreAccessRulesProtected;Violations=$bad} | ConvertTo-Json -Compress",
  ].join("\n");
  const value = JSON.parse(runWindowsPowerShell(
    script,
    path,
    "unable to validate the Windows funded-file access boundary",
  ));
  const violations = Array.isArray(value.Violations)
    ? value.Violations
    : value.Violations
      ? [value.Violations]
      : [];
  const allowedOwners = new Set([value.CurrentSid, "S-1-5-18", "S-1-5-32-544"]);
  if (!value.Protected || !allowedOwners.has(value.OwnerSid) || violations.length !== 0) {
    throw new Error(`funded ${operation} path is not restricted to the current identity`);
  }
}

function restrictWindowsPath(path, directory) {
  const identity = runWindowsPowerShell(
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    path,
    "unable to resolve the Windows funded-file identity",
  );
  if (!/^S-1-(?:\d+-)+\d+$/.test(identity)) {
    throw new Error("unable to resolve the Windows funded-file identity");
  }
  const inheritance = directory ? "(OI)(CI)" : "";
  const commands = [
    [resolve(path), "/reset"],
    [resolve(path), "/inheritance:r"],
    [
      resolve(path),
      "/grant:r",
      `*${identity}:${inheritance}F`,
      `*S-1-5-18:${inheritance}F`,
      `*S-1-5-32-544:${inheritance}F`,
    ],
  ];
  for (const arguments_ of commands) {
    const result = spawnSync(WINDOWS_ICACLS, arguments_, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const diagnostic = result.error?.message ?? result.stderr.trim();
      throw new Error(diagnostic
        ? `unable to restrict the Windows funded-file access boundary: ${diagnostic}`
        : "unable to restrict the Windows funded-file access boundary");
    }
  }
  windowsAcl(path, "write", directory);
}

export function restrictPrivateDirectory(path) {
  const configured = resolve(path);
  const original = lstatSync(configured);
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new Error("funded private directory must be a real directory");
  }
  const canonical = realpathSync(configured);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("funded private directory must be a real directory");
  }
  if (process.platform === "win32") restrictWindowsPath(canonical, true);
  else chmodSync(canonical, 0o700);
  return canonical;
}

export function restrictPrivateFile(path) {
  const configured = resolve(path);
  const original = lstatSync(configured);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("funded private file must be a real regular file");
  }
  const canonical = realpathSync(configured);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("funded private file must be a real regular file");
  }
  if (process.platform === "win32") restrictWindowsPath(canonical, false);
  else chmodSync(canonical, 0o600);
  return canonical;
}

export function assertPrivateFile(path, operation = "write") {
  if (operation !== "read" && operation !== "write") {
    throw new Error("funded private-file operation is invalid");
  }
  const configured = resolve(path);
  const original = lstatSync(configured);
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1) {
    throw new Error("funded private file must be a single-link regular file");
  }
  const canonical = realpathSync(configured);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("funded private file must be a single-link regular file");
  }
  if (process.platform === "win32") {
    windowsAcl(canonical, operation, false);
  } else {
    const currentUid = process.geteuid?.();
    if (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
      throw new Error("funded private file must be owned by the current identity with mode 0600");
    }
  }
  return canonical;
}

export function assertPrivateDirectory(path) {
  const configured = resolve(path);
  const original = lstatSync(configured);
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new Error("funded private directory must be a real directory");
  }
  const canonical = realpathSync(configured);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("funded private directory must be a real directory");
  }
  if (process.platform === "win32") {
    windowsAcl(canonical, "write", true);
  } else {
    const currentUid = process.geteuid?.();
    if (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
      throw new Error("funded private directory must be owned by the current identity with mode 0700");
    }
  }
  return canonical;
}

export function assertPrivateTree(path) {
  const root = assertPrivateDirectory(path);
  const currentUid = process.geteuid?.();
  const visit = (entryPath) => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error("funded private tree must not contain links or reparse points");
    }
    if (stat.isDirectory()) {
      if (
        process.platform !== "win32" &&
        (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o077) !== 0)
      ) throw new Error("funded private tree directory is not owner-only");
      for (const name of readdirSync(entryPath)) visit(resolve(entryPath, name));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("funded private tree must contain only single-link regular files");
    }
    if (
      process.platform !== "win32" &&
      (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o077) !== 0)
    ) throw new Error("funded private tree file is not owner-only");
  };
  visit(root);

  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
      "$allowed=@($identity.User.Value,'S-1-5-18','S-1-5-32-544')",
      "$mask=[int64]([System.Security.AccessControl.FileSystemRights]::ReadData -bor [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)",
      "$items=@(Get-Item -LiteralPath $path -Force)+@(Get-ChildItem -LiteralPath $path -Force -Recurse)",
      "foreach($item in $items) {",
      "  if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'private runtime contains a reparse point' }",
      "  $acl=$item.GetAccessControl()",
      "  $owner=(New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value",
      "  if($allowed -notcontains $owner) { throw 'private runtime descendant has an untrusted owner' }",
      "  foreach($rule in $acl.Access) {",
      "    $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
      "    if($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $sid -and (([int64]$rule.FileSystemRights -band $mask) -ne 0)) { throw 'private runtime descendant has an unsafe ACL' }",
      "  }",
      "}",
    ].join("\n");
    runWindowsPowerShell(
      script,
      root,
      "unable to validate the recursive Windows funded-runtime boundary",
    );
  }
  return root;
}

export function readPrivateEnvironmentFile(path) {
  const configured = resolve(path);
  assertPrivateDirectory(dirname(configured));
  const original = lstatSync(configured);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("funded environment must be a real regular file");
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(configured, flags);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_SECRET_FILE_BYTES) {
      throw new Error("funded environment must be a bounded single-link regular file");
    }
    if (process.platform === "win32") {
      windowsAcl(configured, "read", false);
    } else {
      const currentUid = process.geteuid?.();
      if (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
        throw new Error("funded environment must be owned by the current identity with mode 0600");
      }
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
