import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { output: { type: 'string', default: '/tmp/everchat-cloudflare-tail.json' }, seconds: { type: 'string', default: '300' } } });
const seconds = Number(values.seconds);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900) throw new Error('--seconds must be 10–900');
const directory = await mkdtemp(join(tmpdir(), 'everchat-tail-'));
const startedAt = new Date().toISOString(), events: Record<string, unknown>[] = [];
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'tail', 'everchat-stream-validation',
  '--config', 'wrangler.stream-validation.jsonc', '--format', 'json'], {
  stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
});
let buffer = '', frame = '', connected = false, malformed = 0, dropped = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (data: string) => {
  buffer += data;
  for (let end; (end = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!connected && line.includes('Connected to')) { connected = true; console.log('Isolated validation tail connected.'); }
    if (!frame && !line.trim().startsWith('{')) continue;
    frame += line + '\n';
    if (frame.length > 1_000_000) { frame = ''; malformed++; continue; }
    try {
      const item = JSON.parse(frame); frame = '';
      if (!('outcome' in item) || !('event' in item)) continue;
      if (events.length >= 5000) { dropped++; continue; }
      if (!connected) { connected = true; console.log('Isolated validation tail received an event.'); }
      const request = item.event?.request;
      let path: string | undefined;
      if (typeof request?.url === 'string') {
        try {
          const candidate = new URL(request.url).pathname.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|REDACTED/gi, ':id');
          path = /^\/api\/(session|login|logout|settings\/providers(?:\/:id\/models)?|conversations(?:\/:id(?:\/(sync|messages|measurements|cancel|title))?)?|__validation\/storage)$/.test(candidate) ? candidate : 'other';
        } catch { /* Do not retain malformed URLs. */ }
      }
      // Never retain headers, bodies, console messages, exception text or query strings.
      events.push({ timestamp: item.eventTimestamp, outcome: item.outcome, entrypoint: item.entrypoint, durableObject: Boolean(item.durableObjectId),
        method: request?.method, path, cpuTime: typeof item.cpuTime === 'number' ? item.cpuTime : undefined,
        wallTime: typeof item.wallTime === 'number' ? item.wallTime : undefined, truncated: Boolean(item.truncated), fields: Object.keys(item) });
    } catch { /* JSON is printed across lines; keep the frame until complete. */ }
  }
});
const stop = () => { child.kill('SIGINT'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const timer = setTimeout(stop, seconds * 1000);
try {
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  const output = resolve(values.output!); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, workerName: 'everchat-stream-validation', startedAt, finishedAt: new Date().toISOString(), connected, code, malformed, dropped, partialFrame: Boolean(frame.trim() || buffer.trim()), events,
    scope: 'Sanitized real-time tail. Optional CPU fields may be absent; missing values are not zero. Receipt does not prove exhaustive platform coverage.' }, null, 2) + '\n');
  console.log(JSON.stringify({ connected, events: events.length, withCpu: events.filter((event) => event.cpuTime !== undefined).length, malformed, code }));
  if (!connected || malformed > 0 || (code !== 0 && code !== null)) process.exitCode = 1;
} finally {
  clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); child.kill('SIGINT');
  await rm(directory, { recursive: true, force: true });
}
