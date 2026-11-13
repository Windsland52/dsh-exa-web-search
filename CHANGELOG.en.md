# Changelog

[中文](CHANGELOG.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-13

First release.

### Added

- **A dual-channel Exa provider behind the `exa` id.** With a key it delegates to the official
  `@deepseek-ai/dsh-web-search-exa` REST provider; without one it uses Exa's hosted MCP endpoint,
  which needs no credentials. `mode` forces either channel.
- **Installs as the default search source and leaves nothing behind.** The bundle patch selects
  `exa` for the `web` row, so no settings edit is needed; uninstalling removes the patch with it.
  The user's own configuration still wins.
- **All seven Exa search types**, including the latency presets: `auto`, `keyword`, `neural`,
  `lite`, `deep-lite`, `deep`, and `deep-reasoning`.
- **A two-tier settings page.** The plugin's bundle page carries only the API key; the row page
  carries the full field set — mode, endpoint addresses, and search type — with a per-value
  explanation and a link to the Exa documentation.
- **English and Chinese documentation**, selected by the Host's display language, plus card
  dictionaries in eight languages.
- **A provider display name and picker description** for Hosts that support them (`dsh-web`
  0.2.2-rc.3 and later); earlier releases ignore both fields.

### Notes

- The keyed channel reports `INVALID_CREDENTIAL` on a rejected key instead of falling back to the
  keyless channel, so a broken key is visible rather than silently masked.
- The keyless channel is a shared public endpoint: at most two searches run at once, the rest queue
  and retry once, and heavy use is rate-limited.
