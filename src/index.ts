import { version } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { log, logError, logDebug, setupLogFile, flushLogs } from './utils/logger.js';
import { parsePrefs, defaultProfileDir } from './cli.js';
import type { parseArguments } from './cli.js';
import { FirefoxDevTools } from './firefox/index.js';
import type { FirefoxLaunchOptions } from './firefox/types.js';
import * as tools from './tools/index.js';
import type { McpToolResponse } from './types/common.js';
import { errorResponse } from './utils/response-helpers.js';

type Args = ReturnType<typeof parseArguments>;

// Validate Node.js version
const [major] = version.substring(1).split('.').map(Number);
if (!major || major < 20) {
  console.error(`Node ${version} is not supported. Please use Node.js >=20.`);
  process.exit(1);
}

// Set by run() before the server starts; initialized to satisfy the type checker.
export let args = {} as Args;

// Global context (lazy initialized on first tool call)
let firefox: FirefoxDevTools | null = null;
let nextLaunchOptions: FirefoxLaunchOptions | null = null;
// Warning generated during Firefox startup, surfaced in the first tool response.
let pendingWarning: string | null = null;

/**
 * Reset Firefox instance (used when disconnection is detected).
 * Tries graceful close with a timeout; if it hangs (zombie geckodriver),
 * force-kills the process tree.
 */
export async function resetFirefox(): Promise<void> {
  if (firefox) {
    await firefox.close();
    firefox = null;
  }
  pendingWarning = null;
  log('Firefox instance reset - will reconnect on next tool call');
}

/**
 * Set options for the next Firefox launch
 * Used by restart_firefox tool to change configuration
 */
export function setNextLaunchOptions(options: FirefoxLaunchOptions): void {
  nextLaunchOptions = options;
  log('Next launch options updated');
}

/**
 * Check if Firefox is currently running (without auto-starting)
 */
export function isFirefoxRunning(): boolean {
  return firefox !== null;
}

/**
 * Get Firefox instance if running, null otherwise (no auto-start)
 */
export function getFirefoxIfRunning(): FirefoxDevTools | null {
  return firefox;
}

export async function getFirefox(): Promise<FirefoxDevTools> {
  // If we have an existing instance, verify it's still connected
  if (firefox) {
    const isConnected = await firefox.isConnected();
    if (!isConnected) {
      log('Firefox connection lost, reconnecting...');
      await resetFirefox();
    } else {
      return firefox;
    }
  }

  // No existing instance - create new connection
  log('Initializing Firefox DevTools connection...');

  let options: FirefoxLaunchOptions;

  // Use nextLaunchOptions if set (from restart_firefox tool)
  if (nextLaunchOptions) {
    options = nextLaunchOptions;
    nextLaunchOptions = null; // Clear after use
    log('Using custom launch options from restart_firefox');
  } else {
    // Parse environment variables from CLI args (format: KEY=VALUE)
    let envVars: Record<string, string> | undefined;
    if (args.env && Array.isArray(args.env) && args.env.length > 0) {
      envVars = {};
      for (const envStr of args.env as string[]) {
        const [key, ...valueParts] = envStr.split('=');
        if (key && valueParts.length > 0) {
          envVars[key] = valueParts.join('=');
        }
      }
    }

    // Parse preferences from CLI args
    const prefValues = parsePrefs(args.pref);
    const prefs = Object.keys(prefValues).length > 0 ? prefValues : undefined;

    options = {
      firefoxPath: args.firefoxPath ?? undefined,
      headless: args.headless,
      profilePath:
        args.profilePath ?? (args.autoProfile ? defaultProfileDir(args.firefoxPath) : undefined),
      viewport: args.viewport ?? undefined,
      args: (args.firefoxArg as string[] | undefined) ?? undefined,
      startUrl: args.startUrl ?? undefined,
      acceptInsecureCerts: args.acceptInsecureCerts,
      connectExisting: args.connectExisting,
      marionettePort: args.marionettePort,
      env: envVars,
      logFile: args.outputFile ?? undefined,
      prefs,
      androidDevice: args.androidDevice ?? undefined,
      androidPackage: args.androidPackage ?? undefined,
    };
  }

  firefox = new FirefoxDevTools(options);
  try {
    await firefox.connect();
    log('Firefox DevTools connection established');
    pendingWarning = firefox.getAndClearProfileWarning();
    return firefox;
  } catch (error) {
    // Clean up before discarding — ensures the geckodriver process is killed
    // and the Marionette session is released. Without this, a failure during
    // BiDi setup (after the WebDriver session is already established) would
    // leave geckodriver running with an active Marionette session, causing
    // "Connection attempt denied because an active session has been found"
    // on the next connect attempt.
    await firefox.close();
    firefox = null;
    throw error;
  }
}

export async function run(
  parseArgsFn: (version: string) => Args,
  importMetaUrl: string
): Promise<void> {
  // Only run if this entry file is executed directly (not imported as a library).
  // We need to normalize both paths to handle different execution contexts (npx, node, etc.)
  const modulePath = fileURLToPath(importMetaUrl);
  const scriptPath = process.argv[1] ? resolve(process.argv[1]) : '';
  let isMainModule = false;
  try {
    const realModulePath = realpathSync(modulePath);
    const realScriptPath = scriptPath ? realpathSync(scriptPath) : '';
    isMainModule = realModulePath === realScriptPath;
  } catch {
    isMainModule = modulePath === scriptPath;
  }
  if (!isMainModule) {
    return;
  }

  args = parseArgsFn(SERVER_VERSION);

  if (args.logFile) {
    setupLogFile(args.logFile);
  }

  // Tool handler mapping
  const toolHandlers = new Map<string, (input: unknown) => Promise<McpToolResponse>>([
    // Pages
    ['list_pages', tools.handleListPages],
    ['new_page', tools.handleNewPage],
    ['navigate_page', tools.handleNavigatePage],
    ['select_page', tools.handleSelectPage],
    ['close_page', tools.handleClosePage],

    // Console
    ['list_console_messages', tools.handleListConsoleMessages],
    ['clear_console_messages', tools.handleClearConsoleMessages],

    // Network
    ['list_network_requests', tools.handleListNetworkRequests],
    ['get_network_request', tools.handleGetNetworkRequest],

    // Snapshot
    ['take_snapshot', tools.handleTakeSnapshot],
    ['resolve_uid_to_selector', tools.handleResolveUidToSelector],
    ['clear_snapshot', tools.handleClearSnapshot],

    // Input
    ['click_by_uid', tools.handleClickByUid],
    ['hover_by_uid', tools.handleHoverByUid],
    ['fill_by_uid', tools.handleFillByUid],
    ['drag_by_uid_to_uid', tools.handleDragByUidToUid],
    ['fill_form_by_uid', tools.handleFillFormByUid],
    ['upload_file_by_uid', tools.handleUploadFileByUid],

    // Screenshot
    ['screenshot_page', tools.handleScreenshotPage],
    ['screenshot_by_uid', tools.handleScreenshotByUid],

    // Utilities
    ['accept_dialog', tools.handleAcceptDialog],
    ['dismiss_dialog', tools.handleDismissDialog],
    ['navigate_history', tools.handleNavigateHistory],
    ['set_viewport_size', tools.handleSetViewportSize],

    // Firefox Management
    ['get_firefox_output', tools.handleGetFirefoxLogs],
    ['get_firefox_info', tools.handleGetFirefoxInfo],
    ['restart_firefox', tools.handleRestartFirefox],

    // WebExtensions (install/uninstall use standard BiDi, no privileged context required)
    ['install_extension', tools.handleInstallExtension],
    ['uninstall_extension', tools.handleUninstallExtension],

    // Profiler
    ['profiler_is_active', tools.handleProfilerIsActive],
    ['profiler_start', tools.handleProfilerStart],
    ['profiler_stop', tools.handleProfilerStop],

    // Script evaluation — requires --enable-script
    ...(args.enableScript ? ([['evaluate_script', tools.handleEvaluateScript]] as const) : []),

    // Debugging tools — requires --enable-script
    ...(args.enableScript
      ? ([
          ['enable_debugger', tools.handleEnableDebugger],
          ['list_scripts', tools.handleListScripts],
          ['get_script_source', tools.handleGetScriptSource],
          ['set_logpoint', tools.handleSetLogpoint],
          ['remove_logpoint', tools.handleRemoveLogpoint],
          ['get_logpoint_results', tools.handleGetLogpointResults],
        ] as const)
      : []),

    // Privileged context tools — requires --enable-privileged-context
    ...(args.enablePrivilegedContext
      ? ([
          ['list_privileged_contexts', tools.handleListPrivilegedContexts],
          ['select_privileged_context', tools.handleSelectPrivilegedContext],
          ['evaluate_privileged_script', tools.handleEvaluatePrivilegedScript],
          ['set_firefox_prefs', tools.handleSetFirefoxPrefs],
          ['get_firefox_prefs', tools.handleGetFirefoxPrefs],
          ['list_extensions', tools.handleListExtensions],
        ] as const)
      : []),
  ]);

  // All tool definitions
  const allTools = [
    // Pages
    tools.listPagesTool,
    tools.newPageTool,
    tools.navigatePageTool,
    tools.selectPageTool,
    tools.closePageTool,

    // Console
    tools.listConsoleMessagesTool,
    tools.clearConsoleMessagesTool,

    // Network
    tools.listNetworkRequestsTool,
    tools.getNetworkRequestTool,

    // Snapshot
    tools.takeSnapshotTool,
    tools.resolveUidToSelectorTool,
    tools.clearSnapshotTool,

    // Input
    tools.clickByUidTool,
    tools.hoverByUidTool,
    tools.fillByUidTool,
    tools.dragByUidToUidTool,
    tools.fillFormByUidTool,
    tools.uploadFileByUidTool,

    // Screenshot
    tools.screenshotPageTool,
    tools.screenshotByUidTool,

    // Utilities
    tools.acceptDialogTool,
    tools.dismissDialogTool,
    tools.navigateHistoryTool,
    tools.setViewportSizeTool,

    // Firefox Management
    tools.getFirefoxLogsTool,
    tools.getFirefoxInfoTool,
    tools.restartFirefoxTool,

    // WebExtensions (install/uninstall use standard BiDi, no privileged context required)
    tools.installExtensionTool,
    tools.uninstallExtensionTool,

    // Profiler
    tools.profilerIsActiveTool,
    tools.profilerStartTool,
    tools.profilerStopTool,

    // Script evaluation — requires --enable-script
    ...(args.enableScript ? [tools.evaluateScriptTool] : []),

    // Debugging tools — requires --enable-script
    ...(args.enableScript
      ? [
          tools.enableDebuggerTool,
          tools.listScriptsTool,
          tools.getScriptSourceTool,
          tools.setLogpointTool,
          tools.removeLogpointTool,
          tools.getLogpointResultsTool,
        ]
      : []),

    // Privileged context tools — requires --enable-privileged-context
    ...(args.enablePrivilegedContext
      ? [
          tools.listPrivilegedContextsTool,
          tools.selectPrivilegedContextTool,
          tools.evaluatePrivilegedScriptTool,
          tools.setFirefoxPrefsTool,
          tools.getFirefoxPrefsTool,
          tools.listExtensionsTool,
        ]
      : []),
  ];

  log(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  log(`Node.js ${version}`);

  // Log configuration
  logDebug(`Configuration:`);
  logDebug(`  Headless: ${args.headless}`);
  if (args.firefoxPath) {
    logDebug(`  Firefox Path: ${args.firefoxPath}`);
  }
  if (args.viewport) {
    logDebug(`  Viewport: ${args.viewport.width}x${args.viewport.height}`);
  }

  /**
   * Build a configured MCP Server. HTTP mode creates one per session (a
   * transport supports a single session); they all share the module-level
   * Firefox facade.
   */
  function createServer(): Server {
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      log('Listing available tools');
      return {
        tools: allTools,
      };
    });

    // Handle tool execution
    server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;
      log(`Executing tool: ${name}`);

      const handler = toolHandlers.get(name);
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }

      try {
        const result = await handler(args);
        if (pendingWarning) {
          // Return as isError so that agents acting as MCP clients (e.g. Claude)
          // surface the message to the user.
          // Also note the operation completed so the agent does not retry.
          const operationNote =
            result.content[0]?.type === 'text'
              ? `\n\n[Note: The operation also completed — ${result.content[0].text}]`
              : '';
          const warning = pendingWarning;
          pendingWarning = null;
          return errorResponse(`${warning}${operationNote}`);
        }
        return result;
      } catch (error) {
        logError(`Error executing tool ${name}`, error);
        throw error;
      }
    });

    // List resources (not implemented for this server)
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return { resources: [] };
    });

    // Read resource (not implemented for this server)
    server.setRequestHandler(ReadResourceRequestSchema, async () => {
      throw new Error('Resource reading not implemented');
    });

    return server;
  }

  if (args.httpPort !== undefined) {
    await startHttpTransport(createServer, args.httpPort, args.discoveryFile);
    return;
  }
  if (args.discoveryFile) {
    logError('--discovery-file requires --http-port; ignoring');
  }

  const server = createServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('Firefox DevTools MCP server running on stdio');
  log('Ready to accept tool requests');

  // Clean up the Marionette session so Firefox accepts new connections.
  // Without this, the session stays locked after the MCP client disconnects.
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) {
      return;
    }
    cleaningUp = true;
    await resetFirefox();
    await server.close();
    await flushLogs().catch(() => {});
    process.exit(0);
  };
  const onSignal = () => void cleanup();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  // StdioServerTransport does not fire onclose on stdin EOF.
  process.stdin.on('end', onSignal);
  process.stdin.on('close', onSignal);
}

/**
 * Serve MCP over streamable HTTP on 127.0.0.1 (same wire contract as the
 * in-browser server in Firefox: MCP at /mcp plus an optional discovery file),
 * so clients written against that contract work with either backend.
 *
 * One transport + Server per MCP session (the SDK's canonical pattern);
 * sessions share the global Firefox facade, so one-shot CLI invocations see
 * persistent browser state.
 */
async function startHttpTransport(
  buildServer: () => Server,
  requestedPort: number,
  discoveryFile: string | undefined
): Promise<void> {
  const httpServer = http.createServer();
  await new Promise<void>((resolvePort, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, '127.0.0.1', () => resolvePort());
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if ((req.url ?? '').split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (!transport) {
      // New session (the transport rejects anything but an initialize request
      // for an unknown session). The cast works around the SDK's Transport
      // typings being incompatible with exactOptionalPropertyTypes.
      const sessionTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        onsessioninitialized: (sid) => {
          transports.set(sid, sessionTransport);
        },
      });
      sessionTransport.onclose = () => {
        if (sessionTransport.sessionId) {
          transports.delete(sessionTransport.sessionId);
        }
      };
      const sessionServer = buildServer();
      await sessionServer.connect(
        sessionTransport as unknown as Parameters<typeof sessionServer.connect>[0]
      );
      transport = sessionTransport;
    }
    await transport.handleRequest(req, res);
  };

  httpServer.on('request', (req, res) => {
    handleHttp(req, res).catch((error: unknown) => {
      logError('HTTP transport request failed', error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  let removeDiscoveryFile: (() => Promise<void>) | null = null;
  if (discoveryFile) {
    await fsPromises.writeFile(
      discoveryFile,
      JSON.stringify({
        port,
        endpoint: `http://127.0.0.1:${port}/mcp`,
        pid: process.pid,
        auth: 'none',
      }),
      { mode: 0o600 }
    );
    removeDiscoveryFile = () => fsPromises.unlink(discoveryFile).catch(() => {});
    // Self-terminate if the discovery file disappears: the launcher owns that
    // file, so its removal means our state dir was cleaned up (or the launcher
    // died and something swept it). Prevents orphaned detached runners.
    const watchdog = setInterval(() => {
      fsPromises.access(discoveryFile).catch(() => {
        clearInterval(watchdog);
        removeDiscoveryFile = null;
        log('Discovery file removed externally; shutting down.');
        void cleanup();
      });
    }, 5000);
    watchdog.unref();
  }

  log(`Firefox DevTools MCP server running on http://127.0.0.1:${port}/mcp`);
  log('Ready to accept tool requests');

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) {
      return;
    }
    cleaningUp = true;
    await removeDiscoveryFile?.();
    await resetFirefox();
    for (const transport of transports.values()) {
      await transport.close().catch(() => {});
    }
    httpServer.close();
    await flushLogs().catch(() => {});
    process.exit(0);
  };
  const onSignal = () => void cleanup();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
