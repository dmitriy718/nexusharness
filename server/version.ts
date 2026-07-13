import { readFileSync } from "node:fs";
import { installationPaths } from "./paths.js";

type PackageMetadata = {
  version: string;
};

const packageMetadata = JSON.parse(readFileSync(installationPaths.packageJson, "utf8")) as PackageMetadata;

export const buildInfo = Object.freeze({
  version: packageMetadata.version,
  commit: process.env.NEXUSHARNESS_COMMIT ?? "development",
  builtAt: process.env.NEXUSHARNESS_BUILD_TIME ?? null,
  mode: process.env.NODE_ENV ?? "development"
});
