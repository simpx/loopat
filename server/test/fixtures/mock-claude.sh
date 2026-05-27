#!/bin/bash
# Mock claude binary for loopat integration tests.
#
# The real claude binary reads stream-json user messages on stdin and emits
# stream-json system/assistant/result messages on stdout (one JSON object
# per line). This mock implements the minimum protocol needed to make the
# SDK happy: emit init + assistant + result, then exit cleanly.
#
# Args are ignored. Echo'd text is fixed ("mock-response") so the test can
# assert on it deterministically.
#
# Why bash + not a JS file: bash is in our minimal sandbox image and needs
# zero install. Keeps the test fixture portable.

set -e

# Drain one full user message line from stdin. The SDK pushes
# `{"type":"user",...}\n` for each user input. Without this read we'd
# race: SDK writes input, mock exits before reading it, EPIPE on SDK side.
IFS= read -r USER_LINE || true

# Emit init message (minimal but well-formed).
printf '%s\n' '{"type":"system","subtype":"init","session_id":"mock-session","cwd":"/","tools":[],"mcp_servers":[],"model":"mock-model","permissionMode":"bypassPermissions","slash_commands":[],"apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"0.0.0-mock","output_style":"default","agents":[],"skills":[],"plugins":[],"analytics_disabled":true,"uuid":"mock-init-uuid","memory_paths":{"auto":"/loopat/context/personal/memory/"}}'

# Emit assistant text response.
printf '%s\n' '{"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"mock-response-OK"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"parent_tool_use_id":null,"session_id":"mock-session","uuid":"mock-asst-uuid"}'

# Emit result (signals SDK that the turn is complete).
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"duration_api_ms":1,"num_turns":1,"result":"mock-response-OK","session_id":"mock-session","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"completed","uuid":"mock-result-uuid"}'

# Mimic real claude: stay alive after result. SDK either pushes another
# user message (and we'd handle a multi-turn loop) or eventually closes
# stdin → we exit. Reading stdin until EOF keeps us patient.
while IFS= read -r _; do :; done
exit 0
