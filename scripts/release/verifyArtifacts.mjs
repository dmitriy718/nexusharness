import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expectedTag, readJson, repositoryRoot, sha256File } from "./lib.mjs";

const argument = process.argv[2] ?? "release-artifacts";
const directory = path.resolve(repositoryRoot, argument);
const names = await readdir(directory);
for (const required of ["artifact-manifest.json", "SBOM.cdx.json", "SHA256SUMS", "release-notes.md"]) {
  if (!names.includes(required)) throw new Error(`Release artifacts are missing ${required}.`);
}
const tarballs = names.filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error(`Expected exactly one release tarball, found ${tarballs.length}.`);

const checksumText = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
const entries = checksumText.trim().split(/\r?\n/).map((line) => {
  const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
  if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
  return { digest: match[1], name: match[2] };
});
for (const entry of entries) {
  const filePath = path.join(directory, entry.name);
  if (!(await stat(filePath)).isFile()) throw new Error(`${entry.name} is not a regular artifact file.`);
  const actual = await sha256File(filePath);
  if (actual !== entry.digest) throw new Error(`Checksum mismatch for ${entry.name}.`);
}

const [manifest, packageJson, sbom] = await Promise.all([
  readJson(path.join(directory, "artifact-manifest.json")),
  readJson(path.join(repositoryRoot, "package.json")),
  readJson(path.join(directory, "SBOM.cdx.json"))
]);
if (manifest.package.name !== packageJson.name || manifest.package.version !== packageJson.version) {
  throw new Error("Artifact manifest package identity does not match package.json.");
}
if (manifest.package.filename !== tarballs[0] || manifest.package.sha256 !== await sha256File(path.join(directory, tarballs[0]))) {
  throw new Error("Artifact manifest tarball identity or checksum is invalid.");
}
if (manifest.sbom.sha256 !== await sha256File(path.join(directory, "SBOM.cdx.json")) || sbom.bomFormat !== "CycloneDX") {
  throw new Error("Artifact manifest SBOM identity is invalid.");
}
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== expectedTag(manifest.package.version)) {
  throw new Error(`Workflow ref ${process.env.GITHUB_REF_NAME} does not match artifact version ${manifest.package.version}.`);
}
console.log(`Verified ${entries.length} checksums for ${manifest.package.name}@${manifest.package.version}.`);
