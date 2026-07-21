use crate::config::Config;
use aes::Aes256;
use anyhow::Result;
use ctr::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::Notify,
    time::{sleep, timeout},
};

type Aes256Ctr = ctr::Ctr128BE<Aes256>;
type HmacSha256 = Hmac<Sha256>;

static ACTIVE_TCP_SESSIONS: AtomicU64 = AtomicU64::new(0);

pub struct SessionGuard;

impl SessionGuard {
    pub fn new() -> Self {
        ACTIVE_TCP_SESSIONS.fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        ACTIVE_TCP_SESSIONS.fetch_sub(1, Ordering::Relaxed);
        session_notify().notify_waiters();
    }
}

pub async fn wait_for_session_drain(wait: Duration) -> bool {
    let drain = async {
        loop {
            let notified = session_notify().notified();
            if ACTIVE_TCP_SESSIONS.load(Ordering::Relaxed) == 0 {
                break;
            }
            notified.await;
        }
    };
    timeout(wait, drain).await.is_ok()
}

fn session_notify() -> &'static Notify {
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    NOTIFY.get_or_init(Notify::new)
}

pub struct RateLimiter {
    rate: i64,
    next: Mutex<Option<Instant>>,
}

impl RateLimiter {
    pub fn new(rate: i64) -> Arc<Self> {
        Arc::new(Self {
            rate,
            next: Mutex::new(None),
        })
    }

    pub async fn wait(&self, bytes: usize) {
        if self.rate <= 0 || bytes == 0 {
            return;
        }
        let delay =
            Duration::from_nanos((1_000_000_000u128 * bytes as u128 / self.rate as u128) as u64);
        if delay.is_zero() {
            return;
        }
        let sleep_for = {
            let mut next = self.next.lock().expect("rate limiter lock");
            let now = Instant::now();
            let scheduled = (*next).unwrap_or(now).max(now) + delay;
            *next = Some(scheduled);
            scheduled.saturating_duration_since(now)
        };
        if !sleep_for.is_zero() {
            sleep(sleep_for).await;
        }
    }
}

#[derive(Default)]
pub struct TrafficCounter {
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
}

pub fn start_traffic_reporter(cfg: &Config) -> Arc<TrafficCounter> {
    let counter = Arc::new(TrafficCounter::default());
    let panel_url = cfg.panel_url.trim_end_matches('/').to_string();
    let token = cfg.token.clone();
    let rule_id = cfg.rule_id;
    if panel_url.is_empty() || token.is_empty() || rule_id <= 0 {
        return counter;
    }
    let report_counter = counter.clone();
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build();
        let Ok(client) = client else {
            return;
        };
        let mut last_in = 0u64;
        let mut last_out = 0u64;
        loop {
            sleep(Duration::from_secs(10)).await;
            let current_in = report_counter.bytes_in.load(Ordering::Relaxed);
            let current_out = report_counter.bytes_out.load(Ordering::Relaxed);
            let delta_in = current_in.saturating_sub(last_in);
            let delta_out = current_out.saturating_sub(last_out);
            if delta_in == 0 && delta_out == 0 {
                continue;
            }
            if post_traffic(&client, &panel_url, &token, rule_id, delta_in, delta_out).await {
                last_in = current_in;
                last_out = current_out;
            }
        }
    });
    counter
}

pub fn protocol_blocked(data: &[u8], cfg: &Config) -> Option<&'static str> {
    if cfg.block_http && detect_http(data) {
        return Some("http");
    }
    if cfg.block_tls && detect_tls(data) {
        return Some("tls");
    }
    if cfg.block_socks && detect_socks(data) {
        return Some("socks");
    }
    None
}

pub fn report_protocol_block(cfg: Config, protocol: &'static str) {
    if cfg.panel_url.trim().is_empty() || cfg.token.trim().is_empty() || cfg.rule_id <= 0 {
        return;
    }
    tokio::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        else {
            return;
        };
        let payload = serde_json::json!({
            "ruleId": cfg.rule_id,
            "tunnelId": cfg.tunnel_id,
            "sourcePort": cfg.listen_port,
            "protocol": protocol,
        });
        let Ok(envelope) = encrypted_envelope(&payload, &cfg.token) else {
            return;
        };
        let _ = client
            .post(format!(
                "{}/api/agent/protocol-block",
                cfg.panel_url.trim_end_matches('/')
            ))
            .header("Authorization", format!("Bearer {}", cfg.token))
            .header("Content-Type", "application/json")
            .header("X-Agent-Encrypted", "1")
            .json(&envelope)
            .send()
            .await;
    });
}

async fn post_traffic(
    client: &reqwest::Client,
    panel_url: &str,
    token: &str,
    rule_id: i32,
    bytes_in: u64,
    bytes_out: u64,
) -> bool {
    let payload = serde_json::json!({ "stats": [{ "ruleId": rule_id, "bytesIn": bytes_in, "bytesOut": bytes_out, "connections": 0 }] });
    let Ok(envelope) = encrypted_envelope(&payload, token) else {
        return false;
    };
    match client
        .post(format!("{}/api/agent/traffic", panel_url))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("X-Agent-Encrypted", "1")
        .json(&envelope)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[derive(Serialize)]
struct EncryptedEnvelope {
    #[serde(rename = "v")]
    version: i32,
    #[serde(rename = "iv")]
    iv: String,
    #[serde(rename = "ct")]
    ciphertext: String,
    #[serde(rename = "mac")]
    mac: String,
    #[serde(rename = "ts")]
    timestamp: u128,
}

fn encrypted_envelope<T: Serialize>(payload: &T, token: &str) -> Result<EncryptedEnvelope> {
    let plain = serde_json::to_vec(payload)?;
    let key_enc: [u8; 32] =
        Sha256::digest(format!("{}|forwardx-agent-v1", token).as_bytes()).into();
    let key_mac: [u8; 32] =
        Sha256::digest(format!("{}|forwardx-agent-mac", token).as_bytes()).into();
    let mut iv = [0u8; 16];
    OsRng.fill_bytes(&mut iv);
    let mut ciphertext = plain;
    let mut cipher = Aes256Ctr::new((&key_enc).into(), (&iv).into());
    cipher.apply_keystream(&mut ciphertext);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut mac = HmacSha256::new_from_slice(&key_mac).expect("hmac key");
    mac.update(b"v1");
    mac.update(&iv);
    mac.update(&ciphertext);
    mac.update(&(timestamp as u64).to_be_bytes());
    Ok(EncryptedEnvelope {
        version: 1,
        iv: hex::encode(iv),
        ciphertext: hex::encode(ciphertext),
        mac: hex::encode(mac.finalize().into_bytes()),
        timestamp,
    })
}

fn detect_http(data: &[u8]) -> bool {
    if data.starts_with(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n") {
        return true;
    }
    let upper = String::from_utf8_lossy(&data[..data.len().min(16)]).to_ascii_uppercase();
    [
        "GET ", "POST ", "PUT ", "DELETE ", "HEAD ", "OPTIONS ", "PATCH ", "CONNECT ", "TRACE ",
    ]
    .iter()
    .any(|method| upper.starts_with(method))
}

fn detect_tls(data: &[u8]) -> bool {
    data.len() >= 5 && data[0] == 0x16 && data[1] == 0x03 && (0x01..=0x04).contains(&data[2])
}

fn detect_socks(data: &[u8]) -> bool {
    if data.len() < 2 {
        return false;
    }
    if data[0] == 0x04 {
        return data.len() >= 7 && matches!(data[1], 0x01 | 0x02);
    }
    if data[0] != 0x05 {
        return false;
    }
    let count = data[1] as usize;
    data.len() >= 2 + count
        && data[2..2 + count]
            .iter()
            .any(|method| matches!(method, 0x00 | 0x02))
}
