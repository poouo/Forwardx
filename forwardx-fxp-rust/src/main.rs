mod logging;

macro_rules! eprintln {
    ($($arg:tt)*) => {{ crate::logging::write(format_args!($($arg)*)); }};
}

macro_rules! verbose_log {
    ($($arg:tt)*) => {{
        if crate::logging::verbose_enabled() {
            crate::logging::write(format_args!($($arg)*));
        }
    }};
}

mod config;
mod crypto;
mod runtime;
mod selector;
mod tcp;
mod udp;

use anyhow::{anyhow, Result};
use config::{Config, ExitEndpoint};
use runtime::{start_traffic_reporter, wait_for_session_drain, RateLimiter};
use selector::ExitSelector;
use std::{path::PathBuf, sync::Arc};
use tokio::task::JoinSet;

const RUNTIME_VERSION: &str = "2.2.105-rust";

#[tokio::main]
async fn main() -> Result<()> {
    let config_path = parse_config_path()?;
    let cfg = Arc::new(Config::from_path(config_path)?);
    eprintln!(
        "forwardx-fxp runtime version={} implementation=rust role={} tunnel={} rule={} listen=:{} udpListen=:{} protocol={} exit={}:{} udpExit={} relayNext={}:{} udpRelayNext={} target={}:{} limits=maxConnections:{},maxIPs:{},limitIn:{},limitOut:{}",
        RUNTIME_VERSION, cfg.role, cfg.tunnel_id, cfg.rule_id, cfg.listen_port, cfg.udp_listen_port,
        cfg.protocol, cfg.exit_host, cfg.exit_port, cfg.udp_exit_port, cfg.relay_exit_host,
        cfg.relay_exit_port, cfg.udp_relay_exit_port, cfg.target_ip, cfg.target_port,
        cfg.max_connections, cfg.max_ips, cfg.limit_in, cfg.limit_out,
    );

    let fallback = if cfg.role == "relay" {
        ExitEndpoint {
            host: cfg.relay_exit_host.clone(),
            port: cfg.relay_exit_port,
            udp_port: cfg.udp_relay_exit_port,
            key: cfg.relay_key.clone(),
        }
    } else {
        ExitEndpoint {
            host: cfg.exit_host.clone(),
            port: cfg.exit_port,
            udp_port: cfg.udp_exit_port,
            key: cfg.key.clone(),
        }
    };
    let selector = Arc::new(ExitSelector::new(&cfg.exits, fallback, &cfg.exit_strategy));
    if selector.len() > 1 {
        eprintln!(
            "{} exit selector exits={} strategy={}",
            cfg.role,
            selector.description(),
            cfg.exit_strategy
        );
    }

    let input_limit = RateLimiter::new(cfg.limit_in);
    let output_limit = RateLimiter::new(cfg.limit_out);
    let traffic = start_traffic_reporter(&cfg);
    let mut tasks = JoinSet::new();
    if cfg.has_tcp() {
        let cfg = cfg.clone();
        let selector = selector.clone();
        let input_limit = input_limit.clone();
        let output_limit = output_limit.clone();
        let traffic = traffic.clone();
        tasks.spawn(async move {
            match cfg.role.as_str() {
                "entry" => tcp::run_entry(cfg, selector, input_limit, output_limit, traffic).await,
                "exit" => tcp::run_exit(cfg).await,
                "relay" => tcp::run_relay(cfg, selector).await,
                _ => unreachable!(),
            }
        });
    }
    if cfg.has_udp() {
        let cfg = cfg.clone();
        let selector = selector.clone();
        let input_limit = input_limit.clone();
        let output_limit = output_limit.clone();
        let traffic = traffic.clone();
        tasks.spawn(async move {
            match cfg.role.as_str() {
                "entry" => udp::run_entry(cfg, selector, input_limit, output_limit, traffic).await,
                "exit" => udp::run_exit(cfg).await,
                "relay" => udp::run_relay(cfg, selector).await,
                _ => unreachable!(),
            }
        });
    }
    if tasks.is_empty() {
        return Err(anyhow!("no protocol listener configured"));
    }

    tokio::select! {
        signal = shutdown_signal() => {
            signal?;
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
            if wait_for_session_drain(std::time::Duration::from_secs(5)).await {
                eprintln!("fxp tcp sessions drained role={} tunnel={} rule={}", cfg.role, cfg.tunnel_id, cfg.rule_id);
            } else {
                eprintln!("fxp tcp session drain timeout role={} tunnel={} rule={} timeout=5s", cfg.role, cfg.tunnel_id, cfg.rule_id);
            }
            Ok(())
        }
        result = tasks.join_next() => {
            tasks.abort_all();
            match result {
                Some(Ok(result)) => result,
                Some(Err(error)) => Err(error.into()),
                None => Err(anyhow!("FXP listeners exited")),
            }
        }
    }
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}

fn parse_config_path() -> Result<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        if argument == "-config" || argument == "--config" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| anyhow!("missing -config value"));
        }
    }
    Err(anyhow!("missing -config"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };
    use tokio::{
        net::UdpSocket,
        time::{sleep, timeout},
    };

    static NEXT_CONFIG: AtomicU64 = AtomicU64::new(1);

    fn config(value: serde_json::Value) -> Arc<Config> {
        let id = NEXT_CONFIG.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "forwardx-fxp-rust-test-{}-{}.json",
            std::process::id(),
            id
        ));
        fs::write(
            &path,
            serde_json::to_vec(&value).expect("serialize test config"),
        )
        .expect("write test config");
        let result = Arc::new(Config::from_path(&path).expect("load test config"));
        fs::remove_file(path).ok();
        result
    }

    async fn udp_port() -> u16 {
        let socket = UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("reserve UDP port");
        socket.local_addr().expect("UDP local address").port()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rust_udp_runtime_round_trips_fragmented_datagrams() {
        let echo = Arc::new(UdpSocket::bind("127.0.0.1:0").await.expect("bind UDP echo"));
        let echo_port = echo.local_addr().expect("echo address").port();
        let echo_task = {
            let echo = echo.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 65_507];
                loop {
                    let (length, peer) = echo
                        .recv_from(&mut buffer)
                        .await
                        .expect("receive echo packet");
                    echo.send_to(&buffer[..length], peer)
                        .await
                        .expect("send echo packet");
                }
            })
        };
        let exit_port = udp_port().await;
        let entry_port = udp_port().await;
        let tunnel_id = 71_001;
        let rule_id = 71_002;
        let key = "rust-udp-runtime-test";
        let exit = config(serde_json::json!({
            "role": "exit", "tunnelId": tunnel_id, "ruleId": 0, "listenPort": exit_port,
            "listenHost": "127.0.0.1", "protocol": "udp", "key": key,
            "udpTargets": [{ "ruleId": rule_id, "targetIp": "127.0.0.1", "targetPort": echo_port }]
        }));
        let entry = config(serde_json::json!({
            "role": "entry", "tunnelId": tunnel_id, "ruleId": rule_id, "listenPort": entry_port,
            "listenHost": "127.0.0.1", "protocol": "udp", "key": key,
            "exitHost": "127.0.0.1", "exitPort": exit_port,
            "targetIp": "127.0.0.1", "targetPort": echo_port
        }));
        let exit_task = tokio::spawn(udp::run_exit(exit));
        let entry_selector = Arc::new(ExitSelector::new(
            &[],
            ExitEndpoint {
                host: "127.0.0.1".to_string(),
                port: exit_port,
                udp_port: exit_port,
                key: key.to_string(),
            },
            "round_robin",
        ));
        let entry_task = tokio::spawn(udp::run_entry(
            entry,
            entry_selector,
            RateLimiter::new(0),
            RateLimiter::new(0),
            Arc::default(),
        ));
        sleep(Duration::from_millis(100)).await;

        let client = UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind UDP client");
        let payload: Vec<u8> = (0..32 * 1024 + 137)
            .map(|index| (index % 251) as u8)
            .collect();
        client
            .send_to(&payload, ("127.0.0.1", entry_port))
            .await
            .expect("send UDP payload");
        let mut response = vec![0u8; 65_507];
        let (length, _) = timeout(Duration::from_secs(3), client.recv_from(&mut response))
            .await
            .expect("UDP response timeout")
            .expect("receive UDP response");
        assert_eq!(&response[..length], payload);

        entry_task.abort();
        exit_task.abort();
        echo_task.abort();
    }
}
