import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MAX_OUTPUT_BYTES = 32_000;

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runBash(
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<BashResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: opts.cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: `Error spawning bash: ${err.message}`, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const truncated = (s: string) =>
        s.length >= MAX_OUTPUT_BYTES ? `${s}\n...[output truncated]` : s;
      resolve({ exitCode: code ?? -1, stdout: truncated(stdout), stderr: truncated(stderr), timedOut });
    });
  });
}

export function registerBashTools(server: McpServer, opts?: { cwd?: string }): void {
  server.tool(
    'run_bash',
    'Run a shell command via bash. Returns stdout, stderr and the exit code.',
    {
      command: z.string().describe('The shell command to execute'),
      cwd: z.string().optional().describe('Working directory for the command (defaults to the server working directory)'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(120_000)
        .optional()
        .describe('Timeout in milliseconds (default 30000)'),
    },
    async ({ command, cwd, timeoutMs }) => {
      const result = await runBash(command, { cwd: cwd ?? opts?.cwd, timeoutMs });
      const parts = [
        `exit_code: ${result.exitCode}`,
        result.timedOut ? 'status: timed out' : '',
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ];
      return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n') }] };
    },
  );
}
