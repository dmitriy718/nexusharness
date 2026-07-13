import { git, npmCli } from "./lib.mjs";

const commit = process.env.NEXUSHARNESS_COMMIT ?? await git(["rev-parse", "HEAD"]);
const builtAt = process.env.NEXUSHARNESS_BUILD_TIME ?? await git(["show", "-s", "--format=%cI", commit]);
const releaseEnvironment = {
  ...process.env,
  NODE_ENV: "production",
  NEXUSHARNESS_COMMIT: commit,
  NEXUSHARNESS_BUILD_TIME: builtAt
};

console.log(`Preparing release build for ${commit} at ${builtAt}.`);
await npmCli(["run", "build"], { env: releaseEnvironment, inherit: true });
await npmCli(["run", "verify:package"], { env: releaseEnvironment, inherit: true });
Object.assign(process.env, releaseEnvironment);
await import("./buildArtifacts.mjs");
