use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{collections::HashSet, fs, path::Path};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ExitEndpoint {
    pub host: String,
    pub port: u16,
    #[serde(rename = "udpPort", default)]
    pub udp_port: u16,
    #[serde(default)]
    pub key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct UdpTarget {
    #[serde(rename = "ruleId")]
    pub rule_id: i32,
    #[serde(rename = "targetIp")]
    pub target_ip: String,
    #[serde(rename = "targetPort")]
    pub target_port: u16,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    pub role: String,
    #[serde(rename = "tunnelId", default)]
    pub tunnel_id: i32,
    #[serde(rename = "ruleId", default)]
    pub rule_id: i32,
    #[serde(rename = "listenPort")]
    pub listen_port: u16,
    #[serde(rename = "udpListenPort", default)]
    pub udp_listen_port: u16,
    #[serde(rename = "listenHost", default)]
    pub listen_host: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(rename = "exitHost", default)]
    pub exit_host: String,
    #[serde(rename = "exitPort", default)]
    pub exit_port: u16,
    #[serde(rename = "udpExitPort", default)]
    pub udp_exit_port: u16,
    #[serde(default)]
    pub exits: Vec<ExitEndpoint>,
    #[serde(rename = "exitStrategy", default)]
    pub exit_strategy: String,
    #[serde(rename = "targetIp", default)]
    pub target_ip: String,
    #[serde(rename = "targetPort", default)]
    pub target_port: u16,
    #[serde(rename = "udpTargets", default)]
    pub udp_targets: Vec<UdpTarget>,
    #[serde(default)]
    pub key: String,
    #[serde(rename = "limitIn", default)]
    pub limit_in: i64,
    #[serde(rename = "limitOut", default)]
    pub limit_out: i64,
    #[serde(rename = "maxConnections", default)]
    pub max_connections: usize,
    #[serde(rename = "maxIPs", default)]
    pub max_ips: usize,
    #[serde(rename = "blockHttp", default)]
    pub block_http: bool,
    #[serde(rename = "blockSocks", default)]
    pub block_socks: bool,
    #[serde(rename = "blockTls", default)]
    pub block_tls: bool,
    #[serde(rename = "proxyProtocolReceive", default)]
    pub proxy_protocol_receive: bool,
    #[serde(rename = "proxyProtocolSend", default)]
    pub proxy_protocol_send: bool,
    #[serde(rename = "proxyProtocolExitReceive", default)]
    pub proxy_protocol_exit_receive: bool,
    #[serde(rename = "proxyProtocolExitSend", default)]
    pub proxy_protocol_exit_send: bool,
    #[serde(rename = "proxyProtocolVersion", default)]
    pub proxy_protocol_version: i32,
    #[serde(rename = "tcpFastOpen", default)]
    pub tcp_fast_open: bool,
    #[serde(rename = "panelUrl", default)]
    pub panel_url: String,
    #[serde(default)]
    pub token: String,
    #[serde(rename = "relayExitHost", default)]
    pub relay_exit_host: String,
    #[serde(rename = "relayExitPort", default)]
    pub relay_exit_port: u16,
    #[serde(rename = "udpRelayExitPort", default)]
    pub udp_relay_exit_port: u16,
    #[serde(rename = "relayKey", default)]
    pub relay_key: String,
}

impl Config {
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self> {
        let contents = fs::read_to_string(path.as_ref())
            .with_context(|| format!("read config {}", path.as_ref().display()))?;
        let mut config: Self = serde_json::from_str(&contents).context("parse config JSON")?;
        config.normalize_and_validate()?;
        Ok(config)
    }

    fn normalize_and_validate(&mut self) -> Result<()> {
        self.role = self.role.trim().to_ascii_lowercase();
        self.protocol = normalize_protocol(&self.protocol).to_string();
        self.listen_host = self.listen_host.trim().to_string();
        self.exit_host = self.exit_host.trim().to_string();
        self.target_ip = self.target_ip.trim().to_string();
        self.relay_exit_host = self.relay_exit_host.trim().to_string();
        self.exit_strategy = normalize_exit_strategy(&self.exit_strategy).to_string();
        self.proxy_protocol_version = if self.proxy_protocol_version == 2 {
            2
        } else {
            1
        };

        if self.udp_listen_port == 0 {
            self.udp_listen_port = self.listen_port;
        }
        if self.udp_exit_port == 0 {
            self.udp_exit_port = self.exit_port;
        }
        if self.udp_relay_exit_port == 0 {
            self.udp_relay_exit_port = self.relay_exit_port;
        }

        let default_endpoint_key = if self.role == "relay" && !self.relay_key.is_empty() {
            self.relay_key.clone()
        } else {
            self.key.clone()
        };
        for endpoint in &mut self.exits {
            endpoint.host = endpoint.host.trim().to_string();
            if endpoint.udp_port == 0 {
                endpoint.udp_port = endpoint.port;
            }
            if endpoint.key.is_empty() {
                endpoint.key = default_endpoint_key.clone();
            }
        }

        let mut ids = HashSet::new();
        self.udp_targets.retain_mut(|target| {
            target.target_ip = target.target_ip.trim().to_string();
            target.rule_id > 0
                && !target.target_ip.is_empty()
                && target.target_port > 0
                && ids.insert(target.rule_id)
        });
        self.udp_targets.sort_by_key(|target| target.rule_id);

        if self.key.is_empty() {
            bail!("empty key");
        }
        if self.listen_port == 0 {
            bail!("bad listen port");
        }
        if !self.listen_host.is_empty()
            && self.listen_host != "127.0.0.1"
            && self.listen_host != "::1"
        {
            bail!("unsupported listen host {:?}", self.listen_host);
        }
        if self.role == "entry" {
            if self.exit_host.is_empty() || self.exit_port == 0 {
                bail!("entry requires exit host and port");
            }
            if self.target_ip.is_empty() || self.target_port == 0 {
                bail!("entry requires target host and port");
            }
            if self.exits.iter().any(|endpoint| {
                endpoint.host.is_empty() || endpoint.port == 0 || endpoint.udp_port == 0
            }) {
                bail!("entry exits require host and port");
            }
        }
        if (self.proxy_protocol_receive
            || self.proxy_protocol_send
            || self.proxy_protocol_exit_receive
            || self.proxy_protocol_exit_send)
            && self.protocol == "udp"
        {
            bail!("proxy protocol requires tcp protocol");
        }
        if self.role == "relay"
            && (self.relay_exit_host.is_empty()
                || self.relay_exit_port == 0
                || self.relay_key.is_empty())
        {
            bail!("relay requires relay exit host, port, and key");
        }
        if !matches!(self.role.as_str(), "entry" | "exit" | "relay") {
            bail!("unknown role {:?}", self.role);
        }
        Ok(())
    }

    pub fn has_tcp(&self) -> bool {
        self.protocol == "tcp" || self.protocol == "both"
    }
    pub fn has_udp(&self) -> bool {
        self.protocol == "udp" || self.protocol == "both"
    }
    pub fn udp_target(&self, rule_id: i32) -> Option<&UdpTarget> {
        self.udp_targets
            .iter()
            .find(|target| target.rule_id == rule_id)
    }
}

pub fn normalize_protocol(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "udp" => "udp",
        "both" | "tcp+udp" => "both",
        _ => "tcp",
    }
}

pub fn normalize_exit_strategy(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "fallback" => "fallback",
        "random" => "random",
        "ip_hash" => "ip_hash",
        _ => "round_robin",
    }
}
