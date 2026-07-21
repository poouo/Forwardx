use crate::config::Config;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, bail, Result};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        TcpStream,
    },
};

const HANDSHAKE_VERSION: i32 = 2;
const SALT_SIZE: usize = 32;
const MAX_FRAME: usize = 16 * 1024 * 1024;
const ENTRY_TO_EXIT: u32 = 1;
const EXIT_TO_ENTRY: u32 = 2;

#[derive(Clone, Copy)]
struct WireContext {
    name: &'static str,
    session_info: &'static [u8],
    length_ad: &'static [u8],
    payload_ad: &'static [u8],
    master_context: &'static str,
}

const CURRENT_WIRE: WireContext = WireContext {
    name: "current",
    session_info: b"forwardx-fxp-v2 session",
    length_ad: b"forwardx-fxp-v2 length",
    payload_ad: b"forwardx-fxp-v2 payload",
    master_context: "forwardx-fxp-v2 master",
};
const COMPAT_WIRE: WireContext = WireContext {
    name: "2.3.90-compat",
    session_info: b"forwardx-fxp session",
    length_ad: b"forwardx-fxp length",
    payload_ad: b"forwardx-fxp payload",
    master_context: "forwardx-fxp master",
};
const WIRES: [WireContext; 2] = [CURRENT_WIRE, COMPAT_WIRE];

#[derive(Clone)]
struct CryptoState {
    len_write: Aes256Gcm,
    data_write: Aes256Gcm,
    len_read: Aes256Gcm,
    data_read: Aes256Gcm,
    length_ad: &'static [u8],
    payload_ad: &'static [u8],
    write_dir: u32,
    read_dir: u32,
}

pub struct SecureStream {
    stream: TcpStream,
    crypto: CryptoState,
    write_counter: u64,
    read_counter: u64,
}

pub struct SecureReader {
    stream: OwnedReadHalf,
    crypto: CryptoState,
    read_counter: u64,
}

pub struct SecureWriter {
    stream: OwnedWriteHalf,
    crypto: CryptoState,
    write_counter: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Handshake {
    #[serde(rename = "v")]
    pub version: i32,
    #[serde(rename = "ts")]
    pub timestamp: i64,
    #[serde(rename = "tunnelId")]
    pub tunnel_id: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct HelloFrame {
    #[serde(default)]
    pub network: String,
    #[serde(rename = "targetIp", default)]
    pub target_ip: String,
    #[serde(rename = "targetPort", default)]
    pub target_port: u16,
    #[serde(rename = "tunnelId", default)]
    pub tunnel_id: i32,
    #[serde(rename = "ruleId", default)]
    pub rule_id: i32,
    #[serde(rename = "selectionKey", default)]
    pub selection_key: String,
    #[serde(rename = "proxySourceIp", default)]
    pub proxy_source_ip: String,
    #[serde(rename = "proxySourcePort", default)]
    pub proxy_source_port: u16,
    #[serde(rename = "proxyDestIp", default)]
    pub proxy_dest_ip: String,
    #[serde(rename = "proxyDestPort", default)]
    pub proxy_dest_port: u16,
    #[serde(rename = "proxyProtocolExitReceive", default)]
    pub proxy_protocol_exit_receive: bool,
    #[serde(rename = "proxyProtocolExitSend", default)]
    pub proxy_protocol_exit_send: bool,
    #[serde(rename = "proxyProtocolVersion", default)]
    pub proxy_protocol_version: i32,
}

impl SecureStream {
    pub async fn client(mut stream: TcpStream, cfg: &Config, wire: WireChoice) -> Result<Self> {
        let wire = wire.context();
        let mut salt = [0u8; SALT_SIZE];
        OsRng.fill_bytes(&mut salt);
        stream.write_all(&salt).await?;
        let crypto = new_crypto(&cfg.key, &salt, true, wire)?;
        let mut secure = Self {
            stream,
            crypto,
            write_counter: 0,
            read_counter: 0,
        };
        let handshake = serde_json::to_vec(&Handshake {
            version: HANDSHAKE_VERSION,
            timestamp: unix_seconds(),
            tunnel_id: cfg.tunnel_id,
        })?;
        secure.write_frame(&handshake).await?;
        let reply: Handshake = serde_json::from_slice(&secure.read_frame().await?)?;
        if reply.version != HANDSHAKE_VERSION || reply.tunnel_id != cfg.tunnel_id {
            bail!("fxp handshake rejected");
        }
        Ok(secure)
    }

    pub async fn server(mut stream: TcpStream, cfg: &Config) -> Result<Self> {
        let mut salt = [0u8; SALT_SIZE];
        stream.read_exact(&mut salt).await?;
        if !remember_replay(cfg, &salt) {
            bail!("fxp replay detected");
        }

        let mut length_cipher = [0u8; 20];
        stream.read_exact(&mut length_cipher).await?;
        let mut accepted: Option<(CryptoState, usize, WireContext)> = None;
        for wire in WIRES {
            let crypto = new_crypto(&cfg.key, &salt, false, wire)?;
            if let Ok(length) = decrypt_length(&crypto, 0, &length_cipher) {
                accepted = Some((crypto, length, wire));
                break;
            }
        }
        let Some((crypto, length, wire)) = accepted else {
            bail!("fxp handshake rejected");
        };
        let mut data_cipher = vec![0u8; length + 16];
        stream.read_exact(&mut data_cipher).await?;
        let handshake = decrypt_data(&crypto, 0, &data_cipher)?;
        let hello: Handshake =
            serde_json::from_slice(&handshake).map_err(|_| anyhow!("fxp handshake rejected"))?;
        if hello.version != HANDSHAKE_VERSION
            || hello.tunnel_id != cfg.tunnel_id
            || hello.timestamp <= 0
        {
            bail!("fxp handshake rejected");
        }
        if wire.name != CURRENT_WIRE.name {
            eprintln!(
                "forwardx-fxp accepted compatibility wire context={} tunnel={}",
                wire.name, cfg.tunnel_id
            );
        }
        let mut secure = Self {
            stream,
            crypto,
            write_counter: 0,
            read_counter: 1,
        };
        let reply = serde_json::to_vec(&Handshake {
            version: HANDSHAKE_VERSION,
            timestamp: unix_seconds(),
            tunnel_id: cfg.tunnel_id,
        })?;
        secure.write_frame(&reply).await?;
        Ok(secure)
    }

    pub async fn write_frame(&mut self, data: &[u8]) -> Result<()> {
        let counter = self.write_counter;
        self.write_counter = self
            .write_counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("fxp frame counter exhausted"))?;
        write_encrypted_frame(&mut self.stream, &self.crypto, counter, data).await
    }

    pub async fn read_frame(&mut self) -> Result<Vec<u8>> {
        let counter = self.read_counter;
        self.read_counter = self
            .read_counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("fxp frame counter exhausted"))?;
        read_encrypted_frame(&mut self.stream, &self.crypto, counter).await
    }

    pub fn split(self) -> (SecureReader, SecureWriter) {
        let (read, write) = self.stream.into_split();
        (
            SecureReader {
                stream: read,
                crypto: self.crypto.clone(),
                read_counter: self.read_counter,
            },
            SecureWriter {
                stream: write,
                crypto: self.crypto,
                write_counter: self.write_counter,
            },
        )
    }
}

impl SecureReader {
    pub async fn read_frame(&mut self) -> Result<Vec<u8>> {
        let counter = self.read_counter;
        self.read_counter = self
            .read_counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("fxp frame counter exhausted"))?;
        read_encrypted_frame(&mut self.stream, &self.crypto, counter).await
    }
}

impl SecureWriter {
    pub async fn write_frame(&mut self, data: &[u8]) -> Result<()> {
        let counter = self.write_counter;
        self.write_counter = self
            .write_counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("fxp frame counter exhausted"))?;
        write_encrypted_frame(&mut self.stream, &self.crypto, counter, data).await
    }
}

#[derive(Clone, Copy)]
pub enum WireChoice {
    Current,
    Compat,
}
impl WireChoice {
    fn context(self) -> WireContext {
        match self {
            Self::Current => CURRENT_WIRE,
            Self::Compat => COMPAT_WIRE,
        }
    }
    pub fn all() -> [Self; 2] {
        [Self::Current, Self::Compat]
    }
}

fn new_crypto(key: &str, salt: &[u8], client: bool, wire: WireContext) -> Result<CryptoState> {
    let mut sha = Sha256::new();
    sha.update(key.as_bytes());
    let master: [u8; 32] = sha.finalize().into();
    let material = blake3_derive(&master, salt, wire);
    let c2s_len = Aes256Gcm::new_from_slice(&material[0..32])?;
    let c2s_data = Aes256Gcm::new_from_slice(&material[32..64])?;
    let s2c_len = Aes256Gcm::new_from_slice(&material[64..96])?;
    let s2c_data = Aes256Gcm::new_from_slice(&material[96..128])?;
    Ok(if client {
        CryptoState {
            len_write: c2s_len,
            data_write: c2s_data,
            len_read: s2c_len,
            data_read: s2c_data,
            length_ad: wire.length_ad,
            payload_ad: wire.payload_ad,
            write_dir: ENTRY_TO_EXIT,
            read_dir: EXIT_TO_ENTRY,
        }
    } else {
        CryptoState {
            len_write: s2c_len,
            data_write: s2c_data,
            len_read: c2s_len,
            data_read: c2s_data,
            length_ad: wire.length_ad,
            payload_ad: wire.payload_ad,
            write_dir: EXIT_TO_ENTRY,
            read_dir: ENTRY_TO_EXIT,
        }
    })
}

fn blake3_derive(secret: &[u8; 32], salt: &[u8], wire: WireContext) -> [u8; 128] {
    let derive_key = blake3::derive_key(wire.master_context, wire.session_info);
    let mut hasher = blake3::Hasher::new_keyed(&derive_key);
    hasher.update(secret);
    hasher.update(salt);
    let mut material = [0u8; 128];
    hasher.finalize_xof().fill(&mut material);
    material
}

async fn write_encrypted_frame<W: AsyncWrite + Unpin>(
    stream: &mut W,
    crypto: &CryptoState,
    counter: u64,
    data: &[u8],
) -> Result<()> {
    if data.len() > MAX_FRAME {
        bail!("frame too large");
    }
    let plain_length = (data.len() as u32).to_be_bytes();
    let length = crypto
        .len_write
        .encrypt(
            Nonce::from_slice(&frame_nonce(crypto.write_dir, counter, 0)),
            Payload {
                msg: &plain_length,
                aad: crypto.length_ad,
            },
        )
        .map_err(|_| anyhow!("fxp encrypt length failed"))?;
    let payload = crypto
        .data_write
        .encrypt(
            Nonce::from_slice(&frame_nonce(crypto.write_dir, counter, 1)),
            Payload {
                msg: data,
                aad: crypto.payload_ad,
            },
        )
        .map_err(|_| anyhow!("fxp encrypt payload failed"))?;
    stream.write_all(&length).await?;
    stream.write_all(&payload).await?;
    Ok(())
}

async fn read_encrypted_frame<R: AsyncRead + Unpin>(
    stream: &mut R,
    crypto: &CryptoState,
    counter: u64,
) -> Result<Vec<u8>> {
    let mut length_cipher = [0u8; 20];
    stream.read_exact(&mut length_cipher).await?;
    let length = decrypt_length(crypto, counter, &length_cipher)?;
    let mut payload_cipher = vec![0u8; length + 16];
    stream.read_exact(&mut payload_cipher).await?;
    decrypt_data(crypto, counter, &payload_cipher)
}

fn decrypt_length(crypto: &CryptoState, counter: u64, data: &[u8]) -> Result<usize> {
    let bytes = crypto
        .len_read
        .decrypt(
            Nonce::from_slice(&frame_nonce(crypto.read_dir, counter, 0)),
            Payload {
                msg: data,
                aad: crypto.length_ad,
            },
        )
        .map_err(|_| anyhow!("invalid frame length"))?;
    if bytes.len() != 4 {
        bail!("invalid frame length");
    }
    let length = u32::from_be_bytes(bytes.try_into().expect("frame length")) as usize;
    if length > MAX_FRAME {
        bail!("invalid frame size {}", length);
    }
    Ok(length)
}

fn decrypt_data(crypto: &CryptoState, counter: u64, data: &[u8]) -> Result<Vec<u8>> {
    crypto
        .data_read
        .decrypt(
            Nonce::from_slice(&frame_nonce(crypto.read_dir, counter, 1)),
            Payload {
                msg: data,
                aad: crypto.payload_ad,
            },
        )
        .map_err(|_| anyhow!("invalid frame authentication"))
}

fn frame_nonce(direction: u32, counter: u64, kind: u8) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(&direction.to_be_bytes());
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    nonce[3] ^= kind;
    nonce
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn replay_cache() -> &'static Mutex<HashMap<String, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_replay(cfg: &Config, salt: &[u8]) -> bool {
    let scope = format!(
        "{}:{}:{}:{}",
        cfg.tunnel_id,
        cfg.rule_id,
        cfg.listen_port,
        hex::encode(salt)
    );
    let now = Instant::now();
    let mut cache = replay_cache().lock().expect("replay cache lock");
    if let Some(expires) = cache.get(&scope).copied() {
        if expires > now {
            return false;
        }
        cache.remove(&scope);
    }
    if cache.len() >= 100_000 {
        cache.retain(|_, expires| *expires > now);
        if cache.len() >= 100_000 {
            let remove = cache.len() - 99_999;
            let keys: Vec<_> = cache.keys().take(remove).cloned().collect();
            for key in keys {
                cache.remove(&key);
            }
        }
    }
    cache.insert(scope, now + Duration::from_secs(300));
    true
}
