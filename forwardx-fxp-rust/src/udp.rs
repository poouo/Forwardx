use crate::{
    config::{Config, ExitEndpoint},
    runtime::{RateLimiter, TrafficCounter},
    selector::{ExitSelector, SelectedEndpoint},
};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{lookup_host, UdpSocket},
    sync::{mpsc, Mutex},
    time::{sleep, timeout},
};

const MAGIC: &[u8; 4] = b"FXPU";
const VERSION: u8 = 3;
const TYPE_DATA: u8 = 1;
const TYPE_RETURN: u8 = 2;
const HEADER_SIZE: usize = 32;
const TAG_SIZE: usize = 16;
const MAX_DATAGRAM: usize = 65_507;
const MAX_WIRE: usize = 1200;
const FRAGMENT_SIZE: usize = MAX_WIRE - HEADER_SIZE - TAG_SIZE;
const UDP_IDLE_MS: u64 = 10 * 60 * 1000;
const LISTEN_BUFFER_BYTES: libc::c_int = 4 * 1024 * 1024;
const SESSION_BUFFER_BYTES: libc::c_int = 512 * 1024;
const SESSION_QUEUE_SIZE: usize = 512;
const DROP_LOG_INTERVAL_MS: u64 = 5_000;
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
struct Packet {
    packet_type: u8,
    tunnel_id: i32,
    rule_id: i32,
    session_id: u64,
    sequence: u64,
    fragment: u8,
    fragments: u8,
    payload: Vec<u8>,
}

#[derive(Default)]
struct ReplayWindow {
    initialized: bool,
    highest: u64,
    seen: u64,
}

impl ReplayWindow {
    fn accept(&mut self, sequence: u64) -> bool {
        if sequence == 0 {
            return false;
        }
        if !self.initialized {
            self.initialized = true;
            self.highest = sequence;
            self.seen = 1;
            return true;
        }
        if sequence > self.highest {
            let shift = sequence - self.highest;
            self.seen = if shift >= 64 {
                1
            } else {
                (self.seen << shift) | 1
            };
            self.highest = sequence;
            return true;
        }
        let distance = self.highest - sequence;
        if distance >= 64 {
            return false;
        }
        let bit = 1u64 << distance;
        if self.seen & bit != 0 {
            return false;
        }
        self.seen |= bit;
        true
    }
}

struct FragmentAssembly {
    fragments: u8,
    chunks: Vec<Option<Vec<u8>>>,
    total: usize,
    created_ms: u64,
}
#[derive(Default)]
struct Reassembler {
    pending: HashMap<u64, FragmentAssembly>,
}

impl Reassembler {
    fn accept(&mut self, packet: &Packet, replay: &mut ReplayWindow) -> Option<Vec<u8>> {
        if !valid_fragment(packet.fragment, packet.fragments) {
            return None;
        }
        if packet.fragments == 0 {
            return replay
                .accept(packet.sequence)
                .then(|| packet.payload.clone());
        }
        if packet.payload.is_empty() || packet.payload.len() > FRAGMENT_SIZE {
            return None;
        }
        let now = now_ms();
        self.pending
            .retain(|_, value| now.saturating_sub(value.created_ms) < 5_000);
        if !self.pending.contains_key(&packet.sequence) && self.pending.len() >= 8 {
            if let Some(oldest) = self
                .pending
                .iter()
                .min_by_key(|(_, value)| value.created_ms)
                .map(|(key, _)| *key)
            {
                self.pending.remove(&oldest);
            }
        }
        let assembly = self
            .pending
            .entry(packet.sequence)
            .or_insert_with(|| FragmentAssembly {
                fragments: packet.fragments,
                chunks: vec![None; packet.fragments as usize],
                total: 0,
                created_ms: now,
            });
        if assembly.fragments != packet.fragments {
            self.pending.remove(&packet.sequence);
            return None;
        }
        let index = packet.fragment as usize;
        if assembly.chunks[index].is_some() {
            return None;
        }
        assembly.total += packet.payload.len();
        if assembly.total > MAX_DATAGRAM {
            self.pending.remove(&packet.sequence);
            return None;
        }
        assembly.chunks[index] = Some(packet.payload.clone());
        if assembly.chunks.iter().any(Option::is_none) {
            return None;
        }
        let assembly = self.pending.remove(&packet.sequence)?;
        if !replay.accept(packet.sequence) {
            return None;
        }
        let mut payload = Vec::with_capacity(assembly.total);
        for chunk in assembly.chunks {
            payload.extend_from_slice(chunk.as_deref()?);
        }
        Some(payload)
    }
}

pub async fn run_entry(
    cfg: Arc<Config>,
    selector: Arc<ExitSelector>,
    in_limit: Arc<RateLimiter>,
    out_limit: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
) -> Result<()> {
    let socket = Arc::new(bind_udp(&cfg.listen_host, cfg.udp_listen_port).await?);
    tune_udp_socket(&socket, "entry", LISTEN_BUFFER_BYTES);
    eprintln!(
        "entry udp listening on :{} tunnel={} rule={}",
        cfg.udp_listen_port, cfg.tunnel_id, cfg.rule_id
    );
    let by_client: Arc<Mutex<HashMap<SocketAddr, Arc<EntrySession>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let by_id: Arc<Mutex<HashMap<u64, Arc<EntrySession>>>> = Arc::new(Mutex::new(HashMap::new()));
    spawn_entry_cleanup(by_client.clone(), by_id.clone());
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    loop {
        let (length, source) = socket.recv_from(&mut buffer).await?;
        let source = normalize_socket_addr(source);
        let raw = &buffer[..length];
        if let Some(session_id) = raw_session_id(raw) {
            let session = by_id.lock().await.get(&session_id).cloned();
            if let Some(session) = session {
                if source == session.remote {
                    if let Ok(packet) = open_packet(raw, &session.endpoint_key) {
                        if packet.packet_type == TYPE_RETURN && matches_config(&packet, &cfg) {
                            let payload = {
                                let mut fragments = session.return_fragments.lock().await;
                                let mut replay = session.return_replay.lock().await;
                                fragments.accept(&packet, &mut replay)
                            };
                            if let Some(payload) = payload {
                                if session.to_client.try_send(payload).is_ok() {
                                    session.touch();
                                } else {
                                    log_udp_drop(format_args!(
                                        "entry udp response queue full tunnel={} rule={} client={}",
                                        cfg.tunnel_id, cfg.rule_id, session.client
                                    ));
                                }
                            }
                            continue;
                        }
                    }
                }
            }
        }
        let payload = raw.to_vec();
        let existing = { by_client.lock().await.get(&source).cloned() };
        let session =
            if let Some(current) = existing {
                current
            } else {
                let selected = match pick_udp_endpoint(&selector, &source.ip().to_string()).await {
                    Ok(Some(selected)) => selected,
                    Ok(None) => continue,
                    Err(error) => {
                        log_udp_drop(format_args!(
                            "entry udp session create failed tunnel={} rule={} client={}: {}",
                            cfg.tunnel_id, cfg.rule_id, source, error
                        ));
                        continue;
                    }
                };
                let session = EntrySession::new(
                    source,
                    selected,
                    cfg.clone(),
                    socket.clone(),
                    in_limit.clone(),
                    out_limit.clone(),
                    traffic.clone(),
                );
                by_client.lock().await.insert(source, session.clone());
                by_id
                    .lock()
                    .await
                    .insert(session.session_id, session.clone());
                verbose_log!(
                "entry udp direct session started tunnel={} rule={} client={} exit={} session={}",
                cfg.tunnel_id, cfg.rule_id, source, session.remote, session.session_id
            );
                session
            };
        if session.to_exit.try_send(payload).is_ok() {
            session.touch();
        } else {
            log_udp_drop(format_args!(
                "entry udp send queue full tunnel={} rule={} client={}",
                cfg.tunnel_id, cfg.rule_id, source
            ));
        }
    }
}

pub async fn run_exit(cfg: Arc<Config>) -> Result<()> {
    let socket = Arc::new(bind_udp(&cfg.listen_host, cfg.udp_listen_port).await?);
    tune_udp_socket(&socket, "exit", LISTEN_BUFFER_BYTES);
    eprintln!(
        "exit udp listening on :{} tunnel={}",
        cfg.udp_listen_port, cfg.tunnel_id
    );
    let sessions: Arc<Mutex<HashMap<String, Arc<ExitSession>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    spawn_exit_cleanup(sessions.clone());
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    loop {
        let (length, peer) = socket.recv_from(&mut buffer).await?;
        let peer = normalize_socket_addr(peer);
        let Ok(packet) = open_packet(&buffer[..length], &cfg.key) else {
            continue;
        };
        if packet.packet_type != TYPE_DATA || !matches_config(&packet, &cfg) {
            continue;
        }
        let Some(target) = cfg.udp_target(packet.rule_id).cloned() else {
            eprintln!(
                "exit udp direct target missing tunnel={} rule={} peer={}",
                cfg.tunnel_id, packet.rule_id, peer
            );
            continue;
        };
        let key = session_key(peer, packet.session_id);
        let existing = sessions.lock().await.get(&key).cloned();
        let session = match existing {
            Some(session)
                if session.active.load(Ordering::Relaxed)
                    && session.target_ip == target.target_ip
                    && session.target_port == target.target_port =>
            {
                session
            }
            stale => {
                if let Some(stale) = stale {
                    stale.active.store(false, Ordering::Relaxed);
                }
                let target_socket = match connect_udp(&target.target_ip, target.target_port).await {
                    Ok(socket) => Arc::new(socket),
                    Err(error) => {
                        log_udp_drop(format_args!(
                            "exit udp session create failed tunnel={} rule={} peer={} target={}:{}: {}",
                            cfg.tunnel_id,
                            packet.rule_id,
                            peer,
                            target.target_ip,
                            target.target_port,
                            error
                        ));
                        continue;
                    }
                };
                tune_udp_socket(&target_socket, "exit target", SESSION_BUFFER_BYTES);
                let (to_target, target_rx) = mpsc::channel(SESSION_QUEUE_SIZE);
                let session = Arc::new(ExitSession::new(
                    peer,
                    packet.session_id,
                    packet.rule_id,
                    target.target_ip,
                    target.target_port,
                    target_socket,
                    to_target,
                ));
                sessions.lock().await.insert(key, session.clone());
                spawn_exit_target_writer(cfg.clone(), session.clone(), target_rx);
                spawn_exit_response(cfg.clone(), socket.clone(), session.clone());
                verbose_log!("exit udp direct session routed tunnel={} rule={} peer={} target={}:{} session={}", cfg.tunnel_id, packet.rule_id, peer, session.target_ip, session.target_port, session.session_id);
                session
            }
        };
        let payload = {
            let mut fragments = session.data_fragments.lock().await;
            let mut replay = session.data_replay.lock().await;
            fragments.accept(&packet, &mut replay)
        };
        if let Some(payload) = payload {
            if session.to_target.try_send(payload).is_ok() {
                session.touch();
            } else {
                log_udp_drop(format_args!(
                    "exit udp target queue full tunnel={} rule={} peer={} target={}:{}",
                    cfg.tunnel_id,
                    session.rule_id,
                    session.peer,
                    session.target_ip,
                    session.target_port
                ));
            }
        }
    }
}

pub async fn run_relay(cfg: Arc<Config>, selector: Arc<ExitSelector>) -> Result<()> {
    let socket = Arc::new(bind_udp(&cfg.listen_host, cfg.udp_listen_port).await?);
    tune_udp_socket(&socket, "relay", LISTEN_BUFFER_BYTES);
    eprintln!(
        "relay udp listening on :{} tunnel={} next={}:{}",
        cfg.udp_listen_port, cfg.tunnel_id, cfg.relay_exit_host, cfg.udp_relay_exit_port
    );
    let by_upstream: Arc<Mutex<HashMap<String, Arc<RelaySession>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let by_id: Arc<Mutex<HashMap<u64, Arc<RelaySession>>>> = Arc::new(Mutex::new(HashMap::new()));
    spawn_relay_cleanup(by_upstream.clone(), by_id.clone());
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    loop {
        let (length, source) = socket.recv_from(&mut buffer).await?;
        let source = normalize_socket_addr(source);
        let raw = &buffer[..length];
        let Some(session_id) = raw_session_id(raw) else {
            continue;
        };
        if let Some(session) = by_id.lock().await.get(&session_id).cloned() {
            if source == session.downstream {
                if let Ok(packet) = open_packet(raw, &session.endpoint_key) {
                    if packet.packet_type == TYPE_RETURN && matches_config(&packet, &cfg) {
                        let payload = {
                            let mut fragments = session.return_fragments.lock().await;
                            let mut replay = session.return_replay.lock().await;
                            fragments.accept(&packet, &mut replay)
                        };
                        if let Some(payload) = payload {
                            if session.to_upstream.try_send(payload).is_ok() {
                                session.touch();
                            } else {
                                log_udp_drop(format_args!(
                                    "relay udp upstream queue full tunnel={} rule={} upstream={}",
                                    cfg.tunnel_id, session.rule_id, session.upstream
                                ));
                            }
                        }
                    }
                }
                continue;
            }
        }
        let Ok(packet) = open_packet(raw, &cfg.key) else {
            continue;
        };
        if packet.packet_type != TYPE_DATA || !matches_config(&packet, &cfg) {
            continue;
        }
        let key = session_key(source, session_id);
        let existing = { by_upstream.lock().await.get(&key).cloned() };
        let session = if let Some(session) = existing {
            session
        } else {
            let selected = match pick_udp_endpoint(&selector, &session_id.to_string()).await {
                Ok(Some(selected)) => selected,
                Ok(None) => continue,
                Err(error) => {
                    log_udp_drop(format_args!(
                        "relay udp session create failed tunnel={} rule={} upstream={}: {}",
                        cfg.tunnel_id, packet.rule_id, source, error
                    ));
                    continue;
                }
            };
            let session = RelaySession::new(
                source,
                selected,
                packet.rule_id,
                session_id,
                cfg.clone(),
                socket.clone(),
            );
            by_upstream.lock().await.insert(key, session.clone());
            by_id.lock().await.insert(session_id, session.clone());
            verbose_log!("relay udp direct session routed tunnel={} rule={} upstream={} downstream={} session={}", cfg.tunnel_id, packet.rule_id, source, session.downstream, session_id);
            session
        };
        let payload = {
            let mut fragments = session.data_fragments.lock().await;
            let mut replay = session.data_replay.lock().await;
            fragments.accept(&packet, &mut replay)
        };
        if let Some(payload) = payload {
            if session.to_downstream.try_send(payload).is_ok() {
                session.touch();
            } else {
                log_udp_drop(format_args!(
                    "relay udp downstream queue full tunnel={} rule={} downstream={}",
                    cfg.tunnel_id, session.rule_id, session.downstream
                ));
            }
        }
    }
}

struct EntrySession {
    client: SocketAddr,
    remote: SocketAddr,
    endpoint_key: String,
    session_id: u64,
    to_exit: mpsc::Sender<Vec<u8>>,
    to_client: mpsc::Sender<Vec<u8>>,
    return_replay: Mutex<ReplayWindow>,
    return_fragments: Mutex<Reassembler>,
    last_activity: Arc<AtomicU64>,
}

fn spawn_entry_cleanup(
    by_client: Arc<Mutex<HashMap<SocketAddr, Arc<EntrySession>>>>,
    by_id: Arc<Mutex<HashMap<u64, Arc<EntrySession>>>>,
) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(15)).await;
            let cutoff = now_ms().saturating_sub(UDP_IDLE_MS);
            let stale: HashSet<u64> = by_client
                .lock()
                .await
                .values()
                .filter(|session| session.last_activity.load(Ordering::Relaxed) < cutoff)
                .map(|session| session.session_id)
                .collect();
            if stale.is_empty() {
                continue;
            }
            by_client
                .lock()
                .await
                .retain(|_, session| !stale.contains(&session.session_id));
            by_id.lock().await.retain(|id, _| !stale.contains(id));
        }
    });
}
impl EntrySession {
    fn new(
        client: SocketAddr,
        selected: SelectedEndpoint,
        cfg: Arc<Config>,
        socket: Arc<UdpSocket>,
        in_limit: Arc<RateLimiter>,
        out_limit: Arc<RateLimiter>,
        traffic: Arc<TrafficCounter>,
    ) -> Arc<Self> {
        let remote = selected_address_placeholder(&selected);
        let endpoint_key = selected.endpoint.key;
        let session_id = random_id();
        let last_activity = Arc::new(AtomicU64::new(now_ms()));
        let (to_exit, exit_rx) = mpsc::channel(SESSION_QUEUE_SIZE);
        let (to_client, client_rx) = mpsc::channel(SESSION_QUEUE_SIZE);
        spawn_entry_sender(
            cfg.clone(),
            socket.clone(),
            remote,
            endpoint_key.clone(),
            session_id,
            exit_rx,
            in_limit,
            traffic.clone(),
            last_activity.clone(),
        );
        spawn_entry_client_writer(
            cfg,
            socket,
            client,
            client_rx,
            out_limit,
            traffic,
            last_activity.clone(),
        );
        Arc::new(Self {
            client,
            remote,
            endpoint_key,
            session_id,
            to_exit,
            to_client,
            return_replay: Mutex::new(ReplayWindow::default()),
            return_fragments: Mutex::new(Reassembler::default()),
            last_activity,
        })
    }
    fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_entry_sender(
    cfg: Arc<Config>,
    socket: Arc<UdpSocket>,
    remote: SocketAddr,
    endpoint_key: String,
    session_id: u64,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    limiter: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
    last_activity: Arc<AtomicU64>,
) {
    let remote = udp_send_address(&socket, remote);
    tokio::spawn(async move {
        let sequence = AtomicU64::new(0);
        while let Some(payload) = receiver.recv().await {
            limiter.wait(payload.len()).await;
            let payload_len = payload.len();
            let packets = match seal_datagrams(
                Packet {
                    packet_type: TYPE_DATA,
                    tunnel_id: cfg.tunnel_id,
                    rule_id: cfg.rule_id,
                    session_id,
                    sequence: 0,
                    fragment: 0,
                    fragments: 0,
                    payload,
                },
                &endpoint_key,
                &sequence,
            ) {
                Ok(packets) => packets,
                Err(error) => {
                    log_udp_drop(format_args!(
                        "entry udp seal failed tunnel={} rule={}: {}",
                        cfg.tunnel_id, cfg.rule_id, error
                    ));
                    continue;
                }
            };
            let mut sent = true;
            for packet in packets {
                if let Err(error) = socket.send_to(&packet, remote).await {
                    log_udp_drop(format_args!(
                        "entry udp exit write failed tunnel={} rule={} exit={}: {}",
                        cfg.tunnel_id, cfg.rule_id, remote, error
                    ));
                    sent = false;
                    break;
                }
            }
            if sent {
                traffic
                    .bytes_in
                    .fetch_add(payload_len as u64, Ordering::Relaxed);
                last_activity.store(now_ms(), Ordering::Relaxed);
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn spawn_entry_client_writer(
    cfg: Arc<Config>,
    socket: Arc<UdpSocket>,
    client: SocketAddr,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    limiter: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
    last_activity: Arc<AtomicU64>,
) {
    let client = udp_send_address(&socket, client);
    tokio::spawn(async move {
        while let Some(payload) = receiver.recv().await {
            limiter.wait(payload.len()).await;
            match socket.send_to(&payload, client).await {
                Ok(_) => {
                    traffic
                        .bytes_out
                        .fetch_add(payload.len() as u64, Ordering::Relaxed);
                    last_activity.store(now_ms(), Ordering::Relaxed);
                }
                Err(error) => log_udp_drop(format_args!(
                    "entry udp client write failed tunnel={} rule={} client={}: {}",
                    cfg.tunnel_id, cfg.rule_id, client, error
                )),
            }
        }
    });
}

struct ExitSession {
    peer: SocketAddr,
    session_id: u64,
    rule_id: i32,
    target_ip: String,
    target_port: u16,
    target: Arc<UdpSocket>,
    to_target: mpsc::Sender<Vec<u8>>,
    return_sequence: AtomicU64,
    data_replay: Mutex<ReplayWindow>,
    data_fragments: Mutex<Reassembler>,
    last_activity: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
}

fn spawn_exit_cleanup(sessions: Arc<Mutex<HashMap<String, Arc<ExitSession>>>>) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(15)).await;
            let cutoff = now_ms().saturating_sub(UDP_IDLE_MS);
            sessions.lock().await.retain(|_, session| {
                let active = session.last_activity.load(Ordering::Relaxed) >= cutoff;
                if !active {
                    session.active.store(false, Ordering::Relaxed);
                }
                active
            });
        }
    });
}
impl ExitSession {
    fn new(
        peer: SocketAddr,
        session_id: u64,
        rule_id: i32,
        target_ip: String,
        target_port: u16,
        target: Arc<UdpSocket>,
        to_target: mpsc::Sender<Vec<u8>>,
    ) -> Self {
        Self {
            peer,
            session_id,
            rule_id,
            target_ip,
            target_port,
            target,
            to_target,
            return_sequence: AtomicU64::new(0),
            data_replay: Mutex::new(ReplayWindow::default()),
            data_fragments: Mutex::new(Reassembler::default()),
            last_activity: Arc::new(AtomicU64::new(now_ms())),
            active: Arc::new(AtomicBool::new(true)),
        }
    }
    fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }
}

fn spawn_exit_target_writer(
    cfg: Arc<Config>,
    session: Arc<ExitSession>,
    mut receiver: mpsc::Receiver<Vec<u8>>,
) {
    let target = session.target.clone();
    let active = session.active.clone();
    let last_activity = session.last_activity.clone();
    let rule_id = session.rule_id;
    let target_text = format!("{}:{}", session.target_ip, session.target_port);
    drop(session);
    tokio::spawn(async move {
        while let Some(payload) = receiver.recv().await {
            if !active.load(Ordering::Relaxed) {
                return;
            }
            match target.send(&payload).await {
                Ok(_) => last_activity.store(now_ms(), Ordering::Relaxed),
                Err(error) => {
                    active.store(false, Ordering::Relaxed);
                    log_udp_drop(format_args!(
                        "exit udp target write failed tunnel={} rule={} target={}: {}",
                        cfg.tunnel_id, rule_id, target_text, error
                    ));
                    return;
                }
            }
        }
    });
}

struct RelaySession {
    upstream: SocketAddr,
    downstream: SocketAddr,
    endpoint_key: String,
    rule_id: i32,
    session_id: u64,
    to_downstream: mpsc::Sender<Vec<u8>>,
    to_upstream: mpsc::Sender<Vec<u8>>,
    data_replay: Mutex<ReplayWindow>,
    return_replay: Mutex<ReplayWindow>,
    data_fragments: Mutex<Reassembler>,
    return_fragments: Mutex<Reassembler>,
    last_activity: Arc<AtomicU64>,
}

fn spawn_relay_cleanup(
    by_upstream: Arc<Mutex<HashMap<String, Arc<RelaySession>>>>,
    by_id: Arc<Mutex<HashMap<u64, Arc<RelaySession>>>>,
) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(15)).await;
            let cutoff = now_ms().saturating_sub(UDP_IDLE_MS);
            let stale: HashSet<u64> = by_upstream
                .lock()
                .await
                .values()
                .filter(|session| session.last_activity.load(Ordering::Relaxed) < cutoff)
                .map(|session| session.session_id)
                .collect();
            if stale.is_empty() {
                continue;
            }
            by_upstream
                .lock()
                .await
                .retain(|_, session| !stale.contains(&session.session_id));
            by_id.lock().await.retain(|id, _| !stale.contains(id));
        }
    });
}
impl RelaySession {
    fn new(
        upstream: SocketAddr,
        selected: SelectedEndpoint,
        rule_id: i32,
        session_id: u64,
        cfg: Arc<Config>,
        socket: Arc<UdpSocket>,
    ) -> Arc<Self> {
        let downstream = selected_address_placeholder(&selected);
        let endpoint_key = selected.endpoint.key;
        let last_activity = Arc::new(AtomicU64::new(now_ms()));
        let (to_downstream, downstream_rx) = mpsc::channel(SESSION_QUEUE_SIZE);
        let (to_upstream, upstream_rx) = mpsc::channel(SESSION_QUEUE_SIZE);
        spawn_relay_sender(
            cfg.clone(),
            socket.clone(),
            downstream,
            endpoint_key.clone(),
            rule_id,
            session_id,
            TYPE_DATA,
            downstream_rx,
            last_activity.clone(),
        );
        spawn_relay_sender(
            cfg.clone(),
            socket,
            upstream,
            cfg.key.clone(),
            rule_id,
            session_id,
            TYPE_RETURN,
            upstream_rx,
            last_activity.clone(),
        );
        Arc::new(Self {
            upstream,
            downstream,
            endpoint_key,
            rule_id,
            session_id,
            to_downstream,
            to_upstream,
            data_replay: Mutex::new(ReplayWindow::default()),
            return_replay: Mutex::new(ReplayWindow::default()),
            data_fragments: Mutex::new(Reassembler::default()),
            return_fragments: Mutex::new(Reassembler::default()),
            last_activity,
        })
    }
    fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_relay_sender(
    cfg: Arc<Config>,
    socket: Arc<UdpSocket>,
    destination: SocketAddr,
    key: String,
    rule_id: i32,
    session_id: u64,
    packet_type: u8,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    last_activity: Arc<AtomicU64>,
) {
    let destination = udp_send_address(&socket, destination);
    tokio::spawn(async move {
        let sequence = AtomicU64::new(0);
        while let Some(payload) = receiver.recv().await {
            let packets = match seal_datagrams(
                Packet {
                    packet_type,
                    tunnel_id: cfg.tunnel_id,
                    rule_id,
                    session_id,
                    sequence: 0,
                    fragment: 0,
                    fragments: 0,
                    payload,
                },
                &key,
                &sequence,
            ) {
                Ok(packets) => packets,
                Err(error) => {
                    log_udp_drop(format_args!(
                        "relay udp seal failed tunnel={} rule={} destination={}: {}",
                        cfg.tunnel_id, rule_id, destination, error
                    ));
                    continue;
                }
            };
            let mut sent = true;
            for packet in packets {
                if let Err(error) = socket.send_to(&packet, destination).await {
                    log_udp_drop(format_args!(
                        "relay udp write failed tunnel={} rule={} destination={}: {}",
                        cfg.tunnel_id, rule_id, destination, error
                    ));
                    sent = false;
                    break;
                }
            }
            if sent {
                last_activity.store(now_ms(), Ordering::Relaxed);
            }
        }
    });
}

fn spawn_exit_response(cfg: Arc<Config>, socket: Arc<UdpSocket>, session: Arc<ExitSession>) {
    let peer = udp_send_address(&socket, session.peer);
    tokio::spawn(async move {
        let mut buffer = vec![0u8; MAX_DATAGRAM];
        loop {
            if !session.active.load(Ordering::Relaxed) {
                return;
            }
            match timeout(Duration::from_secs(5), session.target.recv(&mut buffer)).await {
                Ok(Ok(length)) => {
                    if !session.active.load(Ordering::Relaxed) {
                        return;
                    }
                    let packets = match seal_datagrams(
                        Packet {
                            packet_type: TYPE_RETURN,
                            tunnel_id: cfg.tunnel_id,
                            rule_id: session.rule_id,
                            session_id: session.session_id,
                            sequence: 0,
                            fragment: 0,
                            fragments: 0,
                            payload: buffer[..length].to_vec(),
                        },
                        &cfg.key,
                        &session.return_sequence,
                    ) {
                        Ok(packets) => packets,
                        Err(error) => {
                            session.active.store(false, Ordering::Relaxed);
                            eprintln!(
                                "exit udp direct seal failed tunnel={} rule={}: {}",
                                cfg.tunnel_id, session.rule_id, error
                            );
                            break;
                        }
                    };
                    for packet in packets {
                        if let Err(error) = socket.send_to(&packet, peer).await {
                            session.active.store(false, Ordering::Relaxed);
                            eprintln!(
                                "exit udp direct peer write failed tunnel={} rule={}: {}",
                                cfg.tunnel_id, session.rule_id, error
                            );
                            return;
                        }
                    }
                    session.touch();
                }
                Ok(Err(error)) => {
                    session.active.store(false, Ordering::Relaxed);
                    eprintln!(
                        "exit udp direct target read failed tunnel={} rule={}: {}",
                        cfg.tunnel_id, session.rule_id, error
                    );
                    return;
                }
                Err(_)
                    if now_ms().saturating_sub(session.last_activity.load(Ordering::Relaxed))
                        >= UDP_IDLE_MS =>
                {
                    session.active.store(false, Ordering::Relaxed);
                    return;
                }
                Err(_) => continue,
            }
        }
    });
}

async fn pick_udp_endpoint(
    selector: &ExitSelector,
    selection_key: &str,
) -> Result<Option<SelectedEndpoint>> {
    let mut excluded = HashSet::new();
    while excluded.len() < selector.len() {
        let Some(selected) = selector.pick(&excluded, selection_key) else {
            return Ok(None);
        };
        match resolve_endpoint(&selected.endpoint, true).await {
            Ok(address) => {
                selector.mark_healthy(selected.index);
                let mut selected = selected;
                selected.endpoint.host = address.ip().to_string();
                selected.endpoint.udp_port = address.port();
                return Ok(Some(selected));
            }
            Err(error) => {
                selector.mark_failure(selected.index, &error.to_string());
                excluded.insert(selected.index);
            }
        }
    }
    Ok(None)
}

fn selected_address_placeholder(selected: &SelectedEndpoint) -> SocketAddr {
    let host = selected
        .endpoint
        .host
        .parse()
        .expect("selected endpoint must be resolved");
    SocketAddr::new(host, selected.endpoint.udp_port)
}

async fn bind_udp(host: &str, port: u16) -> Result<UdpSocket> {
    if host.trim().is_empty() {
        match dual_stack_udp_socket(port) {
            Ok(socket) => return Ok(UdpSocket::from_std(socket)?),
            Err(error) => eprintln!(
                "dual-stack udp listen unavailable on :{}; falling back to IPv4: {}",
                port, error
            ),
        }
    }
    let host = if host.trim().is_empty() {
        "0.0.0.0"
    } else {
        host.trim()
    };
    Ok(UdpSocket::bind(endpoint_text(host, port)).await?)
}

fn dual_stack_udp_socket(port: u16) -> std::io::Result<std::net::UdpSocket> {
    let socket = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_only_v6(false)?;
    socket.bind(&SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), port).into())?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

async fn connect_udp(host: &str, port: u16) -> Result<UdpSocket> {
    let remote = resolve_host_port(host, port).await?;
    let bind = if remote.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let socket = UdpSocket::bind(bind).await?;
    socket.connect(remote).await?;
    Ok(socket)
}

async fn resolve_endpoint(endpoint: &ExitEndpoint, udp: bool) -> Result<SocketAddr> {
    resolve_host_port(
        &endpoint.host,
        if udp {
            endpoint.udp_port
        } else {
            endpoint.port
        },
    )
    .await
}

async fn resolve_host_port(host: &str, port: u16) -> Result<SocketAddr> {
    if let Ok(ip) = host.trim_matches(['[', ']']).parse() {
        return Ok(SocketAddr::new(ip, port));
    }
    timeout(
        Duration::from_secs(5),
        lookup_host(endpoint_text(host, port)),
    )
    .await
    .map_err(|_| anyhow!("UDP endpoint DNS timeout"))??
    .next()
    .ok_or_else(|| anyhow!("endpoint has no addresses"))
}

fn tune_udp_socket(socket: &UdpSocket, label: &str, bytes: libc::c_int) {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;

        for option in [libc::SO_RCVBUF, libc::SO_SNDBUF] {
            let result = unsafe {
                libc::setsockopt(
                    socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    option,
                    (&bytes as *const libc::c_int).cast(),
                    std::mem::size_of_val(&bytes) as libc::socklen_t,
                )
            };
            if result != 0 {
                log_udp_drop(format_args!(
                    "{} udp buffer tune skipped option={}: {}",
                    label,
                    option,
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (socket, label, bytes);
}

fn log_udp_drop(arguments: std::fmt::Arguments<'_>) {
    static LAST_LOG_MS: AtomicU64 = AtomicU64::new(0);
    static SUPPRESSED: AtomicU64 = AtomicU64::new(0);

    let now = now_ms();
    let last = LAST_LOG_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= DROP_LOG_INTERVAL_MS
        && LAST_LOG_MS
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        let suppressed = SUPPRESSED.swap(0, Ordering::Relaxed);
        if suppressed > 0 {
            eprintln!("{} suppressed={}", arguments, suppressed);
        } else {
            eprintln!("{}", arguments);
        }
    } else {
        SUPPRESSED.fetch_add(1, Ordering::Relaxed);
    }
}

fn endpoint_text(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    }
}

fn normalize_socket_addr(address: SocketAddr) -> SocketAddr {
    match address {
        SocketAddr::V6(address) => address
            .ip()
            .to_ipv4_mapped()
            .map(|ip| SocketAddr::new(ip.into(), address.port()))
            .unwrap_or(SocketAddr::V6(address)),
        address => address,
    }
}

fn udp_send_address(socket: &UdpSocket, address: SocketAddr) -> SocketAddr {
    if socket.local_addr().is_ok_and(|local| local.is_ipv6()) {
        if let IpAddr::V4(ip) = address.ip() {
            return SocketAddr::new(ip.to_ipv6_mapped().into(), address.port());
        }
    }
    address
}

fn random_id() -> u64 {
    loop {
        let value = OsRng.next_u64();
        if value != 0 {
            return value;
        }
    }
}
fn session_key(address: SocketAddr, session_id: u64) -> String {
    format!("{}|{}", address, session_id)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn matches_config(packet: &Packet, cfg: &Config) -> bool {
    packet.tunnel_id == cfg.tunnel_id && (cfg.rule_id <= 0 || packet.rule_id == cfg.rule_id)
}
fn raw_session_id(raw: &[u8]) -> Option<u64> {
    (raw.len() >= HEADER_SIZE && &raw[..4] == MAGIC && raw[4] == VERSION)
        .then(|| u64::from_be_bytes(raw[16..24].try_into().expect("session id")))
}
fn valid_fragment(fragment: u8, fragments: u8) -> bool {
    fragments == 0 && fragment == 0
        || fragments >= 2
            && fragments as usize <= MAX_DATAGRAM.div_ceil(FRAGMENT_SIZE)
            && fragment < fragments
}

fn seal_datagrams(mut packet: Packet, key: &str, counter: &AtomicU64) -> Result<Vec<Vec<u8>>> {
    if packet.payload.len() > MAX_DATAGRAM {
        bail!("udp datagram payload too large: {}", packet.payload.len());
    }
    let count = packet.payload.len().div_ceil(FRAGMENT_SIZE).max(1);
    if count > u8::MAX as usize {
        bail!("udp datagram requires too many fragments");
    }
    let sequence = counter
        .fetch_add(1, Ordering::Relaxed)
        .checked_add(1)
        .ok_or_else(|| anyhow!("udp packet sequence exhausted"))?;
    let original = packet.payload;
    let mut frames = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * FRAGMENT_SIZE;
        let end = (start + FRAGMENT_SIZE).min(original.len());
        packet.sequence = sequence;
        packet.fragment = if count > 1 { index as u8 } else { 0 };
        packet.fragments = if count > 1 { count as u8 } else { 0 };
        packet.payload = original[start..end].to_vec();
        frames.push(seal_packet(&packet, key)?);
    }
    Ok(frames)
}

fn seal_packet(packet: &Packet, key: &str) -> Result<Vec<u8>> {
    let header = packet_header(packet)?;
    let cipher = packet_aead(key, packet)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&udp_nonce(packet.sequence, packet.fragment)),
            Payload {
                msg: &packet.payload,
                aad: &header,
            },
        )
        .map_err(|_| anyhow!("udp encrypt failed"))?;
    Ok([header, encrypted].concat())
}

fn open_packet(raw: &[u8], key: &str) -> Result<Packet> {
    if raw.len() < HEADER_SIZE + TAG_SIZE || &raw[..4] != MAGIC || raw[4] != VERSION {
        bail!("invalid udp packet header");
    }
    let packet = Packet {
        packet_type: raw[5],
        fragment: raw[6],
        fragments: raw[7],
        tunnel_id: u32::from_be_bytes(raw[8..12].try_into()?) as i32,
        rule_id: u32::from_be_bytes(raw[12..16].try_into()?) as i32,
        session_id: u64::from_be_bytes(raw[16..24].try_into()?),
        sequence: u64::from_be_bytes(raw[24..32].try_into()?),
        payload: Vec::new(),
    };
    let _ = packet_header(&packet)?;
    let cipher = packet_aead(key, &packet)?;
    let payload = cipher
        .decrypt(
            Nonce::from_slice(&udp_nonce(packet.sequence, packet.fragment)),
            Payload {
                msg: &raw[HEADER_SIZE..],
                aad: &raw[..HEADER_SIZE],
            },
        )
        .map_err(|_| anyhow!("invalid udp packet authentication"))?;
    Ok(Packet { payload, ..packet })
}

fn packet_header(packet: &Packet) -> Result<Vec<u8>> {
    if !matches!(packet.packet_type, TYPE_DATA | TYPE_RETURN)
        || packet.tunnel_id < 0
        || packet.rule_id < 0
        || packet.session_id == 0
        || packet.sequence == 0
        || !valid_fragment(packet.fragment, packet.fragments)
    {
        bail!("invalid udp packet fields");
    }
    let mut header = vec![0u8; HEADER_SIZE];
    header[..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    header[5] = packet.packet_type;
    header[6] = packet.fragment;
    header[7] = packet.fragments;
    header[8..12].copy_from_slice(&(packet.tunnel_id as u32).to_be_bytes());
    header[12..16].copy_from_slice(&(packet.rule_id as u32).to_be_bytes());
    header[16..24].copy_from_slice(&packet.session_id.to_be_bytes());
    header[24..32].copy_from_slice(&packet.sequence.to_be_bytes());
    Ok(header)
}

fn packet_aead(key: &str, packet: &Packet) -> Result<Aes256Gcm> {
    if key.is_empty() {
        bail!("empty udp key");
    }
    let mut context = Vec::with_capacity(17);
    context.push(packet.packet_type);
    context.extend_from_slice(&(packet.tunnel_id as u32).to_be_bytes());
    context.extend_from_slice(&(packet.rule_id as u32).to_be_bytes());
    context.extend_from_slice(&packet.session_id.to_be_bytes());
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(b"forwardx-fxp-udp-v3/aead/");
    mac.update(&context);
    Ok(Aes256Gcm::new_from_slice(&mac.finalize().into_bytes())?)
}

fn udp_nonce(sequence: u64, fragment: u8) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[3] = fragment;
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    const GO_UDP_VECTOR: &str = "465850550301000000001f4000001f4101020304050607080000000000000001a338daf35a62369ec293b6ab0dfba6c4231885ee6f20a7bd57fafd4fbe3913810c";

    #[test]
    fn udp_packet_matches_go_wire_vector() {
        let packet = Packet {
            packet_type: TYPE_DATA,
            tunnel_id: 8000,
            rule_id: 8001,
            session_id: 0x0102_0304_0506_0708,
            sequence: 1,
            fragment: 0,
            fragments: 0,
            payload: b"forwardx-rust-udp".to_vec(),
        };
        let sealed = seal_packet(&packet, "rust-interop-key").expect("seal UDP vector");
        assert_eq!(hex::encode(&sealed), GO_UDP_VECTOR);
        assert_eq!(
            open_packet(&sealed, "rust-interop-key")
                .expect("open UDP vector")
                .payload,
            packet.payload
        );
    }
}
