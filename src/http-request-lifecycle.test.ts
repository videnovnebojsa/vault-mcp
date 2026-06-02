import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { BootstrapResult } from "./bootstrap.js";
import { VAULT_FOLDERS } from "./config/folders.js";
import type { VaultConfig } from "./config.js";
import type { VaultServices } from "./vault/manager.js";

const createServerMock = mock();
const createMcpExpressAppMock = mock();
const childLogger = {
  error: mock(),
  warn: mock(),
  info: mock(),
  debug: mock(),
};
const rootLogger = {
  child: mock(() => childLogger),
  error: mock(),
  warn: mock(),
  info: mock(),
  debug: mock(),
};

type RouteHandler = (req: MockRequest, res: MockResponse) => Promise<void> | void;

type RequestServer = {
  connect: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
};

type MockHandleRequest = (req: MockRequest, res: MockResponse, body: unknown) => Promise<void> | void;

type MockApp = ((req: MockRequest, res: MockResponse) => Promise<void> | void) & {
  get: ReturnType<typeof mock>;
  all: ReturnType<typeof mock>;
};

type MockHttpServer = EventEmitter & {
  listening: boolean;
  listen: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  address(): { port: number };
};

type MockRequest = EventEmitter & {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type MockResponse = EventEmitter & {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode: number;
  body: unknown;
  allowHeader?: string;
  status(code: number): MockResponse;
  json(body: unknown): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
};

const requestServers: RequestServer[] = [];
const transportInstances: MockStreamableHTTPServerTransport[] = [];
const routeHandlers = {
  get: new Map<string, RouteHandler>(),
  all: new Map<string, RouteHandler>(),
};

let connectImpl: () => Promise<void> | void = async () => {};
let serverCloseImpl: () => Promise<void> | void = async () => {};
let transportCloseImpl: () => Promise<void> | void = async () => {};
let handleRequestImpl: MockHandleRequest = async (_req, res) => {
  res.status(200).json({ ok: true });
};

class MockStreamableHTTPServerTransport {
  readonly close = mock(async () => transportCloseImpl());
  readonly handleRequest = mock(async (req: MockRequest, res: MockResponse, body: unknown) =>
    handleRequestImpl(req, res, body),
  );

  constructor(_opts: Record<string, never>) {
    transportInstances.push(this);
  }
}

function createMockApp(): MockApp {
  const app = ((req: MockRequest, res: MockResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    const path = req.url ?? "/";
    const handler = method === "GET" ? routeHandlers.get.get(path) : routeHandlers.all.get(path);
    if (!handler) {
      throw new Error(`No mock route registered for ${method} ${path}`);
    }
    return handler(req, res);
  }) as MockApp;

  app.get = mock((path: string, handler: RouteHandler) => {
    routeHandlers.get.set(path, handler);
  });
  app.all = mock((path: string, handler: RouteHandler) => {
    routeHandlers.all.set(path, handler);
  });

  return app;
}

function createMockHttpServer(): MockHttpServer {
  const server = new EventEmitter() as MockHttpServer;
  server.listening = false;
  server.listen = mock((_port: number, _host: string, onListen?: () => void) => {
    server.listening = true;
    onListen?.();
    return server;
  });
  server.close = mock((cb?: (err?: Error) => void) => {
    server.listening = false;
    cb?.();
    return server;
  });
  server.address = () => ({ port: 0 });
  return server;
}

function makeMockRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return Object.assign(new EventEmitter(), {
    method: "POST",
    url: "/mcp",
    headers: {},
    body: { jsonrpc: "2.0", id: 1 },
    ...overrides,
  });
}

function makeMockResponse(): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.headersSent = false;
  res.writableEnded = false;
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    res.headersSent = true;
    res.writableEnded = true;
    res.emit("close");
  };
  res.end = (body?: string) => {
    res.body = body;
    res.writableEnded = true;
    res.emit("close");
  };
  res.setHeader = (name: string, value: string) => {
    if (name.toLowerCase() === "allow") {
      res.allowHeader = value;
    }
  };
  return res;
}

mock.module("node:http", () => ({
  createServer: createServerMock,
}));

mock.module("@modelcontextprotocol/sdk/server/express.js", () => ({
  createMcpExpressApp: createMcpExpressAppMock,
}));

mock.module("./mcp/server.js", () => ({
  createServer: createServerMock,
}));

mock.module("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: MockStreamableHTTPServerTransport,
}));

mock.module("./utils/logger.js", () => ({
  logger: rootLogger,
}));

const { startHttpServer } = await import("./http.js");

function makeMockSvc(overrides: Partial<VaultServices> = {}): VaultServices {
  return {
    vault: {} as VaultServices["vault"],
    searchStore: {} as VaultServices["searchStore"],
    vaultSync: {} as VaultServices["vaultSync"],
    capture: null,
    embeddingStore: undefined,
    embedProvider: undefined,
    embeddingConfig: {
      enabled: false,
      apiKey: "",
      endpoint: "",
      model: "",
      hybridAlpha: 0.5,
      batchSize: 20,
    },
    aclConfig: { allowPaths: [], denyPaths: [] },
    vaultPath: "/tmp/vault",
    watcher: null,
    bootFailed: false,
    bootReady: Promise.resolve(),
    ...overrides,
  };
}

function makeBootstrap(vaultServices: Record<string, VaultServices> = {}): BootstrapResult {
  const defaultSvc = makeMockSvc();
  const allSvcs: Record<string, VaultServices> = { default: defaultSvc, ...vaultServices };

  const config: VaultConfig = {
    vaultPath: "/tmp/vault",
    memoryDbPath: ":memory:",
    namedVaults: Object.fromEntries(Object.keys(allSvcs).map((k) => [k, `/tmp/vault/${k}`])),
    periodicNotesRoot: "Journal",
    embedding: {
      enabled: false,
      apiKey: "",
      endpoint: "",
      model: "",
      hybridAlpha: 0.5,
      batchSize: 20,
    },
    backup: { enabled: false, dir: "", maxBackups: 5 },
    capture: { enableCapturePipeline: false, logRawInput: false },
    watcher: { enabled: false, debounceMs: 300 },
    mcpPort: 0,
    mcpHost: "127.0.0.1",
    mcpApiKey: "",
    alertWebhookUrl: "",
    acl: { allowPaths: [], denyPaths: [] },
    toolTimeoutMs: 30_000,
    classifyRules: undefined,
    folders: VAULT_FOLDERS,
    enableOtel: false,
    otelEndpoint: "",
  };

  const vaultManager = {
    listVaults: () => Object.keys(allSvcs).map((name) => ({ name })),
    getServices: (name = "default") => {
      const svc = allSvcs[name];
      if (!svc) throw new Error(`Unknown vault: "${name}"`);
      return svc;
    },
    config,
    shutdown: async () => {},
  };

  return { config, vaultManager } as unknown as BootstrapResult;
}

function getMcpHandler(): RouteHandler {
  const handler = routeHandlers.all.get("/mcp");
  if (!handler) throw new Error("POST /mcp handler was not registered");
  return handler;
}

beforeEach(() => {
  createServerMock.mockReset();
  createMcpExpressAppMock.mockReset();
  childLogger.error.mockReset();
  childLogger.warn.mockReset();
  childLogger.info.mockReset();
  childLogger.debug.mockReset();
  rootLogger.child.mockReset();
  rootLogger.child.mockReturnValue(childLogger);
  requestServers.length = 0;
  transportInstances.length = 0;
  routeHandlers.get.clear();
  routeHandlers.all.clear();
  connectImpl = async () => {};
  serverCloseImpl = async () => {};
  transportCloseImpl = async () => {};
  handleRequestImpl = async (_req, res) => {
    res.status(200).json({ ok: true });
  };

  createMcpExpressAppMock.mockImplementation(() => createMockApp());
  createServerMock.mockImplementation((arg?: unknown) => {
    if (typeof arg === "function") {
      return createMockHttpServer();
    }

    const server = {
      connect: mock(async () => connectImpl()),
      close: mock(async () => serverCloseImpl()),
    };
    requestServers.push(server);
    return server;
  });
});

describe("request lifecycle teardown", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("catches per-request close rejections so they do not surface as unhandled rejections [ERR-01]", async () => {
    transportCloseImpl = async () => {
      throw new Error("transport close failed");
    };
    serverCloseImpl = async () => {
      throw new Error("server close failed");
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();

    let unhandledReason: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandledReason = reason;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const req = makeMockRequest();
      const res = makeMockResponse();

      await mcpHandler(req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(unhandledReason).toBeNull();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("runs the response-close teardown only once per request [QA-01]", async () => {
    handleRequestImpl = async (_req, res) => {
      res.status(200).json({ ok: true });
      res.emit("close");
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();
    const req = makeMockRequest();
    const res = makeMockResponse();

    await mcpHandler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.statusCode).toBe(200);
    expect(transportInstances).toHaveLength(1);
    expect(requestServers).toHaveLength(1);
    expect(transportInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(requestServers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("returns a 500 and tears request resources down once when transport handling throws [QA-02]", async () => {
    handleRequestImpl = async () => {
      throw new Error("boom");
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();
    const req = makeMockRequest();
    const res = makeMockResponse();

    await mcpHandler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(transportInstances).toHaveLength(1);
    expect(requestServers).toHaveLength(1);
    expect(transportInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(requestServers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent POSTs beyond the configured cap [SEC-01]", async () => {
    let releaseFirstRequest: (() => void) | undefined;
    let requestCount = 0;
    handleRequestImpl = async (_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRequest = () => {
            res.status(200).json({ ok: true });
            resolve();
          };
        });
        return;
      }
      res.status(200).json({ ok: true });
    };

    handle = await startHttpServer(makeBootstrap(), { maxConcurrentRequests: 1 });
    const mcpHandler = getMcpHandler();

    const firstReq = makeMockRequest();
    const firstRes = makeMockResponse();
    const secondReq = makeMockRequest();
    const secondRes = makeMockResponse();

    const firstRequestPromise = mcpHandler(firstReq, firstRes);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await mcpHandler(secondReq, secondRes);

    expect(secondRes.statusCode).toBe(429);
    expect(secondRes.body).toEqual({ error: "Too Many Requests" });
    expect(transportInstances).toHaveLength(1);
    expect(requestServers).toHaveLength(1);

    releaseFirstRequest?.();
    await firstRequestPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.body).toEqual({ ok: true });
  });

  it("reuses a warmed request server across sequential POSTs [PERF-01]", async () => {
    handle = await startHttpServer(makeBootstrap(), { maxConcurrentRequests: 1 });
    const mcpHandler = getMcpHandler();

    const firstReq = makeMockRequest();
    const firstRes = makeMockResponse();
    await mcpHandler(firstReq, firstRes);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondReq = makeMockRequest({ body: { jsonrpc: "2.0", id: 2 } });
    const secondRes = makeMockResponse();
    await mcpHandler(secondReq, secondRes);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(requestServers).toHaveLength(1);
    expect(requestServers[0]?.connect).toHaveBeenCalledTimes(2);
    expect(transportInstances).toHaveLength(2);
  });

  it("ends the response when transport handling throws after headers were sent [AGY-02]", async () => {
    handleRequestImpl = async (_req, res) => {
      res.headersSent = true;
      throw new Error("stream failed");
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();
    const req = makeMockRequest();
    const res = makeMockResponse();

    await mcpHandler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.writableEnded).toBe(true);
    expect(res.body).toBeUndefined();
    expect(transportInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(requestServers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("returns 401 for DELETE before the stateless no-op when an API key is configured [QA-03]", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const mcpHandler = getMcpHandler();

    const req = makeMockRequest({ method: "DELETE" });
    const res = makeMockResponse();

    await mcpHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(transportInstances).toHaveLength(0);
    expect(requestServers).toHaveLength(0);
  });

  it("logs the JSON-RPC method and id when a stateless request fails [ERR-04]", async () => {
    handleRequestImpl = async () => {
      throw new Error("boom");
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();
    const req = makeMockRequest({
      body: {
        jsonrpc: "2.0",
        id: "req-42",
        method: "tools/call",
        params: { name: "vault_list_vaults", arguments: {} },
      },
    });
    const res = makeMockResponse();

    await mcpHandler(req, res);

    expect(childLogger.error).toHaveBeenCalledWith("stateless request transport error", {
      err: "boom",
      method: "tools/call",
      id: "req-42",
    });
  });

  it("waits for in-flight request teardown before close resolves [ERR-02]", async () => {
    let releaseRequest: (() => void) | undefined;
    handleRequestImpl = async (_req, res) => {
      await new Promise<void>((resolve) => {
        releaseRequest = () => {
          res.status(200).json({ ok: true });
          resolve();
        };
      });
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();
    const req = makeMockRequest();
    const res = makeMockResponse();

    const requestPromise = mcpHandler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    let closeResolved = false;
    const closePromise = handle.close().then(() => {
      closeResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeResolved).toBe(false);

    releaseRequest?.();
    await requestPromise;
    await closePromise;

    expect(closeResolved).toBe(true);
  });

  it("forwards tools/call without prior initialize or mcp-session-id [API-02]", async () => {
    handleRequestImpl = async (req, res, body) => {
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "vault_list_vaults", arguments: {} },
      });
      res.status(200).json({ ok: true });
    };

    handle = await startHttpServer(makeBootstrap());
    const mcpHandler = getMcpHandler();
    const req = makeMockRequest({
      body: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "vault_list_vaults", arguments: {} },
      },
    });
    const res = makeMockResponse();

    await mcpHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
