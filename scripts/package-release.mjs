import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Build this macOS arm64 package on an Apple Silicon Mac.");
}
const options = process.argv.slice(2);
if (options.some(option => option !== "--skip-build")) throw new Error("Supported option: --skip-build");
if (!options.includes("--skip-build")) {
  execFileSync(process.env.npm_execpath ? process.execPath : "npm",
    process.env.npm_execpath ? [process.env.npm_execpath, "run", "build"] : ["run", "build"],
    { cwd: root, stdio: "inherit" });
}
const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const nativeSource = process.env.SYNCFORGE_DIR
  ? path.resolve(root, process.env.SYNCFORGE_DIR) : path.resolve(root, "../syncforge");
const binary = process.env.SYNCFORGE_BIN
  ? path.resolve(root, process.env.SYNCFORGE_BIN) : path.join(nativeSource, "SyncForgeKit/.build/release/sfctl");
const binaryKind = execFileSync("file", ["-b", binary], { encoding: "utf8" });
if (!binaryKind.includes("Mach-O") || !binaryKind.includes("arm64")) throw new Error("sfctl must contain a macOS arm64 executable.");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const name = `HomeCinema-${metadata.version}-macos-arm64-${timestamp}`;
const staging = await fs.mkdtemp(path.join(os.tmpdir(), "homecinema-release-"));
const packageRoot = path.join(staging, name);
const releases = path.join(root, "releases");
const archive = path.join(releases, `${name}.zip`);
await fs.mkdir(packageRoot);

const excluded = name => [".git", "node_modules", "media", "releases", ".DS_Store"].includes(name)
  || name.startsWith(".env") || name.endsWith(".log");
async function copyTree(source, destination) {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Release source cannot contain symlinks: ${source}`);
  if (info.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      if (!excluded(entry)) await copyTree(path.join(source, entry), path.join(destination, entry));
    }
  } else if (info.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, info.mode & 0o777);
  }
}
async function filesIn(folder, prefix = "") {
  const files = [];
  for (const entry of (await fs.readdir(folder)).sort()) {
    const relative = path.posix.join(prefix, entry);
    const absolute = path.join(folder, entry);
    if ((await fs.stat(absolute)).isDirectory()) files.push(...await filesIn(absolute, relative));
    else files.push(relative);
  }
  return files;
}
try {
  for (const entry of ["package.json", "package-lock.json", "server.js", "index.html", "vite.config.js", "README.md", "README.package.md", "src", "public", "dist", "lib", "docs", "scripts", "packaging"]) {
    await copyTree(path.join(root, entry), path.join(packageRoot, entry));
  }
  await copyTree(path.join(root, "native"), path.join(packageRoot, "native"));
  await copyTree(binary, path.join(packageRoot, "bin", "sfctl"));
  await fs.chmod(path.join(packageRoot, "bin", "sfctl"), 0o755);
  await copyTree(path.join(root, "packaging", "Start HomeCinema.command"), path.join(packageRoot, "Start HomeCinema.command"));
  await fs.chmod(path.join(packageRoot, "Start HomeCinema.command"), 0o755);
  await copyTree(path.join(nativeSource, "LICENSE"), path.join(packageRoot, "licenses", "SyncForge-MIT.txt"));

  const notices = ["HomeCinema bundled third-party notices", "SyncForge's original MIT license is in licenses/SyncForge-MIT.txt."];
  for (const dependency of ["react", "react-dom", "scheduler", "lucide-react", "vite"]) {
    const dependencyRoot = path.join(root, "node_modules", dependency);
    const dependencyMeta = JSON.parse(await fs.readFile(path.join(dependencyRoot, "package.json"), "utf8"));
    const licenseName = (await fs.readdir(dependencyRoot)).find(name => /^license(?:\.md|\.txt)?$/i.test(name));
    if (!licenseName) throw new Error(`Missing ${dependency} license`);
    const license = await fs.readFile(path.join(dependencyRoot, licenseName), "utf8");
    notices.push(`\n--- ${dependency} ${dependencyMeta.version} ---\n${license}`);
    await fs.writeFile(path.join(packageRoot, "licenses", `${dependency}-LICENSE.txt`), license);
  }
  await fs.writeFile(path.join(packageRoot, "THIRD_PARTY_NOTICES.txt"), notices.join("\n") + "\n");
  const releaseInfo = {
    name, version: metadata.version, builtAt: new Date().toISOString(), platform: "darwin", architecture: "arm64",
    nodeRequired: ">=22.12.0", nodeBuildVersion: process.versions.node, nodeBundled: false,
    nativeMinimumOS: "macOS 14.4", validatedOS: "macOS 26.3",
    audioAutoStart: false, mediaIncluded: false, calibrationIncluded: false,
    nativeUpstream: "https://github.com/alexandrustefan/syncforge",
    nativeCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: nativeSource, encoding: "utf8" }).trim(),
    nativeBinarySHA256: createHash("sha256").update(await fs.readFile(binary)).digest("hex")
  };
  await fs.writeFile(path.join(packageRoot, "RELEASE.json"), JSON.stringify(releaseInfo, null, 2) + "\n");
  const manifest = [];
  for (const file of await filesIn(packageRoot)) {
    const digest = createHash("sha256").update(await fs.readFile(path.join(packageRoot, file))).digest("hex");
    manifest.push(`${digest}  ${file}`);
  }
  await fs.writeFile(path.join(packageRoot, "SHA256SUMS"), manifest.join("\n") + "\n");
  await fs.mkdir(releases, { recursive: true });
  execFileSync("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", packageRoot, archive], { stdio: "inherit" });
  const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  console.log(`Release created: ${archive}\nSHA256: ${digest}\nFiles: ${manifest.length}. No audio was started.`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
