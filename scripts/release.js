// One-command release: (optionally bump version) → build → create the GitHub
// release with the installer, portable, blockmap, and latest.yml.
//
//   npm run release            # release the current package.json version
//   npm run release -- patch   # bump patch first (0.1.0 → 0.1.1), then release
//   npm run release -- minor   # 0.1.0 → 0.2.0
//   npm run release -- major   # 0.1.0 → 1.0.0
//
// Requires the GitHub CLI (gh) to be installed and authenticated (gh auth login).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const REPO = '90sCraig/vhs-commercial-cutter';

function run(cmd, args, shell = false) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell });
  if (r.status !== 0) {
    console.error(`\n✗ Command failed: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

function findGh() {
  const candidates = ['C:\\Program Files\\GitHub CLI\\gh.exe', 'gh'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { shell: c === 'gh' });
    if (r.status === 0) return c;
  }
  console.error('✗ GitHub CLI (gh) not found. Install it and run: gh auth login');
  process.exit(1);
}

const gh = findGh();

// Optional version bump.
const bump = process.argv[2];
if (bump) {
  if (!['patch', 'minor', 'major'].includes(bump)) {
    console.error(`✗ Unknown bump "${bump}". Use patch | minor | major, or omit.`);
    process.exit(1);
  }
  run('npm', ['version', bump, '--no-git-tag-version'], true);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
console.log(`\n▶ Releasing ${tag}\n`);

// Build (generates latest.yml via the publish config; does not upload).
run('npx', ['electron-builder', '--publish', 'never'], true);

// Collect the artifacts the updater needs.
const dist = path.join(root, 'dist');
const names = [
  `90s-Craig-Edit-Booth-Setup-${version}.exe`,
  `90s-Craig-Edit-Booth-Setup-${version}.exe.blockmap`,
  'latest.yml',
  `90s-Craig-Edit-Booth-Portable-${version}.exe`,
];
const files = names.map((n) => path.join(dist, n));
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(`✗ Missing build artifact: ${f}`); process.exit(1); }
}

// Create the GitHub release (published, not a draft).
run(gh, [
  'release', 'create', tag, ...files,
  '--repo', REPO,
  '--title', `90s Craig Edit Booth ${version}`,
  '--notes', `Release ${version}.`,
], false);

console.log(`\n✓ Published ${tag}`);
console.log('  Note: auto-update reaches users only when the repo is PUBLIC.');
