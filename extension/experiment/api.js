"use strict";

/* global ExtensionAPI, ExtensionCommon, Services */

// `browser.bidi`: drives the Remote Agent's WebDriver BiDi modules in-process and
// hosts a loopback-only HTTP listener so the addon can serve MCP directly (no
// external relay process).
//
// Key mozilla-central entry points:
//  - handleCommand({moduleName, commandName, params, destination}): remote/shared/messagehandler/MessageHandler.sys.mjs
//  - WebDriverSession / protocol events ("message-handler-protocol-event"): remote/shared/webdriver/Session.sys.mjs

const { EventManager } = ExtensionCommon;
const { ExtensionError } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
).ExtensionUtils;

// Experiment sandboxes don't expose WebIDL globals like TextDecoder/TextEncoder by default.
Cu.importGlobalProperties(["TextDecoder", "TextEncoder"]);

// The extension API layer replaces non-ExtensionError exceptions with a generic
// "An unexpected error occurred" — wrap so real messages reach the caller (and the
// chrome console, which test harness runs pipe to stdout).
function surfaced(label, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(`bidi experiment: ${label} failed:`, e);
      throw new ExtensionError(`${label}: ${e?.message ?? e}`);
    }
  };
}

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  // DOM timers aren't globals in experiment scopes (same story as TextDecoder).
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  RootMessageHandler:
    "chrome://remote/content/shared/messagehandler/RootMessageHandler.sys.mjs",
  WebDriverSession: "chrome://remote/content/shared/webdriver/Session.sys.mjs",
});

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function bytesToString(bytes) {
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
}

function stringToByteString(str) {
  const encoded = new TextEncoder().encode(str);
  let out = "";
  for (const b of encoded) {
    out += String.fromCharCode(b);
  }
  return out;
}

// Parse one HTTP/1.1 request from an accumulated byte-string buffer.
// Returns null if incomplete.
function tryParseHttpRequest(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return buffer.length > MAX_REQUEST_BYTES ? { error: 431 } : null;
  }
  const head = buffer.slice(0, headerEnd).split("\r\n");
  const [method, path] = head[0].split(" ");
  const headers = {};
  for (const line of head.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  if (headers["transfer-encoding"]) {
    return { error: 501 };
  }
  const clRaw = headers["content-length"] ?? "0";
  if (!/^\d+$/.test(clRaw)) {
    return { error: 400 };
  }
  const contentLength = parseInt(clRaw, 10);
  if (contentLength > MAX_REQUEST_BYTES) {
    return { error: 413 };
  }
  const total = headerEnd + 4 + contentLength;
  if (buffer.length < total) {
    return null;
  }
  return {
    method,
    path,
    headers,
    body: bytesToString(buffer.slice(headerEnd + 4, total)),
    byteLength: total,
  };
}

this.bidi = class extends ExtensionAPI {
  #handler;
  #serverSocket = null;
  #pendingResponses = new Map(); // requestId -> connection
  #nextRequestId = 1;
  #fireHttpRequest = null;
  // Strong references to live connections — without this the transport/streams can be
  // GC'd mid-request, which surfaces as "Empty reply from server".
  #liveConnections = new Set();

  onStartup() {}

  onShutdown() {
    try {
      this.#stopServer();
      // Session.destroy() tears down the message handler, process actor and tracking.
      this.#session?.destroy();
      this.#session = null;
      this.#handler = null;
    } catch (e) {
      console.error("bidi experiment: cleanup failed", e);
    }
  }

  #session = null;

  // Create a REAL WebDriverSession (BiDi flavor, no connection) rather than a bare
  // RootMessageHandler: several BiDi paths call
  // getWebDriverSessionById(messageHandler.sessionId) and throw on a bare handler —
  // node serialization (breaks input.setFiles) and browsingContext's #onPromptOpened
  // (silently swallows userPromptOpened). The session also sets up the process actor
  // and navigable/window tracking.
  //
  // unhandledPromptBehavior "ignore": dialogs stay OPEN and emit userPromptOpened —
  // the addon's policy is report-and-let-the-agent-decide, never silent auto-answer.
  #getHandler() {
    if (!this.#handler) {
      // Capabilities.fromJSON takes FLAT capabilities (no alwaysMatch wrapper —
      // matching happens earlier in the real session-creation flow).
      this.#session = new lazy.WebDriverSession(
        { unhandledPromptBehavior: { default: "ignore" } },
        new Set([lazy.WebDriverSession.SESSION_FLAG_BIDI])
      );
      this.#handler = this.#session.messageHandler;
    }
    return this.#handler;
  }

  #respond(connection, status, headers, body) {
    const statusText = { 200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 431: "Request Header Fields Too Large", 501: "Not Implemented", 503: "Service Unavailable" }[status] ?? "OK";
    const bodyBytes = stringToByteString(body ?? "");
    const keepAlive = connection.keepAlive;
    const lines = [
      `HTTP/1.1 ${status} ${statusText}`,
      `Content-Length: ${bodyBytes.length}`,
      `Connection: ${keepAlive ? "keep-alive" : "close"}`,
    ];
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v)) || /^(content-length|connection)$/i.test(k)) {
        continue; // header-injection / framing guard
      }
      lines.push(`${k}: ${v}`);
    }
    const response = lines.join("\r\n") + "\r\n\r\n" + bodyBytes;
    try {
      // Output stream is opened OPEN_BLOCKING, so this writes fully or throws.
      connection.output.write(response, response.length);
    } catch (e) {
      console.error("bidi experiment: response write failed", e);
      this.#closeConnection(connection);
      return;
    }
    if (keepAlive) {
      connection.busy = false;
      this.#armIdleTimer(connection);
      // A pipelined follow-up request may already be fully buffered — parsing only
      // happens on new socket data otherwise, which would stall it until the idle kill.
      this.#processBuffer(connection);
    } else {
      this.#closeConnection(connection);
    }
  }

  // Parse and dispatch at most one request from the connection's buffer.
  #processBuffer(connection) {
    if (connection.busy || !this.#liveConnections.has(connection)) return;
    const parsed = tryParseHttpRequest(connection.buffer);
    if (parsed == null) return;
    if (parsed.error) {
      connection.keepAlive = false;
      this.#respond(connection, parsed.error, {}, "");
      return;
    }
    connection.buffer = connection.buffer.slice(parsed.byteLength);
    connection.keepAlive =
      (parsed.headers["connection"] ?? "keep-alive").toLowerCase() !== "close";
    if (!this.#fireHttpRequest) {
      this.#respond(connection, 503, { "Content-Type": "text/plain" }, "addon not ready");
      return;
    }
    connection.busy = true;
    // Re-arm on dispatch: the deadline bounds THIS request's handling, not time since
    // the previous response.
    this.#armIdleTimer(connection);
    const id = this.#nextRequestId++;
    this.#pendingResponses.set(id, connection);
    this.#fireHttpRequest({
      id,
      method: parsed.method,
      path: parsed.path,
      headers: parsed.headers,
      body: parsed.body,
    });
  }

  #armIdleTimer(connection) {
    if (connection.idleTimer) lazy.clearTimeout(connection.idleTimer);
    connection.idleTimer = lazy.setTimeout(() => {
      for (const [id, pending] of this.#pendingResponses) {
        if (pending === connection) this.#pendingResponses.delete(id);
      }
      this.#closeConnection(connection);
    }, 65000);
  }

  #closeConnection(connection) {
    this.#liveConnections.delete(connection);
    // Sweep any map entries pointing at this connection (peer-close mid-request).
    for (const [id, pending] of this.#pendingResponses) {
      if (pending === connection) this.#pendingResponses.delete(id);
    }
    if (connection.idleTimer) {
      lazy.clearTimeout(connection.idleTimer);
      connection.idleTimer = null;
    }
    try { connection.input?.close(); } catch {}
    try { connection.output?.close(); } catch {}
  }

  #onSocketAccepted(transport) {
    const connection = {
      transport, input: null, output: null, idleTimer: null,
      buffer: "", keepAlive: true, busy: false,
    };
    this.#liveConnections.add(connection);
    connection.input = transport
      .openInputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncInputStream);
    // OPEN_BLOCKING: write() completes fully or throws — avoids silent truncation of
    // large responses (screenshots) on a non-blocking socket stream.
    connection.output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
    const { input } = connection;
    const bin = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
      Ci.nsIBinaryInputStream
    );
    bin.setInputStream(input);

    // Stalled clients (or a background script that never answers) must not leak
    // connections forever.
    this.#armIdleTimer(connection);

    const readMore = () => {
      input.asyncWait(
        {
          onInputStreamReady: () => {
            try {
              let available;
              try {
                available = input.available();
              } catch {
                // Stream closed by peer.
                this.#closeConnection(connection);
                return;
              }
              if (available > 0) {
                connection.buffer += bin.readBytes(available);
              }
              // Cap applies even while busy — a client streaming bytes must not grow
              // the buffer unboundedly.
              if (connection.buffer.length > MAX_REQUEST_BYTES * 2) {
                this.#closeConnection(connection);
                return;
              }
              // Dispatch at most one request at a time per connection (streamable HTTP
              // clients pipeline sequentially; simpler and safe).
              this.#processBuffer(connection);
              if (this.#liveConnections.has(connection)) {
                readMore();
              }
            } catch (e) {
              console.error("bidi experiment: request handling failed", e);
              this.#closeConnection(connection);
            }
          },
        },
        0,
        0,
        Services.tm.currentThread
      );
    };
    readMore();
  }

  #startServer(port) {
    if (this.#serverSocket) {
      return this.#serverSocket.port;
    }
    const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(
      Ci.nsIServerSocket
    );
    // loopbackOnly=true: only 127.0.0.1 can connect.
    socket.init(port, true, -1);
    socket.asyncListen({
      onSocketAccepted: (_socket, transport) => {
        try {
          this.#onSocketAccepted(transport);
        } catch (e) {
          console.error("bidi experiment: accept failed", e);
        }
      },
      onStopListening: () => {},
    });
    this.#serverSocket = socket;
    return socket.port;
  }

  #stopServer() {
    this.#serverSocket?.close();
    this.#serverSocket = null;
    this.#pendingResponses.clear();
    for (const connection of [...this.#liveConnections]) {
      this.#closeConnection(connection);
    }
  }

  getAPI(context) {
    const send = async (moduleName, commandName, params) => {
      const handler = this.#getHandler();
      const result = await handler.handleCommand({
        moduleName,
        commandName,
        params: params ?? {},
        destination: { type: lazy.RootMessageHandler.type },
      });
      return JSON.parse(JSON.stringify(result ?? null));
    };

    return {
      bidi: {
        send: surfaced("send", send),

        subscribe(events, contexts) {
          const params = { events };
          if (contexts?.length) {
            params.contexts = contexts;
          }
          return send("session", "subscribe", params);
        },

        unsubscribe(events) {
          return send("session", "unsubscribe", { events });
        },

        startServer: surfaced("startServer", async (port) => this.#startServer(port)),

        stopServer: surfaced("stopServer", async () => this.#stopServer()),

        sendHttpResponse: async (requestId, status, headers, body) => {
          const connection = this.#pendingResponses.get(requestId);
          if (!connection) {
            throw new Error(`No pending HTTP request with id ${requestId}`);
          }
          this.#pendingResponses.delete(requestId);
          this.#respond(connection, status, headers ?? {}, body ?? "");
        },

        // Pref access for the firefox-prefs tools (the Node server needs privileged
        // BiDi mode for this; the experiment is already privileged).
        getPref: surfaced("getPref", async (name) => {
          switch (Services.prefs.getPrefType(name)) {
            case Services.prefs.PREF_BOOL: return { type: "boolean", value: Services.prefs.getBoolPref(name) };
            case Services.prefs.PREF_INT: return { type: "number", value: Services.prefs.getIntPref(name) };
            case Services.prefs.PREF_STRING: return { type: "string", value: Services.prefs.getStringPref(name) };
            default: return { type: "invalid", value: null };
          }
        }),

        setPref: surfaced("setPref", async (name, value) => {
          if (typeof value === "boolean") Services.prefs.setBoolPref(name, value);
          else if (typeof value === "number") Services.prefs.setIntPref(name, value);
          else Services.prefs.setStringPref(name, String(value));
        }),

        getAutostartConfig: async () => {
          // web-ext --pref values may land as bool/int/string depending on parsing;
          // read defensively.
          const readPref = (name) => {
            for (const getter of ["getBoolPref", "getIntPref", "getCharPref"]) {
              try {
                return Services.prefs[getter](name);
              } catch {}
            }
            return null;
          };
          const rawAutostart = readPref("extensions.bidibridge.autostart");
          const rawPort = readPref("extensions.bidibridge.port");
          return {
            autostart: rawAutostart === true || rawAutostart === "true",
            port: Number.parseInt(String(rawPort ?? ""), 10) || null,
          };
        },

        onEvent: new EventManager({
          context,
          name: "bidi.onEvent",
          register: (fire) => {
            const handler = this.#getHandler();
            const listener = (_eventName, wrappedEvent) => {
              try {
                fire.async(JSON.parse(JSON.stringify(wrappedEvent)));
              } catch (e) {
                console.error("bidi experiment: failed to forward event", e);
              }
            };
            handler.on("message-handler-protocol-event", listener);
            return () => {
              handler.off("message-handler-protocol-event", listener);
            };
          },
        }).api(),

        onHttpRequest: new EventManager({
          context,
          name: "bidi.onHttpRequest",
          register: (fire) => {
            // Last-wins by design (the background owns the server), but only null the
            // slot on unregister if it still holds OUR closure — otherwise a stale
            // context teardown would sever the live listener.
            const mine = (request) => fire.async(request);
            this.#fireHttpRequest = mine;
            return () => {
              if (this.#fireHttpRequest === mine) this.#fireHttpRequest = null;
            };
          },
        }).api(),
      },
    };
  }
};
