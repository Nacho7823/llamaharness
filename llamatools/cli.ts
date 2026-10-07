export interface CliArgs {
  transport: 'stdio' | 'http' | 'sse';
  host: string;
  port: number;
  apiKey?: string;
}

const USAGE = `Usage: llamaharness [--transport stdio|http|sse] [--host HOST] [--port PORT] [--api-key KEY]
  API key: --api-key o env LLAMAHARNESS_API_KEY (solo http/sse, si se omite queda abierto)`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { transport: 'http', host: '0.0.0.0', port: 9908 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--transport':
        args.transport = argv[++i] as CliArgs['transport'];
        break;
      case '--host':
        args.host = argv[++i];
        break;
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--api-key':
        args.apiKey = argv[++i];
        break;
      case '--help':
      case '-h':
        console.error(USAGE);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  if (!['stdio', 'http', 'sse'].includes(args.transport)) {
    console.error(`Invalid transport: ${args.transport} (expected stdio, http or sse)`);
    process.exit(1);
  }
  // Resolución API key: flag --api-key tiene prioridad, fallback a ENV.
  // Trim + vacío => undefined (modo abierto, backward-compat).
  const fromFlag = args.apiKey?.trim();
  const fromEnv = process.env.LLAMAHARNESS_API_KEY?.trim();
  args.apiKey = (fromFlag || fromEnv) || undefined;
  return args;
}
