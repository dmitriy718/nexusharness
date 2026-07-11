import { readFileSync } from "node:fs";
import path from "node:path";

type PackageMetadata = {
  version: string;
};

const packagePath = path.join(process.cwd(), "package.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as PackageMetadata;

export const buildInfo = Object.freeze({
  version: packageMetadata.version,
  commit: process.env.NEXUSHARNESS_COMMIT ?? "development",
  builtAt: process.env.NEXUSHARNESS_BUILD_TIME ?? null,
  mode: process.env.NODE_ENV ?? "development"
});
