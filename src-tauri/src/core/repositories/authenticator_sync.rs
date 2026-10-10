use crate::core::authenticator::{vault, Entry};
use rusqlite::Connection;
use std::collections::HashSet;
use zeroize::Zeroizing;

pub fn validate(entries: &[Entry]) -> Result<(), String> {
    if entries.len() > 100 { return Err("单次迁移最多支持 100 个验证码".into()); }
    let mut ids = HashSet::new();
    let mut seen: Vec<Entry> = vec![];
    for entry in entries {
        let mut checked = entry.clone(); checked.validate()?;
        if !ids.insert(&entry.id) || seen.iter().any(|old| old.same_seed(&checked)) { return Err("迁移包包含重复验证码".into()); }
        seen.push(checked);
    }
    Ok(())
}

pub fn build(conn: &Connection, ids: &[String]) -> Result<Vec<Entry>, String> {
    if ids.is_empty() { return Ok(vec![]); }
    if ids.len() > 100 || ids.iter().collect::<HashSet<_>>().len() != ids.len() { return Err("验证码迁移选择无效".into()); }
    if super::authenticator::header(conn)?.as_deref() != Some(vault::DEVICE_HEADER) { return Err("请先打开验证器并完成旧密码库迁移".into()); }
    let key = vault::read_device_key(&vault::device_key_path()?)?;
    let entries = super::authenticator::selected(conn, &key, ids)?;
    if entries.len() != ids.len() { return Err("验证码迁移选择已失效".into()); }
    validate(&entries)?;
    Ok(entries)
}

pub fn prepare_key(conn: &mut Connection) -> Result<Zeroizing<[u8; 32]>, String> {
    if vault::initialize_device(conn, &vault::device_key_path()?)? != vault::DEVICE_HEADER { return Err("请先打开验证器并迁移旧密码库".into()); }
    vault::read_device_key(&vault::device_key_path()?)
}

// Called inside the same transaction as cloud accounts and other selected records.
pub fn import(conn: &Connection, entries: &[Entry], key: &[u8; 32]) -> Result<(usize, usize), String> {
    validate(entries)?;
    let mut local = super::authenticator::load(conn, key)?;
    let mut added = 0; let mut updated = 0;
    for incoming in entries {
        let mut entry = incoming.clone(); entry.validate()?;
        if let Some(old) = local.iter_mut().find(|item| item.same_seed(&entry)) {
            entry.id = old.id.clone();
            if entry.kind == "hotp" { entry.counter = entry.counter.max(old.counter); }
            super::authenticator::write(conn, key, &entry)?; *old = entry; updated += 1;
        } else {
            if local.iter().any(|item| item.id == entry.id) { return Err("同一验证码标识的密钥已变化，请分别导入为独立条目".into()); }
            if local.len() >= crate::core::authenticator::MAX_ENTRIES { return Err("验证码总数量超过限制".into()); }
            super::authenticator::write(conn, key, &entry)?; local.push(entry); added += 1;
        }
    }
    Ok((added, updated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::authenticator::formats::parse_uri;
    use crate::core::repositories::authenticator;

    #[test]
    fn authenticator_migration_reencrypts_and_preserves_hotp_counter() {
        let source = Connection::open_in_memory().unwrap();
        let target = Connection::open_in_memory().unwrap();
        source.execute_batch(authenticator::SCHEMA).unwrap();
        target.execute_batch(authenticator::SCHEMA).unwrap();
        let mut entry = parse_uri("otpauth://hotp/Example:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=17").unwrap();
        entry.group = "测试分类".into(); entry.pinned = true;
        authenticator::write(&source, &[1; 32], &entry).unwrap();
        let migrated = authenticator::load(&source, &[1; 32]).unwrap();
        assert_eq!(import(&target, &migrated, &[2; 32]).unwrap(), (1, 0));
        assert!(authenticator::load(&target, &[1; 32]).is_err());
        let received = authenticator::load(&target, &[2; 32]).unwrap();
        assert_eq!(received[0].group, "测试分类");
        assert!(received[0].pinned);
        assert_eq!(received[0].secret, entry.secret);
        entry.counter = 19;
        authenticator::write(&target, &[2; 32], &entry).unwrap();
        assert_eq!(import(&target, &migrated, &[2; 32]).unwrap(), (0, 1));
        assert_eq!(authenticator::load(&target, &[2; 32]).unwrap()[0].counter, 19);
    }

    #[test]
    fn authenticator_migration_collision_rolls_back_transaction() {
        let mut target = Connection::open_in_memory().unwrap();
        target.execute_batch(authenticator::SCHEMA).unwrap();
        let existing = parse_uri("otpauth://totp/Example:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        authenticator::write(&target, &[2; 32], &existing).unwrap();
        let fresh = parse_uri("otpauth://totp/Example:new?secret=JBSWY3DPEHPK3PXP").unwrap();
        let mut collision = parse_uri("otpauth://totp/Example:collision?secret=MZXW6YTBOI======").unwrap();
        collision.id = existing.id.clone();
        {
            let transaction = target.transaction().unwrap();
            assert!(import(&transaction, &[fresh, collision], &[2; 32]).is_err());
        }
        assert_eq!(authenticator::load(&target, &[2; 32]).unwrap().len(), 1);
    }
}
