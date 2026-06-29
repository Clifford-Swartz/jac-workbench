mod capture;
mod volume;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()).unwrap_or("") {
        "capture-audio" => {
            let rate = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(44100u32);
            capture::start(rate);
        }
        "volume-watch" | "volume-daemon" => volume::watch(),
        "get-volume" => {
            println!("VOL:{}", volume::get());
        }
        "set-volume" => {
            let n = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(50u32);
            volume::set(n);
        }
        // macOS-specific commands from the Swift binary — no-op stubs so the
        // TypeScript side doesn't crash if it calls them on macOS with this binary.
        "activate" | "restore" | "destroy" | "list" => {
            println!("OK");
        }
        cmd => {
            eprintln!("jac-audio: unknown command '{}'", cmd);
            std::process::exit(1);
        }
    }
}
