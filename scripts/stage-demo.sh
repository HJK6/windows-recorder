#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(node -p "require('${repo_root}/package.json').version")
installer="${repo_root}/dist/HFRecorder-Setup-${version}.exe"
stage_dir=${1:-/mnt/c/Users/vamsh/Desktop/HF-Recorder-Demo}

test -f "$installer"
mkdir -p "$stage_dir"
rm -f "$stage_dir"/HFRecorder-Setup-*.exe \
  "$stage_dir/Launch-HF-Recorder-Demo.cmd" \
  "$stage_dir/Open-HF-Demo-Website.cmd"
install -m 0644 "$installer" "$stage_dir/"
install -m 0644 "$repo_root/demo/windows/DEMO.md" "$stage_dir/"
install -m 0644 "$repo_root/demo/windows/HF-Recorder-Demo.html" "$stage_dir/"
install -m 0644 "$repo_root/demo/windows/app.js" "$stage_dir/"
printf 'Staged HF Recorder demo in %s\n' "$stage_dir"
