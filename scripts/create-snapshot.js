const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version || '0.0.0';

const timestamp = new Date().toISOString();
const stampSafe = timestamp.replace(/[:]/g, '-').replace(/\..+$/, 'Z');
const branch = run('git rev-parse --abbrev-ref HEAD') || 'unknown';
const commit = run('git rev-parse --short HEAD') || 'unknown';
const status = run('git status --short');

const snapshotText = [
  '# Repository Snapshot',
  '',
  `- Timestamp: ${timestamp}`,
  `- Version: ${version}`,
  `- Branch: ${branch}`,
  `- Commit: ${commit}`,
  `- Working tree clean: ${status ? 'no' : 'yes'}`,
  '',
  '## Working Tree',
  '',
  '```text',
  status || '(clean)',
  '```',
  ''
].join('\n');

const snapshotsDir = path.join(repoRoot, 'snapshots');
const historyDir = path.join(snapshotsDir, 'history');
fs.mkdirSync(historyDir, { recursive: true });

const latestPath = path.join(snapshotsDir, 'latest.md');
const historyPath = path.join(historyDir, `${stampSafe}-v${version}.md`);

fs.writeFileSync(latestPath, snapshotText, 'utf8');
fs.writeFileSync(historyPath, snapshotText, 'utf8');

console.log(`Snapshot written: ${latestPath}`);
console.log(`Snapshot archived: ${historyPath}`);
