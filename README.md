# MiniMax (coding) for VS Code

Language model chat provider for GitHub Copilot in VS Code using MiniMax text models with a Token Plan API key.

## Features

- Token Plan API key from [platform.minimax.io](https://platform.minimax.io) (international) or [platform.minimaxi.com](https://platform.minimaxi.com) (China)
- OpenAI-compatible chat to a configurable endpoint
- Tool calling and reasoning/thinking streaming
- M3 model supports image input (multimodal)

## Requirements

- VS Code 1.111.0+
- MiniMax Token Plan subscription and API key
- VS Code Insiders is required to render MiniMax thinking blocks via the proposed `languageModelThinkingPart` API

## Setup

1. Get your Token Plan API key from [Account / Token Plan](https://platform.minimax.io/user-center/payment/token-plan) (international) or [Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) (China)
2. Use the API key navigation action in the model picker
3. Choose a model in the Copilot model picker

Keys are stored in VS Code Secret Storage.

## Configuration

`minimax.apiBaseUrl` selects the API endpoint. Set it to match the platform that issued your key — a key from one platform is rejected by the other with HTTP 401:

```jsonc
"minimax.apiBaseUrl": "https://api.minimax.io/v1",   // platform.minimax.io (international, default)
"minimax.apiBaseUrl": "https://api.minimaxi.com/v1", // platform.minimaxi.com (China)
```

You can also switch via the commands **MiniMax: Switch to Global API** and **MiniMax: Switch to Chinese API**.

`minimax.visibleModels` (array of model IDs) controls which built-in models appear in the picker. Custom models are always shown regardless of this setting.

`minimax.customModels` lets you add new models from `settings.json` without waiting for an extension update. Only `id` is required; it is sent to the API as-is unless `apiModelId` is set:

```jsonc
"minimax.customModels": [
  {
    "id": "MiniMax-M3.1-Flash-Preview",
    "name": "MiniMax M3.1 Flash (Preview)",
    "contextLength": 1000000,
    "maxInputTokens": 1000000,
    "maxOutputTokens": 131072,
    "imageInput": true
  }
]
```

Custom models appear in the picker automatically (they can also be listed in `minimax.visibleModels`). Built-in capabilities such as tool calling are enabled for custom models as well.

## Troubleshooting

**HTTP 401 / "Invalid API key" with a valid key** — the most common cause is a platform mismatch: `minimax.apiBaseUrl` points at a different platform than the one that issued your key. Check that the endpoint matches where you got the key (see Configuration above). The key is stored and reused, so it should not be re-prompted on every message.

## Models

| Model | Context | Max input | Max output |
|--------|---------|-----------|-----------|
| MiniMax-M3 | 1,000,000 | 1,000,000 | 131,072 |
| MiniMax-M2.7 | 204,800 | 200,000 | 131,072 |
| MiniMax-M2.7-highspeed | 204,800 | 200,000 | 131,072 |
| MiniMax-M2.5 | 204,800 | 196,000 | 128,000 |
| MiniMax-M2.5-highspeed | 204,800 | 196,000 | 128,000 |
| MiniMax-M2.1 | 204,800 | 196,000 | 128,000 |
| MiniMax-M2.1-highspeed | 204,800 | 196,000 | 128,000 |
| MiniMax-M2 | 204,800 | 192,000 | 128,000 |

## License

MIT
