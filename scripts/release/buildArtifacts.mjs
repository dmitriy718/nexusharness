import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  changelogSection,
  git,
  npmCli,
  npmDistTag,
  readJson,
  repositoryRoot,
  sha256File
} from "./lib.mjs";

const outputDirectory = path.join(repositoryRoot, "release-artifacts");
if (path.dirname(outputDirectory) !== repositoryRoot || path.basename(outputDirectory) !== "release-artifacts") {
  throw new Error(`Refusing to prepare unexpected output directory ${outputDirectory}.`);
}
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
const changelog = await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
const releaseNotes = changelogSection(changelog, packageJson.version);
await writeFile(path.join(outputDirectory, "release-notes.md"), releaseNotes, "utf8");

const packOutput = await npmCli(["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory]);
const [packed] = JSON.parse(packOutput);
if (!packed?.filename) throw new Error("npm pack did not report the release tarball.");
const tarballPath = path.join(outputDirectory, packed.filename);

const sbomOutput = await npmCli(["sbom", "--omit=dev", "--sbom-format", "cyclonedx"]);
const sbom = JSON.parse(sbomOutput);
if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
  throw new Error("npm sbom did not produce a CycloneDX component inventory.");
}
const sbomPath = path.join(outputDirectory, "SBOM.cdx.json");
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const [commit, dirtyStatus, npmVersion] = await Promise.all([
  git(["rev-parse", "HEAD"]),
  git(["status", "--porcelain"]),
  npmCli(["--version"])
]);
if (process.env.REQUIRE_CLEAN_RELEASE === "1" && dirtyStatus) {
  throw new Error("Canonical release artifacts must be built from a clean checkout.");
}

const tarballStat = await stat(tarballPath);
const manifest = {
  schemaVersion: 1,
  package: {
    name: packageJson.name,
    version: packageJson.version,
    distTag: npmDistTag(packageJson.version),
    filename: packed.filename,
    sha256: await sha256File(tarballPath),
    size: tarballStat.size,
    unpackedSize: packed.unpackedSize,
    entryCount: packed.entryCount
  },
  source: {
    repository: packageJson.repository,
    commit,
    tag: `v${packageJson.version}`,
    dirty: Boolean(dirtyStatus)
  },
  toolchain: {
    node: process.version,
    npm: String(npmVersion).trim()
  },
  sbom: {
    filename: path.basename(sbomPath),
    sha256: await sha256File(sbomPath),
    componentCount: sbom.components.length
  },
  files: packed.files.map((file) => ({ path: file.path.replaceAll("\\", "/"), size: file.size, mode: file.mode }))
};
const manifestPath = path.join(outputDirectory, "artifact-manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const checksummed = [tarballPath, sbomPath, manifestPath, path.join(outputDirectory, "release-notes.md")];
const checksumLines = [];
for (const filePath of checksummed) checksumLines.push(`${await sha256File(filePath)}  ${path.basename(filePath)}`);
await writeFile(path.join(outputDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");

if (process.env.GITHUB_OUTPUT) {
  await writeFile(process.env.GITHUB_OUTPUT, [
    `version=${packageJson.version}`,
    `dist_tag=${manifest.package.distTag}`,
    `tarball=${packed.filename}`
  ].join("\n") + "\n", { encoding: "utf8", flag: "a" });
}

console.log(`Built ${packed.filename} (${tarballStat.size} bytes) from ${commit}${dirtyStatus ? " with local changes" : ""}.`);
console.log(`Recorded ${manifest.files.length} package files and ${sbom.components.length} SBOM components in ${outputDirectory}.`);
