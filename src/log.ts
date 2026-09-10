// Logs always go to stderr: the MCP shim owns stdout for the protocol, and the runner owns the
// terminal. The daemon's stderr is captured by Aspire's dashboard.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.SWITCHBOARD_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

function write(level: Level, scope: string, msg: string, data?: unknown): void {
  if (ORDER[level] < threshold) return;
  let extra = '';
  if (data instanceof Error) extra = ` ${data.stack ?? data.message}`;
  else if (data !== undefined) {
    try {
      extra = ` ${JSON.stringify(data)}`;
    } catch {
      extra = ` ${String(data)}`;
    }
  }
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra}\n`);
}

export function logger(scope: string): Logger {
  return {
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d),
  };
}
