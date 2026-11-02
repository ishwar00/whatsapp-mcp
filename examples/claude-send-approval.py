#!/usr/bin/env python3
"""PreToolUse hook that asks before mcp__whatsapp__send.

Pair with permissions.ask in Claude Code's settings.
"""
import json
import sys

tool_input = json.load(sys.stdin).get("tool_input", {})
reason = "Send WhatsApp to {}:\n\n{}".format(
    tool_input.get("to", "?"), tool_input.get("text", "")
)
file_path = tool_input.get("file_path")
if file_path:
    reason += "\n\nFile: " + file_path
print(
    json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": reason,
            }
        }
    )
)
