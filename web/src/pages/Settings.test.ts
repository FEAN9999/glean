import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validSiteCode } from './Settings.tsx';

test('a site code is lowercase letters, digits and hyphens, starts with a letter or digit, at most 32 characters', () => {
  assert.equal(validSiteCode('rphang'), true);
  assert.equal(validSiteCode('Rphang'), false);
  assert.equal(validSiteCode('-a'), false);
  assert.equal(validSiteCode('a'.repeat(33)), false);
});
