use crate::{
    config::{Config, ExitEndpoint},
    crypto::{HelloFrame, SecureReader, SecureStream, SecureWriter, WireChoice},
    runtime::{protocol_blocked, report_protocol_block, RateLimiter, SessionGuard, TrafficCounter},
    selector::ExitSelector,
};
use anyhow::{anyhow, bail, Context, Result};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        lookup_host,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        TcpListener, TcpStream,
    },
    time::timeout,
};

const INITIAL_TIMEOUT: Duration = Duration::from_millis(150);
const PROXY_TIMEOUT: Duration = Duration::from_secs(5);
const FRAME_BUFFER: usize = 32 * 1024;

pub async fn run_entry(
    cfg: Arc<Config>,
    selector: Arc<ExitSelector>,
    in_limit: Arc<RateLimiter>,
    out_limit: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
) -> Result<()> {
    let listener = listen_tcp(&cfg.listen_host, cfg.listen_port, cfg.tcp_fast_open)?;
    eprintln!(
        "entry tcp listening on :{} tunnel={} rule={}",
        cfg.listen_port, cfg.tunnel_id, cfg.rule_id
    );
    let gate = Arc::new(ConnectionGate::new(cfg.max_connections, cfg.max_ips));
    loop {
        let (stream, peer) = listener.accept().await?;
        let peer = normalize_socket_addr(peer);
        tune_tcp_stream(&stream);
        let Some(permit) = gate.acquire(peer.ip()) else {
            eprintln!(
                "entry tcp rejected by connection gate tunnel={} rule={} client={}",
                cfg.tunnel_id, cfg.rule_id, peer
            );
            continue;
        };
        let cfg = cfg.clone();
        let selector = selector.clone();
        let in_limit = in_limit.clone();
        let out_limit = out_limit.clone();
        let traffic = traffic.clone();
        tokio::spawn(async move {
            let _session = SessionGuard::new();
            let _permit = permit;
            if let Err(error) =
                handle_entry(stream, peer, cfg, selector, in_limit, out_limit, traffic).await
            {
                if !is_closed(&error) {
                    eprintln!("entry tcp session error: {}", error);
                }
            }
        });
    }
}

pub async fn run_exit(cfg: Arc<Config>) -> Result<()> {
    let listener = listen_tcp(&cfg.listen_host, cfg.listen_port, cfg.tcp_fast_open)?;
    eprintln!(
        "exit tcp listening on :{} tunnel={}",
        cfg.listen_port, cfg.tunnel_id
    );
    loop {
        let (stream, _) = listener.accept().await?;
        tune_tcp_stream(&stream);
        let cfg = cfg.clone();
        tokio::spawn(async move {
            let _session = SessionGuard::new();
            if let Err(error) = handle_exit(stream, cfg).await {
                if !is_closed(&error) {
                    eprintln!("exit session error: {}", error);
                }
            }
        });
    }
}

pub async fn run_relay(cfg: Arc<Config>, selector: Arc<ExitSelector>) -> Result<()> {
    let listener = listen_tcp(&cfg.listen_host, cfg.listen_port, cfg.tcp_fast_open)?;
    eprintln!(
        "relay tcp listening on :{} tunnel={} next={}:{}",
        cfg.listen_port, cfg.tunnel_id, cfg.relay_exit_host, cfg.relay_exit_port
    );
    loop {
        let (stream, peer) = listener.accept().await?;
        let peer = normalize_socket_addr(peer);
        tune_tcp_stream(&stream);
        let cfg = cfg.clone();
        let selector = selector.clone();
        tokio::spawn(async move {
            let _session = SessionGuard::new();
            if let Err(error) = handle_relay(stream, peer, cfg, selector).await {
                if !is_closed(&error) {
                    eprintln!("relay session error: {}", error);
                }
            }
        });
    }
}

async fn handle_entry(
    mut client: TcpStream,
    peer: SocketAddr,
    cfg: Arc<Config>,
    selector: Arc<ExitSelector>,
    in_limit: Arc<RateLimiter>,
    out_limit: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
) -> Result<()> {
    let mut proxy = ProxyInfo::from_stream(&client);
    let read_timeout = if cfg.proxy_protocol_receive {
        PROXY_TIMEOUT
    } else {
        INITIAL_TIMEOUT
    };
    let mut initial = read_initial(&mut client, read_timeout).await?;
    if cfg.proxy_protocol_receive {
        let (parsed, remaining) =
            consume_proxy_protocol(&mut client, initial, read_timeout).await?;
        proxy = parsed.ok_or_else(|| anyhow!("missing proxy protocol header"))?;
        initial = remaining;
    }
    if !cfg.proxy_protocol_send {
        proxy = ProxyInfo::default();
    }
    let selection_key = peer.ip().to_string();
    let (mut secure, endpoint) = dial_selected_secure(&selector, &cfg, &selection_key).await?;
    let hello = serde_json::to_vec(&HelloFrame {
        network: "tcp".to_string(),
        target_ip: cfg.target_ip.clone(),
        target_port: cfg.target_port,
        tunnel_id: cfg.tunnel_id,
        rule_id: cfg.rule_id,
        selection_key,
        proxy_source_ip: proxy.source_ip,
        proxy_source_port: proxy.source_port,
        proxy_dest_ip: proxy.dest_ip,
        proxy_dest_port: proxy.dest_port,
        proxy_protocol_exit_receive: cfg.proxy_protocol_exit_receive,
        proxy_protocol_exit_send: cfg.proxy_protocol_exit_send,
        proxy_protocol_version: cfg.proxy_protocol_version,
    })?;
    secure.write_frame(&hello).await?;
    verbose_log!(
        "entry tcp routed tunnel={} rule={} client={} exit={}:{} target={}:{}",
        cfg.tunnel_id,
        cfg.rule_id,
        peer,
        endpoint.host,
        endpoint.port,
        cfg.target_ip,
        cfg.target_port
    );

    let mut sample = initial[..initial.len().min(512)].to_vec();
    if !initial.is_empty() {
        in_limit.wait(initial.len()).await;
        secure.write_frame(&initial).await?;
        traffic
            .bytes_in
            .fetch_add(initial.len() as u64, Ordering::Relaxed);
        if let Some(protocol) = protocol_blocked(&sample, &cfg) {
            report_protocol_block((*cfg).clone(), protocol);
            return Ok(());
        }
    }
    let (plain_read, plain_write) = client.into_split();
    let (secure_read, secure_write) = secure.split();
    wait_bidirectional(
        copy_plain_to_secure(
            plain_read,
            secure_write,
            in_limit,
            traffic.clone(),
            cfg.clone(),
            std::mem::take(&mut sample),
        ),
        copy_secure_to_plain(secure_read, plain_write, out_limit, traffic),
    )
    .await?;
    Ok(())
}

async fn handle_exit(stream: TcpStream, cfg: Arc<Config>) -> Result<()> {
    let mut secure = timeout(Duration::from_secs(10), SecureStream::server(stream, &cfg))
        .await
        .context("FXP server handshake timeout")??;
    let frame = secure.read_frame().await?;
    let mut hello: HelloFrame = serde_json::from_slice(&frame).context("parse FXP hello")?;
    if hello.target_ip.is_empty() {
        hello.target_ip = cfg.target_ip.clone();
    }
    if hello.target_port == 0 {
        hello.target_port = cfg.target_port;
    }
    if !hello.proxy_protocol_exit_receive {
        hello.proxy_source_ip.clear();
        hello.proxy_source_port = 0;
        hello.proxy_dest_ip.clear();
        hello.proxy_dest_port = 0;
    }
    if hello.network.eq_ignore_ascii_case("udp") {
        return handle_exit_stream_udp(secure, hello).await;
    }
    let mut target = timeout(
        Duration::from_secs(10),
        TcpStream::connect(endpoint_text(&hello.target_ip, hello.target_port)),
    )
    .await??;
    tune_tcp_stream(&target);
    if hello.proxy_protocol_exit_send
        && !hello.proxy_source_ip.is_empty()
        && hello.proxy_source_port > 0
    {
        target.write_all(&format_proxy_header(&hello)).await?;
    }
    let (plain_read, plain_write) = target.into_split();
    let (secure_read, secure_write) = secure.split();
    wait_bidirectional(
        copy_plain_to_secure_unlimited(plain_read, secure_write),
        copy_secure_to_plain_unlimited(secure_read, plain_write),
    )
    .await?;
    Ok(())
}

async fn handle_relay(
    stream: TcpStream,
    peer: SocketAddr,
    cfg: Arc<Config>,
    selector: Arc<ExitSelector>,
) -> Result<()> {
    let mut upstream = timeout(Duration::from_secs(10), SecureStream::server(stream, &cfg))
        .await
        .context("FXP relay handshake timeout")??;
    let hello = upstream.read_frame().await?;
    let hello_frame: HelloFrame =
        serde_json::from_slice(&hello).context("parse FXP relay hello")?;
    let selection_key = if hello_frame.selection_key.trim().is_empty() {
        peer.ip().to_string()
    } else {
        hello_frame.selection_key.clone()
    };
    let mut downstream_config = (*cfg).clone();
    downstream_config.key = cfg.relay_key.clone();
    let (mut downstream, endpoint) =
        dial_selected_secure(&selector, &downstream_config, &selection_key).await?;
    downstream.write_frame(&hello).await?;
    verbose_log!(
        "relay tcp routed tunnel={} upstream={} downstream={}:{} target={}:{}",
        cfg.tunnel_id,
        peer,
        endpoint.host,
        endpoint.port,
        hello_frame.target_ip,
        hello_frame.target_port
    );
    let (up_read, up_write) = upstream.split();
    let (down_read, down_write) = downstream.split();
    wait_bidirectional(
        relay_copy(up_read, down_write),
        relay_copy(down_read, up_write),
    )
    .await?;
    Ok(())
}

async fn handle_exit_stream_udp(secure: SecureStream, hello: HelloFrame) -> Result<()> {
    let target = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
    target
        .connect(endpoint_text(&hello.target_ip, hello.target_port))
        .await?;
    let target = Arc::new(target);
    let (mut secure_read, mut secure_write) = secure.split();
    let write_target = target.clone();
    let from_secure = async move {
        loop {
            let frame = secure_read.read_frame().await?;
            if frame.is_empty() {
                return Ok::<(), anyhow::Error>(());
            }
            write_target.send(&frame).await?;
        }
    };
    let to_secure = async move {
        let mut buffer = vec![0u8; 65_507];
        loop {
            let length = target.recv(&mut buffer).await?;
            secure_write.write_frame(&buffer[..length]).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! { result = from_secure => result, result = to_secure => result }
}

async fn dial_selected_secure(
    selector: &ExitSelector,
    cfg: &Config,
    selection_key: &str,
) -> Result<(SecureStream, ExitEndpoint)> {
    let mut excluded = HashSet::new();
    let dial_timeout = if cfg.exit_strategy == "fallback" || !cfg.exits.is_empty() {
        Duration::from_secs(3)
    } else {
        Duration::from_secs(10)
    };
    let mut last_error: Option<anyhow::Error> = None;
    while excluded.len() < selector.len() {
        let Some(selected) = selector.pick(&excluded, selection_key) else {
            break;
        };
        excluded.insert(selected.index);
        let result = async {
            let address = resolve_endpoint(&selected.endpoint).await?;
            let mut dial_cfg = cfg.clone();
            if !selected.endpoint.key.is_empty() {
                dial_cfg.key = selected.endpoint.key.clone();
            }
            for wire in WireChoice::all() {
                let stream = timeout(dial_timeout, TcpStream::connect(address)).await??;
                tune_tcp_stream(&stream);
                match timeout(dial_timeout, SecureStream::client(stream, &dial_cfg, wire))
                    .await
                    .context("FXP client handshake timeout")?
                {
                    Ok(secure) => return Ok::<_, anyhow::Error>(secure),
                    Err(error) => {
                        if matches!(wire, WireChoice::Compat) {
                            return Err(error);
                        }
                    }
                }
            }
            bail!("fxp secure connect failed")
        }
        .await;
        match result {
            Ok(secure) => {
                selector.mark_healthy(selected.index);
                return Ok((secure, selected.endpoint));
            }
            Err(error) => {
                selector.mark_failure(selected.index, &error.to_string());
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("no exit endpoint available")))
}

async fn copy_plain_to_secure(
    mut plain: OwnedReadHalf,
    mut secure: SecureWriter,
    limiter: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
    cfg: Arc<Config>,
    mut sample: Vec<u8>,
) -> Result<()> {
    let mut buffer = vec![0u8; FRAME_BUFFER];
    loop {
        let length = plain.read(&mut buffer).await?;
        if length == 0 {
            secure.write_frame(&[]).await?;
            return Ok(());
        }
        let chunk = &buffer[..length];
        if sample.len() < 512 {
            let remaining = 512 - sample.len();
            sample.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if let Some(protocol) = protocol_blocked(&sample, &cfg) {
                report_protocol_block((*cfg).clone(), protocol);
                bail!("protocol blocked: {}", protocol);
            }
        }
        limiter.wait(length).await;
        secure.write_frame(chunk).await?;
        traffic.bytes_in.fetch_add(length as u64, Ordering::Relaxed);
    }
}

async fn copy_secure_to_plain(
    mut secure: SecureReader,
    mut plain: OwnedWriteHalf,
    limiter: Arc<RateLimiter>,
    traffic: Arc<TrafficCounter>,
) -> Result<()> {
    loop {
        let frame = secure.read_frame().await?;
        if frame.is_empty() {
            plain.shutdown().await?;
            return Ok(());
        }
        limiter.wait(frame.len()).await;
        plain.write_all(&frame).await?;
        traffic
            .bytes_out
            .fetch_add(frame.len() as u64, Ordering::Relaxed);
    }
}

async fn copy_plain_to_secure_unlimited(
    mut plain: OwnedReadHalf,
    mut secure: SecureWriter,
) -> Result<()> {
    let mut buffer = vec![0u8; FRAME_BUFFER];
    loop {
        let length = plain.read(&mut buffer).await?;
        if length == 0 {
            secure.write_frame(&[]).await?;
            return Ok(());
        }
        secure.write_frame(&buffer[..length]).await?;
    }
}

async fn copy_secure_to_plain_unlimited(
    mut secure: SecureReader,
    mut plain: OwnedWriteHalf,
) -> Result<()> {
    loop {
        let frame = secure.read_frame().await?;
        if frame.is_empty() {
            plain.shutdown().await?;
            return Ok(());
        }
        plain.write_all(&frame).await?;
    }
}

async fn relay_copy(mut source: SecureReader, mut destination: SecureWriter) -> Result<()> {
    loop {
        let frame = source.read_frame().await?;
        destination.write_frame(&frame).await?;
        if frame.is_empty() {
            return Ok(());
        }
    }
}

#[derive(Default)]
struct ProxyInfo {
    source_ip: String,
    source_port: u16,
    dest_ip: String,
    dest_port: u16,
}
impl ProxyInfo {
    fn from_stream(stream: &TcpStream) -> Self {
        let source = stream.peer_addr().ok().map(normalize_socket_addr);
        let destination = stream.local_addr().ok().map(normalize_socket_addr);
        Self {
            source_ip: source
                .map(|address| address.ip().to_string())
                .unwrap_or_default(),
            source_port: source.map(|address| address.port()).unwrap_or_default(),
            dest_ip: destination
                .map(|address| address.ip().to_string())
                .unwrap_or_default(),
            dest_port: destination
                .map(|address| address.port())
                .unwrap_or_default(),
        }
    }
}

async fn read_initial(stream: &mut TcpStream, wait: Duration) -> Result<Vec<u8>> {
    let mut buffer = vec![0u8; 4096];
    match timeout(wait, stream.read(&mut buffer)).await {
        Ok(Ok(0)) => bail!("client closed before payload"),
        Ok(Ok(length)) => {
            buffer.truncate(length);
            Ok(buffer)
        }
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Ok(Vec::new()),
    }
}

async fn wait_bidirectional<F, G>(first: F, second: G) -> Result<()>
where
    F: std::future::Future<Output = Result<()>>,
    G: std::future::Future<Output = Result<()>>,
{
    tokio::pin!(first);
    tokio::pin!(second);
    tokio::select! {
        result = &mut first => wait_remaining(result, second).await,
        result = &mut second => wait_remaining(result, first).await,
    }
}

async fn wait_remaining<F>(first: Result<()>, remaining: F) -> Result<()>
where
    F: std::future::Future<Output = Result<()>>,
{
    match first {
        Ok(()) => remaining.await,
        Err(error) if is_closed(&error) => {
            match timeout(Duration::from_secs(30), remaining).await {
                Ok(Ok(())) | Err(_) => Ok(()),
                Ok(Err(next)) if is_closed(&next) => Ok(()),
                Ok(Err(next)) => Err(next),
            }
        }
        Err(error) => Err(error),
    }
}

async fn consume_proxy_protocol(
    stream: &mut TcpStream,
    mut data: Vec<u8>,
    wait: Duration,
) -> Result<(Option<ProxyInfo>, Vec<u8>)> {
    while proxy_header_incomplete(&data) && data.len() < 1024 {
        let mut next = vec![0u8; 1024 - data.len()];
        let length = timeout(wait, stream.read(&mut next))
            .await
            .map_err(|_| anyhow!("incomplete proxy protocol header"))??;
        if length == 0 {
            break;
        }
        data.extend_from_slice(&next[..length]);
    }
    if data.starts_with(b"PROXY ") {
        return parse_proxy_v1(data);
    }
    if data.starts_with(&PROXY_V2_SIGNATURE) {
        return parse_proxy_v2(data);
    }
    Ok((None, data))
}

fn proxy_header_incomplete(data: &[u8]) -> bool {
    if (data.starts_with(b"PROXY ") || b"PROXY ".starts_with(data))
        && !data.windows(2).any(|window| window == b"\r\n")
    {
        return true;
    }
    if PROXY_V2_SIGNATURE.starts_with(data) || data.starts_with(&PROXY_V2_SIGNATURE) {
        if data.len() < 16 {
            return true;
        }
        let length = u16::from_be_bytes([data[14], data[15]]) as usize;
        return data.len() < 16 + length;
    }
    false
}

fn parse_proxy_v1(data: Vec<u8>) -> Result<(Option<ProxyInfo>, Vec<u8>)> {
    let end = data
        .windows(2)
        .position(|window| window == b"\r\n")
        .ok_or_else(|| anyhow!("incomplete proxy protocol header"))?;
    let line = std::str::from_utf8(&data[..end])?;
    let pieces: Vec<_> = line.split_whitespace().collect();
    if pieces.len() >= 2 && pieces[1] == "UNKNOWN" {
        return Ok((Some(ProxyInfo::default()), data[end + 2..].to_vec()));
    }
    if pieces.len() != 6 || !matches!(pieces[1], "TCP4" | "TCP6") {
        bail!("unsupported proxy protocol header");
    }
    Ok((
        Some(ProxyInfo {
            source_ip: pieces[2].to_string(),
            dest_ip: pieces[3].to_string(),
            source_port: pieces[4].parse()?,
            dest_port: pieces[5].parse()?,
        }),
        data[end + 2..].to_vec(),
    ))
}

const PROXY_V2_SIGNATURE: [u8; 12] = [
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
];
fn parse_proxy_v2(data: Vec<u8>) -> Result<(Option<ProxyInfo>, Vec<u8>)> {
    if data.len() < 16 {
        bail!("incomplete proxy protocol v2 header");
    }
    let length = u16::from_be_bytes(data[14..16].try_into()?) as usize;
    if data.len() < 16 + length {
        bail!("incomplete proxy protocol v2 payload");
    }
    if data[12] >> 4 != 0x2 {
        bail!("invalid proxy protocol v2 version");
    }
    let rest = data[16 + length..].to_vec();
    if data[12] & 0x0f == 0 {
        return Ok((Some(ProxyInfo::default()), rest));
    }
    if data[12] & 0x0f != 1 {
        bail!("unsupported proxy protocol v2 command");
    }
    let payload = &data[16..16 + length];
    let info = match data[13] {
        0x11 if payload.len() >= 12 => ProxyInfo {
            source_ip: IpAddr::from(<[u8; 4]>::try_from(&payload[0..4])?).to_string(),
            dest_ip: IpAddr::from(<[u8; 4]>::try_from(&payload[4..8])?).to_string(),
            source_port: u16::from_be_bytes(payload[8..10].try_into()?),
            dest_port: u16::from_be_bytes(payload[10..12].try_into()?),
        },
        0x21 if payload.len() >= 36 => ProxyInfo {
            source_ip: IpAddr::from(<[u8; 16]>::try_from(&payload[0..16])?).to_string(),
            dest_ip: IpAddr::from(<[u8; 16]>::try_from(&payload[16..32])?).to_string(),
            source_port: u16::from_be_bytes(payload[32..34].try_into()?),
            dest_port: u16::from_be_bytes(payload[34..36].try_into()?),
        },
        0x00 => ProxyInfo::default(),
        _ => bail!("unsupported proxy protocol v2 address family"),
    };
    Ok((Some(info), rest))
}

fn format_proxy_header(hello: &HelloFrame) -> Vec<u8> {
    let destination = if hello.proxy_dest_ip.is_empty() {
        &hello.target_ip
    } else {
        &hello.proxy_dest_ip
    };
    let destination_port = if hello.proxy_dest_port == 0 {
        hello.target_port
    } else {
        hello.proxy_dest_port
    };
    if hello.proxy_protocol_version == 2 {
        let source = hello.proxy_source_ip.parse::<IpAddr>().ok();
        let destination = destination.parse::<IpAddr>().ok();
        if let (Some(IpAddr::V4(source)), Some(IpAddr::V4(destination))) = (source, destination) {
            let mut output = vec![0u8; 28];
            output[..12].copy_from_slice(&PROXY_V2_SIGNATURE);
            output[12] = 0x21;
            output[13] = 0x11;
            output[14..16].copy_from_slice(&12u16.to_be_bytes());
            output[16..20].copy_from_slice(&source.octets());
            output[20..24].copy_from_slice(&destination.octets());
            output[24..26].copy_from_slice(&hello.proxy_source_port.to_be_bytes());
            output[26..28].copy_from_slice(&destination_port.to_be_bytes());
            return output;
        }
        if let (Some(IpAddr::V6(source)), Some(IpAddr::V6(destination))) = (source, destination) {
            let mut output = vec![0u8; 52];
            output[..12].copy_from_slice(&PROXY_V2_SIGNATURE);
            output[12] = 0x21;
            output[13] = 0x21;
            output[14..16].copy_from_slice(&36u16.to_be_bytes());
            output[16..32].copy_from_slice(&source.octets());
            output[32..48].copy_from_slice(&destination.octets());
            output[48..50].copy_from_slice(&hello.proxy_source_port.to_be_bytes());
            output[50..52].copy_from_slice(&destination_port.to_be_bytes());
            return output;
        }
        let mut output = vec![0u8; 16];
        output[..12].copy_from_slice(&PROXY_V2_SIGNATURE);
        output[12] = 0x20;
        return output;
    }
    let family = if hello.proxy_source_ip.contains(':') || destination.contains(':') {
        "TCP6"
    } else {
        "TCP4"
    };
    format!(
        "PROXY {} {} {} {} {}\r\n",
        family, hello.proxy_source_ip, destination, hello.proxy_source_port, destination_port
    )
    .into_bytes()
}

async fn resolve_endpoint(endpoint: &ExitEndpoint) -> Result<SocketAddr> {
    if let Ok(ip) = endpoint.host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, endpoint.port));
    }
    lookup_host(endpoint_text(&endpoint.host, endpoint.port))
        .await?
        .next()
        .ok_or_else(|| anyhow!("endpoint has no addresses"))
}
fn bind_address(host: &str, port: u16) -> String {
    endpoint_text(
        if host.trim().is_empty() {
            "0.0.0.0"
        } else {
            host.trim()
        },
        port,
    )
}

fn listen_tcp(host: &str, port: u16, fast_open: bool) -> Result<TcpListener> {
    let listener = if host.trim().is_empty() {
        match dual_stack_tcp_listener(port) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!(
                    "dual-stack tcp listen unavailable on :{}; falling back to IPv4: {}",
                    port, error
                );
                std::net::TcpListener::bind(bind_address("0.0.0.0", port))?
            }
        }
    } else {
        std::net::TcpListener::bind(bind_address(host, port))?
    };
    listener.set_nonblocking(true)?;
    #[cfg(target_os = "linux")]
    if fast_open {
        use std::os::fd::AsRawFd;
        let queue: libc::c_int = 256;
        let result = unsafe {
            libc::setsockopt(
                listener.as_raw_fd(),
                libc::IPPROTO_TCP,
                libc::TCP_FASTOPEN,
                (&queue as *const libc::c_int).cast(),
                std::mem::size_of_val(&queue) as libc::socklen_t,
            )
        };
        if result != 0 {
            eprintln!(
                "tcp fast open unavailable on :{}: {}",
                port,
                std::io::Error::last_os_error()
            );
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = fast_open;
    Ok(TcpListener::from_std(listener)?)
}

fn dual_stack_tcp_listener(port: u16) -> std::io::Result<std::net::TcpListener> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_only_v6(false)?;
    socket.set_reuse_address(true)?;
    socket.bind(&SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), port).into())?;
    socket.listen(1024)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

fn tune_tcp_stream(stream: &TcpStream) {
    stream.set_nodelay(true).ok();
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;

        let fd = stream.as_raw_fd();
        let enabled: libc::c_int = 1;
        let idle: libc::c_int = 30;
        let interval: libc::c_int = 10;
        let probes: libc::c_int = 3;
        unsafe {
            let _ = libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_KEEPALIVE,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            );
            let _ = libc::setsockopt(
                fd,
                libc::IPPROTO_TCP,
                libc::TCP_KEEPIDLE,
                (&idle as *const libc::c_int).cast(),
                std::mem::size_of_val(&idle) as libc::socklen_t,
            );
            let _ = libc::setsockopt(
                fd,
                libc::IPPROTO_TCP,
                libc::TCP_KEEPINTVL,
                (&interval as *const libc::c_int).cast(),
                std::mem::size_of_val(&interval) as libc::socklen_t,
            );
            let _ = libc::setsockopt(
                fd,
                libc::IPPROTO_TCP,
                libc::TCP_KEEPCNT,
                (&probes as *const libc::c_int).cast(),
                std::mem::size_of_val(&probes) as libc::socklen_t,
            );
        }
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
fn is_closed(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("closed")
        || text.contains("broken pipe")
        || text.contains("connection reset")
        || text.contains("early eof")
}

struct ConnectionGate {
    max_connections: usize,
    max_ips: usize,
    active: AtomicUsize,
    ips: Mutex<HashMap<IpAddr, usize>>,
}
impl ConnectionGate {
    fn new(max_connections: usize, max_ips: usize) -> Self {
        Self {
            max_connections,
            max_ips,
            active: AtomicUsize::new(0),
            ips: Mutex::new(HashMap::new()),
        }
    }
    fn acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ConnectionPermit> {
        if self.max_connections > 0 && self.active.load(Ordering::Relaxed) >= self.max_connections {
            return None;
        }
        let mut ips = self.ips.lock().expect("connection gate lock");
        if self.max_ips > 0 && !ips.contains_key(&ip) && ips.len() >= self.max_ips {
            return None;
        }
        *ips.entry(ip).or_default() += 1;
        self.active.fetch_add(1, Ordering::Relaxed);
        Some(ConnectionPermit {
            gate: self.clone(),
            ip,
        })
    }
}
struct ConnectionPermit {
    gate: Arc<ConnectionGate>,
    ip: IpAddr,
}
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.gate.active.fetch_sub(1, Ordering::Relaxed);
        let mut ips = self.gate.ips.lock().expect("connection gate lock");
        if let Some(count) = ips.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                ips.remove(&self.ip);
            }
        }
    }
}
