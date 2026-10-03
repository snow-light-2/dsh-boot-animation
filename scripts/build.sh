#!/bin/bash
# Build for @dsh-external/dsh-boot-animation.
#
# The work lives in scripts/build.mjs so that it runs identically on Windows and
# on a POSIX shell; this file exists only because a repository full of shell
# scripts should not hide the fact that `bash scripts/build.sh` still works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

exec node scripts/build.mjs
