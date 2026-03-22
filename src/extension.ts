import * as vscode from "vscode";
import * as http from "http";
import * as url from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let server: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem;

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Status bar item (shown on the right side of the status bar)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "copilot-lm-proxy.startServer";
  updateStatusBar(false);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilot-lm-proxy.startServer",
      () => startServer(context)
    ),
    vscode.commands.registerCommand("copilot-lm-proxy.stopServer", stopServer)
  );

  // Auto-start if configured
  const cfg = vscode.workspace.getConfiguration("copilot-lm-proxy");
  if (cfg.get<boolean>("autoStart")) {
    startServer(context);
  }
}

export function deactivate(): void {
  stopServer();
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer(context: vscode.ExtensionContext): Promise<void> {
  if (server) {
    vscode.window.showInformationMessage(
      "Copilot LM Proxy is already running."
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("copilot-lm-proxy");
  const port = cfg.get<number>("port") ?? 3030;
  const host = cfg.get<string>("host") ?? "127.0.0.1";
  const apiKey = cfg.get<string>("apiKey") ?? "";

  server = http.createServer((req, res) =>
    handleRequest(req, res, apiKey, context)
  );

  await new Promise<void>((resolve, reject) => {
    server!.listen(port, host, () => resolve());
    server!.once("error", reject);
  }).catch((err: Error) => {
    server = undefined;
    vscode.window.showErrorMessage(
      `Copilot LM Proxy failed to start: ${err.message}`
    );
    return;
  });

  updateStatusBar(true, port);
  statusBarItem.command = "copilot-lm-proxy.stopServer";
  vscode.window.showInformationMessage(
    `Copilot LM Proxy started on http://${host}:${port}`
  );
}

function stopServer(): void {
  if (!server) {
    vscode.window.showInformationMessage("Copilot LM Proxy is not running.");
    return;
  }
  server.close();
  server = undefined;
  updateStatusBar(false);
  statusBarItem.command = "copilot-lm-proxy.startServer";
  vscode.window.showInformationMessage("Copilot LM Proxy stopped.");
}

// ---------------------------------------------------------------------------
// HTTP request router
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiKey: string,
  context: vscode.ExtensionContext
): Promise<void> {
  // CORS headers so browser-based clients can reach the proxy
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Optional API key authentication
  if (apiKey) {
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token !== apiKey) {
      sendJson(res, 401, {
        error: { message: "Unauthorized", type: "auth_error" },
      });
      return;
    }
  }

  const parsedUrl = url.parse(req.url ?? "/");
  const pathname = parsedUrl.pathname ?? "/";

  try {
    if (req.method === "GET" && pathname === "/v1/models") {
      await handleModels(res);
    } else if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      const payload = JSON.parse(body) as ChatCompletionRequest;
      await handleChatCompletions(res, payload);
    } else {
      sendJson(res, 404, {
        error: { message: "Not found", type: "not_found_error" },
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, {
      error: { message, type: "internal_error" },
    });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

async function handleModels(res: http.ServerResponse): Promise<void> {
  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({});
  } catch {
    // lm API not available – return empty list
  }

  const data = models.map((m) => ({
    id: buildModelId(m),
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.vendor,
  }));

  sendJson(res, 200, { object: "list", data });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

async function handleChatCompletions(
  res: http.ServerResponse,
  payload: ChatCompletionRequest
): Promise<void> {
  // Resolve the VS Code LM model to use
  const modelSelector = parseModelSelector(payload.model);
  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels(modelSelector);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 503, {
      error: {
        message: `VS Code Language Model API error: ${message}`,
        type: "service_unavailable",
      },
    });
    return;
  }

  if (models.length === 0) {
    sendJson(res, 503, {
      error: {
        message:
          "No language models available. Make sure GitHub Copilot is installed and you are signed in.",
        type: "service_unavailable",
      },
    });
    return;
  }

  const model = models[0];

  // Convert OpenAI messages to VS Code LM messages
  const lmMessages = payload.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user") {
        return vscode.LanguageModelChatMessage.User(m.content);
      }
      return vscode.LanguageModelChatMessage.Assistant(m.content);
    });

  // Prepend system message if present (as a user turn prefixed with [system])
  const systemMsg = payload.messages.find((m) => m.role === "system");
  if (systemMsg) {
    lmMessages.unshift(
      vscode.LanguageModelChatMessage.User(
        `[System instructions]\n${systemMsg.content}`
      )
    );
  }

  // The VS Code LM API does not expose OpenAI-style max_tokens / temperature
  // parameters in its public LanguageModelChatRequestOptions interface.
  // Those fields from the incoming payload are intentionally not forwarded.
  const requestOptions: vscode.LanguageModelChatRequestOptions = {};

  const isStreaming = payload.stream === true;
  const completionId = `chatcmpl-${Date.now()}`;
  const modelId = buildModelId(model);
  const created = Math.floor(Date.now() / 1000);

  let chatResponse: vscode.LanguageModelChatResponse;
  try {
    chatResponse = await model.sendRequest(
      lmMessages,
      requestOptions,
      new vscode.CancellationTokenSource().token
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, {
      error: { message, type: "internal_error" },
    });
    return;
  }

  if (isStreaming) {
    // Server-Sent Events streaming response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    for await (const chunk of chatResponse.text) {
      const delta = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: chunk },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(delta)}\n\n`);
    }

    // Final chunk with finish_reason
    const finalChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    // Collect full response then send
    let fullText = "";
    for await (const chunk of chatResponse.text) {
      fullText += chunk;
    }

    sendJson(res, 200, {
      id: completionId,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullText },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateStatusBar(running: boolean, port?: number): void {
  if (running && port !== undefined) {
    statusBarItem.text = `$(broadcast) LM Proxy :${port}`;
    statusBarItem.tooltip = `Copilot LM Proxy running on port ${port}. Click to stop.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.text = `$(broadcast) LM Proxy`;
    statusBarItem.tooltip = "Copilot LM Proxy is stopped. Click to start.";
    statusBarItem.backgroundColor = undefined;
  }
}

function buildModelId(model: vscode.LanguageModelChat): string {
  return `${model.vendor}/${model.family}`;
}

/**
 * Map an OpenAI-style model name (e.g. "gpt-4o", "gpt-4") or a
 * vendor/family string (e.g. "copilot/gpt-4o") to a VS Code LM selector.
 */
function parseModelSelector(
  modelId: string | undefined
): vscode.LanguageModelChatSelector {
  if (!modelId) {
    return { vendor: "copilot" };
  }

  // If the caller already uses "vendor/family" notation
  if (modelId.includes("/")) {
    const [vendor, ...rest] = modelId.split("/");
    return { vendor, family: rest.join("/") };
  }

  // Map common OpenAI model names to Copilot families
  const familyMap: Record<string, string> = {
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4": "gpt-4",
    "gpt-4-turbo": "gpt-4",
    "gpt-3.5-turbo": "gpt-3.5-turbo",
    "claude-3-5-sonnet": "claude-3.5-sonnet",
    "claude-3-7-sonnet": "claude-3.7-sonnet",
    o1: "o1",
    "o1-mini": "o1-mini",
    "o3-mini": "o3-mini",
  };

  const family = familyMap[modelId] ?? modelId;
  return { vendor: "copilot", family };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
