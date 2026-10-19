#!/usr/bin/env python3
"""PreToolUse hook for mcp__whatsapp__send_draft.

Always forces Claude Code's permission prompt and puts the exact recipient and text in it.
The bridge refuses the send unless recipient, text and filenames match the frozen draft, so what this
prompt shows is what goes out. Paired with permissions.ask in ~/.claude/settings.json.
"""
import json
import sys

tool_input = json.load(sys.stdin).get("tool_input", {})
reason = "Send WhatsApp to {}:\n\n{}".format(
    tool_input.get("chat_name", "?"), tool_input.get("text", "")
)
names = tool_input.get("attachment_names", [])
if names:
    reason += "\n\nAttachments: " + ", ".join(names)
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
