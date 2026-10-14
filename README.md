# pi-anyrouter

A pi provider extension that adapts requests to the client-specific shapes accepted by AnyRouter.

It currently supports both **Claude Code / Claude Agent SDK** requests and **Codex Responses Lite** requests. It does not require a separate local relay process.

## Status

Confirmed working with provider `anyrouter` using Claude and Codex model routes:

```bash
pi --model anyrouter/claude-opus-4-8 --no-session --no-tools -p "Reply with exactly OK"
pi --model anyrouter/gpt-5.6-sol --no-session --no-tools -p "Reply with exactly OK"
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

- Registers provider: `anyrouter`
- Supports Claude Code and Codex Responses Lite request validation
- No local relay/proxy required
- Converts tool names to Claude Code naming
- Automatically resolves tools and system prompt from Pi's `TranscriptContext`
- Modular architecture with clean separation of client, stream, types, and diagnostics
- Dynamic catalog refreshing with `refreshModels`
- Built-in diagnostics command: `/anyrouter.doctor`
- Built-in reload command: `/anyrouter.refresh`
- Built-in models list command: `/anyrouter.models`
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

- `~/.pi/agent/extensions/anyrouter/index.ts`
- `.pi/extensions/anyrouter/index.ts`

Then reload pi:

```text
/reload
```

## Authentication & Configuration

`pi-anyrouter` follows the official Pi provider specification with **zero custom configuration files**:

### 1. Set your API Key

Choose any official Pi authentication method:

- **Via `/login` command in Pi**:
  ```text
  /login anyrouter
  ```
- **Via `~/.pi/agent/auth.json`**:
  ```json
  {
    "anyrouter": {
      "type": "api_key",
      "key": "sk-your-anyrouter-key"
    }
  }
  ```
- **Via `~/.pi/agent/models.json`**:
  ```json
  {
    "providers": {
      "anyrouter": {
        "apiKey": "sk-your-anyrouter-key"
      }
    }
  }
  ```

### 2. Built-in Models

The provider registers standard AnyRouter models out of the box:

- `gpt-6-astra` (Codex Responses Lite)
- `gpt-6-astra-cc-format` (Claude Code format)
- `claude-opus-5-5`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-5-20250929`
- `claude-haiku-4-5-20251001`

### 3. Custom Models & Overrides (Optional)

To add new models or override existing parameters, use Pi's standard `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anyrouter": {
      "baseUrl": "https://anyrouter.top",
      "models": [
        {
          "id": "my-custom-model",
          "name": "My Custom Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 500000,
          "maxTokens": 32000
        }
      ],
      "modelOverrides": {
        "gpt-6-astra": {
          "contextWindow": 1048576
        }
      }
    }
  }
}
```

## Use

After installation:

```text
/reload
/model
```

Choose an AnyRouter model, for example:

- `anyrouter / claude-opus-4-6`
- `anyrouter / gpt-6-astra`

Or run directly:

```bash
pi --model anyrouter/gpt-6-astra
```

## Commands

In an interactive Pi session, you can run:

- `/anyrouter.doctor` - Displays detailed diagnostics (endpoint, HTTP status, request ID, latency, injected tools count and names, error details).
- `/anyrouter.refresh` - Reloads AnyRouter models from the Pi model registry.
- `/anyrouter.models` - Lists all available AnyRouter models with their capabilities.

## Share as a pi package

This repo is already structured as a pi package through `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
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
