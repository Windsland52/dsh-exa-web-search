/**
 * Install smoke test: what the published tarball actually contains.
 *
 * `npm test` checks the working tree; this checks the package that would reach
 * a user's profile. It answers "does `dsh plugin add` receive every file the
 * Host reads?" — a `files` entry that drops `locale/` or `lib/client.js` breaks
 * the plugin only after publishing.
 *
 * Deliberately not part of `npm test`: it shells out to npm (slow, and it fails
 * where npm is unavailable). Run before publishing.
 *
 * Run: npm run test:install
 */
import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** File paths npm would publish, relative to the package root. */
function packedFiles() {
  // `npm pack --dry-run --json` prints an object keyed by package name. execSync
  // rather than execFileSync because on Windows npm is a .cmd shim, which Node
  // refuses to spawn without a shell.
  const raw = execSync('npm pack --dry-run --json', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(raw);
  const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert(info !== undefined && Array.isArray(info.files), 'npm pack returned no file list');
  return { files: info.files.map(entry => entry.path), info };
}

let packed;
check('0. npm can build the tarball', () => {
  packed = packedFiles();
  assert(packed.files.length > 0, 'tarball is empty');
});

check('1. every file the Host reads at runtime is published', () => {
  const required = [
    'package.json',
    'lib/index.js',
    'lib/client.js',
    'cordis.patch.yml',
    'icon.png',
  ];
  for (const path of required) {
    assert(packed.files.includes(path), `published tarball is missing ${path}`);
  }
  // locale metadata drives the plugin-page title and detail document
  for (const path of ['locale/en.json', 'locale/zh.json']) {
    assert(packed.files.includes(path), `published tarball is missing ${path}`);
  }
  // the detail documents referenced by meta.detail must ship too
  for (const path of ['README.md']) {
    assert(packed.files.includes(path), `published tarball is missing ${path}`);
  }
});

check('2. no development-only path leaks into the tarball', () => {
  const forbidden = ['node_modules', 'tests/', 'package-lock.json'];
  for (const needle of forbidden) {
    const hit = packed.files.find(path => path === needle || path.startsWith(needle));
    assert(hit === undefined, `published tarball should not contain ${needle} (found ${hit})`);
  }
});

check('3. every published JavaScript file parses', () => {
  const scripts = packed.files.filter(path => path.endsWith('.js'));
  assert(scripts.length > 0, 'no JavaScript files were published');
  for (const path of scripts) {
    try {
      execFileSync(process.execPath, ['--check', resolve(ROOT, path)], { stdio: 'pipe' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${path} failed to parse: ${detail.split('\n')[0]}`);
    }
  }
});

check('4. published size stays reasonable', () => {
  const bytes = packed.info.unpackedSize ?? packed.info.size ?? 0;
  assert(bytes > 0, 'npm pack reported no size');
  const kb = Math.round(bytes / 1024);
  console.log(`      unpacked size: ${kb} KB, entries: ${packed.files.length}`);
  assert(bytes < 2 * 1024 * 1024, `unpacked size ${kb} KB exceeds 2 MB`);
});

console.log('\n================ SUMMARY ================');
console.log(`PASS ${pass}   FAIL ${failures.length}   (${pass + failures.length} install checks)`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`- ${failure}`);
  console.log('=========================================');
  process.exitCode = 1;
} else {
  console.log('=========================================');
}
