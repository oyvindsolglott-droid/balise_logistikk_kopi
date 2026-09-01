#!/bin/zsh
set -e
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
python - <<'PY'
import importlib.util, subprocess, sys
mods=['fastapi','uvicorn','multipart','PIL','cv2','numpy','scipy','requests']
missing=[m for m in mods if importlib.util.find_spec(m) is None]
if missing:
    subprocess.check_call([sys.executable,'-m','pip','install','-r','requirements.txt'])
PY
open "http://127.0.0.1:8788" >/dev/null 2>&1 &
python app.py
