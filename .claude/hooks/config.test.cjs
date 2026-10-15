'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../..');
// Reuse the YAML parser already locked through ESLint; no new install/network.
const eslintRequire = createRequire(require.resolve('eslint/package.json'));
const yaml = createRequire(eslintRequire.resolve('@eslint/eslintrc'))('js-yaml');
const minimatchModule = eslintRequire('minimatch');
const match = minimatchModule.minimatch || minimatchModule;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function document(file) {
  const content = fs.readFileSync(file, 'utf8');
  assert.notEqual(content.charCodeAt(0), 0xfeff, `${file}: unexpected BOM`);
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  assert.ok(front, `${file}: missing frontmatter`);
  return yaml.load(front[1]);
}

test('skills are discoverable and all custom reviewers have only read tools', () => {
  const skills = walk(path.join(root, '.claude/skills')).filter(file => path.basename(file) === 'SKILL.md');
  assert.ok(skills.length >= 3);
  for (const file of skills) {
    const config = document(file);
    assert.equal(config.name, path.basename(path.dirname(file)), file);
    assert.match(config.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(typeof config.description, 'string');
    assert.ok(config.description.length > 20 && config.description.length <= 1024, file);
    assert.ok(!config.description.includes('[TODO'), file);
  }
  const agents = walk(path.join(root, '.claude/agents')).filter(file => file.endsWith('.md'));
  assert.ok(agents.length >= 2);
  for (const file of agents) {
    const config = document(file);
    assert.equal(config.name, path.basename(file, '.md'));
    assert.deepEqual(config.tools.split(',').map(x => x.trim()).sort(), ['Glob', 'Grep', 'Read']);
    assert.equal(config.model, 'inherit');
    assert.ok(config.maxTurns > 0 && config.maxTurns <= 20);
  }
});

test('path-scoped rules have valid YAML and match real files in this repo', () => {
  const projectFiles = [...walk(path.join(root, 'src')), ...walk(path.join(root, '.claude')),
    path.join(root, 'package.json')].map(file => path.relative(root, file).replace(/\\/g, '/'));
  for (const file of walk(path.join(root, '.claude/rules')).filter(file => file.endsWith('.md'))) {
    const config = document(file);
    assert.ok(Array.isArray(config.paths) && config.paths.length, file);
    assert.deepEqual(Object.keys(config), ['paths'], file);
    assert.ok(config.paths.some(pattern => projectFiles.some(candidate => match(candidate, pattern, { dot: true }))), `${file}: rules would never load`);
  }
});

test('shared configuration wires real hooks and contains no machine-specific directories', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.permissions.additionalDirectories, undefined);
  assert.doesNotMatch(JSON.stringify(settings), /towerhouse|C:\\\\Users|bypassPermissions/);
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse']) {
    assert.equal(settings.hooks[event].length, 1);
    const hook = settings.hooks[event][0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/project-hooks.cjs"');
    assert.ok(fs.existsSync(path.join(root, '.claude/hooks/project-hooks.cjs')));
    assert.ok(hook.timeout <= 15);
  }
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
});

test('root import, CI validation and local-file ignore policy remain connected', () => {
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:agents'], 'node --test .claude/hooks/config.test.cjs .claude/hooks/project-hooks.test.cjs');
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: pnpm test:agents/);
  yaml.load(ci);
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.doesNotMatch(ignore, /^\/?\.claude\/?\s*$/m);
  for (const local of ['.claude/settings.local.json', '.claude/worktrees/', 'CLAUDE.local.md']) assert.ok(ignore.includes(local), local);
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    assert.ok(fs.readFileSync(path.join(root, file), 'utf8').split('\n').length < 200, file);
  }
});
