import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test process gets its own throwaway data directory, so tests never touch ./data.
process.env.GLEAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glean-test-'));

// Tests call all/get/run/tx outside any request: there they use the main site. Imported only now,
// since the database opens its folder from GLEAN_DATA_DIR on import.
const { setTestFallback } = await import('../db.ts');
const { mainSite } = await import('../site.ts');
setTestFallback(() => mainSite());
