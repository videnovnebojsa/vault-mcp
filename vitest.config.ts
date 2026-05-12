import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*types.ts",
        "src/index.ts",
        "src/bootstrap.ts",
        "src/http.ts",
        "src/config.ts",
        "src/mcp/server.ts",
        "src/capture/service.ts",
        "src/search/tasks.ts",
        "src/search/connections.ts",
        "src/utils/otel.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
      reporter: ["text", "html", "json-summary"],
    },
  },
});
