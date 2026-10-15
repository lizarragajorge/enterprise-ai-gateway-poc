import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPublic, forbiddenPublicPath, inspectPublicFile, publishableFiles } from './check-public.mjs';

test('publication excludes private/generated paths but permits template configuration', () => {
  for (const path of ['.env', '.env.backup', '.npmrc', '.local/proof.json', 'dist/index.html',
    'node_modules/pkg/index.js', '.github/skills/local/SKILL.md', 'node-compile-cache/cache', 'private.pem']) {
    assert.equal(forbiddenPublicPath(path), true, path);
  }
  for (const path of ['.env.example', 'src/main.ts', 'scripts/deployment-config.example.json', 'public/icons/azure-monitor.svg']) {
    assert.equal(forbiddenPublicPath(path), false, path);
  }
});

test('findings report location/category without returning secret or customer content', () => {
  const credential = 'ghp_' + 'x'.repeat(40);
  const findings = inspectPublicFile('fixture.ts', `header\n${credential}\n`, []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].rule, 'GitHub credential');
  assert.ok(!JSON.stringify(findings).includes(credential));
  assert.equal(inspectPublicFile('fixture.ts', 'local-' + 'credential-canary', ['local-' + 'credential-canary']).length, 1);
  assert.equal(inspectPublicFile('fixture.ts', 'const token = process.env.API_KEY;').length, 0);
  assert.equal(inspectPublicFile('fixture.ts', '-----BEGIN ' + 'PRIVATE KEY-----').length, 1);
  assert.equal(inspectPublicFile('fixture.ts', 'https://adb-0000000000000000.0.azuredatabricks.net').length, 0);
  assert.equal(inspectPublicFile('fixture.ts', 'https://adb-' + '1234567890123456.0.azuredatabricks.net').length, 1);
});

test('publication set respects Git ignores and catches an ignored file if force-tracked', () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-publication-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.gitignore'), '.env\n.local/\n');
    writeFileSync(join(root, 'safe.ts'), 'export const synthetic = true;\n');
    writeFileSync(join(root, '.env'), 'API_KEY=local-credential-canary\n');
    assert.ok(!publishableFiles(root).includes('.env'));
    assert.deepEqual(checkPublic(root).findings, []);
    writeFileSync(join(root, 'safe.ts'), 'export const value = "local-credential-canary";\n');
    assert.ok(checkPublic(root).findings.some(finding => finding.rule.includes('ignored local configuration')));
    execFileSync('git', ['add', '-f', '.env'], { cwd: root, stdio: 'ignore' });
    assert.ok(publishableFiles(root).includes('.env'));
    assert.ok(checkPublic(root).findings.some(finding => finding.rule.includes('Private or generated file')));
    mkdirSync(join(root, '.local'));
    writeFileSync(join(root, '.local/deployment-config.json'), JSON.stringify({ tenantId: 'fixture-private-tenant' }));
    writeFileSync(join(root, 'safe.ts'), 'export const value = "fixture-private-tenant";\n');
    assert.ok(!publishableFiles(root).some(file => file.startsWith('.local/')));
    assert.ok(checkPublic(root).findings.some(finding => finding.file === 'safe.ts' && finding.rule.includes('ignored local configuration')));
  } finally {
    rmSync(root, { recursive: true });
  }
});
