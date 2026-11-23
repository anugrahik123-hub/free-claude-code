#!/usr/bin/env bash
export PATH="$HOME/.local/bin:$PATH"
grep -q ffff /etc/gai.conf || echo "precedence ::ffff:0:0/96 100" | sudo tee -a /etc/gai.conf
command -v fcc-claude || pip install --user --break-system-packages .
command -v claude || npm install -g @anthropic-ai/claude-code
nohup ./start.sh >/tmp/start.log 2>&1 </dev/null & sleep 3
