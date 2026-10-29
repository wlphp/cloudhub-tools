//! A deliberately small SQL exchange grammar. Untrusted SQL is never executed:
//! only quoted INSERT identifiers and literal VALUES are parsed, then rebound.
use super::*;
#[cfg(test)]
use crate::core::crypto::{decrypt_secret_with_key, encrypt_secret_with_key};
use rusqlite::{types::Value, OptionalExtension, params_from_iter};
use crate::core::data_transfer as policy;

const HEADER: &str = "-- CloudHub plaintext SQL v1\n";
const MAX_SQL: u64 = 64 * 1024 * 1024;
pub(super) const TABLES: &[(&str, &str)] = policy::TABLES;

fn err() -> String { "SQL 格式、数据或版本无效；仅支持 CloudHub 导出的 SQL，当前数据未修改".into() }
fn ident(name: &str) -> String { format!("\"{}\"", name.replace('"', "\"\"")) }
fn allowed(name: &str) -> bool { TABLES.iter().any(|(table, _)| *table == name) }
fn read_scope(db:&Connection) -> Result<Vec<String>,String> {
    let mut stmt=db.prepare("SELECT name FROM cloudhub_sql_scope ORDER BY rowid").map_err(|_|err())?;
    let result=stmt.query_map([],|r|r.get(0)).map_err(|_|err())?.collect::<rusqlite::Result<Vec<String>>>().map_err(|_|err())?;
    Ok(result)
}
fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", ident(table))).map_err(|_| err())?;
    let rows = stmt.query_map([], |row| row.get(1)).map_err(|_| err())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| err())
}
pub(crate) fn selected(tables: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let tables = tables.unwrap_or_else(|| TABLES.iter().map(|(name, _)| name.to_string()).collect());
    if tables.is_empty() || tables.len() > TABLES.len() || tables.iter().any(|table| !allowed(table)) { return Err(err()); }
    let mut result = TABLES.iter().filter(|(table, _)| tables.iter().any(|name| name == table)).map(|(name, _)| name.to_string()).collect::<Vec<_>>();
    // Always include parent records to keep portable numeric references meaningful.
    if result.iter().any(|name| ["ssh_connections", "certificates", "rdp_connections", "managed_hosts", "panel_connections"].contains(&name.as_str())) && !result.iter().any(|name| name == "cloud_accounts") { result.insert(0, "cloud_accounts".into()); }
    if result.iter().any(|name| ["frp_clients", "rdp_connections"].contains(&name.as_str())) && !result.iter().any(|name| name == "managed_hosts") { result.push("managed_hosts".into()); }
    if result.iter().any(|name| name == "managed_hosts") && !result.iter().any(|name| name == "cloud_accounts") { result.insert(0, "cloud_accounts".into()); }
    if result.iter().any(|name| name == "frp_local_proxies") && !result.iter().any(|name| name == "frp_local_servers") { result.push("frp_local_servers".into()); }
    if result.iter().any(|name| name == "transfer_asset_metadata") {
        for parent in ["cloud_accounts", "managed_hosts"] { if !result.iter().any(|name| name == parent) { result.push(parent.into()); } }
    }
    loop {
        let before = result.len();
        for (child, parents) in [
            ("certificate_versions", &["certificates"][..]),
            ("certificate_source_links", &["certificates", "panel_connections"][..]),
            ("esa_certificate_deployments", &["certificates", "cloud_accounts"][..]),
            ("codex_provider_keys", &["codex_model_providers"][..]),
            ("codex_provider_aggregate_members", &["codex_provider_aggregates", "codex_provider_keys", "codex_model_providers"][..]),
            ("memo_notes", &["memo_groups"][..]),
            ("certificates", &["cloud_accounts"][..]),
            ("panel_connections", &["cloud_accounts"][..]),
        ] {
            if result.iter().any(|name| name == child) {
                for parent in parents { if !result.iter().any(|name| name == parent) { result.push(parent.to_string()); } }
            }
        }
        if before == result.len() { break; }
    }
    Ok(TABLES.iter().filter(|(name, _)| result.iter().any(|item| item == name)).map(|(name, _)| name.to_string()).collect())
}
fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(), Value::Integer(n) => n.to_string(), Value::Real(n) => n.to_string(),
        Value::Text(s) => format!("'{}'", s.replace('\'', "''")), Value::Blob(bytes) => format!("X'{}'", hex::encode(bytes)),
    }
}

pub(crate) fn stamp_ids(db:&Connection,key:&[u8]) -> Result<(),String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS cloudhub_transfer_ids(table_name TEXT,source_rowid INTEGER,portable_id TEXT,PRIMARY KEY(table_name,source_rowid),UNIQUE(table_name,portable_id))").map_err(|_|err())?;
    for (table,_) in TABLES {
        let has_created=columns(db,table)?.iter().any(|name|name=="created_at");
        let mut stmt=db.prepare(&format!("SELECT rowid,{} FROM {}",if has_created {"created_at"}else{"NULL"},ident(table))).map_err(|_|err())?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,Value>(1)?))).map_err(|_|err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|err())?;
        for (rowid,created) in rows {
            let inherited:Option<String>=if policy::exists(db,"data_transfer_identity")? {db.query_row("SELECT portable_id FROM data_transfer_identity WHERE table_name=?1 AND target_rowid=?2 ORDER BY portable_id LIMIT 1",rusqlite::params![table,rowid],|r|r.get(0)).optional().map_err(|_|err())?}else{None};
            let id=inherited.unwrap_or_else(||{let mut hash=Sha256::new();hash.update(key);hash.update(table.as_bytes());hash.update(rowid.to_le_bytes());if has_created {hash.update(literal(&created).as_bytes());}format!("{:x}",hash.finalize())});
            db.execute("INSERT OR IGNORE INTO cloudhub_transfer_ids VALUES(?1,?2,?3)",rusqlite::params![table,rowid,id]).map_err(|_|err())?;
        }
    }
    Ok(())
}

fn metadata_ids(key: &str, raw: &str) -> Result<Vec<(String,i64)>,String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| "资产自定义信息格式无效")?;
    let refs: Vec<String> = if let Some(items)=value.as_array() { items.iter().filter_map(|v|v.as_str().map(String::from)).collect() }
        else if let Some(items)=value.as_object() { items.keys().cloned().collect() } else { return Err("资产自定义信息格式无效".into()); };
    Ok(refs.into_iter().filter_map(|text| {
        let parent=if key=="cloudhub-tools-managed-host-order" {"managed_hosts"}else{"cloud_accounts"};
        text.split(':').next()?.parse::<i64>().ok().map(|id|(parent.to_string(),id))
    }).collect())
}
fn remap_metadata(key: &str, raw: &str, mappings: &HashMap<(String,i64),i64>) -> Result<String,String> {
    let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|_| "资产自定义信息格式无效")?;
    let remap = |text: &str| -> Result<String,String> {
        if text.starts_with("unresolved:") {return Ok(text.into());}
        let (head,suffix)=text.split_once(':').map(|(a,b)|(a,format!(":{b}"))).unwrap_or((text,String::new()));
        let parent=if key=="cloudhub-tools-managed-host-order" {"managed_hosts"}else{"cloud_accounts"};
        let id=head.parse::<i64>().map_err(|_| "资产引用格式无效")?;
        Ok(if let Some(mapped)=mappings.get(&(parent.into(),id)) {format!("{mapped}{suffix}")}else{format!("unresolved:{id}{suffix}")})
    };
    if let Some(items)=value.as_array_mut() { for item in items { *item=remap(item.as_str().ok_or("资产引用格式无效")?)?.into(); } }
    else if let Some(items)=value.as_object_mut() {
        let old=std::mem::take(items);
        for (name,content) in old { items.insert(remap(&name)?,content); }
    } else { return Err("资产自定义信息格式无效".into()); }
    serde_json::to_string(&value).map_err(|_| "资产自定义信息格式无效".into())
}

/// Keep every explicitly selected row and only the transitive parents it uses.
/// Operates exclusively on a private stage, never on the application database.
pub(crate) fn prune_dependencies(db: &Connection, requested: &[String]) -> Result<(),String> {
    selected(Some(requested.to_vec()))?;
    db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS transfer_keep(t TEXT,r INTEGER,PRIMARY KEY(t,r)); DELETE FROM transfer_keep;").map_err(|_| err())?;
    for table in requested { db.execute(&format!("INSERT INTO transfer_keep SELECT ?1,rowid FROM {}",ident(table)),[table]).map_err(|_| err())?; }
    loop {
        let mut changed=0;
        for (child,_) in TABLES {
            let fields=columns(db,child)?;
            let mut links:Vec<(String,String,String)>=vec![];
            let mut stmt=db.prepare(&format!("PRAGMA foreign_key_list({})",ident(child))).map_err(|_|err())?;
            links.extend(stmt.query_map([],|r|Ok((r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_|err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|err())?);
            for (field,parent) in [("account_id","cloud_accounts"),("source_account_id","cloud_accounts"),("managed_host_id","managed_hosts"),("ssh_managed_host_id","managed_hosts"),("certificate_id","certificates"),("panel_id","panel_connections"),("server_id","frp_local_servers")] {
                if fields.iter().any(|v|v==field) { links.push((parent.into(),field.into(),"id".into())); }
            }
            if *child=="memo_notes" {links.push(("memo_groups".into(),"group_name".into(),"name".into()));}
            for (parent,field,referenced) in links.into_iter().filter(|(p,_,_)|policy::allowed(p)) {
                changed+=db.execute(&format!("INSERT OR IGNORE INTO transfer_keep SELECT ?1,p.rowid FROM {} p JOIN {} c ON p.{}=c.{} JOIN transfer_keep k ON k.t=?2 AND k.r=c.rowid",ident(&parent),ident(child),ident(&referenced),ident(&field)),rusqlite::params![parent,child]).map_err(|_|err())?;
            }
        }
        let mut stmt=db.prepare("SELECT target_key FROM rdp_connections WHERE rowid IN (SELECT r FROM transfer_keep WHERE t='rdp_connections')").map_err(|_|err())?;
        let keys=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_|err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|err())?;
        for key in keys { for (prefix,parent) in [("asset:","cloud_accounts"),("managed:","managed_hosts"),("managed-host:","managed_hosts")] { if let Some(rest)=key.strip_prefix(prefix) { if let Ok(id)=rest.split(':').next().unwrap_or("").parse::<i64>() { changed+=db.execute(&format!("INSERT OR IGNORE INTO transfer_keep SELECT ?1,rowid FROM {parent} WHERE id=?2"),rusqlite::params![parent,id]).map_err(|_|err())?; } } } }
        let mut stmt=db.prepare("SELECT key,value FROM transfer_asset_metadata WHERE rowid IN (SELECT r FROM transfer_keep WHERE t='transfer_asset_metadata')").map_err(|_|err())?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_|err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|err())?;
        for (key,value) in rows { for (parent,id) in metadata_ids(&key,&value)? { changed+=db.execute(&format!("INSERT OR IGNORE INTO transfer_keep SELECT ?1,rowid FROM {parent} WHERE id=?2"),rusqlite::params![parent,id]).map_err(|_|err())?; } }
        if changed==0 {break;}
    }
    for (table,_) in TABLES { db.execute(&format!("DELETE FROM {} WHERE rowid NOT IN (SELECT r FROM transfer_keep WHERE t=?1)",ident(table)),[table]).map_err(|_|err())?; }
    if policy::exists(db,"cloudhub_transfer_ids")? {db.execute("DELETE FROM cloudhub_transfer_ids WHERE NOT EXISTS(SELECT 1 FROM transfer_keep WHERE t=table_name AND r=source_rowid)",[]).map_err(|_|err())?;}
    Ok(())
}

pub(crate) fn dump(conn: &Connection, key: &[u8], tables: &[String]) -> Result<Zeroizing<String>, String> {
    dump_scoped(conn,key,tables,tables)
}
fn dump_scoped(conn: &Connection, key: &[u8], tables: &[String], requested:&[String]) -> Result<Zeroizing<String>, String> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|_| err())?;
    let mut output = Zeroizing::new(format!("{HEADER}-- schema: {version}\n-- tables: {}\n-- WARNING: Passwords and private keys are PLAINTEXT, including *_ciphertext columns.\n", tables.join(",")));
    output.push_str(&format!("-- requested: {}\n",requested.join(",")));
    for table in tables {
        if policy::virtual_table(table) && !policy::exists(conn,table)? { continue; }
        let names = columns(conn, table)?;
        let mut stmt = conn.prepare(&format!("SELECT rowid,{} FROM {}", names.iter().map(|name| ident(name)).collect::<Vec<_>>().join(","), ident(table))).map_err(|_| err())?;
        let mut rows = stmt.query([]).map_err(|_| err())?;
        while let Some(row) = rows.next().map_err(|_| err())? {
            if table == "client_preferences" {
                let index = names.iter().position(|name| name == "key").ok_or_else(err)?;
                if policy::preference_module(&row.get::<_,String>(index+1).map_err(|_| err())?)!=Some("client_preferences") { continue; }
            }
            let mut values = Vec::new();
            for (i, name) in names.iter().enumerate() {
                let value: Value = row.get(i+1).map_err(|_| err())?;
                let value = policy::convert(table, name, policy::clean_value(table, name, value), Some(key), None)?;
                values.push(literal(&value));
            }
            let rowid:i64=row.get(0).map_err(|_|err())?;
            let inherited:Option<String>=if policy::exists(conn,"cloudhub_transfer_ids")? {conn.query_row("SELECT portable_id FROM cloudhub_transfer_ids WHERE table_name=?1 AND source_rowid=?2",rusqlite::params![table,rowid],|r|r.get(0)).optional().map_err(|_|err())?}else{None};
            let inherited=if inherited.is_some() {inherited}else if policy::exists(conn,"data_transfer_identity")? {conn.query_row("SELECT portable_id FROM data_transfer_identity WHERE table_name=?1 AND target_rowid=?2 ORDER BY portable_id LIMIT 1",rusqlite::params![table,rowid],|r|r.get(0)).optional().map_err(|_|err())?}else{None};
            let portable_id=inherited.unwrap_or_else(|| {
                let mut hash=Sha256::new(); hash.update(key); hash.update(table.as_bytes()); hash.update(rowid.to_le_bytes());
                if let Some(index)=names.iter().position(|name|name=="created_at") {hash.update(values[index].as_bytes());}
                format!("{:x}",hash.finalize())
            });
            output.push_str(&format!("-- record: {portable_id}\nINSERT INTO {} ({}) VALUES ({});\n", ident(table), names.iter().map(|name| ident(name)).collect::<Vec<_>>().join(","), values.join(",")));
            for value in &mut values { use zeroize::Zeroize; value.zeroize(); }
            if output.len() as u64 > MAX_SQL { return Err("SQL 超过 64 MB 限制，请缩小导出范围".into()); }
        }
    }
    Ok(output)
}

pub(super) fn export_file(app: &tauri::AppHandle, tables: Option<Vec<String>>, include_trash: bool) -> Result<Option<String>, String> {
    let tables = tables.unwrap_or_else(|| TABLES.iter().map(|(name,_)| name.to_string()).collect());
    selected(Some(tables.clone()))?;
    let Some(file) = app.dialog().file().add_filter("CloudHub SQL", &["sql"]).set_file_name(format!("cloudhub-plaintext-{}.sql", Utc::now().format("%Y%m%d-%H%M%S"))).blocking_save_file() else { return Ok(None); };
    let path = file.into_path().map_err(|_| "保存位置无效")?;
    let mut conn = open_db()?;
    let tx = conn.transaction().map_err(|_| "读取一致性快照失败")?;
    let key = Zeroizing::new(crypto_key_bytes()?);
    let bytes = export_portable(&tx, &key, &tables, include_trash)?;
    write_new_or_replace(&path, bytes.as_bytes())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

struct Parser<'a> { rest: &'a str }
impl<'a> Parser<'a> {
    fn ws(&mut self) { self.rest = self.rest.trim_start_matches(char::is_whitespace); }
    fn take(&mut self, token: &str) -> Result<(), String> { self.ws(); self.rest = self.rest.strip_prefix(token).ok_or_else(err)?; Ok(()) }
    fn quoted(&mut self, quote: char) -> Result<String, String> {
        self.ws();
        if !self.rest.starts_with(quote) { return Err(err()); }
        self.rest = &self.rest[quote.len_utf8()..];
        let mut result = String::new();
        loop {
            let index = self.rest.find(quote).ok_or_else(err)?;
            result.push_str(&self.rest[..index]);
            self.rest = &self.rest[index + quote.len_utf8()..];
            if self.rest.starts_with(quote) { result.push(quote); self.rest = &self.rest[quote.len_utf8()..]; }
            else { return Ok(result); }
        }
    }
    fn value(&mut self) -> Result<Value, String> {
        self.ws();
        if self.rest.starts_with('\'') { return self.quoted('\'').map(Value::Text); }
        if self.rest.starts_with("X'") { self.rest = &self.rest[1..]; return hex::decode(self.quoted('\'')?).map(Value::Blob).map_err(|_| err()); }
        let n = self.rest.find(|c: char| c == ',' || c == ')' || c.is_whitespace()).ok_or_else(err)?;
        let token = &self.rest[..n]; self.rest = &self.rest[n..];
        if token == "NULL" { return Ok(Value::Null); }
        if let Ok(integer) = token.parse::<i64>() { return Ok(Value::Integer(integer)); }
        let real = token.parse::<f64>().map_err(|_| err())?;
        if !real.is_finite() { return Err(err()); }
        Ok(Value::Real(real))
    }
}

fn load_sql(conn: &mut Connection, input: &str, key: &[u8]) -> Result<Vec<String>, String> {
    if input.len() as u64 > MAX_SQL { return Err(err()); }
    let tail = input.strip_prefix(HEADER).ok_or_else(err)?;
    let (schema, tail) = tail.split_once('\n').ok_or_else(err)?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|_| err())?;
    if schema != format!("-- schema: {version}") { return Err("SQL 数据版本与当前客户端不一致，请使用相同数据库版本的客户端".into()); }
    let (tables, tail) = tail.split_once('\n').ok_or_else(err)?;
    let names = tables.strip_prefix("-- tables: ").ok_or_else(err)?.split(',').map(String::from).collect::<Vec<_>>();
    let tables = selected(Some(names.clone()))?;
    if tables != names { return Err(err()); }
    let (_, tail) = tail.strip_prefix("-- WARNING: ").ok_or_else(err)?.split_once('\n').ok_or_else(err)?;
    let (requested,tail)=if let Some(rest)=tail.strip_prefix("-- requested: ") {
        let (line,tail)=rest.split_once('\n').ok_or_else(err)?;
        let requested=line.split(',').map(String::from).collect::<Vec<_>>();
        if selected(Some(requested.clone()))?!=tables {return Err(err());}
        (requested,tail)
    }else{(tables.clone(),tail)};
    let tx = conn.transaction().map_err(|_| err())?;
    tx.execute_batch("CREATE TABLE cloudhub_sql_scope(name TEXT PRIMARY KEY)").map_err(|_|err())?;
    for table in requested {tx.execute("INSERT INTO cloudhub_sql_scope VALUES(?1)",[table]).map_err(|_|err())?;}
    let mut parser = Parser { rest: tail };
    let mut count = 0usize;
    loop {
        parser.ws(); if parser.rest.is_empty() { break; }
        let portable_id=if parser.rest.starts_with("-- record: ") {
            let (line,tail)=parser.rest.split_once('\n').ok_or_else(err)?;
            let id=line.strip_prefix("-- record: ").ok_or_else(err)?;
            if id.len()!=64 || !id.bytes().all(|byte|byte.is_ascii_hexdigit()) {return Err(err());}
            parser.rest=tail; Some(id.to_string())
        }else{None};
        count += 1; if count > 100_000 { return Err("SQL 记录超过 100000 条限制".into()); }
        parser.take("INSERT INTO ")?;
        let table = parser.quoted('"')?;
        if !tables.contains(&table) { return Err(err()); }
        parser.take("(")?;
        let expected = columns(&tx, &table)?;
        let mut fields = Vec::new();
        loop { fields.push(parser.quoted('"')?); parser.ws(); if parser.rest.starts_with(')') { parser.take(")")?; break; } parser.take(",")?; if fields.len() > 128 { return Err(err()); } }
        if fields != expected { return Err(err()); }
        parser.take("VALUES (")?;
        let mut values = Vec::new();
        for (i, name) in fields.iter().enumerate() {
            if i > 0 { parser.take(",")?; }
            let mut value = parser.value()?;
            value = policy::convert(&table, name, policy::clean_value(&table, name, value), None, Some(key))?;
            if policy::target_table(&table) == "client_preferences" && name == "key" && !matches!(&value, Value::Text(key) if policy::preference_module(key)==Some(table.as_str())) { return Err(err()); }
            values.push(value);
        }
        parser.take(")")?; parser.take(";")?;
        let sql = format!("INSERT INTO {} ({}) VALUES ({})", ident(&table), fields.iter().map(|name| ident(name)).collect::<Vec<_>>().join(","), vec!["?"; fields.len()].join(","));
        tx.execute(&sql, params_from_iter(values.iter())).map_err(|_| err())?;
        if let Some(id)=portable_id {tx.execute("INSERT INTO cloudhub_transfer_ids VALUES(?1,?2,?3)",rusqlite::params![table,tx.last_insert_rowid(),id]).map_err(|_|err())?;}
    }
    tx.commit().map_err(|_| err())?;
    Ok(tables)
}

fn create_stage(source: &Connection, target: &Path) -> Result<Connection, String> {
    let conn = Connection::open(target).map_err(|_| err())?;
    // Only schema from this running client's database is trusted. No imported DDL.
    for (table, _) in TABLES {
        if policy::virtual_table(table) {
            conn.execute_batch(&format!("CREATE TABLE {table}(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0)")).map_err(|_| err())?;
            continue;
        }
        let ddl: String = source.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1", [table], |row| row.get(0)).map_err(|_| err())?;
        conn.execute_batch(&ddl).map_err(|_| err())?;
    }
    let version: i64 = source.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|_| err())?;
    conn.pragma_update(None, "user_version", version).map_err(|_| err())?;
    copy_indexes(source, &conn)?;
    conn.execute_batch("CREATE TABLE cloudhub_transfer_ids(table_name TEXT,source_rowid INTEGER,portable_id TEXT,PRIMARY KEY(table_name,source_rowid),UNIQUE(table_name,portable_id))").map_err(|_|err())?;
    Ok(conn)
}

// Work on a private in-memory copy: never modify the live OTP vault or cache.
pub(crate) fn portable_copy(source: &Connection, key: &[u8], include_trash: bool, include_authenticator: bool) -> Result<Connection, String> {
    let copy = create_stage(source, Path::new(":memory:"))?;
    for (table, _) in TABLES { copy_table(source, &copy, table)?; }
    if policy::exists(source,"data_transfer_identity")? {
        copy.execute_batch("CREATE TABLE data_transfer_identity(table_name TEXT,portable_id TEXT,target_rowid INTEGER,PRIMARY KEY(table_name,portable_id))").map_err(|_|err())?;
        copy_table(source,&copy,"data_transfer_identity")?;
    }
    policy::project_preferences(&copy)?;
    if policy::exists(source, "authenticator_vault")? {
        let ddl: String = source.query_row("SELECT sql FROM sqlite_master WHERE name='authenticator_vault'", [], |r| r.get(0)).map_err(|_| err())?;
        copy.execute_batch(&ddl).map_err(|_| err())?;
        copy_table(source, &copy, "authenticator_vault")?;
    }
    if include_authenticator { policy::export_authenticator(&copy, key)?; }
    if !include_trash { remove_trash(&copy)?; }
    Ok(copy)
}
pub(crate) fn remove_trash(copy:&Connection) -> Result<(),String> {
        for (table, _) in TABLES {
            if columns(&copy, table)?.iter().any(|c| c == "deleted_at") { copy.execute(&format!("DELETE FROM {} WHERE deleted_at IS NOT NULL", ident(table)), []).map_err(|_| err())?; }
        }
        // Drop children whose parent was in the recycle bin.
        for (child, field, parent) in [("ssh_connections","account_id","cloud_accounts"),("certificate_versions","certificate_id","certificates"),("frp_local_proxies","server_id","frp_local_servers"),("frp_clients","managed_host_id","managed_hosts"),("esa_certificate_deployments","account_id","cloud_accounts"),("esa_certificate_deployments","certificate_id","certificates")] {
            copy.execute(&format!("DELETE FROM {child} WHERE {field} NOT IN (SELECT id FROM {parent})"), []).map_err(|_| err())?;
        }
        for (child, field, parent) in [("managed_hosts","source_account_id","cloud_accounts"),("panel_connections","source_account_id","cloud_accounts"),("certificates","account_id","cloud_accounts"),("certificate_source_links","panel_id","panel_connections"),("certificate_source_links","certificate_id","certificates")] {
            copy.execute(&format!("UPDATE {child} SET {field}=NULL WHERE {field} NOT IN (SELECT id FROM {parent})"), []).map_err(|_| err())?;
        }
        copy.execute("DELETE FROM rdp_connections WHERE (target_key LIKE 'asset:%' AND CAST(substr(target_key,7) AS INTEGER) NOT IN (SELECT id FROM cloud_accounts)) OR (target_key LIKE 'managed:%' AND CAST(substr(target_key,9) AS INTEGER) NOT IN (SELECT id FROM managed_hosts)) OR (target_key LIKE 'managed-host:%' AND CAST(substr(target_key,14) AS INTEGER) NOT IN (SELECT id FROM managed_hosts))", []).map_err(|_| err())?;
    Ok(())
}

pub(crate) fn staged_copy(source: &Connection) -> Result<Connection,String> {
    let copy=create_stage(source,Path::new(":memory:"))?;
    for (table,_) in TABLES { copy_table(source,&copy,table)?; }
    policy::project_preferences(&copy)?;
    if policy::exists(source,"cloudhub_transfer_ids")? {copy_table(source,&copy,"cloudhub_transfer_ids")?;}
    Ok(copy)
}

pub(crate) fn export_portable(source: &Connection, key: &[u8], tables: &[String], include_trash: bool) -> Result<Zeroizing<String>, String> {
    let copy = portable_copy(source, key, include_trash, tables.iter().any(|table| table == "authenticator_entries"))?;
    // Callers may already have expanded the scope. New callers pass explicit scope.
    prune_dependencies(&copy, tables)?;
    dump_scoped(&copy, key, &selected(Some(tables.to_vec()))?,tables)
}

pub(crate) fn import_portable(target: &Connection, input: &str, key: &[u8], mode: &str) -> Result<(u64,u64,u64), String> {
    import_portable_scoped(target, input, key, mode, None)
}

pub(crate) fn import_portable_scoped(target: &Connection, input: &str, key: &[u8], mode: &str, requested: Option<&[String]>) -> Result<(u64,u64,u64), String> {
    import_with_device_key(target,input,key,mode,requested,None)
}
fn import_with_device_key(target: &Connection, input: &str, key: &[u8], mode: &str, requested: Option<&[String]>, planning_key:Option<&[u8;32]>) -> Result<(u64,u64,u64), String> {
    let mut stage = create_stage(target, Path::new(":memory:"))?;
    let tables = load_sql(&mut stage, input, key)?;
    if tables.iter().any(|t| t == "authenticator_entries") && table_count(&stage, "authenticator_entries")? > 0 {
        let device_key = if let Some(key)=planning_key { Zeroizing::new(*key) } else { crate::core::authenticator::vault::read_device_key(&crate::core::authenticator::vault::device_key_path()?)? };
        policy::import_authenticator(&stage, key, &device_key)?;
        policy::reconcile_authenticator(target, &stage, &device_key, mode == "merge")?;
    }
    let mut retained = HashMap::new();
    let stored_scope=read_scope(&stage)?;
    let explicit = requested.unwrap_or(&stored_scope);
    let counts = apply_rows_scoped(target, &stage, &tables, mode, explicit, &mut retained, Some(key))?;
    if mode == "replace" {
        // Upsert first so unchanged parents retain their local IDs and children.
        for (table, _) in TABLES.iter().rev().filter(|(t,_)| explicit.iter().any(|v| v == t)) {
            let target_name = policy::target_table(table);
            let keep = retained.get(*table).cloned().unwrap_or_default();
            let mut stmt = target.prepare(&format!("SELECT rowid FROM {}",ident(target_name))).map_err(|_| err())?;
            let ids = stmt.query_map([], |r| r.get::<_,i64>(0)).map_err(|_| err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| err())?;
            drop(stmt);
            for id in ids.into_iter().filter(|id| !keep.contains(id)) {
                // A partial replacement must never cascade into an unselected module.
                for (child, _) in TABLES.iter().filter(|(name,_)| !explicit.iter().any(|t| t == name) && !policy::virtual_table(name)) {
                    let mut refs = target.prepare(&format!("PRAGMA foreign_key_list({})", ident(child))).map_err(|_| err())?;
                    let links = refs.query_map([], |r| Ok((r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).map_err(|_| err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| err())?;
                    let mut links=links;
                    let fields=columns(target,child)?;
                    for (field,parent) in [("account_id","cloud_accounts"),("source_account_id","cloud_accounts"),("managed_host_id","managed_hosts"),("ssh_managed_host_id","managed_hosts"),("certificate_id","certificates"),("panel_id","panel_connections"),("server_id","frp_local_servers")] {
                        if fields.iter().any(|name|name==field) {links.push((parent.into(),field.into(),"id".into()));}
                    }
                    if *child=="memo_notes" {links.push(("memo_groups".into(),"group_name".into(),"name".into()));}
                    for (parent, field, referenced) in links.into_iter().filter(|(parent,_,_)| parent == table) {
                        let found: bool = target.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {} WHERE {} IN (SELECT {} FROM {} WHERE rowid=?1))", ident(child),ident(&field),ident(&referenced),ident(&parent)),[id],|r|r.get(0)).map_err(|_| err())?;
                        if found { return Err("所选模块被未选择的模块引用；请同时选择关联模块，或使用合并恢复".into()); }
                    }
                }
                if matches!(*table,"cloud_accounts"|"managed_hosts") {
                    if !explicit.iter().any(|t|t=="rdp_connections") {
                        let mut stmt=target.prepare("SELECT target_key FROM rdp_connections").map_err(|_|err())?;
                        let keys=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_|err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|err())?;
                        let prefixes=if *table=="cloud_accounts" {&["asset:"][..]}else{&["managed:","managed-host:"][..]};
                        if keys.iter().any(|key|prefixes.iter().any(|prefix|key.strip_prefix(prefix).and_then(|rest|rest.split(':').next()).and_then(|id|id.parse::<i64>().ok())==Some(id))) {return Err("所选记录仍被 RDP 连接引用，请同时选择关联模块或使用追加恢复".into());}
                    }
                    if !explicit.iter().any(|t|t=="transfer_asset_metadata") {
                        let mut stmt=target.prepare("SELECT key,value FROM client_preferences").map_err(|_|err())?;
                        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_|err())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|err())?;
                        for (key,value) in rows.into_iter().filter(|(key,_)|policy::preference_module(key)==Some("transfer_asset_metadata")) {
                            if metadata_ids(&key,&value)?.iter().any(|(parent,reference)|parent==table&&*reference==id) {return Err("所选记录仍被资产自定义信息引用，请同时选择关联模块或使用追加恢复".into());}
                        }
                    }
                }
                if target_name == "client_preferences" {
                    let key: String = target.query_row("SELECT key FROM client_preferences WHERE rowid=?1", [id], |r| r.get(0)).map_err(|_| err())?;
                    if policy::preference_module(&key) != Some(*table) { continue; }
                }
                target.execute(&format!("DELETE FROM {} WHERE rowid=?1", ident(target_name)), [id]).map_err(|_| "替换模块时存在关联冲突，已取消全部恢复")?;
            }
        }
    }
    Ok(counts)
}

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ModuleImpact { pub table:String, pub label:String, pub added:u64, pub updated:u64, pub skipped:u64, pub deleted:u64 }

pub(crate) fn revision(db: &Connection) -> Result<String,String> {
    let mut hash=Sha256::new();
    for (table,_) in TABLES.iter().filter(|(table,_)|!policy::virtual_table(table)) {
        hash.update(table.as_bytes());
        let mut stmt=db.prepare(&format!("SELECT * FROM {} ORDER BY rowid",ident(table))).map_err(|_|err())?;
        let count=stmt.column_count();
        let mut rows=stmt.query([]).map_err(|_|err())?;
        while let Some(row)=rows.next().map_err(|_|err())? {
            for index in 0..count { let value:Value=row.get(index).map_err(|_|err())?; let bytes=format!("{value:?}"); hash.update((bytes.len() as u64).to_le_bytes()); hash.update(bytes.as_bytes()); }
        }
    }
    Ok(format!("{:x}",hash.finalize()))
}

pub(crate) fn plan_import(current:&Connection,input:&str,key:&[u8],mode:&str,requested:&[String]) -> Result<Vec<ModuleImpact>,String> {
    let validation=create_stage(current,Path::new(":memory:"))?;
    for (table,_) in TABLES {copy_table(current,&validation,table)?;}
    if policy::exists(current,"data_transfer_identity")? {
        validation.execute_batch("CREATE TABLE data_transfer_identity(table_name TEXT,portable_id TEXT,target_rowid INTEGER,PRIMARY KEY(table_name,portable_id))").map_err(|_|err())?;
        copy_table(current,&validation,"data_transfer_identity")?;
    }
    validation.execute_batch("CREATE TEMP TABLE transfer_events(t TEXT,e TEXT,r INTEGER,PRIMARY KEY(t,e,r))").map_err(|_|err())?;
    for (table,_) in TABLES.iter().filter(|(table,_)|!policy::virtual_table(table)) {
        for (event,action,row) in [("added","INSERT","NEW"),("updated","UPDATE","NEW"),("deleted","DELETE","OLD")] {
            let module=if *table=="client_preferences" {
                format!("CASE {row}.key WHEN 'cloud.drive.connections' THEN 'transfer_cloud_drive' WHEN 'cloudhub-tools-favorite-assets' THEN 'transfer_asset_metadata' WHEN 'cloudhub-tools-favorite-asset-order' THEN 'transfer_asset_metadata' WHEN 'cloudhub-tools-asset-notes' THEN 'transfer_asset_metadata' WHEN 'cloudhub-tools-asset-order' THEN 'transfer_asset_metadata' WHEN 'cloudhub-tools-asset-display-names' THEN 'transfer_asset_metadata' WHEN 'cloudhub-tools-managed-host-order' THEN 'transfer_asset_metadata' ELSE 'client_preferences' END")
            } else {format!("'{table}'")};
            validation.execute_batch(&format!("CREATE TEMP TRIGGER plan_{table}_{event} AFTER {action} ON {} BEGIN INSERT OR IGNORE INTO transfer_events VALUES({module},'{event}',{row}.rowid); END;",ident(table))).map_err(|_|err())?;
        }
    }
    let planning_key=if table_count(current,"authenticator_entries")?==0 { Some([0x51;32]) }else{None};
    import_with_device_key(&validation,input,key,mode,Some(requested),planning_key.as_ref())?;
    let incoming=portable_preview(current,input,key)?;
    incoming.into_iter().map(|category| {
        let count=|event:&str| -> Result<u64,String> { validation.query_row("SELECT count(*) FROM transfer_events WHERE t=?1 AND e=?2",rusqlite::params![category.table,event],|r|r.get(0)).map_err(|_|err()) };
        let added=count("added")?; let updated=count("updated")?; let deleted=count("deleted")?;
        Ok(ModuleImpact { table:category.table,label:category.label,added,updated,skipped:category.count.saturating_sub(added+updated),deleted })
    }).collect()
}

pub(crate) fn portable_preview(source: &Connection, input: &str, key: &[u8]) -> Result<Vec<ImportCategory>, String> {
    let mut stage = create_stage(source, Path::new(":memory:"))?;
    let tables = load_sql(&mut stage, input, key)?;
    tables.iter().map(|table| Ok(ImportCategory { table: table.clone(), label: TABLES.iter().find(|(t,_)| *t == table).ok_or_else(err)?.1.into(), count: table_count(&stage, table)? })).collect()
}

pub(crate) fn filter_portable(source: &Connection, input: &str, key: &[u8], selected_tables: Vec<String>) -> Result<Zeroizing<String>, String> {
    let mut stage = create_stage(source, Path::new(":memory:"))?;
    let allowed = load_sql(&mut stage, input, key)?;
    let tables = selected(Some(selected_tables.clone()))?;
    if tables.iter().any(|table| !allowed.contains(table)) { return Err("所选模块不在迁移包中".into()); }
    prune_dependencies(&stage, &selected_tables)?;
    dump_scoped(&stage, key, &tables,&selected_tables)
}

fn copy_indexes(source: &Connection, target: &Connection) -> Result<(), String> {
    let mut stmt = source.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").map_err(|_| err())?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|_| err())?;
    for row in rows {
        let (table, ddl) = row.map_err(|_| err())?;
        if allowed(&table) { target.execute_batch(&ddl).map_err(|_| err())?; }
    }
    Ok(())
}

pub(super) fn prepare(app: &tauri::AppHandle, store: &DatabaseImportStore, mode: &str) -> Result<Option<ImportPreview>, String> {
    if mode != "merge" && mode != "overwrite" { return Err("不支持的 SQL 导入方式".into()); }
    let Some(file) = app.dialog().file().add_filter("CloudHub SQL", &["sql"]).blocking_pick_file() else { return Ok(None); };
    let path = file.into_path().map_err(|_| err())?;
    if fs::metadata(&path).map_err(|_| err())?.len() > MAX_SQL { return Err("SQL 超过 64 MB 限制".into()); }
    let input = Zeroizing::new(fs::read_to_string(&path).map_err(|_| err())?);
    let token = Uuid::new_v4().to_string();
    let target = data_dir()?.join(format!(".cloudhub-sql-preview-{token}.sqlite3"));
    let result = (|| {
        let current = open_db()?;
        let mut stage = create_stage(&current, &target)?;
        let key = Zeroizing::new(crypto_key_bytes()?);
        let tables = load_sql(&mut stage, &input, &key)?;
        let mut categories = Vec::new(); let mut total = 0;
        for table in &tables {
            let count = table_count(&stage, table)?; total += count;
            categories.push(ImportCategory { table: table.clone(), label: TABLES.iter().find(|(name, _)| *name == table).ok_or_else(err)?.1.into(), count });
        }
        // Run the same merge in a rollback-only transaction to validate references,
        // resolve numeric IDs and report conflicts without changing live data.
        let requested=read_scope(&stage)?;
        let impacts=plan_import(&current,&input,&key,mode,&requested)?;
        let (added,changed,skipped)=impacts.iter().fold((0,0,0),|(a,c,s),i|(a+i.added,c+i.updated,s+i.skipped));
        let conflicts = if skipped + changed > 0 { vec![format!("重复记录：覆盖 {changed} 条、跳过 {skipped} 条。确认时会基于最新数据重新检查。") ] } else { vec![] };
        let preview = ImportPreview { token: token.clone(), package_name: path.file_name().and_then(|name| name.to_str()).unwrap_or("SQL").into(), exported_at: "SQL 明文数据交换".into(), total_records: total, categories, details: vec![format!("预计新增 {added} 条、覆盖 {changed} 条、跳过 {skipped} 条；凭据已使用本机密钥重新加密。"), "仅导入所列业务配置；保留本机 Codex 登录账号、设备身份与日志。验证器包含验证码种子。".into(), "SQL 文件本身包含明文凭据、私钥和验证码种子，请妥善保管。".into()], conflicts, import_mode: mode.into() };
        store.sessions.lock().map_err(|_| err())?.insert(token, PreparedImport { database_path: target.clone(), key, sql_mode: Some(mode.into()), plan: None });
        Ok(Some(preview))
    })();
    if result.is_err() { let _ = fs::remove_file(&target); }
    result
}

fn copy_table(source: &Connection, target: &Connection, table: &str) -> Result<(), String> {
    if policy::virtual_table(table) && !policy::exists(source,table)? { return Ok(()); }
    let names = columns(source, table)?;
    let mut stmt = source.prepare(&format!("SELECT * FROM {}", ident(table))).map_err(|_| err())?;
    let mut rows = stmt.query([]).map_err(|_| err())?;
    while let Some(row) = rows.next().map_err(|_| err())? {
        let values = (0..names.len()).map(|i| row.get::<_, Value>(i)).collect::<Result<Vec<_>, _>>().map_err(|_| err())?;
        target.execute(&format!("INSERT INTO {} VALUES ({})", ident(table), vec!["?"; names.len()].join(",")), params_from_iter(values.iter())).map_err(|_| err())?;
    }
    Ok(())
}

fn identity(table: &str) -> &[&str] {
    match table {
        "cloud_accounts" => &["cloud_type", "access_key_id"],
        "managed_hosts" => &["host", "port", "username"],
        "panel_connections" => &["panel_url"],
        "certificates" => &["account_id", "primary_domain", "provider", "serial_number", "created_at"],
        "flow_connections" => &["domain", "organization_id", "name"],
        "frp_local_servers" => &["server_addr", "server_port", "name"],
        "frp_local_proxies" => &["server_id", "name"],
        "certificate_versions" => &["certificate_id", "fingerprint"],
        "certificate_source_links" => &["panel_id", "site_id"],
        "memo_notes" => &["created_at", "title"],
        _ => &[],
    }
}

fn merge_projected(table:&str,local:&str,incoming:&str,key:Option<&[u8]>,mode:&str) -> Result<Option<String>,String> {
    let decode=|raw:&str| -> Result<serde_json::Value,String> {
        let plain=Zeroizing::new(if table=="transfer_cloud_drive" {crate::core::crypto::decrypt_secret_with_key(raw,key.ok_or("缺少云盘恢复密钥")?).map_err(|_|"云盘凭据转换失败")?}else{raw.into()});
        serde_json::from_str(&plain).map_err(|_|"偏好数据格式无效".into())
    };
    let mut result=decode(local)?; let original=result.clone(); let incoming=decode(incoming)?;
    match (&mut result,incoming) {
        (serde_json::Value::Object(target),serde_json::Value::Object(source))=>for (key,value) in source {if mode!="merge" || !target.contains_key(&key) {target.insert(key,value);}},
        (serde_json::Value::Array(target),serde_json::Value::Array(source))=>for mut value in source {
            let matched=target.iter().position(|old|if table=="transfer_cloud_drive" { ["provider","endpoint","bucket","prefix"].iter().all(|field|old.get(field)==value.get(field)) }else{old==&value});
            if let Some(index)=matched {if mode!="merge" {if table=="transfer_cloud_drive" {for field in ["id","mountPoint","cacheDir","autoMount"] {if let Some(local)=target[index].get(field).cloned() {value[field]=local;}}}target[index]=value;}}
            else {if table=="transfer_cloud_drive" {value["id"]=Uuid::new_v4().to_string().into();}target.push(value);}
        },
        _=>return Err("偏好数据格式无效".into()),
    }
    if result==original {return Ok(None);}
    let plain=Zeroizing::new(serde_json::to_string(&result).map_err(|_|"偏好数据格式无效")?);
    Ok(Some(if table=="transfer_cloud_drive" {crate::core::crypto::encrypt_secret_with_key(&plain,key.ok_or("缺少云盘恢复密钥")?)?}else{plain.to_string()}))
}

fn apply_rows(target: &Connection, source: &Connection, tables: &[String], mode: &str) -> Result<(u64, u64, u64), String> {
    apply_rows_tracked(target, source, tables, mode, &mut HashMap::new())
}

fn apply_rows_tracked(target: &Connection, source: &Connection, tables: &[String], mode: &str, retained: &mut HashMap<String,Vec<i64>>) -> Result<(u64, u64, u64), String> {
    apply_rows_scoped(target,source,tables,mode,tables,retained,None)
}
fn apply_rows_scoped(target: &Connection, source: &Connection, tables: &[String], mode: &str, explicit: &[String], retained: &mut HashMap<String,Vec<i64>>, key:Option<&[u8]>) -> Result<(u64, u64, u64), String> {
    target.execute_batch("CREATE TABLE IF NOT EXISTS data_transfer_identity(table_name TEXT,portable_id TEXT,target_rowid INTEGER,PRIMARY KEY(table_name,portable_id))").map_err(|_|err())?;
    for (table,_) in TABLES.iter().filter(|(t,_)|!policy::virtual_table(t)) {
        target.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS transfer_identity_delete_{table} AFTER DELETE ON {} BEGIN DELETE FROM data_transfer_identity WHERE target_rowid=OLD.rowid AND table_name IN ('{table}'{}); END;",ident(table),if *table=="client_preferences" {",'transfer_cloud_drive','transfer_asset_metadata'"}else{""})).map_err(|_|err())?;
    }
    let mut mappings: HashMap<(String, i64), i64> = HashMap::new();
    let mut added = 0; let mut changed = 0; let mut skipped = 0;
    for (table, _) in TABLES.iter().filter(|(name, _)| tables.iter().any(|table| table == name)) {
        let mode = if explicit.iter().any(|name| name == table) { mode } else { "merge" };
        let target_name = policy::target_table(table);
        let fields = columns(source, table)?;
        let mut stmt = source.prepare(&format!("SELECT rowid,* FROM {}", ident(table))).map_err(|_| err())?;
        let mut rows = stmt.query([]).map_err(|_| err())?;
        while let Some(row) = rows.next().map_err(|_| err())? {
            let source_rowid:i64=row.get(0).map_err(|_|err())?;
            let portable_id:Option<String>=if policy::exists(source,"cloudhub_transfer_ids")? {source.query_row("SELECT portable_id FROM cloudhub_transfer_ids WHERE table_name=?1 AND source_rowid=?2",rusqlite::params![table,source_rowid],|r|r.get(0)).optional().map_err(|_|err())?}else{None};
            let mut values = (0..fields.len()).map(|i| row.get::<_, Value>(i+1)).collect::<Result<Vec<_>, _>>().map_err(|_| err())?;
            for (column, parent) in [("account_id", "cloud_accounts"), ("source_account_id", "cloud_accounts"), ("server_id", "frp_local_servers"), ("managed_host_id", "managed_hosts"), ("ssh_managed_host_id", "managed_hosts"), ("certificate_id", "certificates"), ("panel_id", "panel_connections")] {
                if let Some(index) = fields.iter().position(|name| name == column) {
                    if let Value::Integer(old) = values[index] {
                        if let Some(new) = mappings.get(&(parent.into(), old)) { values[index] = Value::Integer(*new); }
                        else if column == "source_account_id" || column == "panel_id" { values[index] = Value::Null; }
                        else { return Err("SQL 缺少关联的父记录，请同时导出云账号、主机或 FRP 服务端".into()); }
                    }
                }
            }
            if *table == "rdp_connections" {
                let index = fields.iter().position(|name| name == "target_key").ok_or_else(err)?;
                if let Value::Text(ref mut text) = values[index] {
                    for (prefix, parent) in [("asset:", "cloud_accounts"), ("managed:", "managed_hosts"), ("managed-host:", "managed_hosts")] {
                        if let Some(rest) = text.strip_prefix(prefix) {
                            let (old, suffix) = rest.split_once(':').map(|(id, suffix)| (id, format!(":{suffix}"))).unwrap_or((rest, String::new()));
                            let old = old.parse::<i64>().map_err(|_| err())?;
                            let new = mappings.get(&(parent.into(), old)).ok_or_else(err)?;
                            *text = format!("{prefix}{new}{suffix}");
                            break;
                        }
                    }
                }
            }
            if *table == "transfer_asset_metadata" {
                let key_index = fields.iter().position(|name| name == "key").ok_or_else(err)?;
                let value_index = fields.iter().position(|name| name == "value").ok_or_else(err)?;
                if let (Value::Text(key),Value::Text(value)) = (&values[key_index], &values[value_index]) {
                    values[value_index] = Value::Text(remap_metadata(key,value,&mappings)?);
                }
            }
            if *table == "client_preferences" {
                let index = fields.iter().position(|name| name == "key").ok_or_else(err)?;
                if !matches!(&values[index],Value::Text(key) if policy::preference_module(key)==Some("client_preferences")) { continue; }
            }
            // Imported sync IDs must not impersonate another device's entities.
            if let Some(index) = fields.iter().position(|name| name == "sync_id") { values[index] = Value::Text(Uuid::new_v4().to_string()); }
            let id_index = fields.iter().position(|name| name == "id").filter(|i| matches!(values[*i], Value::Integer(_)) && !matches!(*table, "frp_local_settings" | "frp_local_client"));
            let natural = if *table == "certificates" && fields.iter().position(|name| name == "fingerprint").is_some_and(|i| matches!(&values[i], Value::Text(text) if !text.is_empty())) { &["fingerprint"][..] } else { identity(table) };
            let mut match_fields = natural.iter().map(|name| name.to_string()).collect::<Vec<_>>();
            if match_fields.is_empty() {
                let mut info = target.prepare(&format!("PRAGMA table_info({})", ident(target_name))).map_err(|_| err())?;
                match_fields = info.query_map([], |row| Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))).map_err(|_| err())?.collect::<Result<Vec<_>, _>>().map_err(|_| err())?.into_iter().filter(|(_, pk)| *pk > 0).map(|(name, _)| name).collect();
            }
            let indexes = match_fields.iter().map(|name| fields.iter().position(|field| field == name).ok_or_else(err)).collect::<Result<Vec<_>, _>>()?;
            let where_sql = match_fields.iter().map(|name| format!("{} IS ?", ident(name))).collect::<Vec<_>>().join(" AND ");
            if where_sql.is_empty() { return Err(err()); }
            let portable_id=if target_name=="client_preferences" {None}else{portable_id};
            let mapped:Option<i64>=if let Some(id)=&portable_id {target.query_row(&format!("SELECT t.rowid FROM {} t JOIN data_transfer_identity m ON m.target_rowid=t.rowid WHERE m.table_name=?1 AND m.portable_id=?2",ident(target_name)),rusqlite::params![table,id],|r|r.get(0)).optional().map_err(|_|err())?}else{None};
            let existing: Option<i64> = if mapped.is_some() {mapped}else{target.query_row(&format!("SELECT rowid FROM {} WHERE {} LIMIT 1", ident(target_name), where_sql), params_from_iter(indexes.iter().map(|i| &values[*i])), |row| row.get(0)).optional().map_err(|_| err())?};
            if let Some(index) = id_index {
                let Value::Integer(old_id) = values[index] else { return Err(err()); };
                let new_id = if let Some(existing) = existing { existing } else { target.query_row(&format!("SELECT COALESCE(MAX(id),0)+1 FROM {}", ident(table)), [], |row| row.get::<_, i64>(0)).map_err(|_| err())? };
                mappings.insert((table.to_string(), old_id), new_id);
                values[index] = Value::Integer(new_id);
            }
            if let Some(existing) = existing {
                if let Some(id)=&portable_id {target.execute("INSERT OR REPLACE INTO data_transfer_identity VALUES(?1,?2,?3)",rusqlite::params![table,id,existing]).map_err(|_|err())?;}
                retained.entry(table.to_string()).or_default().push(existing);
                if policy::virtual_table(table) && mode!="replace" {
                    let index=fields.iter().position(|name|name=="value").ok_or_else(err)?;
                    let Value::Text(ref incoming)=values[index] else{return Err(err());};
                    let local:String=target.query_row("SELECT value FROM client_preferences WHERE rowid=?1",[existing],|r|r.get(0)).map_err(|_|err())?;
                    if let Some(merged)=merge_projected(table,&local,incoming,key,mode)? {
                        target.execute("UPDATE client_preferences SET value=?1 WHERE rowid=?2",rusqlite::params![merged,existing]).map_err(|_|err())?;
                        changed+=1;
                    }else{skipped+=1;}
                    continue;
                }
                if mode == "merge" { skipped += 1; continue; }
                if *table == "ai_profiles" && fields.iter().position(|name| name == "is_default").is_some_and(|i| values[i] == Value::Integer(1)) { target.execute("UPDATE ai_profiles SET is_default=0 WHERE rowid<>?1", [existing]).map_err(|_| err())?; }
                // UPDATE preserves child rows; INSERT OR REPLACE would cascade-delete.
                let updates = fields.iter().enumerate().filter(|(_, name)| name.as_str() != "sync_id").collect::<Vec<_>>();
                let fields_sql = updates.iter().map(|(_, name)| format!("{}=?", ident(name))).collect::<Vec<_>>().join(",");
                let mut args = updates.iter().map(|(index, _)| values[*index].clone()).collect::<Vec<_>>(); args.push(Value::Integer(existing));
                target.execute(&format!("UPDATE {} SET {} WHERE rowid=?", ident(target_name), fields_sql), params_from_iter(args.iter())).map_err(|_| "SQL 记录存在唯一值冲突，已取消全部导入")?;
                changed += 1;
            } else {
                if *table == "ai_profiles" {
                    if let Some(index) = fields.iter().position(|name| name == "is_default") {
                        if values[index] == Value::Integer(1) {
                            if mode == "merge" && target.query_row("SELECT EXISTS(SELECT 1 FROM ai_profiles WHERE is_default=1)", [], |r| r.get::<_,bool>(0)).map_err(|_| err())? { values[index] = Value::Integer(0); }
                            else { target.execute("UPDATE ai_profiles SET is_default=0 WHERE is_default=1", []).map_err(|_| err())?; }
                        }
                    }
                }
                target.execute(&format!("INSERT INTO {} ({}) VALUES ({})", ident(target_name), fields.iter().map(|name| ident(name)).collect::<Vec<_>>().join(","), vec!["?"; fields.len()].join(",")), params_from_iter(values.iter())).map_err(|_| "SQL 记录或关联无效，已取消全部导入")?;
                retained.entry(table.to_string()).or_default().push(target.last_insert_rowid());
                let inserted=target.last_insert_rowid();
                if let Some(id)=&portable_id {target.execute("INSERT OR REPLACE INTO data_transfer_identity VALUES(?1,?2,?3)",rusqlite::params![table,id,inserted]).map_err(|_|err())?;}
                added += 1;
            }
        }
    }
    Ok((added, changed, skipped))
}

pub(super) fn confirm(path: &Path, mode: &str, expected_revision:Option<&str>,include_trash:bool) -> Result<String, String> {
    let stage = Connection::open(path).map_err(|_| err())?;
    let requested=read_scope(&stage)?;
    let tables=selected(Some(requested.clone()))?;
    if !include_trash {remove_trash(&stage)?;}
    prune_dependencies(&stage,&requested)?;
    let mut current = open_db()?;
    if tables.iter().any(|t| t == "authenticator_entries") && table_count(&stage, "authenticator_entries")? > 0 {
        let device_key = crate::core::repositories::authenticator_sync::prepare_key(&mut current)?;
        policy::import_authenticator(&stage, &crypto_key_bytes()?, &device_key)?;
    }
    let tx = current.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "数据库正在使用，请重试")?;
    if expected_revision.is_some_and(|expected|revision(&tx).map_or(true,|actual|actual!=expected)) {return Err("本地数据已变化，请重新预览恢复影响".into());}
    // Recovery snapshot contains the original encrypted fields, never SQL plaintext.
    let recovery = data_dir()?.join(format!("cloudhub_tools.sqlite3.before-sql-{}", Uuid::new_v4()));
    snapshot_database(&recovery)?;
    if tables.iter().any(|t| t == "authenticator_entries") && table_count(&stage, "authenticator_entries")? > 0 {
        let device_key = crate::core::authenticator::vault::read_device_key(&crate::core::authenticator::vault::device_key_path()?)?;
        policy::reconcile_authenticator(&tx, &stage, &device_key, mode == "merge")?;
    }
    let (added, changed, skipped) = apply_rows_scoped(&tx, &stage, &tables, mode,&requested,&mut HashMap::new(),Some(&crypto_key_bytes()?))?;
    super::rebuild_memo_reminders(&tx)?;
    tx.commit().map_err(|_| "SQL 导入未提交，当前数据保持不变")?;
    super::super::cloud_sync::pause_for_restore();
    Ok(format!("SQL 导入完成：新增 {added} 条、覆盖 {changed} 条、跳过 {skipped} 条；导入前数据库快照已保存至数据目录"))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("cloudhub-sql-test-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap(); Self { root }
        }
        fn db(&self, name: &str) -> Connection {
            crate::core::database::open_transfer_test_db(&self.root.join(name)).unwrap()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
    fn account(conn: &Connection, id: i64, name: &str, access: &str, key: &[u8]) {
        let cipher = encrypt_secret_with_key("fixture';\npassword", key).unwrap();
        conn.execute("INSERT INTO cloud_accounts(id,account_name,access_key_id,secret_ciphertext,created_at,updated_at,sync_id) VALUES(?1,?2,?3,?4,1,1,?5)", rusqlite::params![id,name,access,cipher,Uuid::new_v4().to_string()]).unwrap();
    }
    #[test]
    fn persisted_schema_requires_explicit_transfer_classification() {
        let fixture=Fixture::new();let db=fixture.db("coverage.sqlite3");
        let mut stmt=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").unwrap();
        let names=stmt.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        let unknown=names.into_iter().filter(|name|!policy::allowed(name)&&!policy::LOCAL_TABLES.contains(&name.as_str())).collect::<Vec<_>>();
        assert!(unknown.is_empty(),"持久化表需要明确迁移策略：{unknown:?}");
        for key in ["ui.future-credential","memo.future-path","cloud.sync.config","cloud.sync.preview.config","cloudhub-tools-ui-zoom","cloudhub-tools-back-fab-position"] {assert!(!policy::portable_preference(key));}
    }
    #[test]
    fn narrow_replacement_only_imports_required_parents_and_never_replaces_them() {
        let fixture=Fixture::new();let source=fixture.db("source.sqlite3");let mut target=fixture.db("target.sqlite3");
        account(&source,7,"incoming","same-access",&[1;32]);account(&source,8,"unrelated-source","unrelated-access",&[1;32]);
        source.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,updated_at) VALUES(7,'asset','example.test','fixture',1)",[]).unwrap();
        account(&target,42,"keep-name","same-access",&[2;32]);account(&target,43,"keep-local","local-access",&[2;32]);
        target.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,updated_at) VALUES(43,'remove','example.test','fixture',1)",[]).unwrap();
        let requested=vec!["ssh_connections".into()];let input=export_portable(&source,&[1;32],&requested,false).unwrap();
        assert!(!input.contains("unrelated-source"));
        let plan=plan_import(&target,&input,&[2;32],"replace",&requested).unwrap();
        assert_eq!(plan.iter().find(|item|item.table=="cloud_accounts").unwrap().deleted,0);
        assert_eq!(plan.iter().find(|item|item.table=="ssh_connections").unwrap().deleted,1);
        let tx=target.transaction().unwrap();import_portable_scoped(&tx,&input,&[2;32],"replace",Some(&requested)).unwrap();tx.commit().unwrap();
        assert_eq!(table_count(&target,"cloud_accounts").unwrap(),2);
        assert_eq!(target.query_row("SELECT account_name FROM cloud_accounts WHERE id=42",[],|r|r.get::<_,String>(0)).unwrap(),"keep-name");
        assert_eq!(target.query_row("SELECT account_id FROM ssh_connections",[],|r|r.get::<_,i64>(0)).unwrap(),42);
    }
    #[test]
    fn projections_reencrypt_cloud_drive_and_remap_asset_metadata_across_ids() {
        let fixture=Fixture::new();let source=fixture.db("source.sqlite3");let mut target=fixture.db("target.sqlite3");
        account(&source,7,"source","same-access",&[1;32]);account(&target,42,"target","same-access",&[2;32]);
        let config=serde_json::json!([{"id":"fixture","name":"fixture","provider":"Other","endpoint":"https://example.test","bucket":"fixture","prefix":"","secretKey":"fixture-secret","autoMount":true,"mountPoint":"O:","cacheDir":"D:/fixture"}]);
        source.execute("INSERT INTO client_preferences VALUES('cloud.drive.connections',?1,1)",[encrypt_secret_with_key(&config.to_string(),&[1;32]).unwrap()]).unwrap();
        source.execute("INSERT INTO client_preferences VALUES('cloudhub-tools-asset-notes',?1,1)", [r#"{"7:ecs:asset":"note"}"#]).unwrap();
        let requested=vec!["transfer_cloud_drive".into(),"transfer_asset_metadata".into()];
        let input=export_portable(&source,&[1;32],&requested,false).unwrap();
        let tx=target.transaction().unwrap();import_portable_scoped(&tx,&input,&[2;32],"merge",Some(&requested)).unwrap();tx.commit().unwrap();
        let raw:String=target.query_row("SELECT value FROM client_preferences WHERE key='cloud.drive.connections'",[],|r|r.get(0)).unwrap();
        assert!(decrypt_secret_with_key(&raw,&[1;32]).is_err());
        let restored:serde_json::Value=serde_json::from_str(&decrypt_secret_with_key(&raw,&[2;32]).unwrap()).unwrap();
        assert_eq!(restored[0]["secretKey"],"fixture-secret");assert_eq!(restored[0]["autoMount"],false);assert_eq!(restored[0]["mountPoint"],"");assert_eq!(restored[0]["cacheDir"],"");
        let notes:String=target.query_row("SELECT value FROM client_preferences WHERE key='cloudhub-tools-asset-notes'",[],|r|r.get(0)).unwrap();assert!(notes.contains("42:ecs:asset"));
        let plan=plan_import(&target,&input,&[2;32],"merge",&requested).unwrap();assert!(plan.iter().all(|item|item.added==0 && item.deleted==0));
    }
    #[test]
    fn sql_requested_scope_keeps_dependency_updates_out_and_deleted_identity_does_not_attach_reused_id() {
        let fixture=Fixture::new();let source=fixture.db("source.sqlite3");let mut target=fixture.db("target.sqlite3");
        account(&source,7,"incoming","same-access",&[1;32]);account(&target,42,"local-name","same-access",&[2;32]);
        source.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,updated_at) VALUES(7,'fixture','example.test','fixture',1)",[]).unwrap();
        let input=export_portable(&source,&[1;32],&["ssh_connections".into()],false).unwrap();
        {let tx=target.transaction().unwrap();import_portable(&tx,&input,&[2;32],"overwrite").unwrap();tx.commit().unwrap();}
        assert_eq!(target.query_row("SELECT account_name FROM cloud_accounts WHERE id=42",[],|r|r.get::<_,String>(0)).unwrap(),"local-name");
        target.execute("DELETE FROM ssh_connections",[]).unwrap();target.execute("DELETE FROM cloud_accounts WHERE id=42",[]).unwrap();
        assert_eq!(target.query_row("SELECT count(*) FROM data_transfer_identity WHERE table_name='cloud_accounts'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        account(&target,42,"unrelated","unrelated-access",&[2;32]);
        {let tx=target.transaction().unwrap();import_portable(&tx,&input,&[2;32],"merge").unwrap();tx.commit().unwrap();}
        assert_eq!(table_count(&target,"cloud_accounts").unwrap(),2);
        assert_ne!(target.query_row("SELECT account_id FROM ssh_connections",[],|r|r.get::<_,i64>(0)).unwrap(),42);
    }
    #[test]
    fn partial_replace_guards_preferences_and_undeclared_parent_references() {
        let fixture=Fixture::new();let source=fixture.db("source.sqlite3");let mut target=fixture.db("target.sqlite3");
        account(&target,42,"local","fixture-access",&[2;32]);
        target.execute("INSERT INTO client_preferences VALUES('cloudhub-tools-asset-notes',?1,1)",[r#"{"42:ecs:fixture":"note"}"#]).unwrap();
        let requested=vec!["cloud_accounts".into()];let input=export_portable(&source,&[1;32],&requested,false).unwrap();
        assert!(plan_import(&target,&input,&[2;32],"replace",&requested).is_err());
        {let tx=target.transaction().unwrap();assert!(import_portable_scoped(&tx,&input,&[2;32],"replace",Some(&requested)).is_err());}
        assert_eq!(table_count(&target,"cloud_accounts").unwrap(),1);
        target.execute("DELETE FROM client_preferences",[]).unwrap();
        target.execute("INSERT INTO managed_hosts(name,host,username,source_account_id,created_at,updated_at) VALUES('fixture','example.test','fixture',42,1,1)",[]).unwrap();
        assert!(plan_import(&target,&input,&[2;32],"replace",&requested).is_err());
    }
    #[test]
    fn repeated_import_after_title_change_uses_migration_identity_without_reusing_device_identity() {
        let fixture=Fixture::new();let source=fixture.db("source.sqlite3");let mut target=fixture.db("target.sqlite3");
        source.execute("INSERT INTO memo_groups VALUES('fixture',0,1)",[]).unwrap();
        source.execute("INSERT INTO memo_notes(title,group_name,created_at,updated_at) VALUES('before','fixture',1,1)",[]).unwrap();
        let requested=vec!["memo_notes".into()];let input=export_portable(&source,&[1;32],&requested,false).unwrap();
        {let tx=target.transaction().unwrap();import_portable_scoped(&tx,&input,&[2;32],"merge",Some(&requested)).unwrap();tx.commit().unwrap();}
        source.execute("UPDATE memo_notes SET title='after',updated_at=2",[]).unwrap();
        let input=export_portable(&source,&[1;32],&requested,false).unwrap();
        let plan=plan_import(&target,&input,&[2;32],"overwrite",&requested).unwrap();assert_eq!(plan.iter().find(|item|item.table=="memo_notes").unwrap().updated,1);
        {let tx=target.transaction().unwrap();import_portable_scoped(&tx,&input,&[2;32],"overwrite",Some(&requested)).unwrap();tx.commit().unwrap();}
        assert_eq!(table_count(&target,"memo_notes").unwrap(),1);assert_eq!(target.query_row("SELECT title FROM memo_notes",[],|r|r.get::<_,String>(0)).unwrap(),"after");
    }
    #[test]
    fn sql_roundtrip_reencrypts_credentials_and_remaps_relationships() {
        let fixture = Fixture::new();
        let source = fixture.db("source.sqlite3");
        let mut stage = create_stage(&source, &fixture.root.join("stage.sqlite3")).unwrap();
        let mut target = fixture.db("target.sqlite3");
        let old_key = [11u8;32]; let new_key = [22u8;32];
        account(&source, 7, "incoming", "fixture-access", &old_key);
        let cipher = encrypt_secret_with_key("fixture-host-password", &old_key).unwrap();
        source.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,password_ciphertext,updated_at) VALUES(7,'fixture-asset','example.test','fixture',?1,1)", [&cipher]).unwrap();
        source.execute("INSERT INTO managed_hosts(id,name,host,username,password_ciphertext,source_account_id,created_at,updated_at,sync_id) VALUES(9,'fixture','example.test','fixture',?1,7,1,1,'fixture-sync')", [&cipher]).unwrap();
        source.execute("INSERT INTO rdp_connections(target_key,host,username,password_ciphertext,updated_at) VALUES('asset:7:fixture-asset','example.test','fixture',?1,1),('managed:9','example.test','fixture',?1,1)", [&cipher]).unwrap();
        account(&target, 42, "existing", "fixture-access", &new_key);
        let tables = selected(None).unwrap();
        let sql = dump(&source, &old_key, &tables).unwrap();
        assert!(sql.contains("fixture'';\npassword"));
        load_sql(&mut stage, &sql, &new_key).unwrap();
        let tx = target.transaction().unwrap();
        let (added, changed, skipped) = apply_rows(&tx, &stage, &tables, "merge").unwrap();
        assert!(added >= 4); assert_eq!(changed,0); assert!(skipped >= 1); tx.commit().unwrap();
        let (account_id, cipher): (i64,String) = target.query_row("SELECT account_id,password_ciphertext FROM ssh_connections", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(account_id,42);
        assert_eq!(decrypt_secret_with_key(&cipher,&new_key).unwrap(),"fixture-host-password");
        assert!(decrypt_secret_with_key(&cipher,&old_key).is_err());
        assert_eq!(target.query_row("SELECT source_account_id FROM managed_hosts",[],|r|r.get::<_,i64>(0)).unwrap(),42);
        assert_eq!(target.query_row("SELECT COUNT(*) FROM rdp_connections WHERE target_key IN ('asset:42:fixture-asset','managed:1')",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        let sync: String = target.query_row("SELECT sync_id FROM cloud_accounts WHERE id=42",[],|r|r.get(0)).unwrap();
        let tx = target.transaction().unwrap();
        assert!(apply_rows(&tx,&stage,&tables,"overwrite").unwrap().1 >= 1); tx.commit().unwrap();
        let row: (String,String,String) = target.query_row("SELECT account_name,secret_ciphertext,sync_id FROM cloud_accounts WHERE id=42",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(row.0,"incoming"); assert_eq!(row.2,sync);
        assert_eq!(decrypt_secret_with_key(&row.1,&new_key).unwrap(),"fixture';\npassword");
        assert!(!target.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }
    #[test]
    fn untrusted_sql_and_schema_mismatch_roll_back_without_secret_errors() {
        let fixture = Fixture::new(); let source = fixture.db("source.sqlite3");
        account(&source,1,"fixture","fixture-access",&[11u8;32]);
        let tables = selected(Some(vec!["cloud_accounts".into()])).unwrap();
        let sql = dump(&source,&[11u8;32],&tables).unwrap();
        let mut stage = create_stage(&source,&fixture.root.join("stage.sqlite3")).unwrap();
        for suffix in ["ATTACH DATABASE 'fixture' AS injected;", "DROP TABLE cloud_accounts;", "SELECT load_extension('fixture');"] {
            let error = load_sql(&mut stage,&format!("{}{}", &*sql,suffix),&[22u8;32]).unwrap_err();
            assert!(!error.contains("fixture"));
            assert_eq!(stage.query_row("SELECT COUNT(*) FROM cloud_accounts",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        }
        let wrong = sql.replacen("-- schema: ","-- schema: 999",1);
        assert!(load_sql(&mut stage,&wrong,&[22u8;32]).is_err());
    }
    #[test]
    fn invalid_child_rolls_back_whole_merge() {
        let fixture = Fixture::new(); let source = fixture.db("source.sqlite3");
        let mut target = fixture.db("target.sqlite3");
        account(&source,7,"fixture","fixture-access",&[11u8;32]);
        source.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        source.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,updated_at) VALUES(999,'fixture','example.test','fixture',1)",[]).unwrap();
        let tx = target.transaction().unwrap();
        assert!(apply_rows(&tx,&source,&selected(None).unwrap(),"merge").is_err()); drop(tx);
        assert_eq!(target.query_row("SELECT COUNT(*) FROM cloud_accounts",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn recovery_snapshot_can_read_database_under_import_write_lock() {
        let fixture = Fixture::new(); let mut target = fixture.db("target.sqlite3");
        account(&target,1,"fixture","fixture-access",&[11u8;32]);
        let tx = target.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        snapshot_database_at(&fixture.root.join("target.sqlite3"),&fixture.root.join("recovery.sqlite3")).unwrap();
        drop(tx);
        let snapshot = Connection::open(fixture.root.join("recovery.sqlite3")).unwrap();
        assert_eq!(snapshot.query_row("SELECT COUNT(*) FROM cloud_accounts",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn portable_modules_roundtrip_secrets_notes_browser_and_certificate_history() {
        let fixture = Fixture::new(); let source = fixture.db("source.sqlite3");
        let mut stage = create_stage(&source, &fixture.root.join("stage.sqlite3")).unwrap();
        let mut target = fixture.db("target.sqlite3");
        let old = [11u8;32]; let new = [22u8;32];
        let secret = encrypt_secret_with_key("fixture-secret", &old).unwrap();
        source.execute("INSERT INTO codex_model_providers VALUES('provider','fixture','https://example.test','responses','[]','',1,'{}')", []).unwrap();
        source.execute("INSERT INTO codex_provider_keys VALUES('key','provider','fixture',?1,'{}')", [&secret]).unwrap();
        source.execute("INSERT INTO codex_provider_aggregates VALUES('aggregate','fixture','round_robin',1)", []).unwrap();
        source.execute("INSERT INTO codex_provider_aggregate_members VALUES('aggregate',0,'provider','key',1)", []).unwrap();
        let settings = serde_json::json!({"apiKey":format!("cloudhub-encrypted:{secret}"),"name":"fixture"}).to_string();
        source.execute("INSERT INTO claude_providers(id,name,settings_json,website_url,sort_index,is_current,created_at,updated_at) VALUES('claude','fixture',?1,'',0,1,1,1)", [&settings]).unwrap();
        source.execute("INSERT INTO memo_groups VALUES('fixture',0,1)", []).unwrap();
        source.execute("INSERT INTO memo_notes(title,body,group_name,account,password,created_at,updated_at,deleted_at) VALUES('note','memo-body','fixture','fixture-user','fixture-secret',1,2,5)", []).unwrap();
        source.execute("INSERT INTO browser_environments(id,config_json,proxy_secret_ciphertext,created_at,updated_at,last_opened_at) VALUES('browser','{}',?1,1,1,5)", [&secret]).unwrap();
        account(&source,7,"fixture","fixture-access",&old);
        source.execute("INSERT INTO certificates(id,account_id,provider,primary_domain,domains_json,certificate_pem_ciphertext,private_key_ciphertext,created_at,updated_at,fingerprint) VALUES(9,7,'manual','example.test','[]',?1,?1,1,1,'fingerprint')", [&secret]).unwrap();
        source.execute("INSERT INTO certificate_versions(certificate_id,fingerprint,certificate_pem_ciphertext,private_key_ciphertext,created_at) VALUES(9,'old-fingerprint',?1,?1,1)", [&secret]).unwrap();
        let tables=selected(None).unwrap(); let input=dump(&source,&old,&tables).unwrap();
        assert!(input.contains("memo-body")); assert!(!input.contains("cloudhub-encrypted:"));
        load_sql(&mut stage,&input,&new).unwrap();
        let tx=target.transaction().unwrap(); apply_rows(&tx,&stage,&tables,"merge").unwrap(); tx.commit().unwrap();
        let cipher:String=target.query_row("SELECT ciphertext FROM codex_provider_keys",[],|r|r.get(0)).unwrap();
        assert_eq!(decrypt_secret_with_key(&cipher,&new).unwrap(),"fixture-secret");
        assert!(decrypt_secret_with_key(&cipher,&old).is_err());
        let raw:String=target.query_row("SELECT settings_json FROM claude_providers",[],|r|r.get(0)).unwrap();
        let settings:serde_json::Value=serde_json::from_str(&raw).unwrap();
        assert_eq!(decrypt_secret_with_key(settings["apiKey"].as_str().unwrap().strip_prefix("cloudhub-encrypted:").unwrap(),&new).unwrap(),"fixture-secret");
        assert_eq!(target.query_row("SELECT is_current FROM claude_providers",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(target.query_row("SELECT deleted_at FROM memo_notes",[],|r|r.get::<_,i64>(0)).unwrap(),5);
        assert_eq!(target.query_row("SELECT last_opened_at FROM browser_environments",[],|r|r.get::<_,Option<i64>>(0)).unwrap(),None);
        assert!(!target.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }

    #[test]
    fn portable_scope_filters_trash_logs_preferences_and_keeps_backup_trash() {
        let fixture=Fixture::new(); let source=fixture.db("source.sqlite3");
        account(&source,1,"deleted","fixture-access",&[11;32]);
        source.execute("UPDATE cloud_accounts SET deleted_at=5",[]).unwrap();
        source.execute("INSERT INTO memo_groups VALUES('fixture',0,1)",[]).unwrap();
        source.execute("INSERT INTO memo_notes(title,group_name,created_at,updated_at,deleted_at) VALUES('deleted-note','fixture',1,1,5)",[]).unwrap();
        source.execute("INSERT INTO operation_logs(action,result,message,created_at) VALUES('fixture','ok','log-marker',1)",[]).unwrap();
        source.execute("INSERT INTO client_preferences VALUES('cloud.sync.config','local-marker',1),('cloudhub.application-navigation','{}',1)",[]).unwrap();
        let tables=selected(None).unwrap();
        let live=export_portable(&source,&[11;32],&tables,false).unwrap();
        assert!(!live.contains("deleted-note")); assert!(!live.contains("log-marker")); assert!(!live.contains("local-marker"));
        assert!(live.contains("cloudhub.application-navigation"));
        let backup=export_portable(&source,&[11;32],&tables,true).unwrap();
        assert!(backup.contains("deleted-note"));
        assert!(!backup.contains("log-marker"));
    }

    #[test]
    fn replacement_preserves_existing_parent_ids_children_and_local_state() {
        let fixture=Fixture::new(); let source=fixture.db("source.sqlite3"); let mut target=fixture.db("target.sqlite3");
        let old=[11;32]; let new=[22;32];
        account(&source,7,"incoming","fixture-access",&old); account(&target,42,"local","fixture-access",&new);
        target.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,updated_at) VALUES(42,'asset','example.test','fixture',1)",[]).unwrap();
        target.execute("INSERT INTO client_preferences VALUES('cloud.sync.config','local-only',1)",[]).unwrap();
        target.execute("INSERT INTO operation_logs(action,result,message,created_at) VALUES('fixture','ok','local-log',1)",[]).unwrap();
        let tables=selected(Some(vec!["cloud_accounts".into()])).unwrap(); let input=dump(&source,&old,&tables).unwrap();
        let tx=target.transaction().unwrap(); import_portable(&tx,&input,&new,"replace").unwrap(); tx.commit().unwrap();
        assert_eq!(target.query_row("SELECT id FROM cloud_accounts",[],|r|r.get::<_,i64>(0)).unwrap(),42);
        assert_eq!(target.query_row("SELECT account_id FROM ssh_connections",[],|r|r.get::<_,i64>(0)).unwrap(),42);
        assert_eq!(table_count(&target,"operation_logs").unwrap(),1);
        assert_eq!(table_count(&target,"client_preferences").unwrap(),1);
    }
    #[test]
    fn partial_replace_cannot_cascade_into_unselected_modules() {
        let f=Fixture::new(); let source=f.db("source.db"); let mut target=f.db("target.db");
        account(&target,42,"local","local-key",&[1;32]);
        target.execute("INSERT INTO ssh_connections(account_id,asset_key,host,username,updated_at) VALUES(42,'asset','example.test','fixture',1)",[]).unwrap();
        let tables=selected(Some(vec!["cloud_accounts".into()])).unwrap();
        let input=dump(&source,&[1;32],&tables).unwrap();
        { let tx=target.transaction().unwrap(); assert!(import_portable(&tx,&input,&[1;32],"replace").is_err()); }
        assert_eq!(table_count(&target,"cloud_accounts").unwrap(),1);
        assert_eq!(table_count(&target,"ssh_connections").unwrap(),1);
    }
    #[test]
    fn strict_literals_preserve_multiline_secrets_and_reject_expressions() {
        let mut p = Parser { rest: "'fixture'';\nvalue',NULL,123,1.5,X'0102')" };
        assert_eq!(p.value().unwrap(), Value::Text("fixture';\nvalue".into())); p.take(",").unwrap();
        assert_eq!(p.value().unwrap(), Value::Null); p.take(",").unwrap();
        assert_eq!(p.value().unwrap(), Value::Integer(123)); p.take(",").unwrap();
        assert_eq!(p.value().unwrap(), Value::Real(1.5)); p.take(",").unwrap();
        assert_eq!(p.value().unwrap(), Value::Blob(vec![1,2]));
        assert!(Parser { rest: "load_extension('fixture'))" }.value().is_err());
        assert!(Parser { rest: "NaN)" }.value().is_err());
    }
}
