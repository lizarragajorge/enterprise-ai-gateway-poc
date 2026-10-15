import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

const patterns = [
  ['Private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['Literal credential', /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\b\s*[:=]\s*["'][A-Za-z0-9+/_=-]{32,}["']/i],
  ['Internal registry or workplace URL', /(?:packagefeedproxy\.microsoft\.io|[\w.-]+\.pkgs\.visualstudio\.com|pkgs\.dev\.azure\.com|[\w.-]+\.sharepoint\.com)/i],
  ['Machine-specific home path', /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ['Customer-specific reference', /\bP66\b|Phillips\s*66/i],
  ['Deployment-specific subscription', /\/subscriptions\/(?!00000000-0000-0000-0000-000000000000\b)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i],
  ['Deployment-specific Databricks host', /https:\/\/adb-(?!0+\.0\.)\d+\.\d+\.azuredatabricks\.net/i]
];

export function forbiddenPublicPath(file) {
  return /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.mcp\.json)$/.test(file) && file !== '.env.example'
    || /^(?:\.local|node_modules|dist|node-compile-cache|coverage|\.github\/skills)(?:\/|$)/.test(file)
    || /\.(?:pem|key|pfx|p12|crt|zip|tgz)$/i.test(file);
}

export function inspectPublicFile(file, content, localCredentials = []) {
  const findings = [];
  if (forbiddenPublicPath(file)) findings.push({ file, line: 1, rule: 'Private or generated file in publication set' });
  for (const [index, line] of content.split('\n').entries()) {
    for (const [rule, pattern] of patterns) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
    }
    if (localCredentials.some(value => line.includes(value))) {
      findings.push({ file, line: index + 1, rule: 'Sensitive value matches ignored local configuration' });
    }
  }
  return findings;
}

export function publishableFiles(root) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).split('\0').filter(Boolean))].sort();
}

export function checkPublic(root) {
  const envPath = resolve(root, '.env');
  const credentials = existsSync(envPath) ? Object.entries(parseEnv(readFileSync(envPath, 'utf8')))
    .filter(([key, value]) => /(?:KEY|SECRET|PASSWORD|TOKEN|CONNECTION_STRING)/i.test(key) && value.length >= 8)
    .map(([, value]) => value) : [];
  const deploymentPath = resolve(root, '.local/deployment-config.json');
  if (existsSync(deploymentPath)) {
    const inspect = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /^(?:subscriptionId|tenantId|principalId|clientId)$/i.test(key) && item.length >= 8) credentials.push(item);
        else if (typeof item === 'string' && /^(?:https?):\/\//i.test(item)) {
          const url = new URL(item);
          if (!url.hostname.endsWith('.example') && url.hostname !== 'example.com') credentials.push(url.hostname);
        } else if (typeof item === 'object') inspect(item);
      }
    };
    inspect(JSON.parse(readFileSync(deploymentPath, 'utf8')));
  }
  const files = publishableFiles(root);
  const findings = [];
  for (const file of files) {
    const path = resolve(root, file);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
      findings.push({ file, line: 1, rule: 'Symlink, non-file or file over 1 MiB requires manual review' });
      continue;
    }
    const content = readFileSync(path);
    if (content.includes(0)) {
      findings.push({ file, line: 1, rule: 'Binary file requires manual review' });
      continue;
    }
    findings.push(...inspectPublicFile(file, content.toString('utf8'), credentials));
  }
  return { files, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { files, findings } = checkPublic(process.cwd());
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
    if (findings.length) {
      console.error(`Public-readiness check failed: ${findings.length} finding(s). Values are deliberately not printed.`);
      process.exitCode = 1;
    } else {
      console.info(`Checked ${files.length} publishable files. No configured sensitive patterns or local credentials found.`);
      console.info('Ignored local files were excluded. This check is not a comprehensive security audit or publication authorization.');
    }
  } catch {
    console.error('Public-readiness check could not complete. Run from the Git repository root and inspect local file access.');
    process.exitCode = 1;
  }
}
