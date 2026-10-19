/**
 * Single-line JSON logs. Never pass tokens, full emails (use maskEmail), alert targets, or raw
 * scanned bodies. Keys that look secret are redacted defensively.
 */
type Fields = Record<string, unknown> & { msg: string };

const SECRET_KEYS = /token|secret|password|authorization|cookie|api_?key|target|body/i;

function emit(level: 'info' | 'warn' | 'error', fields: Fields): void {
  const out: Record<string, unknown> = { level, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_KEYS.test(k) && k !== 'msg' ? '[redacted]' : typeof v === 'string' ? v.slice(0, 1000) : v;
  }
  const line = JSON.stringify(out);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (f: Fields) => emit('info', f),
  warn: (f: Fields) => emit('warn', f),
  error: (f: Fields) => emit('error', f),
};
