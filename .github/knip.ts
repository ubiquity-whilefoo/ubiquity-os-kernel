import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/worker.ts", "deploy/setup-kv-namespace.ts", "build/index.ts", ".github/empty-string-checker.ts"],
  project: ["src/**/*.ts"],
  ignore: ["jest.config.ts", "src/types/config.ts", "**/__mocks__/**", "**/__fixtures__/**", "eslint.config.mjs"],
  ignoreBinaries: ["i", "publish"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ["@mswjs/data", "esbuild", "eslint-config-prettier", "eslint-plugin-prettier", "@types/jest", "husky"],
  eslint: true,
};

export default config;
