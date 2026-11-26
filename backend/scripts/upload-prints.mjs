// Uploads the 200 print files from ../prints into the private R2 bucket "sp076-prints".
//   npm run upload-prints            -> live bucket
//   npm run upload-prints -- --local -> local test bucket used by `wrangler dev`
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const prints = join(here, '..', '..', 'prints');
const manifestPath = join(prints, 'manifest.json');
if (!existsSync(manifestPath)) { console.error('No prints/manifest.json. Render the print files first (tools/render-prints.html).'); process.exit(1); }

const where = process.argv.includes('--local') ? '--local' : '--remote';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const wrangler = join(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let n = 0;
for (const e of manifest.editions) {
  for (const key of Object.values(e.files)) {
    execFileSync(process.execPath, [wrangler, 'r2', 'object', 'put', `sp076-prints/${key}`, '--file', join(prints, key), '--content-type', 'image/png', where],
      { cwd: join(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`${++n}/200  ${key}`);
  }
}
console.log(`Uploaded ${n} files (${where.slice(2)}).`);
