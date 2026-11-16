import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildModel, type WidgetModel } from './model';

/** Reads the persisted zustand state (`{ state, version }`) of a store without importing the store. */
async function readState<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? ((JSON.parse(raw) as { state?: T }).state ?? null) : null;
  } catch {
    return null;
  }
}

export async function loadModel(): Promise<WidgetModel> {
  const [partner, settings] = await Promise.all([
    readState<{ togetherSince?: string }>('meyou-partner'),
    readState<Parameters<typeof buildModel>[1]>('meyou-settings'),
  ]);
  return buildModel(partner, settings);
}
