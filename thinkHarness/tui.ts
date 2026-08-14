import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput } from 'ink';
import TextInput from 'ink-text-input';

import type { AgentHandlers } from './llm.js';

const h = React.createElement;

export interface ChatRow {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
}

export interface ChatAgent {
  label: string;
  toolNames: string[];
  ask(input: string, handlers?: AgentHandlers): Promise<string>;
  dispose(): Promise<void>;
}

interface AppProps {
  agent: ChatAgent;
  onExit: () => void;
}

function MessageLine({ row }: { row: ChatRow }) {
  let color: string;
  let prefix: string;
  switch (row.role) {
    case 'user':
      color = 'cyan';
      prefix = 'you › ';
      break;
    case 'assistant':
      color = 'green';
      prefix = 'llm › ';
      break;
    case 'tool':
      color = 'yellow';
      prefix = 'tool · ';
      break;
    default:
      color = 'red';
      prefix = '✗ ';
  }
  return h(
    Box,
    { marginTop: 1 },
    h(Text, { color, bold: row.role !== 'tool' }, prefix),
    h(Text, { color }, row.content),
  );
}

function App({ agent, onExit }: AppProps) {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [toolLine, setToolLine] = useState('');
  const [error, setError] = useState('');
  const idCounter = useRef(0);

  useEffect(() => {
    setRows([
      {
        id: ++idCounter.current,
        role: 'assistant',
        content: `Connected. MCP tools available: ${agent.toolNames.join(', ')}. Type a message or Ctrl+C to quit.`,
      },
    ]);
  }, [agent]);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      onExit();
    }
  });

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setRows((prev) => [...prev, { id: ++idCounter.current, role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    setStream('');
    setToolLine('');
    setError('');

    void (async () => {
      try {
        const final = await agent.ask(text, {
          onDelta: (delta) => setStream((prev) => prev + delta),
          onTool: (name, args) =>
            setToolLine(`${name}(${args ? JSON.stringify(args) : ''})`),
        });
        setStream('');
        setToolLine('');
        if (final) {
          setRows((prev) => [...prev, { id: ++idCounter.current, role: 'assistant', content: final }]);
        }
      } catch (err) {
        setStream('');
        setToolLine('');
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [input, busy, agent]);

  const visible = rows.slice(-200);

  return h(
    Box,
    { flexDirection: 'column', height: '100%' },
    h(
      Box,
      { borderStyle: 'round', borderColor: 'magenta', paddingX: 1, flexShrink: 0 },
      h(Text, { bold: true, color: 'magenta' }, ' thinkHarness '),
      h(Text, { dimColor: true }, ` · ${agent.label}`),
    ),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
      visible.map((row) => h(MessageLine, { key: String(row.id), row })),
      stream
        ? h(
            Box,
            { marginTop: 1 },
            h(Text, { color: 'green' }, `llm › ${stream}▌`),
          )
        : null,
      toolLine
        ? h(
            Box,
            { marginTop: 1 },
            h(Text, { color: 'yellow', dimColor: true }, `⟳ using tool ${toolLine}`),
          )
        : null,
      error
        ? h(
            Box,
            { marginTop: 1 },
            h(Text, { color: 'red' }, `✗ ${error}`),
          )
        : null,
    ),
    h(
      Box,
      { flexShrink: 0, borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      h(Text, { color: 'cyan' }, '› '),
      busy
        ? h(Text, { dimColor: true }, '…')
        : h(TextInput, {
            value: input,
            onChange: setInput,
            onSubmit: submit,
            placeholder: 'type a message…',
          }),
    ),
  );
}

export async function runTui(agent: ChatAgent): Promise<void> {
  let finished = false;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  async function finish(): Promise<void> {
    if (finished) {
      return;
    }
    finished = true;
    try {
      await agent.dispose();
    } catch {
      // ignore dispose errors on exit
    }
    resolveExit();
  }

  const onSignal = (): void => {
    void finish();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const instance = render(
    h(App, { agent, onExit: () => void finish() }),
    { exitOnCtrlC: false },
  );

  await exitPromise;
  instance.unmount();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}