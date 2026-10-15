'use strict';

// No shell execution, network calls, credential reads or working-tree writes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 4000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024,
  }).trim();
}

// Tokenize ordinary Bash/PowerShell commands, preserving quoted arguments. This
// is an accidental-staging guard, not a shell interpreter or a security sandbox.
function tokens(command) {
  return (command.match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s;&|()]+|[;&|()]/g) || [])
    .map(token => /^(['"]).*\1$/s.test(token) ? token.slice(1, -1) : token);
}

function broadStaging(command) {
  const words = tokens(command);
  for (let i = 0; i < words.length; i++) {
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(words[i])) continue;
    let j = i + 1;
    // Common global Git options, including git -C "path with spaces" add ...
    while (j < words.length && words[j].startsWith('-')) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[j])) j += 2;
      else j++;
    }
    const operation = words[j++];
    if (operation !== 'add' && operation !== 'commit') continue;
    const args = [];
    while (j < words.length && !/^[;&|()]$/.test(words[j])) args.push(words[j++]);
    if (operation === 'add') {
      // Reject broad scopes even with exclusions: another session may add a file.
      let afterSeparator = false;
      for (const arg of args) {
        if (arg === '--') { afterSeparator = true; continue; }
        if (!afterSeparator && (/^--(?:all|update)(?:=|$)/.test(arg) || /^-[^-]*[Au]/.test(arg))) return true;
        if (['.', './', '.\\', '*', './*', '.\\*', ':/', ':', ':(top)', ':(top).', ':(top)*'].includes(arg)) return true;
      }
    } else {
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '--') break;
        if (['-m', '--message', '-F', '--file', '-C', '-c', '--reuse-message', '--reedit-message'].includes(args[k])) { k++; continue; }
        if (/^--all(?:=|$)/.test(args[k])) return true;
        if (/^-[^-]/.test(args[k])) {
          for (const flag of args[k].slice(1)) {
            if ('mFCcS'.includes(flag)) break; // Remainder is an option argument.
            if (flag === 'a') return true;
          }
        }
      }
    }
  }
  return false;
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function handle(input) {
  if (!input || typeof input !== 'object') throw new Error('Hook input must be an object');
  const event = input.hook_event_name;
  if (event === 'PreToolUse' && ['Bash', 'PowerShell'].includes(input.tool_name)) {
    const command = input.tool_input?.command;
    if (typeof command === 'string' && broadStaging(command)) {
      return { hookSpecificOutput: {
        hookEventName: event, permissionDecision: 'deny',
        permissionDecisionReason: 'Este proyecto comparte trabajo entre sesiones. Usá git add -- <archivos concretos>, revisá git diff --cached --name-only y luego git commit sin -a. No incluyas archivos ajenos a la tarea.',
      } };
    }
    // No "allow": the normal Claude permission checks still apply.
    return null;
  }
  if (event === 'SessionStart') {
    if (typeof input.cwd !== 'string' || !fs.existsSync(input.cwd)) return null;
    try {
      const root = git(input.cwd, ['rev-parse', '--show-toplevel']);
      const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const status = git(root, ['status', '--short', '--untracked-files=normal']);
      const lines = status ? status.split('\n') : [];
      return context(event, [
        `Repositorio: ${root}. Rama: ${branch}.`,
        lines.length ? `Cambios al comenzar (pueden ser ajenos):\n${lines.slice(0, 25).join('\n')}` : 'Árbol de trabajo limpio al comenzar.',
        lines.length > 25 ? `Hay ${lines.length} entradas; consultá git status para ver todas.` : '',
        'Conservá el trabajo existente. Si otra sesión va a editar el mismo repo, usá un worktree separado. Antes de un commit, staging por archivos explícitos.',
      ].filter(Boolean).join('\n'));
    } catch {
      return context(event, 'No pude consultar Git al iniciar. Revisá git status antes de editar; no asumas que el árbol está limpio.');
    }
  }
  if (event === 'PostToolUse' && ['Edit', 'Write', 'MultiEdit'].includes(input.tool_name)) {
    const file = input.tool_input?.file_path;
    if (typeof file !== 'string' || typeof input.cwd !== 'string') return null;
    let root;
    try { root = git(input.cwd, ['rev-parse', '--show-toplevel']); } catch { return null; }
    const relative = path.relative(root, path.resolve(input.cwd, file)).replace(/\\/g, '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) return null;
    if (/^src\/database\/migrations\/[^/]+\.ts$/.test(relative)) {
      return context(event, 'Migración editada: verificá el import y el array de src/config/database.config.ts, RLS/grants/triggers para datos tenant y una prueba con PostgreSQL temporal. Las migraciones se ejecutan al arrancar; no pruebes contra la base real.');
    }
    if (/^src\/(?:.*\/)?[^/]+\.controller\.ts$/.test(relative)) {
      return context(event, 'Contrato HTTP editado: revisá DTOs, endpoint-policy.ts (operadores y empresas suspendidas), consumidor frontend y pruebas de permisos. Si cambia el producto, actualizá docs y assistant/knowledge.ts cuando corresponda.');
    }
  }
  return null;
}

if (require.main === module) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Hook input exceeds 1 MiB');
    const output = handle(JSON.parse(raw));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    process.stderr.write('project-hooks: entrada inválida o error de ejecución; revisar el hook local.\n');
    // Fail visibly; this is not advertised as a fail-closed security boundary.
    process.exitCode = 1;
  }
}

module.exports = { broadStaging, handle };
