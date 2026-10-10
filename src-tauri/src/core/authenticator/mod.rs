pub mod formats;
pub mod otp;
pub mod vault;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

pub const MAX_ENTRIES: usize = 10_000;
pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;

// Never derive Debug for a credential-bearing type.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub issuer: String,
    pub account: String,
    pub kind: String,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
    pub counter: u64,
    pub secret: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub order: i64,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
impl Zeroize for Entry {
    fn zeroize(&mut self) {
        self.id.zeroize(); self.issuer.zeroize(); self.account.zeroize(); self.secret.zeroize();
        self.kind.zeroize(); self.algorithm.zeroize(); self.digits.zeroize(); self.period.zeroize();
        self.counter.zeroize(); self.group.zeroize(); self.note.zeroize(); self.pinned.zeroize(); self.order.zeroize();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub id: String,
    pub issuer: String,
    pub account: String,
    pub kind: String,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
    pub counter: String,
    pub group: String,
    pub note: String,
    pub pinned: bool,
    pub order: i64,
}

impl Entry {
    pub fn summary(&self) -> EntrySummary {
        EntrySummary {
            id: self.id.clone(),
            issuer: self.issuer.clone(),
            account: self.account.clone(),
            kind: self.kind.clone(),
            algorithm: self.algorithm.clone(),
            digits: self.digits,
            period: self.period,
            counter: self.counter.to_string(),
            group: self.group.clone(),
            note: self.note.clone(),
            pinned: self.pinned,
            order: self.order,
        }
    }
    pub fn validate(&mut self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.id).is_err() {
            return Err("验证码标识无效".into());
        }
        self.issuer = self.issuer.trim().into();
        self.account = self.account.trim().into();
        if self.issuer.is_empty() && self.account.is_empty() {
            return Err("请输入服务商或账户名称".into());
        }
        for (value, limit) in [
            (&self.issuer, 256),
            (&self.account, 512),
            (&self.group, 128),
            (&self.note, 4096),
        ] {
            if value.len() > limit
                || value
                    .chars()
                    .any(|c| c.is_control() && !['\n', '\r', '\t'].contains(&c))
            {
                return Err("名称或备注长度无效".into());
            }
        }
        if !["totp", "hotp", "steam"].contains(&self.kind.as_str())
            || !["SHA1", "SHA256", "SHA512"].contains(&self.algorithm.as_str())
        {
            return Err("验证码类型或算法不受支持".into());
        }
        if self.kind == "steam" {
            if self.digits != 5 || self.period != 30 || self.algorithm != "SHA1" {
                return Err("Steam 必须使用 SHA1、5 位、30 秒周期".into());
            }
        } else if !(6..=8).contains(&self.digits) {
            return Err("验证码位数仅支持 6 至 8 位".into());
        }
        if !(1..=3600).contains(&self.period)
            || !(i32::MIN as i64..=i32::MAX as i64).contains(&self.order)
        {
            return Err("验证码周期或排序序号无效".into());
        }
        let normalized = otp::normalize_secret(&self.secret)?;
        self.secret.zeroize();
        self.secret = normalized;
        Ok(())
    }
    pub fn same_seed(&self, other: &Entry) -> bool {
        self.secret == other.secret
            && self.kind == other.kind
            && self.algorithm == other.algorithm
            && self.digits == other.digits
            && self.period == other.period
    }
}
