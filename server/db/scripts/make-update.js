'use strict';

/* Makes an update for the live server, run from the server/ folder:
 *
 *   npm run make-update
 *
 * Saves deploy-kit/update-<date-time>/ (gitignored) holding:
 *   - time-slide-app.zip: the whole app as it is in this folder -- every file
 *     git knows about, plus a VERSION.txt naming the commit -- but never
 *     node_modules, any .env, or the live-copy data,
 *   - update-timeslide.ps1: the script that installs it on the server,
 *   - HOW-TO-UPDATE.txt: the two steps.
 * Sending the whole app every time means no changed file can be missed.
 * Push to GitHub first, so the live server always matches a commit.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const archiver = require('archiver');

const server = path.join(__dirname, '..', '..');
const repo = path.join(server, '..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const NEVER = [/^server\/node_modules\//, /^server\/db\/live-copy\//, /(^|\/)\.env$/, /^server\/deploy\/update-timeslide\.ps1$/];

function version() {
  const commit = git('log', '-1', '--format=%h %ad %s', '--date=format:%Y-%m-%d %H:%M');
  const uncommitted = git('status', '--porcelain', '--', 'server').split('\n').filter(Boolean).length;
  return { text: uncommitted ? `${commit} + ${uncommitted} uncommitted change(s)` : commit, uncommitted };
}

async function main() {
  const files = git('ls-files', '-co', '--exclude-standard', '--', 'server')
    .split('\n').filter(Boolean).filter((f) => !NEVER.some((re) => re.test(f)) && fs.existsSync(path.join(repo, f)));
  const { text, uncommitted } = version();
  const d = new Date(); const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}`; // local time
  const outDir = path.join(repo, 'deploy-kit', `update-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const zipPath = path.join(outDir, 'time-slide-app.zip');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    files.forEach((f) => zip.file(path.join(repo, f), { name: f }));
    zip.append(`${text}\nPacked ${new Date().toISOString()}\n`, { name: 'server/VERSION.txt' });
    zip.finalize();
  });
  fs.copyFileSync(path.join(server, 'deploy', 'update-timeslide.ps1'), path.join(outDir, 'update-timeslide.ps1'));
  fs.writeFileSync(path.join(outDir, 'HOW-TO-UPDATE.txt'), [
    `Time Slide update: ${text}`,
    '',
    '1. Copy this whole folder to the server (Remote Desktop to CMTDC01) as',
    '   C:\\TIME SLIDE\\update   (replace anything already there).',
    '2. On the server, in PowerShell as administrator, run:',
    '',
    '   powershell -ExecutionPolicy Bypass -File "C:\\TIME SLIDE\\update\\update-timeslide.ps1"',
    '',
    'It ends with [OK] (done: refresh the browser with Ctrl+F5) or [FAILED]',
    '(the previous version is put back automatically; paste the window to Claude).',
    '',
  ].join('\r\n'));

  console.log(`Saved ${outDir}`);
  console.log(`  version: ${text}`);
  console.log(`  ${files.length} files in time-slide-app.zip (${Math.round(fs.statSync(zipPath).size / 1024)} KB), plus update-timeslide.ps1 and HOW-TO-UPDATE.txt`);
  if (uncommitted) console.log('  NOTE: there are uncommitted changes -- push to GitHub first so the live server matches a commit.');
}

main().catch((err) => {
  console.error(`make-update failed: ${err.message}`);
  process.exit(1);
});
