// ── Windows: WASAPI loopback capture ─────────────────────────────────────────

#[cfg(windows)]
pub fn start(sample_rate: u32) {
    use std::io::Write;
    use wasapi::*;

    let _ = sample_rate; // WASAPI shared mode uses the device mix format; we output whatever it is

    initialize_mta().expect("COM MTA init failed");

    // Loopback captures from the render (output) device
    let device = get_default_endpoint(Direction::Render).expect("no default audio output device");
    let mut audio_client = device.get_iaudioclient().expect("get IAudioClient failed");

    // Use the device's native mix format — WASAPI shared mode requires it
    let mix_fmt = audio_client.get_mixformat().expect("GetMixFormat failed");
    let channels = mix_fmt.get_nchannels() as usize;
    let sample_type = mix_fmt.get_sampletype();
    let bits = mix_fmt.get_bitspersample();

    audio_client
        .initialize_client(
            &mix_fmt,
            0,                   // default latency
            &Direction::Capture, // capture direction
            &ShareMode::Shared,
            true, // loopback = true
        )
        .expect("IAudioClient::Initialize failed");

    let capture_client = audio_client
        .get_iaudiocaptureclient()
        .expect("get IAudioCaptureClient failed");

    audio_client.start_stream().expect("IAudioClient::Start failed");

    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::with_capacity(65536, stdout.lock());

    loop {
        // Wait up to 100ms for the next buffer
        let _ = audio_client.wait_for_buffer(100);

        loop {
            let frames = match capture_client.get_next_packet_size() {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };

            let mono_samples: Vec<f32> = match (&sample_type, bits) {
                (SampleType::Float, _) => {
                    match capture_client.get_buffer::<f32>() {
                        Ok((data, _flags)) => downmix_f32(&data, channels),
                        Err(_) => { let _ = capture_client.release_buffer(0); break; }
                    }
                }
                (SampleType::Int, 16) => {
                    match capture_client.get_buffer::<i16>() {
                        Ok((data, _flags)) => downmix_i16(&data, channels),
                        Err(_) => { let _ = capture_client.release_buffer(0); break; }
                    }
                }
                _ => {
                    // Unsupported format — skip this packet
                    let _ = capture_client.release_buffer(frames);
                    continue;
                }
            };

            let actual_frames = mono_samples.len() as u32;
            for s in &mono_samples {
                out.write_all(&s.to_le_bytes()).ok();
            }
            let _ = capture_client.release_buffer(actual_frames);
        }

        out.flush().ok();
    }
}

#[cfg(windows)]
fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    let frames = data.len() / channels.max(1);
    (0..frames).map(|i| {
        let sum: f32 = (0..channels).map(|ch| data[i * channels + ch]).sum();
        sum / channels as f32
    }).collect()
}

#[cfg(windows)]
fn downmix_i16(data: &[i16], channels: usize) -> Vec<f32> {
    let frames = data.len() / channels.max(1);
    (0..frames).map(|i| {
        let sum: f32 = (0..channels).map(|ch| data[i * channels + ch] as f32 / 32768.0).sum();
        sum / channels as f32
    }).collect()
}

// ── macOS: cpal input capture (BlackHole or default input) ───────────────────

#[cfg(target_os = "macos")]
pub fn start(sample_rate: u32) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    let host = cpal::default_host();

    // JAC_AUDIO_DEVICE env var selects the capture device by name substring.
    // Set to "BlackHole" (or whatever loopback device is installed) for system audio.
    let device = std::env::var("JAC_AUDIO_DEVICE")
        .ok()
        .and_then(|name| {
            host.input_devices().ok()?.find(|d| {
                d.name().map(|n| n.to_lowercase().contains(&name.to_lowercase())).unwrap_or(false)
            })
        })
        .or_else(|| host.default_input_device())
        .expect("no input audio device found");

    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let out = Arc::new(Mutex::new(
        std::io::BufWriter::with_capacity(65536, std::io::stdout()),
    ));
    let out2 = out.clone();

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                if let Ok(mut w) = out2.lock() {
                    for &s in data {
                        w.write_all(&s.to_le_bytes()).ok();
                    }
                    w.flush().ok();
                }
            },
            |e| eprintln!("cpal stream error: {e}"),
            None,
        )
        .expect("build_input_stream failed");

    stream.play().expect("cpal play failed");

    // Block forever — the stream runs on a background thread
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
