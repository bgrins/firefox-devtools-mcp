#!/usr/bin/env node
import {
  launch,
  listInstances,
  readLog,
  resolveInstance,
  stop,
} from '../lib/instances.mjs';
import {
  callTool,
  findInSnapshot,
  listTools,
  printResult,
  TOOL_COMMANDS,
} from '../lib/mcp.mjs';

const VALUE_FLAGS = new Set([
  'instance',
  'binary',
  'profile',
  'selector',
  'timeout',
  'lines',
  'context',
]);

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (VALUE_FLAGS.has(arg.slice(2))) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg === '-i') {
      flags.instance = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function help() {
  const lines = [
    'firefox-cli - drive Firefox from the terminal via firefox-devtools-mcp',
    '',
    'Usage: firefox-cli <command> [args] [--instance <id>] [--json]',
    '',
    'Instances:',
    '  launch [--headless] [--binary <path>] [--profile <path>]',
    '                              launch a Firefox instance (prints instance id)',
    '  servers                     list instances',
    '  stop [--instance <id>]      stop an instance',
    '  logs [--lines <n>]          print runner log tail',
    '',
    'Tools:',
  ];
  for (const [name, cmd] of Object.entries(TOOL_COMMANDS)) {
    lines.push(`  ${cmd.usage.padEnd(27)} ${cmd.describe}`);
  }
  lines.push(
    '  find <text> [--regex] [--context <n>]',
    '                              search the snapshot, print matches with context',
    "  call <tool> [json-args]     call any MCP tool, e.g. call take_snapshot '{}'",
    '  tools                       list available MCP tools',
    '',
    'The selected instance is the single running one unless --instance is given.'
  );
  return lines.join('\n');
}

async function main() {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command || flags.help || command === 'help') {
    console.log(help());
    return 0;
  }

  if (command === 'launch') {
    const inst = await launch(flags);
    console.log(`instance: ${inst.id}`);
    console.log(`endpoint: ${inst.discovery.endpoint}`);
    console.log(`pid: ${inst.runnerPid}`);
    return 0;
  }

  if (command === 'servers') {
    const instances = listInstances();
    if (!instances.length) {
      console.log('(no instances)');
      return 0;
    }
    for (const inst of instances) {
      console.log(
        `${inst.id}  ${inst.status.padEnd(8)}  pid=${inst.runnerPid}  ${inst.discovery?.endpoint ?? ''}`
      );
    }
    return 0;
  }

  if (command === 'stop') {
    const inst = resolveInstance(flags);
    const wasRunning = await stop(inst);
    console.log(wasRunning ? `stopped ${inst.id}` : `${inst.id} was not running`);
    return 0;
  }

  if (command === 'logs') {
    const inst = resolveInstance(flags);
    console.log(readLog(inst, flags.lines ? Number(flags.lines) : undefined));
    return 0;
  }

  if (command === 'tools') {
    const inst = resolveInstance(flags);
    const tools = await listTools(inst.discovery.endpoint);
    for (const tool of tools) {
      console.log(`${tool.name.padEnd(28)} ${tool.description ?? ''}`);
    }
    return 0;
  }

  if (command === 'find') {
    const [pattern] = rest;
    if (!pattern) {
      throw new Error(
        "Usage: firefox-cli find <text> [--regex] [--context <n>]"
      );
    }
    const inst = resolveInstance(flags);
    const result = await findInSnapshot(inst.discovery.endpoint, pattern, flags);
    return printResult(result, flags);
  }

  if (command === 'call') {
    const [toolName, jsonArgs] = rest;
    if (!toolName) {
      throw new Error("Usage: firefox-cli call <tool> ['<json-args>']");
    }
    const inst = resolveInstance(flags);
    const result = await callTool(
      inst.discovery.endpoint,
      toolName,
      jsonArgs ? JSON.parse(jsonArgs) : {}
    );
    return printResult(result, flags);
  }

  const toolCommand = TOOL_COMMANDS[command];
  if (!toolCommand) {
    throw new Error(`Unknown command "${command}". Run firefox-cli --help`);
  }
  const inst = resolveInstance(flags);
  const result = await callTool(
    inst.discovery.endpoint,
    toolCommand.tool,
    toolCommand.build(rest, flags)
  );
  return printResult(result, flags);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
);
