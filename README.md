# pi-anyrouter

A pi provider extension that adapts requests to the client-specific shapes accepted by AnyRouter.

It currently supports both **Claude Code / Claude Agent SDK** requests and **Codex Responses Lite** requests. It does not require a separate local relay process.

## Status

Confirmed working with provider `anyrouter-cc` using Claude and Codex model routes:

```bash
pi --model anyrouter-cc/claude-opus-4-8 --no-session --no-tools -p "Reply with exactly OK"
pi --model anyrouter-cc/gpt-5.6-sol --no-session --no-tools -p "Reply with exactly OK"
```

Expected output:

```text
OK
```

## What this package fixes

Some AnyRouter Claude endpoints, especially `claude-opus-4-6`, reject older or more generic Claude-style requests with errors like:

```json
{"error":{"type":"new_api_error","message":"invalid claude code request (...)"},"type":"error"}
```

This package selects an adapter by model family:

- Claude models use `POST /v1/messages?beta=true` with Claude Code headers, system blocks, metadata, and Anthropic SSE conversion.
- Codex models use `POST /v1/responses` with the Codex Responses Lite headers/body shape and OpenAI Responses SSE conversion.

## Features

- Registers provider: `anyrouter-cc`
- Supports Claude Code and Codex Responses Lite request validation
- No local relay/proxy required
- Converts tool names to Claude Code naming
- Supports reasoning via `thinking` + `output_config`
- Built-in request/response debug dump
- Retries transient upstream failures like HTTP 520/502/503/504 automatically
- Packaged so it can be shared as a pi package

## Install

## Option A: local development checkout

Clone into a normal directory:

```bash
git clone https://github.com/xifan2333/pi-anyrouter.git
cd pi-anyrouter
```

Install as a pi package from the local path:

```bash
pi install .
```

Or install directly from a path later:

```bash
pi install /absolute/path/to/pi-anyrouter
```

## Option B: direct git install

Once pushed to GitHub, install with:

```bash
pi install git:github.com/xifan2333/pi-anyrouter
```

Or pin a ref/tag:

```bash
pi install git:github.com/xifan2333/pi-anyrouter@<tag>
```

## Option C: manual extension placement

If you only want the extension file layout, place it at either:

- `~/.pi/agent/extensions/anyrouter-cc/index.ts`
- `.pi/extensions/anyrouter-cc/index.ts`

Then reload pi:

```text
/reload
```

## Config

Create:

- `~/.pi/agent/anyrouter-cc.json`

Example:

```json
{
  "baseUrl": "https://anyrouter.top",
  "apiKey": "YOUR_ANYROUTER_KEY_OR_ENV_NAME",
  "models": [
    {
      "id": "claude-opus-4-8",
      "name": "Claude Opus 4.8",
      "reasoning": true,
      "input": ["text"],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 32000
    }
  ]
}
```

You can also override config values with environment variables:

- `PI_ANYROUTER_CC_CONFIG`
- `PI_ANYROUTER_CC_BASE_URL`
- `PI_ANYROUTER_CC_API_KEY`
- `PI_ANYROUTER_CC_MAX_RETRIES` (default: `10`)
- `PI_ANYROUTER_CC_STREAM_MODE` (default: `force`)

Notes:

- `apiKey` can be a literal key or an environment variable name.
- shell-command values like `"!command"` are intentionally not supported.
- this package reads `~/.pi/agent/anyrouter-cc.json` by default rather than `models.json`.
- `PI_ANYROUTER_CC_STREAM_MODE=auto` tries real SSE streaming first and falls back to the old non-stream JSON path if streaming fails before any content arrives.
- `PI_ANYROUTER_CC_STREAM_MODE=force` uses SSE only; `PI_ANYROUTER_CC_STREAM_MODE=off` disables SSE.

## Use

After installation/configuration:

```text
/reload
/model
```

Choose a configured model, for example:

- `anyrouter-cc / claude-opus-4-8`
- `anyrouter-cc / gpt-5.6-sol`

Or run directly:

```bash
pi --model anyrouter-cc/gpt-5.6-sol
```

## Debugging

Enable request/response dumps:

```bash
PI_ANYROUTER_CC_DEBUG=1 pi --model anyrouter-cc/gpt-5.6-sol -p "Reply with exactly OK"
```

Optional custom debug directory:

```bash
PI_ANYROUTER_CC_DEBUG=1 \
PI_ANYROUTER_CC_DEBUG_DIR=/tmp/anyrouter-cc-debug \
pi --model anyrouter-cc/gpt-5.6-sol -p "Reply with exactly OK"
```

Default debug output directory:

- `.pi/anyrouter-cc-debug/`

If AnyRouter intermittently returns `HTTP 520` / `Origin Error`, this package retries transient upstream failures automatically with exponential backoff. You can tune the retry count with `PI_ANYROUTER_CC_MAX_RETRIES`.

The runtime uses SSE by default (`PI_ANYROUTER_CC_STREAM_MODE=force`). For troubleshooting, you can force old behavior with:

```bash
PI_ANYROUTER_CC_STREAM_MODE=off pi --model anyrouter-cc/claude-opus-4-8 -p "Reply with exactly OK"
```

## Share as a pi package

This repo is already structured as a pi package through `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

That means users can install it with:

```bash
pi install git:github.com/xifan2333/pi-anyrouter
```

## Publish checklist

### Publish to GitHub

```bash
git init
git add .
git commit -m "feat: add AnyRouter Claude and Codex adapters"
git branch -M main
git remote add origin git@github.com:xifan2333/pi-anyrouter.git
git push -u origin main
```

### Optional npm publish

If you want npm distribution too:

```bash
npm publish
```

Then users can install with:

```bash
pi install npm:pi-anyrouter
```

## Important behavior

This package implements the Claude Code / Claude Agent SDK and Codex Responses Lite request shapes currently accepted by AnyRouter.

If AnyRouter changes its validation again, enable debug dumps and compare the request shape against fresh official client captures.

## Credits

Based on [pi-anyrouter-cc](https://github.com/phy-zhangzl/pi-anyrouter-cc) by zhenliangzhang, licensed under the MIT License.

This is an unofficial community project and is not affiliated with Anthropic, OpenAI, or AnyRouter.

## License

MIT. See [LICENSE](LICENSE) for the original and modification copyright notices.
