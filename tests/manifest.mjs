/**
 * Manifest contract tests: everything that can make a published package
 * install but fail to load. These catch packaging mistakes that never show up
 * in a local checkout — a `files` entry that drops `locale/`, an `exports`
 * path pointing nowhere, a `dsh.bundle.patch` that was edited into invalid
 * YAML, an icon over the Host's size limit.
 *
 * Zero dependencies on purpose: a test that cannot run because of a missing
 * dev dependency is worse than no test.
 *
 * Run: npm test
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ICON_BYTES = 256 * 1024;

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

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function readJson(relative) {
  const path = join(ROOT, relative);
  assert(existsSync(path), `${relative} does not exist`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson('package.json');

/* ------------------------------------------------------------------ */
/* 1. identity and entry points                                        */
/* ------------------------------------------------------------------ */
check('1a. package identity is a dsh plugin name', () => {
  assertEqual(typeof pkg.name, 'string', 'name type');
  assert(/^dsh-/.test(pkg.name), `name should start with "dsh-", got ${pkg.name}`);
  assertEqual(pkg.license, 'MIT', 'license');
  assert(/^\d+\.\d+\.\d+/.test(pkg.version), `version should be semver, got ${pkg.version}`);
});

check('1b. main entry exists and is loadable JavaScript', () => {
  assertEqual(pkg.type, 'module', 'type');
  assert(typeof pkg.main === 'string', 'main is declared');
  const mainPath = join(ROOT, pkg.main);
  assert(existsSync(mainPath), `main target ${pkg.main} does not exist`);
  const source = readFileSync(mainPath, 'utf8');
  assert(/export\s*\{/.test(source), 'main should be an ES module with exports');
  for (const symbol of ['apply', 'Config', 'PROVIDER_ID']) {
    assert(source.includes(symbol), `main should export ${symbol}`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. exports map resolves to real files                               */
/* ------------------------------------------------------------------ */
check('2a. every exports target exists', () => {
  const entries = Object.entries(pkg.exports ?? {});
  assert(entries.length > 0, 'exports map is declared');
  for (const [key, value] of entries) {
    const target = typeof value === 'string' ? value : value?.default;
    assert(typeof target === 'string', `exports["${key}"] should be a string or { default }`);
    if (target.includes('*')) {
      // wildcard export: the containing directory must exist and match something
      const [prefix] = target.split('*');
      const dir = join(ROOT, dirname(prefix));
      assert(existsSync(dir), `exports["${key}"] directory ${dirname(prefix)} does not exist`);
      const files = readdirSync(dir).filter(name => name.endsWith('.json'));
      assert(files.length > 0, `exports["${key}"] matches no file in ${dirname(prefix)}`);
    } else {
      assert(existsSync(join(ROOT, target)), `exports["${key}"] -> ${target} does not exist`);
    }
  }
});

check('2b. client bundle is exported and registers a factory', () => {
  const clientTarget = typeof pkg.exports?.['./client'] === 'string'
    ? pkg.exports['./client']
    : pkg.exports?.['./client']?.default;
  assert(typeof clientTarget === 'string', 'exports["./client"] is declared');
  const clientPath = join(ROOT, clientTarget);
  assert(existsSync(clientPath), `client target ${clientTarget} does not exist`);
  const source = readFileSync(clientPath, 'utf8');
  assert(source.includes('__ModuleLoader__'), 'client must register through window.__ModuleLoader__');
  assert(source.includes(`id: '${pkg.name}'`) || source.includes(`id: "${pkg.name}"`),
    `client must register under the package name ${pkg.name}`);
});

/* ------------------------------------------------------------------ */
/* 3. dsh plugin declarations                                          */
/* ------------------------------------------------------------------ */
check('3a. dsh.bundle declares a patch that exists', () => {
  const patch = pkg.dsh?.bundle?.patch;
  assert(typeof patch === 'string', 'dsh.bundle.patch is declared');
  assert(existsSync(join(ROOT, patch)), `dsh.bundle.patch ${patch} does not exist`);
});

check('3b. dsh.client declares the web platform and its injects', () => {
  assertEqual(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform');
  const inject = pkg.dsh?.client?.inject;
  assert(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject is a non-empty array');
  // The client bundle injects the ctx services `slots`, `locale` and
  // `configForms`; each is provided by one of these packages, so their bundles
  // must load first. Platform seeds (react, ui-primitives, ui-slots…) come from
  // the shell's static module table and must NOT be listed here.
  for (const id of [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ]) {
    assert(inject.includes(id), `dsh.client.inject should list ${id}`);
  }
  for (const id of inject) {
    assert(!id.includes('ui-primitives'), 'platform seeds (ui-primitives) must not be injected');
    assert(!id.includes('ui-slots'), 'platform seeds (ui-slots) must not be injected');
  }
});

/* ------------------------------------------------------------------ */
/* 4. the bundle patch actually selects this provider                  */
/* ------------------------------------------------------------------ */
check('4a. cordis.patch.yml inserts this plugin row', () => {
  const text = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8');
  assert(/^-\s*insert:/m.test(text) || /^\s*-\s*insert:/m.test(text), 'patch must contain an insert block');
  const rowIds = [...text.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map(m => m[1]);
  assert(rowIds.length > 0, 'patch declares at least one row id');
  assert(text.includes(pkg.name), `patch should reference the package name ${pkg.name}`);
});

check('4b. patch overrides the web row to select our provider id', () => {
  const text = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8');
  // the override row is a top-level `- id: web` with searchProvider in its config
  assert(/^-\s*id:\s*web\s*$/m.test(text), 'patch must override the `web` row at top level');
  const searchProvider = text.match(/^\s*searchProvider:\s*(\S+)\s*$/m)?.[1];
  assert(searchProvider !== undefined, 'patch must set searchProvider');
  const mainSource = readFileSync(join(ROOT, pkg.main), 'utf8');
  const providerId = mainSource.match(/const PROVIDER_ID\s*=\s*["']([^"']+)["']/)?.[1];
  assert(providerId !== undefined, 'PROVIDER_ID is declared in main');
  assertEqual(searchProvider, providerId, 'patch searchProvider must match PROVIDER_ID');
});

check('4c. patch is structurally valid YAML (no tabs, consistent mapping)', () => {
  const text = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8');
  assert(!/\t/.test(text), 'patch must not contain tab characters');
  const badLines = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return false;
    // every content line is either a list item, or a `key:` / `key: value`
    return !/^-\s/.test(trimmed) && !/^[\w.$-]+:(\s|$)/.test(trimmed);
  });
  assertEqual(badLines.length, 0, `malformed YAML lines: ${badLines.slice(0, 3).join(' | ')}`);
});

/* ------------------------------------------------------------------ */
/* 5. published file set                                               */
/* ------------------------------------------------------------------ */
check('5a. files covers every path the Host reads at runtime', () => {
  const files = pkg.files;
  assert(Array.isArray(files) && files.length > 0, 'files is declared');
  const required = [
    'lib',
    'locale',
    pkg.dsh.bundle.patch.replace(/^\.\//, ''),
    'README.md',
    'LICENSE',
  ];
  for (const entry of required) {
    assert(files.some(declared => declared === entry || entry.startsWith(`${declared}/`)),
      `files must publish ${entry}`);
  }
  for (const entry of files) {
    assert(existsSync(join(ROOT, entry)), `files entry ${entry} does not exist on disk`);
  }
});

check('5b. locale dictionaries ship with the package', () => {
  const files = pkg.files;
  assert(files.includes('locale'), 'files must publish the locale directory');
  const dir = join(ROOT, 'locale');
  assert(existsSync(dir), 'locale directory exists');
  const names = readdirSync(dir).filter(name => name.endsWith('.json'));
  assert(names.includes('en.json'), 'locale/en.json is required (Host metadata baseline)');
  for (const name of names) {
    const meta = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert(typeof meta.meta?.title === 'string' && meta.meta.title !== '',
      `${name} must declare meta.title`);
    if (meta.meta.detail !== undefined) {
      const detail = meta.meta.detail;
      assert(/:/.test(detail) === false && !detail.startsWith('/'), `${name} meta.detail must be a relative path`);
      assert(existsSync(join(ROOT, detail)), `${name} meta.detail ${detail} does not exist`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 6. icon limits                                                      */
/* ------------------------------------------------------------------ */
check('6a. declared icon exists, is a supported type and within the size cap', () => {
  const icon = pkg.icon;
  if (icon === undefined) return; // icon is optional
  const path = join(ROOT, icon);
  assert(existsSync(path), `icon ${icon} does not exist`);
  const stat = statSync(path);
  assert(stat.isFile(), `icon ${icon} must be a regular file`);
  assert(stat.size <= MAX_ICON_BYTES,
    `icon is ${stat.size} bytes; the Host rejects anything over ${MAX_ICON_BYTES}`);
  assert(/\.(svg|png|jpe?g|webp)$/i.test(icon), `icon ${icon} must be SVG, PNG, JPEG or WebP`);
});

/* ------------------------------------------------------------------ */
/* 7. engine and peer ranges agree                                     */
/* ------------------------------------------------------------------ */
check('7a. engines.dsh does not claim more than peerDependencies allow', () => {
  const declared = pkg.engines?.dsh;
  assert(typeof declared === 'string', 'engines.dsh is declared');
  const peerWeb = pkg.peerDependencies?.['@deepseek-ai/dsh-web'];
  assert(typeof peerWeb === 'string', 'peerDependencies declares @deepseek-ai/dsh-web');
  // The two must cap at the same minor line, otherwise the Host can satisfy one
  // check and fail the other.
  const capOf = (range) => range.match(/<(0\.\d+\.\d+(?:-[\w.]+)?)/)?.[1];
  const peerCap = capOf(peerWeb);
  assert(peerCap !== undefined, `peer range "${peerWeb}" declares no upper bound`);
  assertEqual(capOf(declared), peerCap, 'engines.dsh upper bound must match the peer bound');
});

check('7b. prerelease coverage enumerates every 0.2 minor', () => {
  // A single lower bound cannot span a prerelease line: semver only matches a
  // prerelease when some comparator carries a prerelease on the SAME
  // major.minor.patch. `>=0.2.0-rc.1` therefore excludes 0.2.1-alpha.1 and
  // 0.2.2-rc.1 — including the version this project develops against. Each
  // minor that ships prereleases needs its own comparator.
  const peerWeb = pkg.peerDependencies?.['@deepseek-ai/dsh-web'] ?? '';
  for (const minor of ['0.2.0', '0.2.1', '0.2.2']) {
    assert(new RegExp(`>=${minor.replaceAll('.', '\\.')}-`).test(peerWeb),
      `peer range must carry a comparator for the ${minor} prerelease line: ${peerWeb}`);
  }
  // and it must still exclude the next minor
  assert(/<0\.3\.0/.test(peerWeb), `peer range must exclude 0.3: ${peerWeb}`);
});

/* ------------------------------------------------------------------ */
/* 8. documentation stays in step with the schema                       */
/* ------------------------------------------------------------------ */
check('8a. README config tables match the Config schema exactly', () => {
  const source = readFileSync(join(ROOT, pkg.main), 'utf8');
  const block = source.split('const Config = z.object({')[1]?.split('});')[0];
  assert(block !== undefined, 'cannot locate the Config schema in the main entry');
  const schemaFields = [...block.matchAll(/^\t(\w+):/gm)].map(match => match[1]);
  assert(schemaFields.length > 0, 'Config schema exposes no fields');

  for (const file of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const header = text.search(/^\| (字段|Field) \|/m);
    assert(header >= 0, `${file} has no configuration table`);
    const end = text.indexOf('\n\n', header);
    const rows = [...text.slice(header, end === -1 ? undefined : end).matchAll(/^\| `(\w+)`/gm)]
      .map(match => match[1]);
    const documented = rows.filter(name => !schemaFields.includes(name));
    const missing = schemaFields.filter(name => !rows.includes(name));
    assertEqual(documented.length, 0, `${file} documents fields the schema does not have: ${documented.join(', ')}`);
    assertEqual(missing.length, 0, `${file} does not document: ${missing.join(', ')}`);
  }
});

check('8b. README relative links and images resolve', () => {
  // A relative target in a README is a reference to a real file: renaming one
  // breaks the npm page (broken image) or the plugin detail view (dead link).
  const targetPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const file of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    let checked = 0;
    for (const match of text.matchAll(targetPattern)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const path = target.split('#')[0];
      if (path === '') continue;
      checked += 1;
      assert(existsSync(join(ROOT, path)), `${file} links to missing file "${path}"`);
    }
    assert(checked > 0, `${file} has no relative links? at least the icon should be there`);
  }
});

check('8c. Chinese and English READMEs keep the same structure', () => {
  // The two documents are hand-maintained mirrors. Wording may differ, but a
  // missing section on one side means one language silently fell behind.
  const shapeOf = (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    return {
      sections: (text.match(/^## /gm) ?? []).length,
      tables: (text.match(/^\| --- /gm) ?? []).length,
      codeBlocks: (text.match(/^```/gm) ?? []).length / 2,
    };
  };
  const zh = shapeOf('README.md');
  const en = shapeOf('README.en.md');
  assertEqual(zh.sections, en.sections, '## section count (zh vs en)');
  assertEqual(zh.tables, en.tables, 'table count (zh vs en)');
  assertEqual(zh.codeBlocks, en.codeBlocks, 'code block count (zh vs en)');
});

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */
console.log('\n================ SUMMARY ================');
console.log(`PASS ${pass}   FAIL ${failures.length}   (${pass + failures.length} manifest checks)`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`- ${failure}`);
  console.log('=========================================');
  process.exitCode = 1;
} else {
  console.log('=========================================');
}
