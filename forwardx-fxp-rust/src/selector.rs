use crate::config::{normalize_exit_strategy, ExitEndpoint};
use rand::{rngs::OsRng, RngCore};
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, Instant},
};

const RETRY_AFTER: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct SelectedEndpoint {
    pub endpoint: ExitEndpoint,
    pub index: usize,
}

struct SelectorState {
    healthy: Vec<bool>,
    retry_after: Vec<Option<Instant>>,
    next: usize,
}

pub struct ExitSelector {
    endpoints: Vec<ExitEndpoint>,
    strategy: &'static str,
    state: Mutex<SelectorState>,
}

impl ExitSelector {
    pub fn new(extra: &[ExitEndpoint], fallback: ExitEndpoint, strategy: &str) -> Self {
        let mut endpoints = Vec::with_capacity(extra.len() + 1);
        let mut seen = HashSet::new();
        for endpoint in std::iter::once(fallback).chain(extra.iter().cloned()) {
            if endpoint.host.is_empty() || endpoint.port == 0 {
                continue;
            }
            let udp_port = if endpoint.udp_port == 0 {
                endpoint.port
            } else {
                endpoint.udp_port
            };
            let key = format!(
                "{}:{}:{}:{}",
                endpoint.host, endpoint.port, udp_port, endpoint.key
            );
            if !seen.insert(key) {
                continue;
            }
            endpoints.push(ExitEndpoint {
                udp_port,
                ..endpoint
            });
        }
        let size = endpoints.len();
        Self {
            endpoints,
            strategy: normalize_exit_strategy(strategy),
            state: Mutex::new(SelectorState {
                healthy: vec![true; size],
                retry_after: vec![None; size],
                next: 0,
            }),
        }
    }

    pub fn len(&self) -> usize {
        self.endpoints.len()
    }
    pub fn pick(&self, excluded: &HashSet<usize>, selection_key: &str) -> Option<SelectedEndpoint> {
        let mut state = self.state.lock().expect("selector lock");
        let now = Instant::now();
        let eligible = |index: usize, state: &SelectorState| {
            state.healthy[index] || state.retry_after[index].is_none_or(|until| now >= until)
        };
        let available: Vec<usize> = (0..self.endpoints.len())
            .filter(|index| !excluded.contains(index) && eligible(*index, &state))
            .collect();
        let candidates = if available.is_empty() {
            (0..self.endpoints.len())
                .filter(|index| !excluded.contains(index))
                .collect()
        } else {
            available
        };
        if candidates.is_empty() {
            return None;
        }

        let index = match self.strategy {
            "fallback" => candidates[0],
            "random" => {
                let mut value = [0u8; 8];
                OsRng.fill_bytes(&mut value);
                candidates[(u64::from_be_bytes(value) as usize) % candidates.len()]
            }
            "ip_hash" if !selection_key.trim().is_empty() => {
                candidates[(fnv1a(selection_key.as_bytes()) as usize) % candidates.len()]
            }
            _ => {
                let index = candidates[state.next % candidates.len()];
                state.next = (state.next + 1) % 1_000_000;
                index
            }
        };
        Some(SelectedEndpoint {
            endpoint: self.endpoints[index].clone(),
            index,
        })
    }

    pub fn mark_failure(&self, index: usize, error: &str) {
        let mut state = self.state.lock().expect("selector lock");
        if index >= self.endpoints.len() {
            return;
        }
        let was_healthy = state.healthy[index];
        state.healthy[index] = false;
        state.retry_after[index] = Some(Instant::now() + RETRY_AFTER);
        if was_healthy {
            let endpoint = &self.endpoints[index];
            eprintln!(
                "exit endpoint unhealthy index={} endpoint={}:{} reason={}",
                index, endpoint.host, endpoint.port, error
            );
        }
    }

    pub fn mark_healthy(&self, index: usize) {
        let mut state = self.state.lock().expect("selector lock");
        if index >= self.endpoints.len() {
            return;
        }
        let was_healthy = state.healthy[index];
        state.healthy[index] = true;
        state.retry_after[index] = None;
        if !was_healthy {
            let endpoint = &self.endpoints[index];
            eprintln!(
                "exit endpoint recovered index={} endpoint={}:{}",
                index, endpoint.host, endpoint.port
            );
        }
    }

    pub fn description(&self) -> String {
        self.endpoints
            .iter()
            .map(|endpoint| {
                if endpoint.udp_port != endpoint.port {
                    format!(
                        "{}:{}/udp:{}",
                        endpoint.host, endpoint.port, endpoint.udp_port
                    )
                } else {
                    format!("{}:{}", endpoint.host, endpoint.port)
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn fnv1a(value: &[u8]) -> u64 {
    let mut hash = 14_695_981_039_346_656_037u64;
    for byte in value {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}
