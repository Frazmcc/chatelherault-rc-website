const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  path.join(root, 'index.html'),
  ...fs.readdirSync(path.join(root, 'pages'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => path.join(root, 'pages', name))
];

let failed = false;

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const html = fs.readFileSync(file, 'utf8');

  const checks = [
    { name: 'title', ok: /<title>[\s\S]*?<\/title>/i.test(html) },
    { name: 'meta description', ok: /<meta[^>]*name=["']description["'][^>]*>/i.test(html) },
    { name: 'canonical', ok: /<link[^>]*rel=["']canonical["'][^>]*>/i.test(html) }
  ];

  for (const check of checks) {
    if (!check.ok) {
      failed = true;
      console.error(`FAIL ${rel}: missing ${check.name}`);
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log(`SEO verification passed for ${files.length} HTML files.`);
