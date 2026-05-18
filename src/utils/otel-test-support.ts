import "./otel.js";

const RESET_OTEL_FOR_TEST = Symbol.for("vault-mcp.otel.resetForTest");
const INJECT_SDK_FOR_TEST = Symbol.for("vault-mcp.otel.injectSdkForTest");

export function resetOtelForTest(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("resetOtelForTest is only available outside production");
  }

  const reset = (globalThis as Record<PropertyKey, unknown>)[RESET_OTEL_FOR_TEST];
  if (typeof reset !== "function") {
    throw new Error("resetOtelForTest hook is unavailable");
  }

  reset();
}

export function injectSdkForTest(sdk: { shutdown(): Promise<void> }): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("injectSdkForTest is only available outside production");
  }

  const inject = (globalThis as Record<PropertyKey, unknown>)[INJECT_SDK_FOR_TEST];
  if (typeof inject !== "function") {
    throw new Error("injectSdkForTest hook is unavailable");
  }

  inject(sdk);
}
