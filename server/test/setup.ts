import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test process gets its own throwaway data directory, so tests never touch ./data.
process.env.GLEAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glean-test-'));
