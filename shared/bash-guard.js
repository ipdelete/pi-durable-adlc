import { fileURLToPath } from 'node:url';
import treeSitter from '@vscode/tree-sitter-wasm';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';

const { Parser, Language } = treeSitter;
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(fileURLToPath(
  import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm'),
)));

const commands = new Set([
  'gh', 'jq', 'grep', 'rg', 'head', 'tail', 'sort', 'uniq', 'cut', 'tr', 'wc',
  'printf', 'echo', 'sed', 'awk',
]);
const ghCommands = new Set(['issue', 'api', 'pr', 'search', 'project', 'label', 'repo', 'help', '--help', '--version']);
const containers = new Set(['program', 'pipeline', 'list', 'command_name', 'string', 'concatenation']);
const leaves = new Set(['word', 'number', 'raw_string', 'string_content', 'variable_name', 'comment']);

// Only literal arguments count as executable names, gh subcommands, or helper programs.
function literal(node) {
  if (!node) return undefined;
  if (node.type === 'word' || node.type === 'number') return node.text.includes('\\') ? undefined : node.text;
  if (node.type === 'raw_string') return node.text.slice(1, -1);
  if (node.type === 'string' && node.namedChildren.every((child) => child.type === 'string_content')) {
    const text = node.text.slice(1, -1);
    return text.includes('\\') ? undefined : text;
  }
  return undefined;
}

function checkCommand(node) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode?.text;
  if (!commands.has(name)) return `Executable ${name ?? '(dynamic)'} is not allowed`;
  if (node.namedChildren.some((child) => child.type === 'variable_assignment')) {
    return 'Environment assignments on commands are not allowed';
  }
  const args = node.childrenForFieldName('argument');
  if (name === 'gh' && !ghCommands.has(literal(args[0]))) {
    return 'Use a literal built-in gh subcommand; aliases and extensions are not allowed';
  }
  if (name === 'printf') {
    const format = literal(args[0]);
    if (format === undefined || format.startsWith('-') || /%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?n/.test(format)) {
      return 'printf requires a literal format without options or %n';
    }
  }
  if (name === 'sed') {
    const values = args.map(literal);
    if (values[0] === '-n') values.shift();
    // One print/range or substitution script, stdin only. No e/r/w, script files, or in-place edits.
    const print = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?p$/;
    const substitute = /^s\/((?:[^/\\\n]|\\.)*)\/((?:[^/\\\n]|\\.)*)\/[gI0-9]*$/;
    if (values.length !== 1 || values[0] === undefined ||
        (!print.test(values[0]) && !substitute.test(values[0]))) {
      return 'sed supports one literal print/range or s/old/new/g script on stdin';
    }
  }
  if (name === 'awk' && (args.length !== 1 || !/^\{\s*print\s+\$\d+(?:\s*,\s*\$\d+)*\s*;?\s*\}$/.test(literal(args[0]) ?? ''))) {
    return 'awk supports only a literal {print $N} field-selection script on stdin';
  }
  // These helpers have options that launch programs. Keep their option surface explicit.
  if (name === 'rg' || name === 'sort') {
    const flags = name === 'rg' ? /^-[ivnclowFxqUH]+$/ : /^-[runfhVMbds]+$/;
    const longFlags = name === 'rg' ? new Set(['--ignore-case', '--fixed-strings', '--line-number', '--count', '--color=never']) : new Set(['--unique', '--reverse', '--numeric-sort']);
    for (const arg of args) {
      const value = literal(arg);
      if (value === undefined || (value.startsWith('-') && value !== '--' && !flags.test(value) && !longFlags.has(value))) {
        return `${name} requires literal arguments and supported filtering/sorting options`;
      }
    }
  }
}

function checkNode(node) {
  if (node.isMissing || node.hasError) return 'Invalid or unsupported Bash syntax';
  // Named nodes omit operators such as &, so inspect those tokens too.
  if (!node.isNamed) {
    if (node.type === '&' || node.type === '|&') return 'Background jobs and stderr pipelines are not allowed';
    return;
  }
  if (leaves.has(node.type)) return;
  if (node.type === 'command') {
    const reason = checkCommand(node);
    if (reason) return reason;
  } else if (node.type === 'variable_assignment') {
    if (!/^[a-z][a-z0-9_]*$/.test(node.childForFieldName('name')?.text ?? '')) {
      return 'Use simple lowercase variables; shell environment variables cannot be assigned';
    }
  } else if (node.type === 'command_substitution') {
    if (!node.text.startsWith('$(')) return 'Use $(...) instead of backticks';
  } else if (node.type === 'simple_expansion') {
    return;
  } else if (node.type === 'expansion') {
    if (!/^\$\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(node.text)) return 'Only simple ${variable} expansions are supported';
    return;
  } else if (node.type === 'redirected_statement') {
    // Its body and redirections are checked below.
  } else if (node.type === 'file_redirect') {
    if (!/^(?:[12])?\s*>\s*\/dev\/null$|^2\s*>&\s*1$/.test(node.text)) {
      return 'File redirections are limited to /dev/null and 2>&1; use pipes or quoted heredocs';
    }
    return;
  } else if (node.type === 'heredoc_redirect') {
    const start = node.namedChildren.find((child) => child.type === 'heredoc_start');
    if (!/^'[a-zA-Z_][a-zA-Z0-9_]*'$/.test(start?.text ?? '')) return 'Use a single-quoted heredoc delimiter';
    return; // A quoted heredoc is literal data, not executable shell syntax.
  } else if (!containers.has(node.type)) {
    return `Bash construct ${node.type} is not allowed`;
  }
  for (const child of node.children) {
    const reason = checkNode(child);
    if (reason) return reason;
  }
}

export function checkShellCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return { allowed: false, reason: 'Provide a Bash command' };
  let tree;
  try {
    tree = parser.parse(command);
    const reason = checkNode(tree.rootNode);
    return reason ? { allowed: false, reason } : { allowed: true };
  } catch {
    return { allowed: false, reason: 'Could not parse the Bash command' };
  } finally {
    tree?.delete();
  }
}

export const BashGuard = defineExtension({
  name: 'github-bash-guard',
  hooks: [hook(ToolTask, {
    beforeTool(call) {
      if (call.name !== 'bash') return;
      const verdict = checkShellCommand(call.arguments?.command);
      if (!verdict.allowed) return { block: verdict.reason };
    },
  })],
});
