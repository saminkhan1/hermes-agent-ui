import AVFoundation
import Foundation
import Speech

final class SpeechCapture {
  private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private let audioEngine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var bestTranscript = ""

  func run(seconds: TimeInterval = 8.0) {
    let authSemaphore = DispatchSemaphore(value: 0)
    var authOK = false
    SFSpeechRecognizer.requestAuthorization { status in
      authOK = status == .authorized
      authSemaphore.signal()
    }
    _ = authSemaphore.wait(timeout: .now() + 15)
    guard authOK else {
      fputs("Speech recognition permission denied\n", stderr)
      exit(2)
    }

    request = SFSpeechAudioBufferRecognitionRequest()
    guard let request else {
      fputs("Could not create speech request\n", stderr)
      exit(1)
    }
    request.shouldReportPartialResults = true

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }

    task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
      if let result {
        self?.bestTranscript = result.bestTranscription.formattedString
        if result.isFinal {
          self?.stopAndPrint()
        }
      }
      if error != nil {
        self?.stopAndPrint()
      }
    }

    do {
      try audioEngine.start()
    } catch {
      fputs("Could not start microphone: \(error.localizedDescription)\n", stderr)
      exit(1)
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
      self?.stopAndPrint()
    }
    RunLoop.main.run()
  }

  private func stopAndPrint() {
    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    request?.endAudio()
    task?.cancel()
    print(bestTranscript)
    exit(bestTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 3 : 0)
  }
}

SpeechCapture().run()
