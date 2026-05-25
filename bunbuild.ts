import { mkdirSync } from "node:fs";
import { $ } from "bun";
import { resolveBunBinaryName } from "./src/build/bun-binary-name.js";

const name = resolveBunBinaryName(process.env["BUN_BINARY_NAME"]);
mkdirSync("dist-bin", { recursive: true });

// OTel packages are optional runtime dependencies (dynamic imports, ENABLE_OTEL=false by default).
// Mark them external so the bundler does not attempt to bundle them at compile time.
// If ENABLE_OTEL=true, the packages must be installed alongside the binary.
await $`bun build src/index.ts --compile --outfile dist-bin/${name} --sourcemap=none \
  --external @opentelemetry/sdk-node \
  --external @opentelemetry/auto-instrumentations-node \
  --external @opentelemetry/exporter-trace-otlp-http \
  --external @opentelemetry/sdk-trace-node \
  --external @opentelemetry/api`;

console.log(`Built: dist-bin/${name}`);
