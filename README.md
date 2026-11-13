# dsh-exa-web-search

![插件图标](icon.png)

[English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-exa-web-search)](https://www.npmjs.com/package/dsh-exa-web-search)
[![downloads](https://img.shields.io/npm/dm/dsh-exa-web-search)](https://www.npmjs.com/package/dsh-exa-web-search)
[![Check](https://github.com/Windsland52/dsh-exa-web-search/actions/workflows/check.yml/badge.svg)](https://github.com/Windsland52/dsh-exa-web-search/actions/workflows/check.yml)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-339933?logo=node.js&logoColor=white)](package.json)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-4c6)](package.json)

把 Exa 接入 DeepSeek Harness 的内置联网搜索：`web_search` 工具照常用，只是搜索结果改由 Exa 提供。**没有额外工具，不改系统提示词。**

## 两个通道，自动切换

| 模式 | 什么情况 | 走哪条路 |
| --- | --- | --- |
| `auto`（默认） | 有 Key（填在配置里，或环境变量里） | Exa 官方 API |
| `auto` | 没有 Key | 免 Key 的公共通道 |
| `anonymous` | 手动选择 | 强制公共通道，忽略 Key |
| `keyed` | 手动选择 | 强制官方 API；没有 Key 时不可用 |

公共通道（界面里显示为「匿名」）是免费的共享服务，同时只跑 2 个查询，超出的排队等待并重试一次；量大时可能被限流。要求稳定就用 Key 走官方 API。

Key 被拒（401）时直接报 `INVALID_CREDENTIAL`，不会改用公共通道。

## 安装

**桌面版**：打开 **插件** 页 → 右上角 **+ 添加插件** → 输入包名 `dsh-exa-web-search` → 安装。

**命令行**：

```bash
dsh plugin add dsh-exa-web-search
```

装好后**不用改任何设置**：联网搜索默认就走 Exa。卸载时自动还原，不会在你的配置里留下痕迹。想换成别的搜索源，在你自己的设置里改即可。

## 配置（可选）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` / `anonymous` / `keyed`，行为见上表 |
| `apiKey` | — | 直接填入的 Key；留空则从 `apiKeyEnv` 指定的环境变量读取 |
| `apiKeyEnv` | `EXA_API_KEY` | 从哪个环境变量读 Key |
| `baseURL` | `https://api.exa.ai` | 官方 API 地址（带 Key 通道） |
| `mcpURL` | `https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_search_exa` | 公共通道地址（免 Key） |
| `searchType` | `auto` | Exa 检索类型（仅带 Key 时生效）：`auto` / `keyword` / `neural` / `lite` / `deep-lite` / `deep` / `deep-reasoning` |

平时不用手改配置文件：在**插件**页找到 `dsh-exa-web-search`，往 **Exa API Key** 卡片里填 Key 就行（界面自动打码，保存后不回显）。插件卡片上只放 Key；**点开这个插件的那一行**，行详情页还有模式、接口地址、检索类型等完整配置。

## 和官方 Exa 插件的区别

官方 Exa 插件只负责注册搜索源，装完还得自己把它设成默认。

本插件直接以 `exa` 作为搜索源（顶替官方实现），装上即为默认，卸载即还原，不动你其它配置：

- **没 Key 也能搜**：有 Key 走官方接口，没 Key 走免 Key 的公共通道，`auto` 自动切。
- **零打扰**：不加新工具、不改系统提示词，`web_search` 照常用。
