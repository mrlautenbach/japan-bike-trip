// Web transcode using the system's AVFoundation hardware encoder.
//
// macOS ships `avconvert`, but it only takes fixed quality presets with no
// bitrate control, which put a 6.5 minute 1080p film at 300MB+. This drives
// AVAssetReader/AVAssetWriter directly so the target bitrate is explicit.
//
// Both tracks are pumped from one synchronous loop. Driving each track from
// its own queue via requestMediaDataWhenReady deadlocks once one track
// finishes ahead of the other, and the writer simply stops being fed.
//
// Usage: transcode-video <input> <output.mp4> <heightPx> <videoKbps>

import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count == 5,
      let targetHeight = Int(args[3]),
      let videoKbps = Int(args[4])
else {
    print("usage: transcode-video <input> <output.mp4> <heightPx> <videoKbps>")
    exit(1)
}

let inputURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: outputURL)

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("transcode failed: \(message)\n".utf8))
    exit(1)
}

let asset = AVURLAsset(url: inputURL)

// Load tracks up front; everything after this point is synchronous.
var videoTrack: AVAssetTrack?
var audioTrack: AVAssetTrack?
var naturalSize = CGSize.zero
var transform = CGAffineTransform.identity
var loadError: String?
let loaded = DispatchSemaphore(value: 0)

Task {
    do {
        videoTrack = try await asset.loadTracks(withMediaType: .video).first
        audioTrack = try await asset.loadTracks(withMediaType: .audio).first
        if let videoTrack {
            naturalSize = try await videoTrack.load(.naturalSize)
            transform = try await videoTrack.load(.preferredTransform)
        }
    } catch {
        loadError = error.localizedDescription
    }
    loaded.signal()
}
loaded.wait()

if let loadError { fail(loadError) }
guard let videoTrack else { fail("no video track") }

let displaySize = naturalSize.applying(transform)
let srcH = abs(displaySize.height)
let srcW = abs(displaySize.width)
let scale = CGFloat(targetHeight) / srcH
let outW = (Int((srcW * scale).rounded()) / 2) * 2
let outH = (Int((srcH * scale).rounded()) / 2) * 2

let reader: AVAssetReader
let writer: AVAssetWriter
do {
    reader = try AVAssetReader(asset: asset)
    writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
} catch {
    fail(error.localizedDescription)
}
writer.shouldOptimizeForNetworkUse = true // faststart: moov atom first

let readerVideo = AVAssetReaderTrackOutput(
    track: videoTrack,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
readerVideo.alwaysCopiesSampleData = false
guard reader.canAdd(readerVideo) else { fail("cannot add video reader output") }
reader.add(readerVideo)

let writerVideo = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: outW,
        AVVideoHeightKey: outH,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: videoKbps * 1000,
            AVVideoMaxKeyFrameIntervalKey: 120,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: true,
        ],
    ])
writerVideo.expectsMediaDataInRealTime = false
guard writer.canAdd(writerVideo) else { fail("cannot add video writer input") }
writer.add(writerVideo)

var readerAudio: AVAssetReaderTrackOutput?
var writerAudio: AVAssetWriterInput?
if let audioTrack {
    let out = AVAssetReaderTrackOutput(
        track: audioTrack,
        outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
    out.alwaysCopiesSampleData = false
    let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 2,
            AVSampleRateKey: 44100,
            AVEncoderBitRateKey: 128_000,
        ])
    input.expectsMediaDataInRealTime = false
    if reader.canAdd(out), writer.canAdd(input) {
        reader.add(out)
        writer.add(input)
        readerAudio = out
        writerAudio = input
    }
}

guard reader.startReading() else {
    fail("startReading: \(reader.error?.localizedDescription ?? "unknown")")
}
guard writer.startWriting() else {
    fail("startWriting: \(writer.error?.localizedDescription ?? "unknown")")
}
writer.startSession(atSourceTime: .zero)

var videoDone = false
var audioDone = readerAudio == nil
var frames = 0

while !videoDone || !audioDone {
    var moved = false

    if !videoDone, writerVideo.isReadyForMoreMediaData {
        if let buffer = readerVideo.copyNextSampleBuffer() {
            if !writerVideo.append(buffer) {
                fail("video append: \(writer.error?.localizedDescription ?? "unknown")")
            }
            frames += 1
            if frames % 600 == 0 {
                FileHandle.standardError.write(Data("  \(frames) frames\n".utf8))
            }
        } else {
            writerVideo.markAsFinished()
            videoDone = true
        }
        moved = true
    }

    if !audioDone, let readerAudio, let writerAudio, writerAudio.isReadyForMoreMediaData {
        if let buffer = readerAudio.copyNextSampleBuffer() {
            if !writerAudio.append(buffer) {
                fail("audio append: \(writer.error?.localizedDescription ?? "unknown")")
            }
        } else {
            writerAudio.markAsFinished()
            audioDone = true
        }
        moved = true
    }

    if !moved { usleep(2000) }
}

if reader.status == .failed {
    fail("reader: \(reader.error?.localizedDescription ?? "unknown")")
}

let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()

if writer.status != .completed {
    fail(writer.error?.localizedDescription ?? "writer did not complete")
}

let bytes = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int) ?? 0
let mb = Double(bytes ?? 0) / 1_048_576
print(String(format: "wrote %@ — %dx%d, %.1f MB", outputURL.lastPathComponent, outW, outH, mb))
