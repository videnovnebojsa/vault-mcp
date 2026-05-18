import { mkdirSync } from "node:fs";
import { $ } from "bun";
import { resolveBunBinaryName } from "./src/build/bun-binary-name.js";

const name = resolveBunBinaryName(process.env["BUN_BINARY_NAME"]);
mkdirSync("dist-bin", { recursive: true });

await $`bun build src/index.ts --compile --outfile dist-bin/${name} --sourcemap=none`;

console.log(`Built: dist-bin/${name}`);
