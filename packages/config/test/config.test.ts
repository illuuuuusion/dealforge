import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, createRedactor } from '../src/index.ts';

test('DF-603: secrets can come from files (Docker secrets); a directly set value wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealforge-secrets-'));
  try {
    writeFileSync(join(dir, 'pw'), 'from-file-password-123\n');
    assert.equal(loadConfig({ APP_PASSWORD_FILE: join(dir, 'pw') }).appPassword, 'from-file-password-123');
    assert.equal(loadConfig({ APP_PASSWORD_FILE: join(dir, 'pw'), APP_PASSWORD: 'direct-password-1234' }).appPassword, 'direct-password-1234');
    assert.throws(() => loadConfig({ SECRETS_KEY_FILE: join(dir, 'missing') }), /ENOENT/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('DF-603: the redactor masks configured secrets and credential patterns', () => {
  const ebaySecret = `PRD-${randomBytes(8).toString('hex')}`;
  const redact = createRedactor(loadConfig({ APP_PASSWORD: 'hunter2-hunter2-hunter2', EBAY_CLIENT_SECRET: ebaySecret, KLAZ_API_KEY: 'k' }));
  const line = redact(`login hunter2-hunter2-hunter2 with ${ebaySecret} via postgres://dealforge:pgpass@db:5432/x `
    + 'Authorization: Bearer v^1.1#i^1 Basic dXNlcjpwYXNz {"access_token":"tok123","klaz_key":"kk"} ?api_key=zzz&q=rtx');
  for (const secret of ['hunter2', ebaySecret, 'pgpass', '^1.1#i^1', 'dXNlcjpwYXNz', 'tok123', '"kk"', 'zzz']) assert.ok(!line.includes(secret), `${secret} in ${line}`);
  assert.match(line, /q=rtx/);
  assert.equal(redact('RTX 4070 Super 12GB'), 'RTX 4070 Super 12GB');
});
