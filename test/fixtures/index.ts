import { RAW_FIXTURES } from './fixtures.generated';

/** Load a fixture, substituting the store host placeholder and expanding size markers. */
export function fixture(path: string, host = 'good.mockstore.test'): string {
  const raw = RAW_FIXTURES[path];
  if (raw === undefined) throw new Error(`unknown fixture ${path}`);
  return raw.replaceAll('STORE_HOST', host).replace('__ONE_MEGABYTE__', 'A'.repeat(1_000_000));
}

export function jsonFixture<T = unknown>(path: string, host?: string): T {
  return JSON.parse(fixture(path, host)) as T;
}
