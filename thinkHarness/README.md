# thinkHarness

Chatbot TUI that drives a **llama.cpp** backend (via its OpenAI-compatible API) and gives the model access to the **MCP tools** from `llamaharness` (`bash`, `fs`, `notes`).

```
tui.ts ──► harness.ts ──► llm.ts      (OpenAI-compatible client, pure HTTP)
                    └──► llamaharness MCP server (spawned over stdio)
```

The llama.cpp process is **not** managed here — it can be running on any machine. This project only talks to its HTTP endpoint.

## Requirements

- The `llamaharness` MCP server built in the parent project: `pnpm build` at the repo root (produces `dist/llamaharness.js`).
- An OpenAI-compatible endpoint, e.g. an already-running `llama-server`:

  ```sh
  llama-server -m /path/to/model.gguf --port 8080
  ```

- Node.js 18+ (Node 22 recommended).

## Install

```sh
pnpm install          # inside thinkHarness/
```

## Run

```sh
pnpm dev                              # tsx harness.ts
# or
pnpm build && pnpm start
```

### Options

All flags also work as environment variables.

| Flag              | Env           | Default                          |
| ----------------- | ------------- | -------------------------------- |
| `--llm-base`      | `LLM_BASE`    | `http://localhost:8080/v1`       |
| `--llm-model`     | `LLM_MODEL`   | `default`                        |
| `--llm-key`       | `LLM_API_KEY` | —                                |
| `--mcp-bin`       | `MCP_BIN`     | `../dist/llamaharness.js`        |
| `--mcp-cwd`       | `MCP_CWD`     | current directory                |
| `--node-bin`      | `NODE_BIN`    | current node                     |
| `--max-iterations`| —             | `8`                              |

### Examples

Connect to a llama.cpp server running on another computer:

```sh
pnpm dev -- --llm-base http://192.168.1.50:8080/v1 --llm-model llama
```

Constrain where the MCP tools operate:

```sh
pnpm dev -- --mcp-cwd ~/projects/some-repo
```

## Usage

- Type a message and press Enter. The model may call tools (shown as `⟳ using tool …`); results are fed back automatically until it produces a final answer, streamed live.
- `Ctrl+C` quits and shuts down the spawned MCP server.