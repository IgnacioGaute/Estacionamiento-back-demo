'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { broadStaging, handle } = require('./project-hooks.cjs');

test('rejects broad staging and implicit commit staging, including combined commands', () => {
  for (const command of [
    'git add -A', 'git add .', 'git add --all', 'git add -u', 'git add -Av',
    'git add -- .', 'git add ":/"', 'git add "*"', 'git add ./*', "git add . ':!secret'",
    'git -C "C:/repo con espacios" add --all', 'git -c core.autocrlf=false add .',
    'git status && git add -A', 'git status; git.exe add .', 'git commit -am "fix"',
    'git commit --all -m "fix"', 'git commit -a',
  ]) assert.equal(broadStaging(command), true, command);
});

test('keeps explicit paths, read-only Git commands and ordinary commits available', () => {
  for (const command of [
    'git add -- src/example.ts test/example.test.cjs', 'git add "docs/file with spaces.md"',
    'git status --short', 'git diff --cached', 'git commit -m "change"',
    'git commit --amend --no-edit', 'git commit -m "-a"', 'git commit --message="a change"',
    'git commit -Sabc -m "change"', 'git commit -ma-message',
    'pnpm test', 'node --test .claude/hooks/project-hooks.test.cjs',
  ]) assert.equal(broadStaging(command), false, command);
});

test('blocked commands return deny; allowed commands never override normal permissions', () => {
  for (const tool_name of ['Bash', 'PowerShell']) {
    const result = handle({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command: 'git add -A' } });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(handle({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command: 'git add -- README.md' } }), null);
  }
});

test('session and edit hooks inspect the active checkout, without changing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-hooks-'));
  try {
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    fs.writeFileSync(path.join(root, 'existing.txt'), 'existing work\n');
    // SessionStart handles unborn branches through its explicit diagnostic.
    const start = handle({ hook_event_name: 'SessionStart', cwd: root });
    assert.match(start.hookSpecificOutput.additionalContext, /Git|Cambios/);
    const edit = file_path => handle({ hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path } });
    assert.match(edit(path.join(root, 'src/database/migrations/123-example.ts')).hookSpecificOutput.additionalContext, /database.config/);
    assert.match(edit(path.join(root, 'src/tickets/tickets.controller.ts')).hookSpecificOutput.additionalContext, /endpoint-policy/);
    assert.equal(edit(path.join(root, 'src/tickets/tickets.service.ts')), null);
    assert.equal(edit(path.join(root, '../outside/src/database/migrations/123.ts')), null);
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'existing work\n');
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', 'existing.txt']);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^parking-hooks-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI reads stdin JSON and reports malformed input without printing payloads', () => {
  const script = path.join(__dirname, 'project-hooks.cjs');
  const good = spawnSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add -A' } }), encoding: 'utf8', windowsHide: true });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const bad = spawnSync(process.execPath, [script], { input: '{', encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
});
