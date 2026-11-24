const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const SECRET = (process.env.BRIDGE_SECRET || '').trim();
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || '/workspaces');

function safePath(inputPath) {
  const raw = String(inputPath || WORKSPACE_ROOT);
  const resolved = path.resolve(raw.startsWith('/') ? raw : path.join(WORKSPACE_ROOT, raw));
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error('Access outside /workspaces is forbidden');
  }
  return resolved;
}

function timingSafeAuth(header) {
  if (!SECRET) return true;
  const expected = Buffer.from('Bearer ' + SECRET);
  const actual = Buffer.from(String(header || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function postGitHubForm(urlPath, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'github.com',
      path: urlPath,
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode || 200, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchLocalModels() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8082/v1/models', (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed.data) ? parsed.data : []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(3500, () => { req.destroy(); resolve([]); });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'POST' && parsedUrl.pathname === '/github-oauth') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      try {
        const json = JSON.parse(body || '{}');
        const out = json.action === 'device_code'
          ? await postGitHubForm('/login/device/code', { client_id: json.client_id || '', scope: json.scope || 'codespace repo' })
          : await postGitHubForm('/login/oauth/access_token', { client_id: json.client_id || '', device_code: json.device_code || '', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(out.body);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/api/files' || parsedUrl.pathname === '/api/files/content') {
    if (!timingSafeAuth(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/api/files') {
      try {
        const dir = safePath(parsedUrl.searchParams.get('path') || WORKSPACE_ROOT);
        const includeHidden = parsedUrl.searchParams.get('includeHidden') === 'true';
        const dirents = fs.readdirSync(dir, { withFileTypes: true });
        const entries = dirents
          .filter((d) => includeHidden || !d.name.startsWith('.'))
          .map((d) => {
            const full = path.join(dir, d.name);
            let size = 0;
            try { if (!d.isDirectory()) size = fs.statSync(full).size; } catch {}
            return { name: d.name, path: full, isDirectory: d.isDirectory(), size };
          });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, entries }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/api/files/content') {
      try {
        const content = fs.readFileSync(safePath(parsedUrl.searchParams.get('path')), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/api/files') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        try {
          const msg = JSON.parse(body || '{}');
          if (msg.action === 'write') {
            const target = safePath(msg.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(msg.content ?? ''), 'utf8');
          } else if (msg.action === 'mkdir') {
            fs.mkdirSync(safePath(msg.path), { recursive: true });
          } else if (msg.action === 'rename') {
            fs.renameSync(safePath(msg.oldPath), safePath(msg.newPath));
          } else if (msg.action === 'delete') {
            fs.rmSync(safePath(msg.path), { recursive: true, force: true });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'claude-code-studio-bridge', port: PORT, features: ['ws', 'api_files', 'keepalive', 'resume'] }));
});

const wss = new WebSocketServer({ server });
const clients = new Set();
const sessions = new Map(); // sessionId -> { events: [], proc: ChildProcess|null }
const ptys = new Map(); // tabId -> ChildProcess
let globalEventId = 1;

function broadcastSessionEvent(sessionId, payload) {
  const ev = { ...payload, sessionId, eventId: globalEventId++ };
  let st = sessions.get(sessionId);
  if (!st) { st = { events: [], proc: null }; sessions.set(sessionId, st); }
  st.events.push(ev);
  if (st.events.length > 500) st.events.shift();
  const wire = JSON.stringify(ev);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(wire);
  }
}

function broadcastPty(tabId, stream, chunk) {
  const wire = JSON.stringify({ type: 'pty_output', tabId, stream, data: chunk.toString('utf8') });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(wire);
  }
}

function ensurePty(tabId) {
  if (ptys.has(tabId)) return ptys.get(tabId);
  const sh = spawn('bash', ['-i'], { cwd: WORKSPACE_ROOT, env: { ...process.env, TERM: 'xterm-256color' } });
  sh.stdout.on('data', (d) => broadcastPty(tabId, 'stdout', d));
  sh.stderr.on('data', (d) => broadcastPty(tabId, 'stderr', d));
  sh.on('close', () => ptys.delete(tabId));
  ptys.set(tabId, sh);
  return sh;
}

wss.on('connection', (ws, req) => {
  if (!timingSafeAuth(req.headers.authorization)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

    if (msg.type === 'ping' || msg.type === 'keepalive') { send({ type: 'pong', ts: Date.now() }); return; }

    if (msg.type === 'resume') {
      const st = sessions.get(msg.sessionId);
      const afterId = Number(msg.lastEventId || 0);
      if (st) {
        for (const ev of st.events) {
          if (ev.eventId > afterId) send(ev);
        }
      }
      return;
    }

    if (msg.type === 'list_models') {
      const models = await fetchLocalModels();
      send({ requestId: msg.requestId, ok: true, models });
      return;
    }

    if (msg.type && msg.type.startsWith('fs_')) {
      try {
        if (msg.type === 'fs_list') {
          const dir = safePath(msg.path);
          const includeHidden = Boolean(msg.includeHidden);
          const dirents = fs.readdirSync(dir, { withFileTypes: true });
          const entries = dirents
            .filter((d) => includeHidden || !d.name.startsWith('.'))
            .map((d) => {
              const full = path.join(dir, d.name);
              let size = 0;
              try { if (!d.isDirectory()) size = fs.statSync(full).size; } catch {}
              return { name: d.name, path: full, isDirectory: d.isDirectory(), size };
            });
          send({ requestId: msg.requestId, ok: true, entries });
        } else if (msg.type === 'fs_read') {
          const content = fs.readFileSync(safePath(msg.path), 'utf8');
          send({ requestId: msg.requestId, ok: true, content });
        } else if (msg.type === 'fs_write') {
          const target = safePath(msg.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(msg.content ?? ''), 'utf8');
          send({ requestId: msg.requestId, ok: true });
        } else if (msg.type === 'fs_mkdir') {
          fs.mkdirSync(safePath(msg.path), { recursive: true });
          send({ requestId: msg.requestId, ok: true });
        } else if (msg.type === 'fs_rename') {
          fs.renameSync(safePath(msg.oldPath), safePath(msg.newPath));
          send({ requestId: msg.requestId, ok: true });
        } else if (msg.type === 'fs_delete') {
          fs.rmSync(safePath(msg.path), { recursive: true, force: true });
          send({ requestId: msg.requestId, ok: true });
        }
      } catch (e) {
        send({ requestId: msg.requestId, ok: false, error: e.message });
      }
      return;
    }

    if (msg.type === 'pty_input') {
      ensurePty(msg.tabId || 'term-bash-1').stdin.write(String(msg.data || ''));
      return;
    }
    if (msg.type === 'pty_signal') {
      const sh = ptys.get(msg.tabId || 'term-bash-1');
      if (sh) sh.kill(msg.signal || 'SIGINT');
      return;
    }
    if (msg.type === 'pty_resize') { return; }

    if (msg.type === 'cancel_prompt') {
      const st = sessions.get(msg.sessionId);
      if (st && st.proc) { st.proc.kill('SIGINT'); st.proc = null; }
      return;
    }

    if (msg.type === 'prompt') {
      const sid = msg.sessionId || 'default';
      let st = sessions.get(sid);
      if (!st) { st = { events: [], proc: null }; sessions.set(sid, st); }
      if (st.proc) { try { st.proc.kill('SIGTERM'); } catch {} }

      const args = ['-p', String(msg.prompt || ''), '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
      if (msg.model) args.push('--model', String(msg.model));
      const procEnv = { ...process.env };
      if (msg.thinkingEnabled === false || msg.effortLevel === 'off') {
        procEnv.CLAUDE_CODE_DISABLE_THINKING = '1';
      } else if (msg.effortLevel || msg.effort) {
        procEnv.CLAUDE_CODE_EFFORT_LEVEL = String(msg.effortLevel || msg.effort);
      }
      const proc = spawn('fcc-claude', args, { cwd: WORKSPACE_ROOT, env: procEnv });
      st.proc = proc;
      broadcastSessionEvent(sid, { type: 'status', label: 'Working on project…' });

      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const ev = JSON.parse(t);
            if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
              for (const b of ev.message.content) {
                if (b.type === 'thinking' && b.thinking) broadcastSessionEvent(sid, { type: 'thinking_delta', delta: b.thinking });
                else if (b.type === 'text' && b.text) broadcastSessionEvent(sid, { type: 'text_delta', delta: b.text });
                else if (b.type === 'tool_use') broadcastSessionEvent(sid, { type: 'tool_call', actionLabel: b.name || 'Tool', target: JSON.stringify(b.input || {}).slice(0, 220) });
              }
            } else if (ev.type === 'content_block_delta' && ev.delta) {
              if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) broadcastSessionEvent(sid, { type: 'thinking_delta', delta: ev.delta.thinking });
              if (ev.delta.type === 'text_delta' && ev.delta.text) broadcastSessionEvent(sid, { type: 'text_delta', delta: ev.delta.text });
            } else if (ev.type === 'result' && ev.result) {
              broadcastSessionEvent(sid, { type: 'done', inputTokens: ev.usage?.input_tokens || 0, outputTokens: ev.usage?.output_tokens || 0 });
            }
          } catch {
            broadcastSessionEvent(sid, { type: 'text_delta', delta: t + '\n' });
          }
        }
      });
      proc.stderr.on('data', (d) => broadcastSessionEvent(sid, { type: 'tool_result', id: 'stderr', stdout: d.toString('utf8') }));
      proc.on('close', (code) => {
        if (buf.trim()) broadcastSessionEvent(sid, { type: 'text_delta', delta: buf });
        st.proc = null;
        if (code && code !== 0) broadcastSessionEvent(sid, { type: 'error', message: 'fcc-claude exited with code ' + code });
        else broadcastSessionEvent(sid, { type: 'done', inputTokens: 0, outputTokens: 0 });
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('Claude Code Studio bridge listening on :' + PORT));
