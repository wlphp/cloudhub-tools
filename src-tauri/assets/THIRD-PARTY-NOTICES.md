# Third-party notices

## codex_client_models.json

Codex 客户端官方模型目录快照，用作供应商模型目录的字段模板。
不含任何凭据或供应商数据，仅包含模型能力声明与官方提示词模板。

- 来源：CLIProxyAPI `internal/registry/models/codex_client_models.json`
- 许可：MIT License，副本见 `CLIProxyAPI-LICENSE`

更新快照时递增 `src/core/codex/model_catalog.rs` 中的 `GENERATOR_VERSION`，
否则用户磁盘上的旧目录不会被判定为过期。
