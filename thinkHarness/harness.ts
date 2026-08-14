import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  createLlmClient,
  type AgentHandlers,
  type LlmMessage,
  type LlmTool,
} from './llm.js';
import { runTui } from './tui.js';

export interface HarnessConfig {
  llmBase: string;
  llmModel: string;
  llmApiKey?: string;
  llmTimeoutMs?: number;
  mcpUrl: string;
  systemPrompt?: string;
  maxToolIterations: number;
}

export interface HarnessAgent {
  label: string;
  toolNames: string[];
  ask(input: string, handlers?: AgentHandlers): Promise<string>;
  dispose(): Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful autonomous assistant with access to tools.
Available tools:
- bash: run shell commands and inspect their output.
- fs: read, write and manipulate files (list, read, write, etc.).
- notes: create, read and list short notes (note objects with id/title/content).

Use tools whenever a task requires them (running commands, inspecting or editing files, keeping notes).
After you receive tool results, continue reasoning. Reply with a concise final answer when the task is done.`;

const USAGE = `Usage: thinkharness [options]

Drives an OpenAI-compatible LLM backend (e.g. llama.cpp) and gives it access to the
llamaharness MCP server over HTTP (which may be running on another machine).

Options:
  --llm-base <url>      OpenAI-compatible base URL (default: $LLM_BASE or http://localhost:8080/v1)
  --llm-model <name>    model identifier sent to the server (default: $LLM_MODEL or "default")
  --llm-key <key>       optional bearer token (default: $LLM_API_KEY)
  --mcp-url <url>       MCP server HTTP endpoint (default: $MCP_URL or http://localhost:9908/mcp)
  --max-iterations <n>  max tool-call rounds per turn (default: 8)
  --help, -h            show this message`;

function parseArgs(argv: string[]): HarnessConfig {
  const config: HarnessConfig = {
    llmBase: process.env.LLM_BASE ?? 'http://localhost:8080/v1',
    llmModel: process.env.LLM_MODEL ?? 'default',
    llmApiKey: process.env.LLM_API_KEY,
    llmTimeoutMs: 120_000,
    mcpUrl: process.env.MCP_URL ?? 'http://localhost:9908/mcp',
    systemPrompt: process.env.SYSTEM_PROMPT,
    maxToolIterations: 8,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.split('=') as [string, string | undefined];
    const value = (): string => inlineValue ?? argv[++i] ?? '';
    switch (flag) {
      case '--llm-base':
        config.llmBase = value();
        break;
      case '--llm-model':
        config.llmModel = value();
        break;
      case '--llm-key':
        config.llmApiKey = value();
        break;
      case '--mcp-url':
        config.mcpUrl = value();
        break;
      case '--max-iterations':
        config.maxToolIterations = Number(value()) || 8;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return config;
}

function stringifyContent(content: unknown): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        const b = block as Record<string, unknown>;
        if (b.type === 'text') {
          return String(b.text ?? '');
        }
        if (b.type === 'resource' && b.resource) {
          return JSON.stringify(b.resource);
        }
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function formatToolResult(result: Record<string, unknown>): string {
  const body = stringifyContent(result.content) || '(no output)';
  return result.isError ? `[tool error] ${body}` : body;
}

export async function startHarness(config: HarnessConfig): Promise<HarnessAgent> {
  const llm = createLlmClient({
    baseUrl: config.llmBase,
    model: config.llmModel,
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs,
  });

  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl));
  const client = new Client(
    { name: 'thinkHarness', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: LlmTool[] = listed.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
    },
  }));
  const toolNames = listed.tools.map((tool) => tool.name);

  const messages: LlmMessage[] = [
    { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
  ];

  let disposed = false;

  async function ask(input: string, handlers?: AgentHandlers): Promise<string> {
    messages.push({ role: 'user', content: input });

    for (let i = 0; i < config.maxToolIterations; i++) {
      const reply = await llm.chat({
        messages,
        tools: tools.length ? tools : undefined,
        stream: true,
        onDelta: handlers?.onDelta,
      });
      messages.push(reply);

      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) {
        return reply.content ?? '';
      }

      for (const call of calls) {
        let content: string;
        try {
          let args: Record<string, unknown> = {};
          if (call.function.arguments) {
            try {
              args = JSON.parse(call.function.arguments) as Record<string, unknown>;
            } catch {
              args = {};
            }
          }
          handlers?.onTool?.(call.function.name, args);
          const result = await client.callTool({
            name: call.function.name,
            arguments: args,
          });
          content = formatToolResult(result as Record<string, unknown>);
        } catch (err) {
          content = `[tool error] ${(err as Error).message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }

    return 'Reached maximum tool iterations without a final answer.';
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      await client.close();
    } catch {
      // ignore close errors on shutdown
    }
  }

  const label = `${config.llmModel} @ ${config.llmBase}`;
  return { label, toolNames, ask, dispose };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  let agent: HarnessAgent;
  try {
    agent = await startHarness(config);
  } catch (err) {
    console.error(`Failed to start harness: ${(err as Error).message}`);
    process.exit(1);
  }
  await runTui(agent);
  await agent.dispose();
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}