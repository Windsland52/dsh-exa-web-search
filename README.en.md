# dsh-exa-web-search

![Plugin icon](icon.png)

[中文说明](README.md)

Wires Exa into DeepSeek Harness's built-in web search: keep using the `web_search` tool as usual, but the results now come from Exa. **No extra tools, no system-prompt changes.**

## Two channels, switched automatically

| Mode | When | Route |
| --- | --- | --- |
| `auto` (default) | a key is available (configured, or in an environment variable) | official Exa API |
| `auto` | no key | keyless public channel |
| `anonymous` | chosen manually | force the public channel; any key is ignored |
| `keyed` | chosen manually | force the official API; unavailable without a key |

The public channel (labelled "anonymous" in the UI) is a free shared service: at most 2 queries run at once, the rest queue and retry once, and heavy use may be rate-limited. Use a key on the official API when you need reliability.

A rejected key (401) reports `INVALID_CREDENTIAL` instead of switching to the public channel.

## Install

**Desktop app**: open **Plugins** → **+ Add plugin** (top right) → enter the package name `dsh-exa-web-search` → install.

**Command line**:

```bash
dsh plugin add dsh-exa-web-search
```

No settings to change afterwards: web search goes through Exa by default. Uninstalling restores everything and leaves no trace in your config. To switch to another search source, change it in your own settings.

## Configuration (optional)

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` / `anonymous` / `keyed`; behaviour in the table above |
| `apiKey` | — | the key typed in directly; when empty, read from the variable named by `apiKeyEnv` |
| `apiKeyEnv` | `EXA_API_KEY` | which environment variable holds the key |
| `baseURL` | `https://api.exa.ai` | official API address (keyed channel) |
| `mcpURL` | `https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_search_exa` | public channel address (keyless) |
| `searchType` | `auto` | Exa search type (keyed only): `auto` / `keyword` / `neural` / `lite` / `deep-lite` / `deep` / `deep-reasoning` |

You normally don't edit config files by hand: open **Plugins**, find `dsh-exa-web-search`, and type the key into the **Exa API Key** card (masked, and never echoed back after saving). The card carries only the key; **open the plugin's row** for the rest — mode, endpoint addresses, and search type.

## How it differs from the official Exa plugin

The official Exa plugin only registers the search source; you still have to make it the default yourself.

This plugin registers as the `exa` search source itself (replacing the official implementation), so it is the default on install, is undone on uninstall, and leaves your other config alone:

- **Search even without a key**: with a key it uses the official API, without one the keyless public channel, and `auto` switches for you.
- **Zero intrusion**: no new tools, no system-prompt changes; keep using `web_search` as usual.
