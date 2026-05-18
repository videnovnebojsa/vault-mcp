export async function assertOkResponse(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text();
  const suffix = body ? `: ${body}` : "";
  throw new Error(`FAIL: ${label} returned HTTP ${res.status} ${res.statusText}${suffix}`);
}

export type ToolsListResponse = { result?: { tools?: unknown[] } };

export function parseToolsListResponse(body: string): ToolsListResponse {
  const dataLine = body.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return {};

  try {
    return JSON.parse(dataLine.slice(5).trim()) as ToolsListResponse;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`FAIL: tools/list returned malformed SSE JSON: ${detail}`);
  }
}

export async function drainTextStream(
  stream: ReadableStream<Uint8Array> | null,
  sink: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) sink(tail);
  } finally {
    reader.releaseLock();
  }
}

const SMOKE_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"];

export function buildSmokeEnv(source: NodeJS.ProcessEnv, vaultPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SMOKE_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env["OBSIDIAN_VAULT_PATH"] = vaultPath;
  env["MCP_PORT"] = "3783";
  return env;
}
