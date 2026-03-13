// meet-recorder-audio — capture system audio + mic via ScreenCaptureKit, mix, write M4A
// Usage: meet-recorder-audio <output.m4a>
// Send SIGTERM or SIGINT to stop recording gracefully.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import Accelerate

let kSampleRate: Double = 48000
let kChannels: UInt32 = 2
let kBytesPerSample = MemoryLayout<Float>.size
let kBytesPerFrame = Int(kChannels) * kBytesPerSample

// MARK: - Recorder

class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let outputURL: URL
    var stream: SCStream?
    var writer: AVAssetWriter?
    var audioInput: AVAssetWriterInput?

    private var systemPCM = Data()
    private var micPCM = Data()
    private let lock = NSLock()

    private var sampleOffset: Int64 = 0
    private var sessionStarted = false
    private var formatLogged = false

    init(outputURL: URL) {
        self.outputURL = outputURL
    }

    func start() async throws {
        // AVAssetWriter for M4A with AAC encoding
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: kSampleRate,
            AVNumberOfChannelsKey: kChannels,
            AVEncoderBitRateKey: 128_000,
        ]
        audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        audioInput!.expectsMediaDataInRealTime = true
        writer!.add(audioInput!)
        writer!.startWriting()

        // ScreenCaptureKit setup — need a display filter even for audio-only
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "MeetRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let config = SCStreamConfiguration()
        // System audio
        config.capturesAudio = true
        config.sampleRate = Int(kSampleRate)
        config.channelCount = Int(kChannels)
        config.excludesCurrentProcessAudio = true
        // Microphone (macOS 14+)
        if #available(macOS 14.0, *) {
            config.captureMicrophone = true
        }
        // Minimal video (required by SCK but we ignore it)
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let filter = SCContentFilter(display: display, excludingWindows: [])
        stream = SCStream(filter: filter, configuration: config, delegate: self)

        let queue = DispatchQueue(label: "com.hartreeworks.meet-recorder.stream")
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try stream!.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        if #available(macOS 14.0, *) {
            try stream!.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        }

        try await stream!.startCapture()
    }

    func stop() async {
        try? await stream?.stopCapture()
        drain() // final flush
        audioInput?.markAsFinished()
        await writer?.finishWriting()
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .audio:
            if !formatLogged {
                logFormat(sampleBuffer, label: "System audio")
                formatLogged = true
            }
            if let data = extractPCMData(from: sampleBuffer) {
                lock.lock()
                systemPCM.append(data)
                lock.unlock()
            }
        case .microphone:
            if let data = extractPCMData(from: sampleBuffer) {
                lock.lock()
                micPCM.append(data)
                lock.unlock()
            }
        default:
            break
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("Stream stopped with error: \(error.localizedDescription)")
    }

    // MARK: - Audio processing

    private func extractPCMData(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
        guard status == noErr, let ptr = dataPointer, length > 0 else { return nil }
        return Data(bytes: ptr, count: length)
    }

    func drain() {
        lock.lock()
        let sysData = systemPCM
        let micData = micPCM
        systemPCM = Data()
        micPCM = Data()
        lock.unlock()

        // SCStream delivers non-interleaved (planar) stereo:
        // [L0, L1, ..., L_{N-1}, R0, R1, ..., R_{N-1}]
        // Each buffer has (frames * channels) float samples total.
        let sysSamples = sysData.count / kBytesPerSample
        let micSamples = micData.count / kBytesPerSample

        if sysSamples == 0 && micSamples == 0 { return }

        let maxSamples = max(sysSamples, micSamples)
        var mixed = [Float](repeating: 0, count: maxSamples)

        if sysSamples > 0 {
            sysData.withUnsafeBytes { raw in
                guard let ptr = raw.baseAddress?.assumingMemoryBound(to: Float.self) else { return }
                vDSP_vadd(ptr, 1, mixed, 1, &mixed, 1, vDSP_Length(sysSamples))
            }
        }

        if micSamples > 0 {
            micData.withUnsafeBytes { raw in
                guard let ptr = raw.baseAddress?.assumingMemoryBound(to: Float.self) else { return }
                vDSP_vadd(ptr, 1, mixed, 1, &mixed, 1, vDSP_Length(micSamples))
            }
        }

        // Clip to [-1, 1] to prevent distortion from summing two signals
        var minVal: Float = -1.0
        var maxVal: Float = 1.0
        vDSP_vclip(mixed, 1, &minVal, &maxVal, &mixed, 1, vDSP_Length(maxSamples))

        let frameCount = maxSamples / Int(kChannels)
        if frameCount == 0 { return }

        // Convert non-interleaved [L0..L_{N-1}, R0..R_{N-1}] to
        // interleaved [L0, R0, L1, R1, ..., L_{N-1}, R_{N-1}]
        // This is the fix for the "chipmunk audio" bug — SCStream delivers
        // planar audio but AVAssetWriter expects interleaved PCM.
        var interleaved = [Float](repeating: 0, count: maxSamples)
        let channels = Int(kChannels)
        for ch in 0..<channels {
            for f in 0..<frameCount {
                interleaved[f * channels + ch] = mixed[ch * frameCount + f]
            }
        }

        guard let sb = createSampleBuffer(from: interleaved, frameCount: frameCount) else { return }

        if !sessionStarted {
            writer?.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb))
            sessionStarted = true
        }

        if audioInput?.isReadyForMoreMediaData == true {
            audioInput?.append(sb)
        }

        sampleOffset += Int64(frameCount)
    }

    private func createSampleBuffer(from floats: [Float], frameCount: Int) -> CMSampleBuffer? {
        let dataSize = frameCount * kBytesPerFrame

        var blockBuffer: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: dataSize,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: dataSize,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr, let block = blockBuffer else { return nil }

        floats.withUnsafeBytes { rawBuffer in
            guard let ptr = rawBuffer.baseAddress else { return }
            CMBlockBufferReplaceDataBytes(with: ptr, blockBuffer: block, offsetIntoDestination: 0, dataLength: dataSize)
        }

        // Interleaved float PCM format descriptor
        var asbd = AudioStreamBasicDescription(
            mSampleRate: kSampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(kBytesPerFrame),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(kBytesPerFrame),
            mChannelsPerFrame: kChannels,
            mBitsPerChannel: UInt32(kBytesPerSample * 8),
            mReserved: 0
        )

        var formatDesc: CMAudioFormatDescription?
        status = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: &asbd,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &formatDesc
        )
        guard status == noErr, let fmt = formatDesc else { return nil }

        let pts = CMTime(value: sampleOffset, timescale: CMTimeScale(kSampleRate))
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(kSampleRate)),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )

        var sampleSize = kBytesPerFrame
        var sampleBuffer: CMSampleBuffer?
        status = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            formatDescription: fmt,
            sampleCount: frameCount,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard status == noErr else { return nil }

        return sampleBuffer
    }

    // MARK: - Helpers

    private func logFormat(_ sampleBuffer: CMSampleBuffer, label: String) {
        guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return }
        log("\(label) format: \(asbd.pointee.mSampleRate)Hz, \(asbd.pointee.mChannelsPerFrame)ch, \(asbd.pointee.mBitsPerChannel)bit, flags=0x\(String(asbd.pointee.mFormatFlags, radix: 16))")
    }
}

func log(_ message: String) {
    fputs("[meet-recorder-audio] \(message)\n", stderr)
}

// MARK: - Main

guard CommandLine.arguments.count > 1 else {
    log("Usage: meet-recorder-audio <output.m4a>")
    exit(1)
}

let outputPath = CommandLine.arguments[1]
let outputURL = URL(fileURLWithPath: outputPath)
let recorder = Recorder(outputURL: outputURL)

// Start capture (async bridge)
let startSem = DispatchSemaphore(value: 0)
var startError: Error?
Task {
    do {
        try await recorder.start()
        log("Recording to \(outputPath)")
    } catch {
        startError = error
        log("Failed to start: \(error)")
    }
    startSem.signal()
}
startSem.wait()
if startError != nil { exit(1) }

// Drain timer — mix and write every 100ms
let timer = DispatchSource.makeTimerSource(queue: .global())
timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
timer.setEventHandler { recorder.drain() }
timer.resume()

// Signal handling via GCD dispatch sources
let stopSem = DispatchSemaphore(value: 0)

let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termSource.setEventHandler { stopSem.signal() }
termSource.resume()
signal(SIGTERM, SIG_IGN)

let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
intSource.setEventHandler { stopSem.signal() }
intSource.resume()
signal(SIGINT, SIG_IGN)

log("Recording... Send SIGTERM or SIGINT to stop.")
stopSem.wait()

// Graceful shutdown
log("Stopping...")
timer.cancel()

let stopSemaphore = DispatchSemaphore(value: 0)
Task {
    await recorder.stop()
    stopSemaphore.signal()
}
stopSemaphore.wait()

log("Done.")
exit(0)
