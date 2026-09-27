import { currentSeason } from './contracts.ts';
import { PredictionService, message, type PublicState, type RefreshPhase } from './service.ts';
import type { Posterior } from './model.ts';
import { memoryStore, readConfig } from './storage.ts';

export type RefreshRequest = { configUrl: string; dataBase: string; cache: Record<string, string> };
export type RefreshMessage =
  | { type: 'progress'; phase: RefreshPhase }
  | { type: 'complete'; state: PublicState; model: Posterior | null; cache: Record<string, string> }
  | { type: 'error'; error: string };

export async function refresh(request: RefreshRequest, emit: (message: RefreshMessage) => void): Promise<void> {
  try {
    const { config, hash } = await readConfig(request.configUrl);
    const store = memoryStore();
    for (const [key, value] of Object.entries(request.cache)) store.setItem(key, value);
    const service = new PredictionService({
      config,
      configHash: hash,
      dataBase: request.dataBase,
      season: currentSeason(config),
      store,
      onProgress: (phase) => emit({ type: 'progress', phase }),
    });
    await service.initialize();
    emit({
      type: 'complete',
      state: service.getState(),
      model: service.getModel(),
      cache: Object.fromEntries(store.keys().map((key) => [key, store.getItem(key)!])),
    });
  } catch (e) {
    emit({ type: 'error', error: message(e) });
  }
}
