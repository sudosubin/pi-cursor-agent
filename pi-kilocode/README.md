# pi-kilocode

[![npm](https://badgen.net/npm/v/pi-kilocode)](https://www.npmjs.com/package/pi-kilocode)

Kilo Code provider extension for [pi](https://github.com/badlogic/pi-mono).

Use [Kilo Code](https://kilo.ai/)'s gateway directly from pi through Kilo's OpenAI-compatible API and device-auth login flow. `pi-kilocode` is a thin provider wrapper around pi's built-in `openai-completions` stack:

- Uses Kilo Gateway's OpenAI-compatible endpoint
- Fetches the Kilo model catalog from `https://api.kilo.ai/api/gateway/models`
- Caches the raw model response on disk
- Registers all text-capable models from the Kilo catalog
- Supports anonymous usage for free models and browser-based Kilo login

## Installation

```sh
pi install npm:pi-kilocode
```

## Authentication

### Anonymous usage

No login is required for Kilo's free models.

### Browser login

1. Open pi and enter `/login`.
2. Select **Kilo Code** from the provider list.
3. A browser window will open to Kilo's verification page.
4. Enter the device code shown by pi and complete login.
5. If your account has organizations, pi will let you choose one.

When an organization is selected, `pi-kilocode` sends it as `X-KiloCode-OrganizationId` on Kilo model requests.

## Anonymous access and limits

According to Kilo's public gateway documentation and behavior:

- Anonymous access is available for free models
- Anonymous usage is limited to free models only
- Anonymous usage is rate-limited to about [200 requests/hour per IP](https://kilo.ai/docs/gateway/authentication#anonymous-access)

## Current limitations

- Image-output-only models are intentionally hidden

## Requirements

- `pi >= 0.49.0`
- A Kilo Code account if you want to use `/login`
- Network access to `https://api.kilo.ai`

## License

MIT
