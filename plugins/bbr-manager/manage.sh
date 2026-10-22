#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 ForwardX contributors
set -eu
if [ -z "${FORWARDX_AGENT_EXECUTABLE:-}" ] || [ ! -x "$FORWARDX_AGENT_EXECUTABLE" ]; then
  echo 'BBR 管理需要支持内置 BBR 管理的新 Agent，请先更新 Agent。' >&2
  exit 1
fi
exec "$FORWARDX_AGENT_EXECUTABLE" --plugin-bbr "$@"
