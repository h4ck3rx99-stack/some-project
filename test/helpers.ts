import { mockStore } from './mock-store/app';
import { createContext, limitsFor } from '../src/scan/context';
import { initialState, runPhase } from '../src/scan/engine';
import { scoreScan } from '../src/scan/scoring';
import type { Phase, ScanContext, ScanInput, ScanState } from '../src/scan/types';
import type { FetchLike } from '../src/lib/safeFetch';

export const mockFetch: FetchLike = (req) => mockStore.fetch(req) as Promise<Response>;

export function testInput(host: string, over: Partial<ScanInput> = {}): ScanInput {
  return {
    scanId: 'scan_test',
    url: `https://${host}`,
    domain: host,
    limits: limitsFor(30),
    verifiedOwnership: false,
    testCheckoutEndpoint: null,
    testModeConfirmed: false,
    ...over,
  };
}

export function testContext(
  input: ScanInput,
  state: ScanState = initialState(),
  fetchImpl: FetchLike = mockFetch,
): ScanContext {
  return createContext(input, state, {
    fetchImpl,
    sleep: async () => undefined,
    appUrl: 'https://cartprobe.test',
    appDomain: 'cartprobe.test',
    allowTestTld: true,
  });
}

/** Run every phase in-memory, like the job runner but without the database. */
export async function runScan(host: string, over: Partial<ScanInput> = {}, fetchImpl?: FetchLike) {
  const input = testInput(host, over);
  const state = initialState();
  let phase: Phase = 'discovery';
  const phases: Phase[] = [];
  while (phase !== 'done') {
    phases.push(phase);
    const ctx = testContext(input, state, fetchImpl);
    phase = (await runPhase(phase, ctx)).next;
  }
  const results = state.results;
  const score = scoreScan(Object.values(results), {
    includeCheckout: input.verifiedOwnership && input.testModeConfirmed,
  });
  const status = (id: string) => results[id]?.status;
  return { state, results, score, status, phases };
}
