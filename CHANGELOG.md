# 更新日志

[English](CHANGELOG.en.md)

本项目的所有重要变更都记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.0] - 2026-11-13

首次发布。

### 新增

- **以 `exa` 为 id 的双通道 provider。** 有 Key 时委托官方
  `@deepseek-ai/dsh-web-search-exa` 的 REST 实现；没有 Key 时走 Exa 托管的 MCP
  端点，不需要任何凭据。`mode` 可以强制走其中一条。
- **装上即默认，卸载无残留。** bundle patch 把 `web` 这一行的搜索源设为 `exa`，
  不用改任何设置；卸载时补丁随之移除。用户自己的配置优先级仍然更高。
- **Exa 的全部七种检索类型**，含速度预设：`auto`、`keyword`、`neural`、`lite`、
  `deep-lite`、`deep`、`deep-reasoning`。
- **两级设置页。** 插件页卡片只放 API Key；行详情页放完整字段——模式、接口地址、
  检索类型——每个取值都有一句说明和 Exa 文档链接。
- **中英文档**，跟随宿主的界面语言切换；卡片字典覆盖八种语言。
- **provider 显示名与选择说明**，供支持这两个字段的宿主使用（`dsh-web`
  0.2.2-rc.3 及以后）；更早的版本会忽略它们。

### 说明

- 带 Key 通道遇到被拒的 Key 时直接报 `INVALID_CREDENTIAL`，不会退回免 Key 通道，
  这样失效的 Key 能被看见，而不是被静默掩盖。
- 免 Key 通道是共享的公共端点：同时最多跑两个查询，超出的排队并重试一次，
  量大时会被限流。
