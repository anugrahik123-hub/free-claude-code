const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const SECRET = (process.env.BRIDGE_SECRET || "").trim();
const WEB_SEARCH_PROMPT = "You have live web search via Tavily MCP. For any question about events, releases, models, or facts after May 2025, always use Tavily web search instead of relying on your training cutoff.";

// Process crash protection - log but don't exit
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

function isAuthorized(authHeader = "") {
  if (!SECRET) return true;
  const expected = Buffer.from("Bearer " + SECRET);
  const actual = Buffer.from(String(authHeader));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, bridge: "claude-code-studio", port: PORT }));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("HTTP server error: Port " + PORT + " already in use");
  } else {
    console.error("HTTP server error:", err.message);
  }
});

const wss = new WebSocketServer({ server });
wss.on("error", (err) => console.error("WSS error:", err.message));

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function mapToolType(name = "") {
  const n = String(name).toLowerCase();
  if (n.includes("read")) return "ReadFile";
  if (n.includes("edit") || n.includes("replace")) return "EditFile";
  if (n.includes("write")) return "WriteFile";
  if (n.includes("grep") || n.includes("search")) return "SearchGrep";
  if (n.includes("glob")) return "Glob";
  return "RunBash";
}

wss.on("connection", (ws, req) => {
  if (!isAuthorized(req.headers.authorization)) {
    ws.close(1008, "Unauthorized");
    return;
  }

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });

  const shells = new Map();
  let activeClaude = null;
  let sessionState = { model: "", effort: "", permissionMode: "default", hasTurn: false };

  function getShell(tabId) {
    if (shells.has(tabId)) return shells.get(tabId);
    const sh = spawn("bash", ["--norc", "--noprofile"], {
      cwd: process.cwd(),
      env: { ...process.env, TERM: "dumb", FORCE_COLOR: "0" },
    });
    sh.stdout.on("data", (buf) => send(ws, { type: "pty_output", tabId, stream: "stdout", data: buf.toString("utf8") }));
    sh.stderr.on("data", (buf) => send(ws, { type: "pty_output", tabId, stream: "stderr", data: buf.toString("utf8") }));
    sh.on("error", (err) => {
      console.error("Shell error:", err.message);
      shells.delete(tabId);
    });
    sh.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") console.error("Shell stdin error:", err.message);
    });
    sh.on("exit", (code) => {
      shells.delete(tabId);
      send(ws, { type: "pty_output", tabId, stream: "stdout", data: "[shell exited: " + code + "]\n" });
    });
    shells.set(tabId, sh);
    return sh;
  }

  function runPrompt(msg) {
    if (activeClaude) {
      try { activeClaude.kill("SIGINT"); } catch {}
      // SIGKILL fallback after 2s if still alive
      setTimeout(() => {
        if (activeClaude && !activeClaude.killed) {
          try { activeClaude.kill("SIGKILL"); } catch {}
          activeClaude = null;
        }
      }, 2000);
      activeClaude = null;
    }
    const model = msg.model || sessionState.model;
    const permissionMode = msg.permissionMode || sessionState.permissionMode;
    const args = [
      "-p", String(msg.prompt || ""),
      "--output-format", "stream-json",
      "--verbose",
      "--append-system-prompt", WEB_SEARCH_PROMPT
    ];
    if (model) args.push("--model", String(model));
    if (permissionMode) args.push("--permission-mode", String(permissionMode));
    if (sessionState.hasTurn) args.push("--continue");

    const env = { ...process.env };
    if (msg.effort) env.CLAUDE_CODE_EFFORT_LEVEL = String(msg.effort);

    const child = spawn("fcc-claude", args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeClaude = child;
    let emittedText = false;
    let thinkingOpen = false;
    let stderrBuf = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const ev = JSON.parse(trimmed);
        if (ev.type === "stream_event" && ev.event?.delta) {
          const d = ev.event.delta;
          if (d.type === "thinking_delta" && d.thinking) {
            thinkingOpen = true;
            send(ws, { type: "thinking_delta", delta: d.thinking });
          } else if (d.type === "text_delta" && d.text) {
            if (thinkingOpen) { send(ws, { type: "thinking_complete" }); thinkingOpen = false; }
            emittedText = true;
            send(ws, { type: "text_delta", delta: d.text });
          }
        } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b.type === "thinking" && b.thinking) {
              send(ws, { type: "thinking_delta", delta: b.thinking });
              send(ws, { type: "thinking_complete" });
            } else if (b.type === "text" && b.text && !emittedText) {
              emittedText = true;
              send(ws, { type: "text_delta", delta: b.text });
            } else if (b.type === "tool_use") {
              const target = b.input?.file_path || b.input?.command || b.input?.path || b.input?.pattern || JSON.stringify(b.input || {});
              send(ws, { type: "tool_call", id: b.id, toolType: mapToolType(b.name), actionLabel: b.name || "Tool", target: String(target) });
            }
          }
          if (ev.message?.usage) {
            inputTokens = ev.message.usage.input_tokens || inputTokens;
            outputTokens = ev.message.usage.output_tokens || outputTokens;
          }
        } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
          // Reset emittedText on tool_result so follow-up text after MCP/tool calls is never dropped
          emittedText = false;
          for (const b of ev.message.content) {
            if (b.type === "tool_result") {
              const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
              send(ws, { type: "tool_result", id: b.tool_use_id || "", stdout: out.slice(0, 4000) });
            }
          }
        } else if (ev.type === "result") {
          if (ev.result && !emittedText) {
            emittedText = true;
            send(ws, { type: "text_delta", delta: String(ev.result) });
          }
          if (ev.usage) {
            inputTokens = ev.usage.input_tokens || inputTokens;
            outputTokens = ev.usage.output_tokens || outputTokens;
          }
        }
      } catch {
        emittedText = true;
        send(ws, { type: "text_delta", delta: line + "\n" });
      }
    });

    child.stderr.on("data", (buf) => { stderrBuf += buf.toString("utf8"); });
    child.on("error", (err) => {
      if (activeClaude === child) activeClaude = null;
      send(ws, { type: "error", message: "Failed to spawn fcc-claude: " + err.message });
    });
    child.on("close", (code) => {
      if (activeClaude === child) activeClaude = null;
      // Clean up readline interface to prevent leaks
      try { rl.close(); } catch {}
      if (thinkingOpen) send(ws, { type: "thinking_complete" });
      if (code !== 0 && !emittedText) {
        send(ws, { type: "error", message: (stderrBuf.trim() || "fcc-claude exited with code " + code) });
      } else {
        sessionState.hasTurn = true;
        send(ws, { type: "done", inputTokens, outputTokens });
      }
    });
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (msg.type === "ping") return send(ws, { type: "pong" });
    if (msg.type === "pty_input") {
      const sh = getShell(msg.tabId || "term-bash-1");
      // Check stdin is writable before writing (handles shell restarts/exited shells)
      if (sh.stdin?.writable) {
        sh.stdin.write(String(msg.data || ""));
      }
    } else if (msg.type === "pty_signal") {
      const sh = shells.get(msg.tabId || "term-bash-1");
      if (sh) sh.kill(msg.signal || "SIGINT");
    } else if (msg.type === "claude_cli_control") {
      const cmd = String(msg.command || "").trim();
      if (cmd.startsWith("/model ")) sessionState.model = cmd.slice(7).trim();
      if (cmd.startsWith("/effort ")) sessionState.effort = cmd.slice(8).trim().split(" ")[0];
      if (cmd === "/clear") sessionState.hasTurn = false;
    } else if (msg.type === "permission_policy") {
      sessionState.permissionMode = String(msg.mode || "default");
    } else if (msg.type === "tool_approval" && activeClaude?.stdin?.writable) {
      activeClaude.stdin.write(msg.decision === "Reject" ? "n\n" : "y\n");
    } else if (msg.type === "cancel_prompt" && activeClaude) {
      try { activeClaude.kill("SIGINT"); } catch {}
      // SIGKILL fallback after 2s
      setTimeout(() => {
        if (activeClaude && !activeClaude.killed) {
          try { activeClaude.kill("SIGKILL"); } catch {}
          activeClaude = null;
        }
      }, 2000);
      activeClaude = null;
    } else if (msg.type === "prompt") {
      runPrompt(msg);
    }
  });

  ws.on("close", () => {
    for (const sh of shells.values()) { try { sh.kill(); } catch {} }
    shells.clear();
    if (activeClaude) {
      try { activeClaude.kill("SIGINT"); } catch {}
      // SIGKILL fallback after 2s
      setTimeout(() => {
        if (activeClaude && !activeClaude.killed) {
          try { activeClaude.kill("SIGKILL"); } catch {}
          activeClaude = null;
        }
      }, 2000);
      activeClaude = null;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Claude Code Studio bridge listening on ws://0.0.0.0:" + PORT);
});
