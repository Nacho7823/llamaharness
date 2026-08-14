export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: LlmRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentHandlers {
  onDelta?: (delta: string) => void;
  onTool?: (name: string, args: unknown) => void;
}

export interface LlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface LlmChatOptions {
  messages: LlmMessage[];
  tools?: LlmTool[];
  stream?: boolean;
  onDelta?: (delta: string) => void;
}

export interface LlmClient {
  chat(options: LlmChatOptions): Promise<LlmMessage>;
}

function normalizeMessage(message: Record<string, unknown>): LlmMessage {
  let content = message.content;
  if (Array.isArray(content)) {
    content = content
      .map((part) =>
        typeof part === 'string'
          ? part
          : (part as Record<string, unknown>).text ?? JSON.stringify(part),
      )
      .join('\n');
  }
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>).map((call) => ({
        id: String(call.id ?? `call_${Math.random().toString(36).slice(2, 8)}`),
        type: 'function' as const,
        function: {
          name: String((call.function as Record<string, unknown>)?.name ?? ''),
          arguments: String(
            (call.function as Record<string, unknown>)?.arguments ?? '{}',
          ),
        },
      }))
    : undefined;
  return {
    role: (message.role as LlmRole) ?? 'assistant',
    content: content as string | null | undefined,
    tool_calls: toolCalls?.length ? toolCalls : undefined,
  };
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function chat(opts: LlmChatOptions): Promise<LlmMessage> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }

    const payload: Record<string, unknown> = {
      model: options.model,
      messages: opts.messages,
      stream: opts.stream ?? false,
    };
    if (opts.tools && opts.tools.length > 0) {
      payload.tools = opts.tools;
      payload.tool_choice = 'auto';
    }

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
    } catch (err) {
      throw new Error(`LLM request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
    }

    return opts.stream ? readStream(res, opts.onDelta) : readJson(res);
  }

  return { chat };
}

async function readJson(res: Response): Promise<LlmMessage> {
  const data = (await res.json()) as {
    choices?: Array<{ message?: Record<string, unknown> }>;
  };
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error('LLM response missing choices[0].message');
  }
  return normalizeMessage(message);
}

async function readStream(
  res: Response,
  onDelta?: (delta: string) => void,
): Promise<LlmMessage> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('LLM response has no body stream');
  }
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let text = '';
  let buffer = '';
  let role: LlmRole = 'assistant';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        continue;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const delta = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> })
        .choices?.[0]?.delta;
      if (!delta) {
        continue;
      }
      if (typeof delta.role === 'string') {
        role = delta.role as LlmRole;
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = Number(tc.index ?? 0);
          const fn = tc.function as Record<string, unknown> | undefined;
          const current = toolCalls.get(index) ?? { id: `call_${index}`, name: '', arguments: '' };
          if (typeof tc.id === 'string' && tc.id) {
            current.id = tc.id;
          }
          if (typeof fn?.name === 'string') {
            current.name += fn.name;
          }
          if (typeof fn?.arguments === 'string') {
            current.arguments += fn.arguments;
          }
          toolCalls.set(index, current);
        }
      }
    }
  }

  const calls = [...toolCalls.values()]
    .filter((call) => call.name)
    .map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: call.arguments || '{}',
      },
    }));

  return {
    role,
    content: text || null,
    tool_calls: calls.length ? calls : undefined,
  };
}