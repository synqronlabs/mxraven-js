import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/webhook/index.ts", "src/feedback/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: { sourcemap: true },
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  exports: false,
  checks: { legacyCjs: false },
});
