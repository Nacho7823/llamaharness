# thinkHarness

Chatbot TUI that drives a **llama.cpp** backend (via its OpenAI-compatible API) and gives the model access to the **MCP tools** from `llamaharness` (`bash`, `fs`, `notes`).

```
tui.ts ──► harness.ts ──► llm.ts        (OpenAI-compatible client, pure HTTP)
                     └──► llamaharness MCP server (Streamable HTTP, no coupling)
```

Neither the llama.cpp process nor the MCP server are managed here — both can be running on another machine. This project only talks to their HTTP endpoints.

## Requirements

- A running `llamaharness` MCP server exposed over Streamable HTTP, e.g. from the `llamatools` package:

  ```sh
  node llamatools/dist/llamaharness.js --transport http --host 0.0.0.0 --port 9908
  ```

  (On another machine, substitute the host.)
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

| Flag              | Env           | Default                              |
| ----------------- | ------------- | ------------------------------------ |
| `--llm-base`      | `LLM_BASE`    | `http://localhost:8080/v1`           |
| `--llm-model`     | `LLM_MODEL`   | `default`                            |
| `--llm-key`       | `LLM_API_KEY` | —                                    |
| `--mcp-url`       | `MCP_URL`     | `http://localhost:9908/mcp`          |
| `--max-iterations`| —             | `8`                                  |

### Examples

llama.cpp and the MCP server both running on another computer:

```sh
pnpm dev -- --llm-base http://192.168.1.50:8080/v1 \
             --mcp-url http://192.168.1.50:9908/mcp
```

## Usage

- Type a message and press Enter. The model may call tools (shown as `⟳ using tool …`); results are fed back automatically until it produces a final answer, streamed live.
- `Ctrl+C` quits. Nothing is spawned or left behind by this project.
