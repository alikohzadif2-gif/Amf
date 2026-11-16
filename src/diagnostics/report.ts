import type { LogLine } from './log';

export type ReportInput = {
  appVersion: string;
  platform: string;
  language: string;
  generatedAt: string;
  /** Preferences by name (values only; callers never pass secrets). */
  settings: Record<string, string | number | boolean>;
  sources: { id: string; kind: string; backend: string; enabled: boolean }[];
  uploads: Record<string, number>;
  failures: { name: string; code: string }[];
  log: readonly LogLine[];
};

/** Plain text report for sharing. Contains no tokens, topics, addresses or passwords. */
export function buildReport(input: ReportInput): string {
  const out: string[] = [];
  out.push('meYou diagnostics');
  out.push(`generated: ${input.generatedAt}`);
  out.push(`version: ${input.appVersion}`);
  out.push(`platform: ${input.platform}`);
  out.push(`language: ${input.language}`);
  out.push('', '[settings]');
  for (const [key, value] of Object.entries(input.settings)) out.push(`${key}=${String(value)}`);
  out.push('', '[sources]');
  for (const s of input.sources) out.push(`${s.id} ${s.kind}/${s.backend} ${s.enabled ? 'enabled' : 'disabled'}`);
  out.push('', '[uploads]');
  out.push(Object.entries(input.uploads).map(([k, v]) => `${k}=${v}`).join(' ') || 'none');
  for (const f of input.failures) out.push(`failed: ${f.name} (${f.code})`);
  out.push('', `[log] ${input.log.length} lines`);
  for (const line of input.log) out.push(`${line.t} ${line.level} ${line.msg}`);
  return `${out.join('\n')}\n`;
}
