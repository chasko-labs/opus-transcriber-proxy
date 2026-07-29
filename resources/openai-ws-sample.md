# `openai-ws-sample.jsonl`

A raw capture of the WebSocket traffic between `OutgoingConnection`/`OpenAIBackend` and OpenAI's
Realtime API (`wss://api.openai.com/v1/realtime?intent=transcription`) for a single participant's
`/transcribe` session with `PROVIDERS_PRIORITY=openai`. Captured by replaying
[`sample.jsonl`](sample.jsonl) (the client-facing Opus dump) against a local container and logging
every frame sent/received on the outbound OpenAI socket.

## Format

Newline-delimited JSON (JSONL) — one object per line, one line per WebSocket frame, in the order
they were sent/received:

```json
{"timestamp": 1785358733701, "direction": "outgoing", "data": { ... }}
```

- `timestamp` — capture time, `Date.now()` (ms since epoch)
- `direction` — `outgoing` (proxy → OpenAI) or `incoming` (OpenAI → proxy)
- `data` — the parsed OpenAI Realtime API message (the raw frame is JSON text; this is that text
  parsed back into an object). Every message carries a `type` field identifying the event

## Message types present in this sample

Outgoing (proxy → OpenAI):
- `session.update` — sent once on connect (`OpenAIBackend.sendSessionUpdate`); configures the
  transcription model, PCM input format (24kHz), noise reduction, and turn detection
- `input_audio_buffer.append` — one per audio chunk; `audio` is base64-encoded 24kHz 16-bit PCM
- `input_audio_buffer.commit` — sent once the source goes idle (`forceCommit`), finalizing the
  trailing utterance

Incoming (OpenAI → proxy):
- `session.created` / `session.updated` — session lifecycle acks
- `input_audio_buffer.committed` — ack of the commit above
- `conversation.item.added` / `conversation.item.done` — conversation item lifecycle
- `conversation.item.input_audio_transcription.delta` — incremental (interim) transcript text
- `conversation.item.input_audio_transcription.completed` — final transcript for the utterance

## Notes

- This is a single participant's stream; a real session has one such stream per active speaker
- Not an exhaustive sample — it doesn't include error frames
  (`type: "error"`) or `conversation.item.input_audio_transcription.failed`, which
  `OpenAIBackend.handleMessage` also handles
