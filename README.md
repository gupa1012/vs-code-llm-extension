# Copilot LM Proxy

A VS Code extension that starts a **local OpenAI-compatible REST API** and routes every request through **GitHub Copilot** using the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model).

No separate LLM API key is required — requests are fulfilled by whichever Copilot models are available in your VS Code session.

---

## Features

| Endpoint | Description |
|---|---|
| `GET  /v1/models` | Lists all language models available through VS Code |
| `POST /v1/chat/completions` | OpenAI-compatible chat completion (streaming and non-streaming) |

---

## Requirements

- VS Code 1.90 or later
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension installed and signed in

---

## Quick Start

1. **Install the extension** (or open this repo in VS Code and press `F5` to run in extension development host).
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
   ```
   Copilot LM Proxy: Start Server
   ```
3. The status bar shows **$(broadcast) LM Proxy :3030** when the server is running.
4. Point any OpenAI-compatible client at `http://127.0.0.1:3030`.

### Stop the server

```
Copilot LM Proxy: Stop Server
```

Or click the status bar item while the server is running.

---

## Configuration

Open VS Code Settings and search for **Copilot LM Proxy**.

| Setting | Default | Description |
|---|---|---|
| `copilot-lm-proxy.port` | `3030` | TCP port the proxy listens on |
| `copilot-lm-proxy.host` | `127.0.0.1` | Network interface to bind (use `0.0.0.0` to expose on LAN) |
| `copilot-lm-proxy.apiKey` | `""` | Optional `Bearer` token required by clients. Empty = no auth. |
| `copilot-lm-proxy.autoStart` | `false` | Start the proxy automatically when VS Code opens |

---

## Usage Examples

### curl

```bash
# List available models
curl http://127.0.0.1:3030/v1/models

# Chat completion (non-streaming)
curl http://127.0.0.1:3030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello! Who are you?"}]
  }'

# Streaming
curl http://127.0.0.1:3030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Count to 5."}],
    "stream": true
  }'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3030/v1",
    api_key="not-needed",   # required by the SDK, value is ignored unless you set copilot-lm-proxy.apiKey
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Explain async/await in Python in one paragraph."}],
)
print(response.choices[0].message.content)
```

### Streaming with Python

```python
for chunk in client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Write a haiku about VS Code."}],
    stream=True,
):
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### Node.js / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3030/v1",
  apiKey: "not-needed",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What is the capital of France?" }],
});
console.log(response.choices[0].message.content);
```

---

## Model Names

You can use **OpenAI-style names** (the proxy maps them to Copilot families automatically):

| OpenAI name | Copilot family |
|---|---|
| `gpt-4o` | `gpt-4o` |
| `gpt-4o-mini` | `gpt-4o-mini` |
| `gpt-4` / `gpt-4-turbo` | `gpt-4` |
| `gpt-3.5-turbo` | `gpt-3.5-turbo` |
| `claude-3-5-sonnet` | `claude-3.5-sonnet` |
| `o1`, `o1-mini`, `o3-mini` | same |

Or use the **vendor/family** notation returned by `GET /v1/models`:

```json
{ "model": "copilot/gpt-4o" }
```

If no model is specified the proxy picks the first available Copilot model.

---

## Security Notes

- By default the server only listens on `127.0.0.1` (localhost). It is **not** reachable from other machines unless you change `copilot-lm-proxy.host` to `0.0.0.0`.
- If you do expose the server on a network interface, **always set `copilot-lm-proxy.apiKey`** to prevent unauthorised access to your Copilot quota.
- The API key is transmitted as a standard `Authorization: Bearer <key>` HTTP header.

---

## How It Works

```
Your app (OpenAI SDK / curl / …)
        │  HTTP POST /v1/chat/completions
        ▼
  Copilot LM Proxy (localhost:3030)
        │  vscode.lm.selectChatModels()
        │  model.sendRequest(messages)
        ▼
  GitHub Copilot (VS Code Language Model API)
        │
        ▼
  Response streamed back to your app
```

The extension creates a standard Node.js `http.Server` inside the VS Code extension host process. It converts the OpenAI request format to `vscode.LanguageModelChatMessage` objects, calls the VS Code LM API, and converts the response back to the OpenAI wire format (including SSE streaming).

---

## Development

```bash
git clone https://github.com/gupa1012/vs-code-llm-extension
cd vs-code-llm-extension
npm install
npm run compile   # or: npm run watch
# Press F5 in VS Code to launch the Extension Development Host
```
