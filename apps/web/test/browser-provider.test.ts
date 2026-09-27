import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { config } from './helpers.ts';

it('loads and parses the browser provider bundle without Node globals', async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(import.meta.dirname, '../src/provider.ts'),
        name: 'provider',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!('output' in output)) throw new Error('Expected a browser bundle');
  const chunk = output.output.find((file) => file.type === 'chunk');
  expect(chunk).toBeDefined();
  const context = createContext({
    config,
    csv:
      '\ufeffgame_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\n' +
      'a,2002,REG,1,2002-09-01,13:00,SD,10,OAK,10,Neutral\n',
  });
  runInContext(chunk!.code, context);
  expect(runInContext('provider.parseSource(csv, config)', context)).toMatchObject([
    { id: 'a', away_team: 'LAC', home_team: 'LV', result: 'tie', neutral: true },
  ]);
});
