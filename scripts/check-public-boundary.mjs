import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoints = [
  "package.json", "package-lock.json", ".mcp.json", ".claude-plugin", ".github",
  ".gitignore", ".npmignore", "tsconfig.json", "vitest.config.ts", "playwright.config.ts",
  "skills", "docs", "schemas", "examples", "scripts", "src", "tests", "test", "dist",
  "README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md", "AGENTS.md"
];
const skippedDirectories = new Set([".git", "node_modules", "coverage", "test-results", "playwright-report", ".demo-studio"]);
const maxTextBytes = 20 * 1024 * 1024;
const maxMediaBytes = 512 * 1024 * 1024;
const maxArchiveBytes = 512 * 1024 * 1024;
const issues = [];
const scanned = new Set();
let sourceMediaAssets = [];

// Generic network suffixes are assembled from labels so this scanner can audit its own source.
const privateDnsSuffixes = [
  ["svc", "cluster", "local"],
  ["cluster", "local"],
  ["internal"],
  ["lan"],
  ["local"],
  ["ts", "net"]
].map((labels) => labels.join(".")).join("|");
const privateDnsPattern = new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${privateDnsSuffixes})\\b`, "i");
const unixHomePattern = /(?:^|[\s"'=])\/(?:home|Users)\/[a-z0-9._-]+\//i;
const windowsHomePattern = /[a-z]:\\Users\\[a-z0-9._-]+\\/i;
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const credentialPatterns = [
  { id: "credential-shaped-token", regex: /\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{12,}|akia[0-9a-z]{16}|AIza[0-9a-z_-]{30,})\b/i },
  { id: "jwt-shaped-value", regex: /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i },
  { id: "bearer-credential", regex: /\bBearer\s+[a-z0-9._~-]{24,}\b/i },
  { id: "credential-assignment", regex: /\b[a-z0-9_]*(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET|ACCESS_KEY)[a-z0-9_]*\s*[:=]\s*(?!(?:["'`]?[\s]*(?:REDACTED|PLACEHOLDER|YOUR[_ -]|EXAMPLE|CHANGEME|DUMMY|<|\/)))(?:["'`][^"'`\r\n]{4,}["'`]|[a-z0-9_./+=~-]{12,})/i },
  { id: "credential-url", regex: /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/i }
];

function relativeName(name) {
  if (name.startsWith("archive:") || !name.startsWith(sep)) return name;
  return relative(root, name);
}

function issue(name, rule) {
  issues.push(`${relativeName(name)} [${rule}]`);
}

function withinRoot(path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function isPrivateAddress(address) {
  const octets = address.split(".").map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  if (address === "127.0.0.1") return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function parseMediaManifest(bytes, label) {
  try {
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error("invalid");
    return manifest.assets;
  } catch {
    issue(label, "invalid-media-audit-manifest");
    return [];
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateMedia(label, bytes, manifestAssets, extension) {
  let name = label.startsWith("archive:") ? label.slice("archive:".length) : relativeName(label);
  if (name.startsWith("package/")) name = name.slice("package/".length);
  const asset = manifestAssets.find((candidate) => candidate && candidate.path === name);
  if (!asset) {
    issue(label, "binary-media-missing-audit-manifest-entry");
    return;
  }
  const kind = extension === ".png" ? "png" : "mp4";
  if (asset.kind !== kind || asset.sha256 !== sha256(bytes)) issue(label, "binary-media-metadata-hash-mismatch");
  if (asset.synthetic !== true || asset.metadataVerified !== true || asset.framesReviewed !== true
    || typeof asset.reviewedBy !== "string" || !asset.reviewedBy.trim()
    || typeof asset.reviewedAt !== "string" || !asset.reviewedAt.trim()) {
    issue(label, "binary-media-audit-incomplete");
  }
  if (extension === ".png" && (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")) {
    issue(label, "binary-media-type-mismatch");
  }
  if (extension === ".mp4" && (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp")) {
    issue(label, "binary-media-type-mismatch");
  }
  scanned.add(label);
}

function scanText(name, bytes, privateTerms, markScanned = true) {
  if (bytes.length > maxTextBytes) {
    issue(name, "oversized-public-source");
    return;
  }
  if (bytes.includes(0)) {
    issue(name, "unexpected-binary-public-file");
    return;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    issue(name, "unexpected-binary-public-file");
    return;
  }
  if (markScanned) scanned.add(name);
  for (const match of text.matchAll(ipv4Pattern)) if (isPrivateAddress(match[0])) issue(name, "private-network-address");
  if (privateDnsPattern.test(text)) issue(name, "private-network-hostname");
  if (unixHomePattern.test(text) || windowsHomePattern.test(text)) issue(name, "absolute-home-path");
  for (const pattern of credentialPatterns) if (pattern.regex.test(text)) issue(name, pattern.id);
  const normalized = text.toLocaleLowerCase("en-US");
  for (const term of privateTerms) if (term.length >= 3 && normalized.includes(term.toLocaleLowerCase("en-US"))) issue(name, "external-private-term-match");
}

function scanBytes(name, bytes, privateTerms, manifestAssets = sourceMediaAssets) {
  const lowered = name.toLocaleLowerCase("en-US");
  const extension = lowered.endsWith(".png") ? ".png" : lowered.endsWith(".mp4") ? ".mp4" : null;
  if (extension) {
    validateMedia(name, bytes, manifestAssets, extension);
    return;
  }
  scanText(name, bytes, privateTerms);
}

function scanPath(path, privateTerms) {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    issue(path, "public-source-symlink");
    return;
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (skippedDirectories.has(entry)) continue;
      scanPath(join(path, entry), privateTerms);
    }
    return;
  }
  if (!info.isFile()) {
    issue(path, "unexpected-public-filesystem-entry");
    return;
  }
  const name = relativeName(path);
  scanText(`${name} [filename]`, Buffer.from(name, "utf8"), privateTerms, false);
  if (info.size > maxMediaBytes) {
    issue(path, "oversized-public-file");
    return;
  }
  if (name === "docs/media-manifest.json") sourceMediaAssets = parseMediaManifest(readFileSync(path), name);
  scanBytes(path, readFileSync(path), privateTerms);
}

function checkedArchiveName(rawName) {
  if (!rawName || rawName.includes("\0") || rawName.startsWith("/") || rawName.includes("\\") || /^[a-z]:/i.test(rawName)) return null;
  const normalized = posix.normalize(rawName);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function tarHeaderChecksum(header) {
  const expected = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(), 8);
  let actual = 0;
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index];
  return Number.isFinite(expected) && expected === actual;
}

function parsePaxPath(bytes) {
  for (const line of bytes.toString("utf8").split("\n")) {
    const pathIndex = line.indexOf("path=");
    if (pathIndex >= 0) return line.slice(pathIndex + 5).replace(/\0.*$/, "");
  }
  return null;
}

function scanTarArchive(archivePath, privateTerms) {
  const info = lstatSync(archivePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    issue("archive:[input]", "archive-must-be-a-local-regular-file");
    return;
  }
  if (info.size > maxArchiveBytes) {
    issue("archive:[input]", "release-archive-too-large");
    return;
  }
  let archive = readFileSync(archivePath);
  if (archivePath.endsWith(".tgz") || archivePath.endsWith(".tar.gz")) archive = gunzipSync(archive, { maxOutputLength: maxArchiveBytes });
  if (archive.length > maxArchiveBytes) {
    issue("archive:[input]", "release-archive-too-large");
    return;
  }
  if (archive.length % 512 !== 0) {
    issue("archive:[input]", "malformed-release-archive");
    return;
  }
  const entries = [];
  let offset = 0;
  let pendingPath = null;
  let sawEndMarker = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const trailer = archive.subarray(offset);
      sawEndMarker = true;
      if (trailer.length < 1024 || trailer.some((byte) => byte !== 0)) issue("archive:[trailer]", "malformed-release-archive");
      break;
    }
    if (!tarHeaderChecksum(header)) {
      issue("archive:[header]", "malformed-release-archive");
      return;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const linkName = header.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
    const userName = header.subarray(265, 297).toString("utf8").replace(/\0.*$/, "");
    const groupName = header.subarray(297, 329).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    scanText("archive:[header-metadata]", Buffer.from([name, linkName, userName, groupName, prefix].join("\n")), privateTerms);
    const rawName = pendingPath || (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;
    const safeName = checkedArchiveName(rawName);
    if (!safeName) {
      issue("archive:[entry]", "archive-path-traversal");
      return;
    }
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] || 0);
    if (!Number.isFinite(size) || size < 0) {
      issue("archive:[header]", "malformed-release-archive");
      return;
    }
    const dataStart = offset + 512;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (nextOffset > archive.length) {
      issue("archive:[entry]", "malformed-release-archive");
      return;
    }
    const data = archive.subarray(dataStart, dataStart + size);
    if (type === "x" || type === "g") {
      scanText("archive:[pax-metadata]", data, privateTerms);
      pendingPath = parsePaxPath(data) || pendingPath;
    } else if (["1", "2", "3", "4", "6"].includes(type)) {
      issue(`archive:${safeName}`, "archive-link-or-special-entry");
    } else if (type === "0" || type === "\0" || type === "5") {
      entries.push({ name: safeName, data, directory: type === "5" });
    } else {
      issue(`archive:${safeName}`, "unsupported-archive-entry-type");
    }
    offset = nextOffset;
  }
  if (!sawEndMarker) issue("archive:[trailer]", "malformed-release-archive");
  const manifest = entries.find((entry) => !entry.directory && entry.name.endsWith("docs/media-manifest.json"));
  const archiveMediaAssets = manifest ? parseMediaManifest(manifest.data, "archive:[media-manifest]") : [];
  for (const entry of entries) if (!entry.directory) scanBytes(`archive:${entry.name}`, entry.data, privateTerms, archiveMediaAssets);
}

function loadPrivateTerms(filePath) {
  if (!filePath) return [];
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath) || lstatSync(absolutePath).isSymbolicLink() || !lstatSync(absolutePath).isFile()) {
    throw new Error("Private-term input must be an existing regular file outside the repository.");
  }
  const canonicalPath = realpathSync(absolutePath);
  if (withinRoot(canonicalPath)) throw new Error("Private-term input must be outside the repository.");
  if (lstatSync(canonicalPath).size > maxTextBytes) throw new Error("Private-term input is too large.");
  return readFileSync(canonicalPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function requireSelfTest(condition) {
  if (!condition) throw new Error("public-boundary self-test assertion failed");
}

function syntheticTar(entries, endMarker = true) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = (entry.type || "0").charCodeAt(0);
    if (entry.linkName) header.write(entry.linkName, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header);
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      chunks.push(padded);
    }
  }
  if (endMarker) chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function runPublicBoundarySelfTests() {
  const syntheticPrivateIp = ["10", "44", "6", "12"].join(".");
  const syntheticPrivateHost = ["sample", "integration", "internal"].join(".");
  const syntheticHomePath = ["/", "Users/", "sample-person/", "project"].join("");
  const syntheticCredentialKey = ["DEMO_", "API_", "KEY"].join("");
  const syntheticCredential = ["sample", "only", "credential", "value"].join("-");
  const syntheticPrivateTerm = ["sample", "unpublished", "workspace"].join("-");
  const textCases = [
    { value: `endpoint ${syntheticPrivateIp}`, rule: "private-network-address" },
    { value: `endpoint ${syntheticPrivateHost}`, rule: "private-network-hostname" },
    { value: `source ${syntheticHomePath}`, rule: "absolute-home-path" },
    { value: `${syntheticCredentialKey}=${syntheticCredential}`, rule: "credential-assignment" }
  ];

  try {
    for (const testCase of textCases) {
      issues.length = 0;
      scanned.clear();
      scanText("synthetic-fixture.txt", Buffer.from(testCase.value), []);
      requireSelfTest(issues.some((entry) => entry.endsWith(`[${testCase.rule}]`)));
      requireSelfTest(!issues.join("\n").includes(testCase.value));
      requireSelfTest(!issues.join("\n").includes(syntheticCredential));
    }

    issues.length = 0;
    scanned.clear();
    scanText("synthetic-fixture.txt", Buffer.from(syntheticPrivateTerm), [syntheticPrivateTerm]);
    requireSelfTest(issues.some((entry) => entry.endsWith("[external-private-term-match]")));
    requireSelfTest(!issues.join("\n").includes(syntheticPrivateTerm));

    issues.length = 0;
    scanned.clear();
    scanText("synthetic-fixture.txt", Buffer.from("Synthetic public release note."), []);
    requireSelfTest(issues.length === 0 && scanned.size === 1);

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "demo-studio-boundary-"));
    try {
      const validArchive = syntheticTar([{ name: "package/README.md", data: "Synthetic archive fixture." }]);
      const archiveCases = [
        { name: "valid.tgz", bytes: gzipSync(validArchive), rule: null },
        { name: "traversal.tgz", bytes: gzipSync(syntheticTar([{ name: "../outside.txt", data: "synthetic" }])), rule: "archive-path-traversal" },
        { name: "symlink.tgz", bytes: gzipSync(syntheticTar([{ name: "package/link", type: "2", linkName: "outside" }])), rule: "archive-link-or-special-entry" },
        { name: "malformed-trailer.tgz", bytes: gzipSync(Buffer.from(validArchive.map((byte, index) => index === validArchive.length - 1 ? 1 : byte))), rule: "malformed-release-archive" },
        { name: "missing-trailer.tgz", bytes: gzipSync(syntheticTar([{ name: "package/README.md", data: "Synthetic archive fixture." }], false)), rule: "malformed-release-archive" }
      ];
      for (const testCase of archiveCases) {
        const archivePath = join(temporaryDirectory, testCase.name);
        writeFileSync(archivePath, testCase.bytes, { flag: "wx" });
        issues.length = 0;
        scanned.clear();
        scanTarArchive(archivePath, []);
        if (testCase.rule) requireSelfTest(issues.some((entry) => entry.endsWith(`[${testCase.rule}]`)));
        else requireSelfTest(issues.length === 0 && scanned.size > 0);
        requireSelfTest(!issues.some((entry) => entry.includes("Synthetic archive fixture.")));
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    issues.length = 0;
    scanned.clear();
    sourceMediaAssets = [];
  }
}

let archivePath = null;
let privateTermsPath = null;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--archive" && args[index + 1]) {
    archivePath = resolve(args[++index]);
  } else if (args[index] === "--private-terms-file" && args[index + 1]) {
    privateTermsPath = resolve(args[++index]);
  } else {
    process.stderr.write("Usage: node scripts/check-public-boundary.mjs [--archive path/to/package.tgz] [--private-terms-file path/outside/repository]\n");
    process.exit(2);
  }
}

try {
  runPublicBoundarySelfTests();
} catch {
  process.stderr.write("Public-boundary scanner self-tests failed; source scanning was not run.\n");
  process.exit(2);
}

let privateTerms;
try {
  privateTerms = loadPrivateTerms(privateTermsPath);
  const mediaManifest = resolve(root, "docs/media-manifest.json");
  if (existsSync(mediaManifest) && lstatSync(mediaManifest).isFile()) {
    sourceMediaAssets = parseMediaManifest(readFileSync(mediaManifest), "docs/media-manifest.json");
  }
  for (const entry of entryPoints) scanPath(resolve(root, entry), privateTerms);
  if (archivePath) scanTarArchive(archivePath, privateTerms);
} catch {
  process.stderr.write("Public-boundary scan could not read or validate an input. Check the source tree, optional external terms, and release archive, then retry.\n");
  process.exit(2);
}

if (!scanned.size) {
  process.stderr.write("No public source files were scanned.\n");
  process.exit(2);
}
if (issues.length) {
  const uniqueIssues = [...new Set(issues)].sort();
  process.stderr.write(`Public-boundary check failed (${uniqueIssues.length} issue(s)):\n${uniqueIssues.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Scanned ${scanned.size} public source file(s)${archivePath ? " and release archive" : ""}; no boundary findings.\n`);
