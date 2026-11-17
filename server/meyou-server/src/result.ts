// Tiny result type shared by the household and the encrypted-queue logic (routes only translate it to HTTP).
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; body: Record<string, unknown> };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result<never> => ({
  ok: false,
  status,
  body: { error, ...extra },
});
