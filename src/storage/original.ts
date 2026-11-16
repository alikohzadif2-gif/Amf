import type { ImageRef, StorageProvider } from './types';

/**
 * The original file as `{ uri, headers? }`. Server originals need an
 * Authorization header (video streaming, downloads); other providers only
 * have a bare URL, which is returned without headers.
 */
export async function originalSource(provider: StorageProvider, id: string): Promise<ImageRef | null> {
  if (provider.getOriginalSource) return provider.getOriginalSource(id);
  const uri = await provider.getOriginalUrl(id);
  return uri ? { uri } : null;
}
