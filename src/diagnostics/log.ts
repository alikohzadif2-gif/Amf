import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogLine = { t: string; level: LogLevel; msg: string };

const MAX_LINES = 400;
const MAX_MSG = 500;
const KEY = 'meyou-diagnostics';

let lines: LogLine[] = [];
let loaded = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const TRACE_FILE = 'meyou-trace.log';

function serialize(line: LogLine): string {
  return `${line.t}|${line.level}|${line.msg.replace(/\r?\n/g, ' / ')}`;
}

function parse(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split('\n')) {
    const a = raw.indexOf('|');
    const b = a < 0 ? -1 : raw.indexOf('|', a + 1);
    if (a < 0 || b < 0) continue;
    const level = raw.slice(a + 1, b);
    if (level !== 'info' && level !== 'warn' && level !== 'error') continue;
    out.push({ t: raw.slice(0, a), level, msg: raw.slice(b + 1) });
  }
  return out;
}

/** Writes the whole log to a file right now (synchronous, so a crash a moment later cannot lose it). */
function flushFileNow(): void {
  try {
    const file = new File(Paths.document, TRACE_FILE);
    file.create({ overwrite: true });
    file.write(`${lines.map(serialize).join('\n')}\n`);
  } catch {
    // the debounced AsyncStorage copy is still written
  }
}

function persistSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    AsyncStorage.setItem(KEY, JSON.stringify(lines)).catch(() => undefined);
  }, 1000);
}

/**
 * Live trace: adds one line and writes the log file immediately. Use it for steps where the app may be killed
 * right after (the last line left in the log then shows how far the app got).
 */
export function traceEvent(msg: string): void {
  logEvent('info', `» ${msg}`);
  flushFileNow();
}

/** After a risky step: writes "alive +Nms" lines, so the gap between the last line and the crash is visible. */
export function traceAlive(tag: string, delays: readonly number[] = [100, 300, 700, 1500, 3000, 6000]): void {
  for (const ms of delays) setTimeout(() => traceEvent(`${tag}: alive +${ms}ms`), ms);
}

/** The whole log as plain text (for copy / share). */
export function getLogText(): string {
  return `${lines.map((l) => `${l.t.slice(0, 23).replace('T', ' ')} ${l.level} ${l.msg}`).join('\n')}\n`;
}

/** Loads the lines saved by earlier runs (call once at startup). */
export async function loadLog(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    let saved: LogLine[] = [];
    try {
      const file = new File(Paths.document, TRACE_FILE);
      if (file.exists) saved = parse(await file.text());
    } catch {
      saved = [];
    }
    if (saved.length === 0) {
      const raw = await AsyncStorage.getItem(KEY);
      saved = raw ? (JSON.parse(raw) as LogLine[]) : [];
    }
    const last = saved[saved.length - 1];
    lines = [...saved, ...lines].slice(-MAX_LINES);
    traceEvent(`app start; the line before was: ${last ? `${last.t.slice(11, 19)} ${last.msg.slice(0, 120)}` : 'none'}`);
  } catch {
    // a broken log must never break the app
  }
}

/** Adds one line (UTC ISO time). Never put tokens, topics or passwords in `msg`. */
export function logEvent(level: LogLevel, msg: string, now: () => Date = () => new Date()) {
  lines.push({ t: now().toISOString(), level, msg: msg.slice(0, MAX_MSG) });
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  persistSoon();
}

export function getLog(): readonly LogLine[] {
  return lines;
}

export function clearLog() {
  lines = [];
  AsyncStorage.removeItem(KEY).catch(() => undefined);
  flushFileNow();
}

/** Routes uncaught JS errors into the log (keeps the previous handler). */
export function installErrorCapture() {
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, fatal) => {
    const e = error as Error | undefined;
    logEvent('error', `${fatal ? 'fatal ' : ''}${e?.name ?? 'Error'}: ${e?.message ?? String(error)}`);
    previous(error, fatal);
  });
}
