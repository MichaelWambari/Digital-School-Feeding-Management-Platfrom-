// Runs every database test in supabase/tests/ against a local PGlite
// database (no Supabase project needed) and fails if any check fails.
//   npm run test:db
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../supabase/tests/', import.meta.url));
const tests = readdirSync(dir)
  .filter((f) => /^(test\d.*|table_5_8|githeri_check)\.mjs$/.test(f))
  .sort();

const failed = [];
for (const test of tests) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [dir + test], { encoding: 'utf8' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (run.status === 0) {
    console.log(`pass  ${test} (${seconds} s)`);
  } else {
    failed.push(test);
    console.log(`FAIL  ${test} (${seconds} s)`);
    const lines = `${run.stdout}${run.stderr}`.split('\n');
    for (const line of lines.filter((l) => /^FAIL|Error|error:/.test(l)).slice(0, 20)) console.log(`      ${line}`);
  }
}
console.log(failed.length ? `\n${failed.length} of ${tests.length} test files failed` : `\nall ${tests.length} test files passed`);
process.exit(failed.length ? 1 : 0);
