import { describe, expect, it } from 'vitest';
import { classifyVersion, LATEST_VERSION, PREVIOUS_VERSION, UCP_VERSIONS } from '../src/ucp/versions';
import { authorityBinding } from '../src/ucp/profile';
import { validate } from '../src/ucp/validators';
import { RAW_FIXTURES } from './fixtures/fixtures.generated';
import { jsonFixture } from './fixtures';

// Vendored schema folders are bundled at build time; list them via the generated validator modules.
const vendoredFolders = Object.keys(import.meta.glob('../schemas/ucp/*/ucp.json')).map(
  (p) => p.split('/')[3],
);

describe('vendored versions', () => {
  it('versions.ts matches the schema folders exactly', () => {
    expect([...vendoredFolders].sort()).toEqual([...UCP_VERSIONS]);
  });
  it('is sorted with latest last', () => {
    expect([...UCP_VERSIONS].sort()).toEqual([...UCP_VERSIONS]);
    expect(LATEST_VERSION).toBe('2026-08-25');
    expect(PREVIOUS_VERSION).toBe('2026-04-08');
  });
});

describe('version currency', () => {
  it.each([
    ['2026-08-25', 'latest'],
    ['2026-04-08', 'previous'],
    ['2026-01-23', 'older'],
    ['2026-01-11', 'older'],
    ['2026-05-01', 'unknown'],
    ['draft', 'unknown'],
    [undefined, 'unknown'],
    [20260825, 'unknown'],
  ] as const)('%s → %s', (v, expected) => expect(classifyVersion(v)).toBe(expected));
});

describe('authority binding (cases from the spec table)', () => {
  it.each([
    ['dev.ucp.shopping.checkout', 'https://ucp.dev/x.json', true],
    ['dev.ucp.shopping.checkout', 'https://shopping.ucp.dev/x.json', true],
    ['com.example.payments.installments', 'https://example.com/x.json', true],
    ['com.example.pay', 'https://pay.example.com/x.json', true],
    ['com.example.pay', 'https://example.com/x.json', true],
    ['com.example.pay', 'https://evil.example/x.json', false],
    ['dev.ucp.shopping.checkout', 'https://evil.example/x.json', false],
    ['com.examplecorp.pay', 'https://example.com/x.json', false],
    ['com.example.pay', 'https://cdn.example.com/x.json', false],
    ['dev.ucp.shopping.checkout', 'https://ucp.dev@evil.example/x.json', false],
    ['dev.ucp.shopping.checkout', 'http://ucp.dev/x.json', false],
    ['dev.ucp.shopping.checkout', 'https://203.0.113.10/x.json', false],
    ['dev.ucp.shopping.checkout', 'https://localhost/x.json', false],
    ['dev.ucp.shopping.checkout', 'https://UCP.DEV./x.json', true],
  ] as const)('%s @ %s → %s', (name, url, ok) => expect(authorityBinding(name, url).ok).toBe(ok));
});

describe('validators', () => {
  it('accept the valid fixtures and reject the invalid ones', () => {
    expect(validate('profile', jsonFixture('ucp/2026-08-25/profile.valid.json'), '2026-08-25').valid).toBe(
      true,
    );
    expect(
      validate('profile', jsonFixture('ucp/2026-08-25/profile.previous-version.json'), '2026-04-08').valid,
    ).toBe(true);
    expect(
      validate('profile', jsonFixture('ucp/2026-08-25/profile.schema-invalid.json'), '2026-08-25').valid,
    ).toBe(false);
    expect(
      validate('catalogSearchResponse', jsonFixture('ucp/2026-08-25/catalog.search.valid.json'), '2026-08-25')
        .valid,
    ).toBe(true);
    expect(
      validate('checkout', jsonFixture('ucp/2026-08-25/checkout.session.valid.json'), '2026-08-25').valid,
    ).toBe(true);
    expect(Object.keys(RAW_FIXTURES).length).toBeGreaterThan(20);
  });
});
