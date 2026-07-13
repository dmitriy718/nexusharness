import path from "node:path";
import { readFile } from "node:fs/promises";
import { changelogSection, expectedTag, git, readJson, repositoryRoot } from "./lib.mjs";

const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) throw new Error("Usage: node scripts/release/verifyTag.mjs <tag>");
if (tag !== expectedTag(packageJson.version)) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}; expected ${expectedTag(packageJson.version)}.`);
}

const changelog = await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
changelogSection(changelog, packageJson.version);

if (process.env.GITHUB_ACTIONS === "true") {
  const head = await git(["rev-parse", "HEAD"]);
  const tagged = await git(["rev-list", "-n", "1", tag]);
  if (head !== tagged) throw new Error(`Checked-out commit ${head} is not the commit referenced by ${tag} (${tagged}).`);
}

console.log(`Release identity verified: ${packageJson.name}@${packageJson.version} from ${tag}.`);
