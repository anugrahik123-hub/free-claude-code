#!/usr/bin/env bash
grep -q "::ffff:0:0/96" /etc/gai.conf 2>/dev/null || \
  echo "precedence ::ffff:0:0/96 100" | \
  sudo tee -a /etc/gai.conf >/dev/null
export PATH="$HOME/.local/bin:$PATH"
command -v fcc-claude >/dev/null 2>&1 || \
  pip install --user --break-system-packages . \
  >/tmp/pip.log 2>&1
command -v claude >/dev/null 2>&1 || \
  npm install -g --allow-scripts=@anthropic-ai/claude-code \
  @anthropic-ai/claude-code >/tmp/npm.log 2>&1
chmod +x ./start.sh
nohup ./start.sh >/tmp/start.log 2>&1 </dev/null &
sleep 3
