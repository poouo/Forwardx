use std::{
    fmt,
    io::Write,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(60);
const MAX_WINDOW_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024;

struct LogState {
    window_started: Instant,
    written: usize,
    suppressed: u64,
}

pub fn write(arguments: fmt::Arguments<'_>) {
    let mut line = arguments.to_string();
    if line.len() > MAX_LINE_BYTES {
        line.truncate(MAX_LINE_BYTES.saturating_sub(16));
        line.push_str("... [truncated]");
    }
    let now = Instant::now();
    let mut state = log_state().lock().expect("FXP log state lock");
    let mut stderr = std::io::stderr().lock();
    if now.duration_since(state.window_started) >= WINDOW {
        if state.suppressed > 0 {
            let _ = writeln!(
                stderr,
                "forwardx-fxp log rate limit suppressed={}",
                state.suppressed
            );
        }
        state.window_started = now;
        state.written = 0;
        state.suppressed = 0;
    }
    if state.written.saturating_add(line.len() + 1) > MAX_WINDOW_BYTES {
        state.suppressed += 1;
        return;
    }
    if writeln!(stderr, "{}", line).is_ok() {
        state.written += line.len() + 1;
    }
}

pub fn verbose_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        matches!(
            std::env::var("FORWARDX_FXP_VERBOSE_LOG")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn log_state() -> &'static Mutex<LogState> {
    static STATE: OnceLock<Mutex<LogState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(LogState {
            window_started: Instant::now(),
            written: 0,
            suppressed: 0,
        })
    })
}
