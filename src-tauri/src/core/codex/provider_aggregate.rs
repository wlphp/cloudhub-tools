use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Strategy {
    Failover,
    RoundRobin,
    WeightedRoundRobin,
}

#[derive(Clone, Debug)]
pub struct Member {
    pub key_id: String,
    pub models: Vec<String>,
    pub weight: u32,
}

pub struct Selector {
    strategy: Strategy,
    members: Vec<Member>,
    cursors: Mutex<HashMap<String, usize>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregateInput {
    pub id: Option<String>,
    pub version: Option<i64>,
    pub name: String,
    pub strategy: Strategy,
    pub members: Vec<AggregateMemberInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregateMemberInput {
    pub provider_id: String,
    pub key_id: String,
    pub weight: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateMember {
    pub provider_id: String,
    pub key_id: String,
    pub provider_name: String,
    pub key_name: String,
    pub wire_api: String,
    pub models: Vec<String>,
    pub weight: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub id: String,
    pub version: i64,
    pub name: String,
    pub strategy: Strategy,
    pub models: Vec<String>,
    pub members: Vec<AggregateMember>,
}

pub fn list(conn: &Connection) -> Result<Vec<Aggregate>, String> {
    let mut statement = conn
        .prepare("SELECT id,name,strategy,version FROM codex_provider_aggregates ORDER BY name COLLATE NOCASE,id")
        .map_err(|_| "读取聚合供应商失败")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|_| "读取聚合供应商失败")?;
    let headers = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "读取聚合供应商失败")?;
    let providers = super::providers::list(conn)?;
    headers
        .into_iter()
        .map(|(id, name, strategy, version)| {
            let strategy = parse_strategy(&strategy)?;
            let mut members_statement = conn
                .prepare("SELECT provider_id,key_id,weight FROM codex_provider_aggregate_members WHERE aggregate_id=?1 ORDER BY position")
                .map_err(|_| "读取聚合成员失败")?;
            let rows = members_statement
                .query_map([&id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                    ))
                })
                .map_err(|_| "读取聚合成员失败")?;
            let mut members = Vec::new();
            let mut models = Vec::new();
            for row in rows {
                let (provider_id, key_id, weight) =
                    row.map_err(|_| "读取聚合成员失败")?;
                let provider = providers
                    .iter()
                    .find(|provider| provider.id == provider_id)
                    .ok_or("聚合供应商成员已失效")?;
                let key = provider
                    .keys
                    .iter()
                    .find(|key| key.id == key_id)
                    .ok_or("聚合供应商密钥已失效")?;
                let effective = super::providers::effective_settings(provider, key);
                for model in &effective.models {
                    if !models.contains(model) {
                        models.push(model.clone());
                    }
                }
                members.push(AggregateMember {
                    provider_id,
                    key_id,
                    provider_name: provider.name.clone(),
                    key_name: key.name.clone(),
                    wire_api: provider.wire_api.clone(),
                    models: effective.models,
                    weight,
                });
            }
            Ok(Aggregate {
                id,
                version,
                name,
                strategy,
                models,
                members,
            })
        })
        .collect()
}

fn parse_strategy(value: &str) -> Result<Strategy, String> {
    match value {
        "failover" => Ok(Strategy::Failover),
        "roundRobin" => Ok(Strategy::RoundRobin),
        "weightedRoundRobin" => Ok(Strategy::WeightedRoundRobin),
        _ => Err("聚合策略无效".into()),
    }
}

fn strategy_name(strategy: Strategy) -> &'static str {
    match strategy {
        Strategy::Failover => "failover",
        Strategy::RoundRobin => "roundRobin",
        Strategy::WeightedRoundRobin => "weightedRoundRobin",
    }
}

pub fn save(conn: &mut Connection, input: AggregateInput) -> Result<Vec<Aggregate>, String> {
    if input.name.trim().is_empty()
        || input.name.trim().len() > 100
        || input.name.chars().any(char::is_control)
        || !(2..=50).contains(&input.members.len())
        || input
            .id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err("聚合名称、成员数量或标识无效".into());
    }
    let mut seen = std::collections::HashSet::new();
    for member in &input.members {
        if member.weight == 0
            || member.weight > 100
            || uuid::Uuid::parse_str(&member.provider_id).is_err()
            || uuid::Uuid::parse_str(&member.key_id).is_err()
            || !seen.insert((&member.provider_id, &member.key_id))
        {
            return Err("聚合成员或权重无效".into());
        }
    }
    let available = super::providers::list(conn)?;
    for member in &input.members {
        let provider = available
            .iter()
            .find(|provider| provider.id == member.provider_id)
            .ok_or("聚合供应商不存在")?;
        if provider.wire_api != "chat_completions"
            || !provider.keys.iter().any(|key| key.id == member.key_id)
        {
            return Err("聚合目前要求成员均为有效的 Chat Completions 密钥".into());
        }
    }
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let tx = conn.transaction().map_err(|_| "保存聚合供应商失败")?;
    if input.id.is_some() {
        let active: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM codex_provider_bindings WHERE provider_id=?1)",
                [format!("aggregate:{id}")],
                |row| row.get(0),
            )
            .map_err(|_| "读取聚合绑定失败")?;
        if active {
            return Err("请先恢复应用此聚合配置的 Codex 目标，再修改聚合".into());
        }
        if tx
            .execute(
                "UPDATE codex_provider_aggregates SET name=?1,strategy=?2,version=version+1 WHERE id=?3 AND version=?4",
                params![input.name.trim(), strategy_name(input.strategy), id, input.version],
            )
            .map_err(|_| "保存聚合供应商失败")?
            != 1
        {
            return Err("聚合供应商已被修改，请刷新后重试".into());
        }
    } else {
        tx.execute(
            "INSERT INTO codex_provider_aggregates(id,name,strategy,version) VALUES(?1,?2,?3,1)",
            params![id, input.name.trim(), strategy_name(input.strategy)],
        )
        .map_err(|_| "保存聚合供应商失败")?;
    }
    tx.execute(
        "DELETE FROM codex_provider_aggregate_members WHERE aggregate_id=?1",
        [&id],
    )
    .map_err(|_| "保存聚合成员失败")?;
    for (position, member) in input.members.iter().enumerate() {
        tx.execute(
            "INSERT INTO codex_provider_aggregate_members(aggregate_id,position,provider_id,key_id,weight) VALUES(?1,?2,?3,?4,?5)",
            params![id, position, member.provider_id, member.key_id, member.weight],
        )
        .map_err(|_| "保存聚合成员失败")?;
    }
    tx.commit().map_err(|_| "保存聚合供应商失败")?;
    list(conn)
}

pub fn remove(conn: &Connection, id: &str, version: i64) -> Result<Vec<Aggregate>, String> {
    let active: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM codex_provider_bindings WHERE provider_id=?1)",
            [format!("aggregate:{id}")],
            |row| row.get(0),
        )
        .map_err(|_| "读取聚合绑定失败")?;
    if active {
        return Err("请先恢复应用此聚合配置的 Codex 目标，再删除聚合".into());
    }
    let tx = conn.unchecked_transaction().map_err(|_| "删除聚合供应商失败")?;
    let account_ids = {
        let mut statement = tx
            .prepare("SELECT account_id FROM codex_provider_accounts WHERE provider_id=?1")
            .map_err(|_| "读取聚合账号关联失败")?;
        let rows = statement
            .query_map([format!("aggregate:{id}")], |row| row.get::<_, i64>(0))
            .map_err(|_| "读取聚合账号关联失败")?;
        let values = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| "读取聚合账号关联失败")?;
        values
    };
    if tx
        .execute(
            "DELETE FROM codex_provider_aggregates WHERE id=?1 AND version=?2",
            params![id, version],
        )
        .map_err(|_| "删除聚合供应商失败")?
        != 1
    {
        return Err("聚合供应商已被修改，请刷新后重试".into());
    }
    tx.execute(
        "DELETE FROM codex_provider_aggregate_members WHERE aggregate_id=?1",
        [id],
    )
    .map_err(|_| "清理聚合成员失败")?;
    tx.execute(
        "DELETE FROM codex_provider_accounts WHERE provider_id=?1",
        [format!("aggregate:{id}")],
    )
    .map_err(|_| "清理聚合账号关联失败")?;
    for account_id in account_ids {
        tx.execute(
            "DELETE FROM codex_accounts WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM codex_profiles WHERE account_id=?1)",
            [account_id],
        )
        .map_err(|_| "清理聚合账号失败")?;
    }
    tx.commit().map_err(|_| "删除聚合供应商失败")?;
    list(conn)
}

impl Selector {
    pub fn new(strategy: Strategy, members: Vec<Member>) -> Result<Self, String> {
        if members.is_empty()
            || members.len() > 50
            || members.iter().any(|member| {
                member.key_id.is_empty()
                    || member.models.is_empty()
                    || member.models.len() > 200
                    || !(1..=100).contains(&member.weight)
            })
        {
            return Err("聚合成员配置无效".into());
        }
        let mut ids = std::collections::HashSet::new();
        if members.iter().any(|member| !ids.insert(member.key_id.as_str())) {
            return Err("聚合成员不能重复".into());
        }
        Ok(Self {
            strategy,
            members,
            cursors: Mutex::new(HashMap::new()),
        })
    }

    pub fn plan(&self, model: &str) -> Result<Vec<usize>, String> {
        let candidates = self
            .members
            .iter()
            .enumerate()
            .filter_map(|(index, member)| member.models.iter().any(|v| v == model).then_some(index))
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Err("模型不在聚合成员目录中".into());
        }
        let mut cursors = self.cursors.lock().map_err(|_| "聚合路由状态不可用")?;
        let cursor = cursors.entry(model.to_owned()).or_default();
        match self.strategy {
            Strategy::Failover | Strategy::RoundRobin => {
                let offset = if self.strategy == Strategy::Failover {
                    candidates
                        .iter()
                        .position(|index| *index >= *cursor)
                        .unwrap_or(0)
                } else {
                    *cursor % candidates.len()
                };
                let ordered = candidates[offset..]
                    .iter()
                    .chain(&candidates[..offset])
                    .copied()
                    .collect::<Vec<_>>();
                if self.strategy == Strategy::RoundRobin {
                    *cursor = (*cursor + 1) % candidates.len();
                }
                Ok(ordered)
            }
            Strategy::WeightedRoundRobin => {
                let mut schedule = Vec::new();
                for index in &candidates {
                    schedule.extend(std::iter::repeat_n(
                        *index,
                        self.members[*index].weight as usize,
                    ));
                }
                let offset = *cursor % schedule.len();
                let mut ordered = Vec::new();
                for index in schedule[offset..].iter().chain(&schedule[..offset]) {
                    if !ordered.contains(index) {
                        ordered.push(*index);
                    }
                }
                *cursor = (*cursor + 1) % schedule.len();
                Ok(ordered)
            }
        }
    }

    pub fn record_success(&self, model: &str, member_index: usize) -> Result<(), String> {
        if self.members.get(member_index).is_none_or(|member| !member.models.iter().any(|value| value == model)) {
            return Err("聚合成员索引无效".into());
        }
        if self.strategy == Strategy::Failover {
            self.cursors.lock().map_err(|_| "聚合路由状态不可用")?.insert(model.to_owned(), member_index);
        }
        Ok(())
    }

    pub fn record_rate_limit(&self, model: &str, member_index: usize) -> Result<(), String> {
        if self.members.get(member_index).is_none_or(|member| !member.models.iter().any(|value| value == model)) {
            return Err("聚合成员索引无效".into());
        }
        if self.strategy == Strategy::Failover {
            self.cursors.lock().map_err(|_| "聚合路由状态不可用")?.insert(
                model.to_owned(), (member_index + 1) % self.members.len());
        }
        Ok(())
    }
}

pub fn safe_to_retry(status: u16, response_started: bool) -> bool {
    status == 429 && !response_started
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (Connection, Vec<String>, Vec<String>) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::core::database::CODEX_PROVIDERS_SCHEMA).unwrap();
        conn.execute_batch("ALTER TABLE codex_model_providers ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'; ALTER TABLE codex_provider_keys ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';").unwrap();
        conn.execute_batch(crate::core::database::CODEX_PROVIDER_AGGREGATES_SCHEMA).unwrap();
        conn.execute_batch("CREATE TABLE codex_provider_bindings(home TEXT,provider_id TEXT); CREATE TABLE codex_provider_accounts(account_id INTEGER,provider_id TEXT,key_id TEXT); CREATE TABLE codex_profiles(account_id INTEGER); CREATE TABLE codex_accounts(id INTEGER);").unwrap();
        let ids = (0..2).map(|_| uuid::Uuid::new_v4().to_string()).collect::<Vec<_>>();
        let key_ids = (0..2).map(|_| uuid::Uuid::new_v4().to_string()).collect::<Vec<_>>();
        for (index, (id, key_id)) in ids.iter().zip(&key_ids).enumerate() {
            conn.execute("INSERT INTO codex_model_providers(id,name,base_url,wire_api,models_json,note,version,settings_json) VALUES(?1,?2,'https://example.com/v1','chat_completions','[\"shared\",\"model\"]','',1,'{}')", params![id,format!("Supplier {index}")]).unwrap();
            conn.execute("INSERT INTO codex_provider_keys(id,provider_id,name,ciphertext,settings_json) VALUES(?1,?2,'primary','cipher','{}')", params![key_id,id]).unwrap();
        }
        (conn, ids, key_ids)
    }

    #[test]
    fn aggregate_crud_validates_members_and_protects_member_suppliers() {
        let (mut conn, providers, keys) = database();
        let input = AggregateInput {
            id: None,
            version: None,
            name: "Shared pool".into(),
            strategy: Strategy::WeightedRoundRobin,
            members: providers.iter().enumerate().map(|(index, provider_id)| AggregateMemberInput {
                provider_id: provider_id.clone(),
                key_id: keys[index].clone(),
                weight: (index + 1) as u32,
            }).collect(),
        };
        let aggregate = save(&mut conn, input).unwrap().remove(0);
        assert_eq!(aggregate.models, vec!["shared", "model"]);
        assert_eq!(aggregate.members[1].weight, 2);

        let provider = super::super::providers::list(&conn).unwrap().remove(0);
        assert!(super::super::providers::remove(&conn, &provider.id, provider.version).is_err());

        let update = AggregateInput {
            id: Some(aggregate.id.clone()),
            version: Some(aggregate.version),
            name: "Updated pool".into(),
            strategy: Strategy::Failover,
            members: aggregate.members.iter().map(|member| AggregateMemberInput {
                provider_id: member.provider_id.clone(),
                key_id: member.key_id.clone(),
                weight: member.weight,
            }).collect(),
        };
        let updated = save(&mut conn, update).unwrap().remove(0);
        assert_eq!(updated.version, aggregate.version + 1);
        assert!(remove(&conn, &updated.id, aggregate.version).is_err());
        remove(&conn, &updated.id, updated.version).unwrap();
        let provider = super::super::providers::list(&conn).unwrap().remove(0);
        assert_eq!(super::super::providers::remove(&conn, &provider.id, provider.version).unwrap().len(), 1);
    }

    fn members() -> Vec<Member> {
        vec![
            Member {
                key_id: "key-a".into(),
                models: vec!["shared".into(), "only-a".into()],
                weight: 2,
            },
            Member {
                key_id: "key-b".into(),
                models: vec!["shared".into()],
                weight: 1,
            },
            Member {
                key_id: "key-c".into(),
                models: vec!["other".into()],
                weight: 1,
            },
        ]
    }

    #[test]
    fn model_routes_exclude_members_without_that_model() {
        let selector = Selector::new(Strategy::Failover, members()).unwrap();
        assert_eq!(selector.plan("only-a").unwrap(), vec![0]);
        assert_eq!(selector.plan("missing").unwrap_err(), "模型不在聚合成员目录中");
    }

    #[test]
    fn failover_sticks_to_successful_member_and_advances_after_explicit_429() {
        let selector = Selector::new(Strategy::Failover, members()).unwrap();
        assert_eq!(selector.plan("shared").unwrap(), vec![0, 1]);
        selector.record_success("shared", 1).unwrap();
        assert_eq!(selector.plan("shared").unwrap(), vec![1, 0]);
        selector.record_success("only-a", 0).unwrap();
        assert_eq!(selector.plan("shared").unwrap(), vec![1, 0]);
        assert!(selector.record_success("other", 1).is_err());
        assert!(selector.record_rate_limit("missing", 0).is_err());
        selector.record_rate_limit("shared", 1).unwrap();
        assert_eq!(selector.plan("shared").unwrap(), vec![0, 1]);
    }

    #[test]
    fn weighted_and_round_robin_plans_are_deterministic() {
        let weighted = Selector::new(Strategy::WeightedRoundRobin, members()).unwrap();
        assert_eq!(weighted.plan("shared").unwrap(), vec![0, 1]);
        assert_eq!(weighted.plan("shared").unwrap(), vec![0, 1]);
        assert_eq!(weighted.plan("shared").unwrap(), vec![1, 0]);

        let round_robin = Selector::new(Strategy::RoundRobin, members()).unwrap();
        assert_eq!(round_robin.plan("shared").unwrap(), vec![0, 1]);
        assert_eq!(round_robin.plan("shared").unwrap(), vec![1, 0]);
    }

    #[test]
    fn interleaved_models_preserve_each_models_rotation_and_weights() {
        let round_robin = Selector::new(Strategy::RoundRobin, members()).unwrap();
        let mut selected = Vec::new();
        for _ in 0..4 {
            selected.push(round_robin.plan("shared").unwrap()[0]);
            assert_eq!(round_robin.plan("only-a").unwrap(), vec![0]);
        }
        assert_eq!(selected, vec![0, 1, 0, 1]);

        let weighted = Selector::new(Strategy::WeightedRoundRobin, members()).unwrap();
        let mut selected = Vec::new();
        for _ in 0..6 {
            selected.push(weighted.plan("shared").unwrap()[0]);
            assert_eq!(weighted.plan("other").unwrap(), vec![2]);
        }
        assert_eq!(selected, vec![0, 0, 1, 0, 0, 1]);
    }

    #[test]
    fn retries_only_explicit_rejection_before_any_response() {
        assert!(safe_to_retry(429, false));
        for (status, started) in [(408, false), (500, false), (503, false), (429, true)] {
            assert!(!safe_to_retry(status, started));
        }
    }
}
