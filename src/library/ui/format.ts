import { toDigits } from '@/src/lib/calendar';
import type { TranslationKey } from '@/src/i18n';
import type { DigitMode } from '@/src/state/settings-store';

type T = (key: TranslationKey) => string;

export function formatBytes(bytes: number, t: T, digits: DigitMode): string {
  const units: [number, TranslationKey][] = [
    [1024 ** 3, 'unitGb'],
    [1024 ** 2, 'unitMb'],
    [1024, 'unitKb'],
  ];
  for (const [size, key] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
      return `${toDigits(text, digits)} ${t(key)}`;
    }
  }
  return `${toDigits(bytes, digits)} ${t('unitB')}`;
}

export function formatDuration(seconds: number, digits: DigitMode): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return toDigits(`${m}:${String(s).padStart(2, '0')}`, digits);
}
