// Writes google-services.json for the Android build (S10) from the GOOGLE_SERVICES_JSON secret.
// The secret may hold the file as base64 (recommended: base64 -w0 google-services.json) or as raw JSON.
// It checks that the file belongs to this app's package and never prints the content.
// Usage (the workflow does this before `expo prebuild`):  node scripts/write-google-services.mjs [outFile]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'ir.maryafox.meyou';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Returns { ok: true, json } or { ok: false, error } (the error never quotes the secret). */
export function readGoogleServices(secret, packageName = PACKAGE_NAME) {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (!value) return { ok: false, error: 'the secret GOOGLE_SERVICES_JSON is missing or empty' };
  let json = parseJson(value);
  if (!json && /^[A-Za-z0-9+/=\s_-]+$/.test(value)) json = parseJson(Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8'));
  if (!json || typeof json !== 'object') return { ok: false, error: 'the secret is neither base64 of a JSON file nor raw JSON' };
  if (!json.project_info || typeof json.project_info.project_id !== 'string' || !Array.isArray(json.client)) {
    return { ok: false, error: 'the file does not look like google-services.json (no project_info or client)' };
  }
  const packages = json.client.map((c) => c?.client_info?.android_client_info?.package_name).filter((n) => typeof n === 'string');
  if (!packages.includes(packageName)) {
    return { ok: false, error: `google-services.json is not for the package ${packageName}: register the Android app in Firebase with exactly that package name and download the file again` };
  }
  return { ok: true, json };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? 'google-services.json');
  const result = readGoogleServices(process.env.GOOGLE_SERVICES_JSON);
  if (!result.ok) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }
  fs.writeFileSync(out, `${JSON.stringify(result.json, null, 2)}\n`, { mode: 0o600 });
  console.log(`google-services.json written for project ${result.json.project_info.project_id}`);
}
