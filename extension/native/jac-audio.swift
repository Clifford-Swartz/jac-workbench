import CoreAudio
import Foundation
import CoreGraphics
import Cocoa
import ScreenCaptureKit
import AVFoundation

// ── Device helpers ──────────────────────────────────────────────────────────

func getDevices() -> [(AudioDeviceID, String)] {
    var size: UInt32 = 0
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)

    var result: [(AudioDeviceID, String)] = []
    for id in ids {
        var ns: UInt32 = UInt32(MemoryLayout<CFString>.size)
        var na = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: CFString = "" as CFString
        AudioObjectGetPropertyData(id, &na, 0, nil, &ns, &name)
        result.append((id, name as String))
    }
    return result
}

func findSpeakerID() -> AudioDeviceID? {
    let devices = getDevices()
    return devices.first(where: { $0.1.contains("Speaker") || $0.1.contains("Built-in Output") })?.0
}

func setDefaultOutput(_ targetName: String) -> Bool {
    for (id, name) in getDevices() {
        if name == targetName {
            var addr = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            var devId = id
            let status = AudioObjectSetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil,
                UInt32(MemoryLayout<AudioDeviceID>.size), &devId
            )
            return status == noErr
        }
    }
    return false
}

func destroyAggregateByName(_ targetName: String) {
    for (id, name) in getDevices() {
        if name == targetName {
            AudioHardwareDestroyAggregateDevice(id)
        }
    }
}

// ── Volume control on speaker sub-device ────────────────────────────────────

func getSpeakerVolume() -> Float32? {
    guard let speakerID = findSpeakerID() else { return nil }
    var vol: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)

    // Try virtual main volume first (works on most Macs)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: 1 // channel 1
    )

    // Check if the property exists on channel 1
    var hasProperty = AudioObjectHasProperty(speakerID, &addr)
    if hasProperty {
        AudioObjectGetPropertyData(speakerID, &addr, 0, nil, &size, &vol)
        return vol
    }

    // Try main element
    addr.mElement = kAudioObjectPropertyElementMain
    hasProperty = AudioObjectHasProperty(speakerID, &addr)
    if hasProperty {
        AudioObjectGetPropertyData(speakerID, &addr, 0, nil, &size, &vol)
        return vol
    }

    return nil
}

func setSpeakerVolume(_ volume: Float32) -> Bool {
    guard let speakerID = findSpeakerID() else { return false }
    var vol = max(0, min(1, volume))
    let size = UInt32(MemoryLayout<Float32>.size)

    // Set on both channels
    for channel: UInt32 in [1, 2] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: channel
        )
        if AudioObjectHasProperty(speakerID, &addr) {
            AudioObjectSetPropertyData(speakerID, &addr, 0, nil, size, &vol)
        }
    }

    // Also try main element
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    if AudioObjectHasProperty(speakerID, &addr) {
        AudioObjectSetPropertyData(speakerID, &addr, 0, nil, size, &vol)
    }

    return true
}

func getSpeakerMute() -> Bool? {
    guard let speakerID = findSpeakerID() else { return nil }
    var muted: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    if AudioObjectHasProperty(speakerID, &addr) {
        AudioObjectGetPropertyData(speakerID, &addr, 0, nil, &size, &muted)
        return muted != 0
    }
    return nil
}

func setSpeakerMute(_ muted: Bool) -> Bool {
    guard let speakerID = findSpeakerID() else { return false }
    var val: UInt32 = muted ? 1 : 0
    let size = UInt32(MemoryLayout<UInt32>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    if AudioObjectHasProperty(speakerID, &addr) {
        AudioObjectSetPropertyData(speakerID, &addr, 0, nil, size, &val)
        return true
    }
    return false
}

// ── Media key daemon ────────────────────────────────────────────────────────
// Intercepts volume up/down/mute keys and routes them to the speaker sub-device.
// Prints volume changes as JSON to stdout for the extension to read.

func startVolumeDaemon() {
    let volumeStep: Float32 = 1.0 / 16.0  // ~6.25% per press (matches macOS default 16 notches)

    // Create an event tap for system-defined events (media keys)
    let mask: CGEventMask = (1 << CGEventType(rawValue: 14)!.rawValue)

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,  // can modify/consume events
        eventsOfInterest: mask,
        callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
            if type == CGEventType(rawValue: 14)! {
                let data1 = event.getIntegerValueField(.mouseEventSubtype)
                // NX_SUBTYPE_AUX_CONTROL_BUTTONS = 7
                if data1 == 7 {
                    let data2 = event.getIntegerValueField(.mouseEventButtonNumber)
                    let keyCode = (data2 & 0xFFFF0000) >> 16
                    let keyDown = ((data2 & 0xFF00) >> 8) == 0x0A  // key down flag

                    if keyDown {
                        let step = Unmanaged<VolumeStep>.fromOpaque(refcon!).takeUnretainedValue()

                        switch keyCode {
                        case 0:  // Volume up (NX_KEYTYPE_SOUND_UP)
                            let current = getSpeakerVolume() ?? 0.5
                            let newVol = min(1.0, current + step.value)
                            setSpeakerVolume(newVol)
                            let pct = Int(round(newVol * 100))
                            print("VOL:\(pct)", terminator: "\n")
                            fflush(stdout)
                            return nil  // consume the event

                        case 1:  // Volume down (NX_KEYTYPE_SOUND_DOWN)
                            let current = getSpeakerVolume() ?? 0.5
                            let newVol = max(0, current - step.value)
                            setSpeakerVolume(newVol)
                            let pct = Int(round(newVol * 100))
                            print("VOL:\(pct)", terminator: "\n")
                            fflush(stdout)
                            return nil

                        case 7:  // Mute (NX_KEYTYPE_MUTE)
                            let isMuted = getSpeakerMute() ?? false
                            setSpeakerMute(!isMuted)
                            print("MUTE:\(!isMuted)", terminator: "\n")
                            fflush(stdout)
                            return nil

                        default:
                            break
                        }
                    }
                }
            }
            return Unmanaged.passRetained(event)
        },
        userInfo: Unmanaged.passUnretained(VolumeStep(volumeStep)).toOpaque()
    ) else {
        print("ERROR:failed_to_create_event_tap")
        print("HINT: Grant Accessibility permission to the terminal/VS Code in System Settings > Privacy & Security > Accessibility")
        exit(1)
    }

    let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)

    // Print initial volume
    if let vol = getSpeakerVolume() {
        print("VOL:\(Int(round(vol * 100)))")
        fflush(stdout)
    }

    print("DAEMON:started")
    fflush(stdout)

    // Run forever
    CFRunLoopRun()
}

class VolumeStep {
    let value: Float32
    init(_ v: Float32) { self.value = v }
}

// ── ScreenCaptureKit audio capture ──────────────────────────────────────────
// Captures system audio directly — no BlackHole, no Multi-Output needed.
// Volume keys work because the default output stays as speakers.

@available(macOS 13.0, *)
class AudioStreamOutput: NSObject, SCStreamOutput {
    let sampleRate: Int

    init(sampleRate: Int) {
        self.sampleRate = sampleRate
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)

        guard let ptr = dataPointer, length > 0 else { return }

        // Write raw PCM (f32le) directly to stdout
        let data = Data(bytes: ptr, count: length)
        FileHandle.standardOutput.write(data)
    }
}

@available(macOS 13.0, *)
func startScreenCaptureAudio(sampleRate: Int = 48000) {
    let semaphore = DispatchSemaphore(value: 0)

    Task {
        do {
            // Get shareable content (we only need audio, no video)
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

            // Create a filter that captures the entire display (but we only want audio)
            guard let display = content.displays.first else {
                fputs("ERROR: No display found\n", stderr)
                exit(1)
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])

            // Configure stream — audio only, no video
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = false
            config.channelCount = 1  // mono for visualization
            config.sampleRate = sampleRate

            // Disable video capture to save resources
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps minimum
            config.showsCursor = false

            let stream = SCStream(filter: filter, configuration: config, delegate: nil)

            let output = AudioStreamOutput(sampleRate: sampleRate)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))

            try await stream.startCapture()

            fputs("CAPTURE:started:sampleRate=\(sampleRate)\n", stderr)

            // Keep running until killed
            semaphore.wait()

        } catch {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    // Run the main loop to keep the process alive
    dispatchMain()
}

// ── CLI interface ───────────────────────────────────────────────────────────

let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: jac-audio <activate|restore|destroy|list|get-volume|set-volume N|volume-daemon>")
    exit(1)
}

switch args[1] {
case "activate":
    if setDefaultOutput("Multi-Output Device") {
        print("OK:activated")
    } else {
        print("ERROR:not_found")
        exit(1)
    }

case "restore":
    let devices = getDevices()
    let speaker = devices.first(where: { $0.1.contains("Speaker") || $0.1.contains("Built-in Output") })
    if let spk = speaker {
        if setDefaultOutput(spk.1) {
            print("OK:speakers_restored")
        } else {
            print("ERROR:restore_failed")
            exit(1)
        }
    } else {
        print("ERROR:no_speakers")
        exit(1)
    }

case "destroy":
    destroyAggregateByName("Multi-Output Device")
    destroyAggregateByName("JAC Audio")
    let devices = getDevices()
    if let spk = devices.first(where: { $0.1.contains("Speaker") || $0.1.contains("Built-in Output") }) {
        setDefaultOutput(spk.1)
    }
    print("OK:destroyed")

case "list":
    for (id, name) in getDevices() {
        print("\(id): \(name)")
    }

case "get-volume":
    if let vol = getSpeakerVolume() {
        print("VOL:\(Int(round(vol * 100)))")
    } else {
        print("ERROR:no_speakers")
        exit(1)
    }

case "set-volume":
    guard args.count >= 3, let pct = Int(args[2]) else {
        print("Usage: jac-audio set-volume <0-100>")
        exit(1)
    }
    let vol = Float32(max(0, min(100, pct))) / 100.0
    if setSpeakerVolume(vol) {
        print("OK:volume_set:\(pct)")
    } else {
        print("ERROR:no_speakers")
        exit(1)
    }

case "volume-daemon":
    startVolumeDaemon()

case "volume-watch":
    // Watch for speaker volume changes via polling.
    // Works on macOS Sequoia where CGEventTap can't catch volume keys.
    // Prints VOL:XX when volume changes, MUTE:true/false for mute.
    var lastVol: Int = -1
    var lastMute: Bool? = nil
    if let vol = getSpeakerVolume() {
        lastVol = Int(round(vol * 100))
        print("VOL:\(lastVol)")
        fflush(stdout)
    }
    print("WATCH:started")
    fflush(stdout)

    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
        if let vol = getSpeakerVolume() {
            let pct = Int(round(vol * 100))
            if pct != lastVol {
                lastVol = pct
                print("VOL:\(pct)")
                fflush(stdout)
            }
        }
        let muted = getSpeakerMute() ?? false
        if lastMute == nil || muted != lastMute! {
            lastMute = muted
            print("MUTE:\(muted)")
            fflush(stdout)
        }
    }
    RunLoop.main.run()

case "capture-audio":
    // Capture system audio via ScreenCaptureKit — outputs raw f32le PCM to stdout.
    // No BlackHole needed! Volume keys work because speakers stay as default output.
    // Usage: jac-audio capture-audio [sample_rate]
    if #available(macOS 13.0, *) {
        let sr = args.count >= 3 ? Int(args[2]) ?? 48000 : 48000
        startScreenCaptureAudio(sampleRate: sr)
    } else {
        print("ERROR:requires_macos_13")
        exit(1)
    }

case "media-keys":
    // Monitor global media key events (volume up/down/mute, play/pause, next/prev)
    // Uses NSEvent global monitor — requires accessibility permissions on first run.
    // Outputs JSON lines to stdout: {"key":"volume_up"}, {"key":"volume_down"}, etc.
    let mediaKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .systemDefined) { event in
        // Media keys are system-defined events with subtype 8
        guard event.subtype.rawValue == 8 else { return }
        let keyCode = ((event.data1 & 0xFFFF0000) >> 16)
        let keyFlags = (event.data1 & 0x0000FFFF)
        let keyState = ((keyFlags & 0xFF00) >> 8) // 0xA = down, 0xB = up

        // Only emit on key down
        guard keyState == 0x0A else { return }

        let keyName: String
        switch Int32(keyCode) {
        case NX_KEYTYPE_SOUND_UP:       keyName = "volume_up"
        case NX_KEYTYPE_SOUND_DOWN:     keyName = "volume_down"
        case NX_KEYTYPE_MUTE:           keyName = "mute"
        case NX_KEYTYPE_PLAY:           keyName = "play_pause"
        case NX_KEYTYPE_NEXT:           keyName = "next"
        case NX_KEYTYPE_PREVIOUS:       keyName = "previous"
        case NX_KEYTYPE_FAST:           keyName = "fast_forward"
        case NX_KEYTYPE_REWIND:         keyName = "rewind"
        default: return
        }

        print("{\"key\":\"\(keyName)\"}")
        fflush(stdout)
    }

    // Run the event loop to receive events
    print("{\"status\":\"listening\"}")
    fflush(stdout)
    NSApplication.shared.run()

default:
    print("Unknown command: \(args[1])")
    exit(1)
}
