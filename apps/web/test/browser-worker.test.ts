import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import type { RefreshMessage } from '../src/refresh-worker.ts';
import { config, configBytes, historyBytes, seed } from './helpers.ts';

afterEach(() => vi.useRealTimers());

it('downloads and fits through the bundled worker entry without window, localStorage, or Node globals', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-19T18:00:00Z') });
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve(import.meta.dirname, '../src/refresh.worker.ts'), formats: ['iife'], name: 'refreshWorker' },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!('output' in output)) throw new Error('Expected a browser bundle');
  const chunk = output.output.find((file) => file.type === 'chunk')!;
  const messages: RefreshMessage[] = [];
  const requests: { url: string; cache: RequestCache | undefined }[] = [];
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const context = createContext({
    self: {
      postMessage: (message: RefreshMessage) => {
        messages.push(message);
        if (message.type !== 'progress') complete();
      },
    },
    request: { configUrl: 'https://test/config/nfl.json', dataBase: 'https://test/data', cache: {} },
    TextEncoder,
    TextDecoder,
    crypto,
    AbortSignal,
    setTimeout,
    URL,
    Date,
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, cache: init?.cache });
      if (url.endsWith('/config/nfl.json')) return new Response(configBytes);
      if (url.endsWith('/history.json')) return new Response(historyBytes);
      if (url.endsWith('/elo-2026.json')) return new Response(JSON.stringify(seed()));
      if (url === config.source.url)
        return new Response(
          'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\ng1,2026,REG,1,2026-09-01,13:00,SF,10,SEA,20,Home\n',
        );
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  runInContext(chunk.code, context);
  runInContext('self.onmessage({ data: request })', context);
  await done;
  const result = messages.at(-1)!;
  if (result.type === 'error') throw new Error(result.error);
  expect(messages.at(-1)).toMatchObject({
    type: 'complete',
    state: { status: 'ready', training_games: 1 },
    model: { games_used: 1 },
  });
  expect(messages).toContainEqual({ type: 'progress', phase: 'building' });
  expect(requests.find((r) => r.url === config.source.url)?.cache).toBe('no-cache');
});
