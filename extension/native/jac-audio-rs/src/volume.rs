use std::io::Write;

pub fn get() -> u32 { platform::get() }
pub fn set(n: u32)  { platform::set(n) }
pub fn watch()      { platform::watch() }

// ── Windows: IAudioEndpointVolume ─────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use windows::{
        core::*,
        Win32::{
            Media::Audio::{
                eConsole, eRender, IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator,
            },
            System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
        },
    };

    fn endpoint() -> Result<IAudioEndpointVolume> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
        }
    }

    pub fn get() -> u32 {
        endpoint()
            .ok()
            .and_then(|ep| unsafe { ep.GetMasterVolumeLevelScalar().ok() })
            .map(|v| (v * 100.0).round() as u32)
            .unwrap_or(50)
    }

    pub fn set(pct: u32) {
        if let Ok(ep) = endpoint() {
            let v = (pct.min(100) as f32) / 100.0;
            unsafe {
                ep.SetMasterVolumeLevelScalar(v, std::ptr::null()).ok();
            }
        }
    }

    fn muted() -> bool {
        endpoint()
            .ok()
            .and_then(|ep| unsafe { ep.GetMute().ok() })
            .map(|m| m.as_bool())
            .unwrap_or(false)
    }

    pub fn watch() {
        let mut last_vol = u32::MAX;
        let mut last_muted: Option<bool> = None;
        loop {
            let vol = get();
            let m = muted();
            if vol != last_vol {
                println!("VOL:{}", vol);
                std::io::stdout().flush().ok();
                last_vol = vol;
            }
            if Some(m) != last_muted {
                println!("MUTE:{}", m);
                std::io::stdout().flush().ok();
                last_muted = Some(m);
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

// ── macOS: osascript ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    fn osascript(script: &str) -> String {
        std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }

    // Parse "output volume:75, input volume:75, alert volume:100, output muted:false"
    fn parse_settings() -> (u32, bool) {
        let out = osascript("get volume settings");
        let mut vol = 50u32;
        let mut muted = false;
        for part in out.split(',') {
            let mut kv = part.trim().splitn(2, ':');
            match (kv.next().map(str::trim), kv.next().map(str::trim)) {
                (Some("output volume"), Some(v)) => {
                    vol = v.parse().unwrap_or(50);
                }
                (Some("output muted"), Some(v)) => {
                    muted = v == "true";
                }
                _ => {}
            }
        }
        (vol, muted)
    }

    pub fn get() -> u32 { parse_settings().0 }

    pub fn set(pct: u32) {
        osascript(&format!("set volume output volume {}", pct.min(100)));
    }

    pub fn watch() {
        let mut last_vol = u32::MAX;
        let mut last_muted: Option<bool> = None;
        loop {
            let (vol, m) = parse_settings();
            if vol != last_vol {
                println!("VOL:{}", vol);
                std::io::stdout().flush().ok();
                last_vol = vol;
            }
            if Some(m) != last_muted {
                println!("MUTE:{}", m);
                std::io::stdout().flush().ok();
                last_muted = Some(m);
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

// ── Linux stub (not wired up yet) ─────────────────────────────────────────────

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    pub fn get() -> u32 { 50 }
    pub fn set(_: u32) {}
    pub fn watch() {
        loop { std::thread::sleep(std::time::Duration::from_secs(3600)); }
    }
}
