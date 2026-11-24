import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Tests must never open the real data folder, whatever runs them (npm test, bun test, an editor).
 * Each test file therefore loads ./setup.ts first, before anything that opens the database.
 */

const self = fileURLToPath(import.meta.url);
const serverDir = path.resolve(path.dirname(self), '..');
const setupFile = path.join(serverDir, 'test', 'setup.ts');
const testFiles = (fs.readdirSync(serverDir, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(serverDir, f));
const name = (f: string) => path.relative(serverDir, f);

const setupSpecifier = (file: string) => {
  const rel = path.relative(path.dirname(file), setupFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

test('every test file loads the test setup before anything else', () => {
  assert.ok(testFiles.length >= 9, `found only ${testFiles.length} test files`);
  for (const f of testFiles) {
    const first = fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .find((l) => /^import\s/.test(l));
    assert.equal(first?.trim().replace(/"/g, "'"), `import '${setupSpecifier(f)}';`, name(f));
  }
});

test('test files stay out of the data folder even when run without the setup flag', { timeout: 120_000 }, async () => {
  const tsx = import.meta.resolve('tsx');
  const env = { ...process.env };
  for (const k of ['GLEAN_DATA_DIR', 'NODE_TEST_CONTEXT']) delete env[k];
  const opened = await Promise.all(
    testFiles
      .filter((f) => f !== self)
      .map(async (f) => {
        // An unprotected file would open "<cwd>/data"; run it from an empty folder to catch that harmlessly.
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glean-isolation-'));
        await new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, ['--import', tsx, '--test', f], { cwd, env, stdio: 'ignore' });
          p.on('error', reject);
          p.on('exit', () => resolve());
        });
        return fs.existsSync(path.join(cwd, 'data')) ? name(f) : null;
      }),
  );
  assert.deepEqual(opened.filter(Boolean), []);
});

test('under a test runner, the database will not open the default data folder', { timeout: 60_000 }, async () => {
  const tsx = import.meta.resolve('tsx');
  const dbModule = pathToFileURL(path.join(serverDir, 'db.ts')).href;
  // node --test sets NODE_TEST_CONTEXT; bun, vitest and jest set NODE_ENV=test.
  for (const runner of [{ NODE_TEST_CONTEXT: 'child' }, { NODE_ENV: 'test' }]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['GLEAN_DATA_DIR', 'NODE_TEST_CONTEXT', 'NODE_ENV']) delete env[k];
    Object.assign(env, runner);
    // From an empty folder: without the guard this opens "<empty folder>/data", not the real one.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glean-guard-'));
    const exit = await new Promise<number | null>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', tsx, '--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], { cwd, env, stdio: 'ignore' });
      p.on('error', reject);
      p.on('exit', resolve);
    });
    assert.notEqual(exit, 0, JSON.stringify(runner));
    assert.equal(fs.existsSync(path.join(cwd, 'data')), false, JSON.stringify(runner));
  }
});
