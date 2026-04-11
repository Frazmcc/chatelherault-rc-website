const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, options = {}) {
  execSync(cmd, { stdio: 'inherit', ...options });
}

function runCapture(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function fail(message) {
  console.error(`Release failed: ${message}`);
  process.exit(1);
}

const bump = process.argv[2];
const allowed = new Set(['patch', 'minor', 'major']);

if (!allowed.has(bump)) {
  fail('Usage: node scripts/release.js <patch|minor|major>');
}

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

const status = runCapture('git status --short');
if (status) {
  fail('Working tree is not clean. Commit/stash changes first.');
}

try {
  runCapture('gh --version');
  runCapture('gh auth status');
} catch {
  fail('GitHub CLI is not installed or not authenticated. Run: gh auth login');
}

run('git fetch --tags origin');
run('git pull --ff-only origin main');

run(`npm version ${bump} --no-git-tag-version`);
run('npm run verify');
run('npm run snapshot');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const today = new Date().toISOString().slice(0, 10);
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

if (fs.existsSync(changelogPath)) {
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  if (!changelog.includes(`## [${version}]`)) {
    const unreleasedMarker = '## [Unreleased]';
    if (changelog.includes(unreleasedMarker)) {
      const insertion = `\n\n## [${version}] - ${today}\n\n### Changed\n- Release ${tag}.\n`;
      fs.writeFileSync(changelogPath, changelog.replace(unreleasedMarker, `${unreleasedMarker}${insertion}`), 'utf8');
    }
  }
}

const existingTag = runCapture(`git tag --list ${tag}`);
if (existingTag) {
  fail(`Tag ${tag} already exists.`);
}

run('git add -A');
run(`git commit -m "Release ${tag}"`);
run(`git tag -a ${tag} -m "Release ${tag}"`);
run('git push origin main');
run(`git push origin ${tag}`);
run(`gh release create ${tag} --target main --title "${tag}" --generate-notes --latest`);
run('npx wrangler deploy');

console.log(`Release completed successfully: ${tag}`);
