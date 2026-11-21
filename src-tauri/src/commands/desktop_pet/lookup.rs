use chrono::{DateTime, Local, Utc};
use rusqlite::{params, Connection};
use std::fmt::Write;
use tauri::{AppHandle, WebviewWindow};

use super::{chat_caller, open_db};
use crate::core::{ai, error::PlatformResult, repositories::certificate_sync};

const LIMIT: usize = 8;
const SCOPES: &[(&str, &str)] = &[
    ("备忘录", "notes"),
    ("笔记", "notes"),
    ("证书", "certificates"),
    ("域名", "domain"),
    ("云服务器", "ecs"),
    ("服务器", "ecs"),
    ("轻量服务器", "swas"),
    ("轻量应用服务器", "swas"),
    ("对象存储", "oss"),
    ("存储桶", "oss"),
    ("云数据库", "rds"),
    ("数据库", "rds"),
    ("Redis", "redis"),
    ("边缘站点", "esa"),
    ("ESA", "esa"),
    ("云资源", "assets"),
    ("云资产", "assets"),
    ("云账号", "accounts"),
    ("云账户", "accounts"),
    ("受管主机", "hosts"),
    ("终端主机", "hosts"),
    ("SSH 主机", "hosts"),
    ("运维面板", "panels"),
    ("宝塔面板", "panels"),
    ("面板", "panels"),
];
const HELP: &str = "用法：查备忘录 项目交接、查证书、查域名 example.com、查云服务器、查云资源。也可以查云账号、轻量服务器、数据库、Redis、对象存储、边缘站点、受管主机和面板。";

fn query(message: &str) -> Option<(&'static str, &str)> {
    let message = message
        .trim()
        .trim_end_matches(['。', '？', '?', '！', '!']);
    let message = message
        .strip_prefix("小小驼")
        .unwrap_or(message)
        .trim_start_matches(['，', ',', ' ']);
    let message = message.strip_prefix("请").unwrap_or(message).trim_start();
    let message = message.strip_prefix("帮我").unwrap_or(message).trim_start();
    let lower = message.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "几点了" | "现在几点" | "现在几点了" | "本机时间"
    ) {
        return Some(("time", ""));
    }
    if lower.contains("证书")
        && lower.contains("到期")
        && (lower.contains("天内") || lower.starts_with("快到期") || lower.starts_with("哪些证书"))
    {
        return Some(("expiry", message));
    }
    if let Some(rest) = message
        .strip_prefix("从")
        .and_then(|rest| rest.trim_start().strip_prefix("备忘录"))
    {
        let rest = rest.trim_start();
        let rest = ["里面", "里", "中"]
            .into_iter()
            .find_map(|prefix| rest.strip_prefix(prefix))
            .unwrap_or(rest)
            .trim_start();
        let rest = ["查一下", "找一下", "查询", "搜索", "查找", "找", "查", "搜"]
            .into_iter()
            .find_map(|prefix| rest.strip_prefix(prefix))
            .unwrap_or(rest);
        return Some(("notes", rest.trim()));
    }
    let rest = [
        "查一下",
        "查找",
        "查询",
        "搜索",
        "看看",
        "列出",
        "找一下",
        "查",
        "搜",
    ]
    .into_iter()
    .find_map(|prefix| message.strip_prefix(prefix))?
    .trim_start();
    let rest = rest
        .strip_prefix("云枢")
        .unwrap_or(rest)
        .trim_start_matches([' ', '里', '的']);
    let lower = rest.to_ascii_lowercase();
    for &(label, scope) in SCOPES {
        if lower.starts_with(&label.to_ascii_lowercase()) {
            let term = rest[label.len()..]
                .trim_start_matches([' ', ':', '：'])
                .trim();
            return Some((scope, term));
        }
    }
    matches!(rest, "" | "本地资料" | "资料").then_some(("help", ""))
}

fn safe_text(text: &str, max: usize) -> String {
    if text.len() > 32_000 {
        return "[内容较长，请在原模块查看]".into();
    }
    match ai::preview(text) {
        Ok(preview) => {
            let mut output = preview.text.chars().take(max).collect::<String>();
            if preview.text.chars().count() > max {
                output.push('…');
            }
            output
        }
        Err(_) => "[已省略含凭据的内容]".into(),
    }
}

fn snippet(body: &str, term: &str) -> String {
    let matching_line = if term.is_empty() {
        None
    } else {
        body.lines()
            .find(|line| line.to_ascii_lowercase().contains(term))
    };
    let excerpt = matching_line.unwrap_or(body.trim());
    if let Some(offset) = excerpt
        .to_ascii_lowercase()
        .find(term)
        .filter(|_| !term.is_empty())
    {
        let start = excerpt[..offset]
            .char_indices()
            .rev()
            .nth(48)
            .map_or(0, |(index, _)| index);
        let text = safe_text(&excerpt[start..], 240);
        return if start > 0 {
            format!("…{text}")
        } else {
            text
        };
    }
    safe_text(excerpt, 240)
}

fn notes(db: &Connection, term: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = db.prepare(
        "WITH entries AS (
             SELECT title, group_name, pinned, updated_at, id,
                CASE WHEN account='' AND password='' THEN body ELSE NULL END AS searchable_body,
                instr(lower(title), ?1)>0 OR instr(lower(group_name), ?1)>0
                    OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END)
                        WHERE type='text' AND instr(lower(value), ?1)>0) AS metadata_match
             FROM memo_notes WHERE deleted_at IS NULL
         ) SELECT title, group_name, searchable_body, metadata_match
         FROM entries WHERE metadata_match OR instr(lower(searchable_body), ?1)>0
         ORDER BY pinned DESC, updated_at DESC, id DESC",
    )?;
    let mut rows = statement.query([term])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let title: String = row.get(0)?;
        let group: String = row.get(1)?;
        let body: Option<String> = row.get(2)?;
        let metadata_match: bool = row.get(3)?;
        // Filter complete lines before testing body matches or displaying excerpts.
        let preview = body.as_deref().and_then(|body| ai::preview(body).ok());
        if !metadata_match
            && !preview.as_ref().is_some_and(|value| {
                value.text.lines().any(|line| {
                    line != "[已移除可能含凭据的行]" && line.to_ascii_lowercase().contains(term)
                })
            })
        {
            continue;
        }
        let title = safe_text(&title, 100);
        let group = safe_text(&group, 30);
        let excerpt = match (body, preview) {
            (_, Some(preview)) => snippet(&preview.text, term),
            (Some(_), None) => "正文请在备忘录查看。".into(),
            (None, None) => "此条目含账号或密码字段，正文可在备忘录查看。".into(),
        };
        items.push(format!("{title}（{group}）\n{excerpt}"));
        if items.len() > LIMIT {
            break;
        }
    }
    Ok(items)
}

fn certificates(db: &Connection, scope: &str, term: &str) -> Result<Vec<String>, String> {
    let now = Utc::now().timestamp();
    let days = term
        .split_once("天内")
        .and_then(|(before, _)| {
            before
                .trim_end()
                .rsplit(|c: char| !c.is_ascii_digit())
                .next()
        })
        .and_then(|days| days.parse::<i64>().ok())
        .unwrap_or(30);
    if scope == "expiry" && !(1..=3650).contains(&days) {
        return Err("请输入 1 到 3650 天以内的证书查询范围。".into());
    }
    let mut items = certificate_sync::list(db).map_err(|_| "无法读取证书摘要")?;
    if scope == "expiry" {
        items.sort_by_key(|item| item.metadata.not_after.unwrap_or(i64::MAX));
    }
    Ok(items
        .into_iter()
        .map(|item| item.metadata)
        .filter(|item| {
            if scope == "expiry" {
                return item
                    .not_after
                    .is_some_and(|expiry| (now..=now + days * 86400).contains(&expiry));
            }
            item.domains
                .iter()
                .any(|domain| domain.to_ascii_lowercase().contains(term))
                || item.primary_domain.to_ascii_lowercase().contains(term)
        })
        .take(LIMIT + 1)
        .map(|item| {
            let date = item
                .not_after
                .and_then(|expiry| DateTime::from_timestamp(expiry, 0))
                .map(|date| {
                    date.with_timezone(&Local)
                        .format("%Y-%m-%d %H:%M")
                        .to_string()
                })
                .unwrap_or_else(|| "未知".into());
            format!("{} · 到期 {date}", safe_text(&item.primary_domain, 253))
        })
        .collect())
}

fn summaries(db: &Connection, scope: &str, term: &str) -> rusqlite::Result<Vec<String>> {
    let sql = match scope {
        "accounts" => "SELECT account_name, cloud_type || ' · ' || CASE WHEN enabled=1 THEN '启用' ELSE '停用' END
            FROM cloud_accounts WHERE deleted_at IS NULL
            AND (instr(lower(account_name),?1)>0 OR instr(lower(cloud_type),?1)>0 OR instr(lower(coalesce(group_name,'')),?1)>0)
            ORDER BY sort_order, id LIMIT ?2",
        "hosts" => "SELECT name, host || ':' || port || ' · ' || status
            FROM managed_hosts WHERE deleted_at IS NULL
            AND (instr(lower(name),?1)>0 OR instr(lower(host),?1)>0 OR instr(lower(coalesce(group_name,'')),?1)>0)
            ORDER BY name COLLATE NOCASE, id LIMIT ?2",
        "panels" => "SELECT name, status FROM panel_connections WHERE deleted_at IS NULL
            AND (instr(lower(name),?1)>0 OR instr(lower(coalesce(group_name,'')),?1)>0)
            ORDER BY sort_order, id LIMIT ?2",
        _ => "WITH assets AS (
            SELECT c.asset_key, c.resource_type, c.region_id, a.account_name,
                   CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END AS data
            FROM cloud_assets c JOIN cloud_accounts a ON a.id=c.account_id
            WHERE a.deleted_at IS NULL AND (?3='assets' OR c.resource_type=?3)
        ), names AS (
            SELECT *, coalesce(nullif(json_extract(data,'$.InstanceName'),''),
                nullif(json_extract(data,'$.DomainName'),''), nullif(json_extract(data,'$.BucketName'),''),
                nullif(json_extract(data,'$.DBInstanceDescription'),''), nullif(json_extract(data,'$.Name'),''),
                nullif(json_extract(data,'$.name'),''), asset_key) AS label
            FROM assets
        ) SELECT CAST(label AS TEXT), resource_type || ' · ' || account_name || coalesce(' · ' || region_id,'')
            FROM names WHERE instr(lower(label),?1)>0 OR instr(lower(asset_key),?1)>0
                OR instr(lower(account_name),?1)>0 OR instr(lower(coalesce(region_id,'')),?1)>0
            ORDER BY resource_type, label COLLATE NOCASE, asset_key LIMIT ?2",
    };
    let mut statement = db.prepare(sql)?;
    let result = |row: &rusqlite::Row<'_>| {
        let title: String = row.get(0)?;
        let detail: String = row.get(1)?;
        Ok(format!(
            "{} · {}",
            safe_text(&title, 160),
            safe_text(&detail, 120)
        ))
    };
    if statement.parameter_count() == 3 {
        statement
            .query_map(params![term, LIMIT + 1, scope], result)?
            .collect()
    } else {
        statement
            .query_map(params![term, LIMIT + 1], result)?
            .collect()
    }
}

#[tauri::command]
pub async fn pet_chat_lookup(
    window: WebviewWindow,
    app: AppHandle,
    message: String,
    has_image: Option<bool>,
) -> PlatformResult<Option<String>> {
    chat_caller(&window)?;
    if message.len() > 8000 {
        return Err("查询文本过长。".into());
    }
    let Some((scope, term)) = query(&message) else {
        return Ok(None);
    };
    if has_image.unwrap_or(false) {
        return Err("本地查询使用文字关键词，请先移除待发送的图片。".into());
    }
    if term.chars().count() > 160 {
        return Err("查询关键词过长，请缩短至 160 个字符以内。".into());
    }
    if scope == "time" {
        return Ok(Some(
            Local::now().format("本机时间 %Y-%m-%d %H:%M").to_string(),
        ));
    }
    if scope == "help" {
        return Ok(Some(HELP.into()));
    }
    let term = term.to_ascii_lowercase();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let db = open_db().map_err(|_| "无法打开云枢本地资料")?;
        crate::commands::app_lock::require_unlocked(&app, &db)?;
        let items = match scope {
            "notes" => notes(&db, &term).map_err(|_| "无法查询备忘录")?,
            "certificates" | "expiry" => certificates(&db, scope, &term)?,
            _ => summaries(&db, scope, &term).map_err(|_| "无法查询云枢本地资料")?,
        };
        crate::commands::app_lock::require_unlocked(&app, &db)?;
        let mut reply = String::new();
        if items.is_empty() {
            reply.push_str("本地没有匹配的记录。可以换个关键词，或在云枢对应模块查看。");
        }
        for (index, item) in items.iter().take(LIMIT).enumerate() {
            if index > 0 {
                reply.push_str("\n\n");
            }
            let _ = write!(reply, "{}. {item}", index + 1);
        }
        if items.len() > LIMIT {
            reply.push_str("\n\n还有更多结果，可以缩小关键词。");
        }
        Ok::<_, String>(reply)
    })
    .await
    .map_err(|_| "本地查询任务执行失败")??;
    Ok(Some(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_explicit_queries_and_preserves_the_keyword() {
        assert_eq!(
            query("小小驼，请帮我从 备忘录里面查一下一期交接。"),
            Some(("notes", "一期交接"))
        );
        assert_eq!(
            query("查云枢里的域名 example.com"),
            Some(("domain", "example.com"))
        );
        assert_eq!(query("查 Redis 生产"), Some(("redis", "生产")));
        assert_eq!(
            query("哪些证书 30 天内到期？"),
            Some(("expiry", "哪些证书 30 天内到期"))
        );
        assert_eq!(query("现在几点了？"), Some(("time", "")));
        assert_eq!(query("怎么在备忘录里加一条记录？"), None);
    }

    #[test]
    fn notes_searches_safe_body_and_tags_without_returning_deleted_or_secret_matches() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::core::repositories::notes::SCHEMA)
            .unwrap();
        for (title, body, tags, password, deleted) in [
            (
                "交接记录",
                "项目在周五验收\n密码：测试字段",
                "[\"迭代\"]",
                "",
                None,
            ),
            ("含凭据记录", "周一发布", "[]", "测试值", None),
            ("已删除记录", "周五", "[]", "", Some(42_i64)),
        ] {
            db.execute(
                "INSERT INTO memo_notes(title,body,group_name,tags_json,password,created_at,updated_at,deleted_at)
                 VALUES(?1,?2,'工作',?3,?4,0,0,?5)",
                params![title, body, tags, password, deleted],
            ).unwrap();
        }
        let reply = notes(&db, "周五").unwrap();
        assert_eq!(reply.len(), 1);
        assert!(reply[0].contains("项目在周五验收"));
        assert!(!reply[0].contains("测试字段"));
        assert_eq!(notes(&db, "迭代").unwrap().len(), 1);
        assert!(notes(&db, "测试字段").unwrap().is_empty());
        assert!(notes(&db, "周一").unwrap().is_empty());
        assert!(notes(&db, "含凭据").unwrap()[0].contains("正文可在备忘录查看"));
    }

    #[test]
    fn assets_project_only_safe_fields_for_active_accounts() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE cloud_accounts(id INTEGER, account_name TEXT, deleted_at INTEGER);
             CREATE TABLE cloud_assets(account_id INTEGER, resource_type TEXT, asset_key TEXT, region_id TEXT, payload_json TEXT);
             INSERT INTO cloud_accounts VALUES(1,'生产',NULL),(2,'已删除',1);",
        ).unwrap();
        for id in [1, 2] {
            db.execute(
                "INSERT INTO cloud_assets VALUES(?1,'ecs','instance-1','华东',?2)",
                params![
                    id,
                    r#"{"InstanceName":"项目服务器","credential":"测试字段"}"#
                ],
            )
            .unwrap();
        }
        assert_eq!(
            summaries(&db, "ecs", "项目").unwrap(),
            ["项目服务器 · ecs · 生产 · 华东"]
        );
        assert!(summaries(&db, "domain", "项目").unwrap().is_empty());
        assert!(summaries(&db, "assets", "测试字段").unwrap().is_empty());
    }
}
