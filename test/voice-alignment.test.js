'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { formatVoiceCaptureErrorForUser } = require('../src/main/hermes-runtime');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test('voice input is backed by Hermes voice-mode capture and transcription', () => {
  const runtime = read('src/main/hermes-runtime.js');
  const main = read('src/main/index.js');

  assert.match(runtime, /from tools\.voice_mode import check_voice_requirements, create_audio_recorder, play_beep, transcribe_recording/);
  assert.match(runtime, /silence_threshold = int\(cfg\.get\("silence_threshold", 200\)\)/);
  assert.match(runtime, /silence_duration = float\(cfg\.get\("silence_duration", 3\.0\)\)/);
  assert.match(runtime, /max_recording_seconds = float\(cfg\.get\("max_recording_seconds", 120\)\)/);
  assert.match(runtime, /recorder\.start\(on_silence_stop=on_silence_stop\)/);
  assert.match(runtime, /play_beep\(frequency=880, count=1\)/);
  assert.match(runtime, /play_beep\(frequency=660, count=2\)/);
  assert.match(runtime, /result = transcribe_recording\(audio_path\)/);
  assert.match(main, /const result = await captureAndTranscribeVoice\(\{ onStatus \}\)/);
  assert.match(runtime, /"status": "transcribing"/);
  assert.match(main, /async function startVoiceSessionFromShortcut\(win, modalContextId\)/);
  assert.match(main, /sendVoiceInputStatus\(win, modalContextId, \{\s*state: 'transcript_ready'/);
  assert.doesNotMatch(main, /startCatRunFromPayload\(\{ prompt, modalContextId \}, \{ closeModal: false \}\)/);
});

test('voice and text are separate menu-selected input modes', () => {
  const main = read('src/main/index.js');
  const preload = read('src/preload/index.js');
  const modalHtml = read('src/renderer/modal.html');
  const modal = read('src/renderer/src/modal.js');

  assert.match(main, /const INPUT_MODE_TEXT = 'text'/);
  assert.match(main, /const INPUT_MODE_VOICE = 'voice'/);
  assert.match(main, /label: 'Settings'/);
  assert.match(main, /label: 'Input Mode'/);
  assert.match(main, /label: 'Text'/);
  assert.match(main, /label: 'Voice'/);
  assert.match(main, /selectedInputMode === INPUT_MODE_VOICE/);
  assert.match(main, /void startVoiceSessionFromShortcut\(newModalWindow, modalContextId\)/);
  assert.match(main, /openNewCatModal\(modalContextId, inputMode\)/);
  assert.match(preload, /onVoiceInputStatus/);
  assert.match(modal, /inputMode = params\.get\('inputMode'\) === 'voice'/);
  assert.match(modal, /voiceTranscriptReady = true/);
  assert.match(modal, /Review transcript, then press Enter to start/);
  assert.match(modal, /setVoiceProgressPlaceholder/);
  assert.doesNotMatch(modal, /placeholder = 'Listening\.\.\.'/);
  assert.doesNotMatch(modal, /placeholder = 'Transcribing\.\.\.'/);
  assert.doesNotMatch(preload, /startVoiceDictation/);
  assert.doesNotMatch(modalHtml, /btn-dictate|Dictate prompt/);
  assert.doesNotMatch(modal, /startDictation|startVoiceDictation|voice_transcript_inserted|btnDictate/);
});

test('voice input has no legacy Apple Speech or browser MediaRecorder fallback', () => {
  const files = [
    'src/main/index.js',
    'src/main/hermes-runtime.js',
    'src/preload/index.js',
    'src/renderer/src/modal.js',
    'src/renderer/modal.html',
    'package.json',
  ];
  const combined = files.map(read).join('\n');

  assert.equal(fs.existsSync(path.join(root, 'src/main/AgentUISpeech.swift')), false);
  assert.doesNotMatch(combined, /AgentUISpeech/);
  assert.doesNotMatch(combined, /\/usr\/bin\/swift|swiftc/);
  assert.doesNotMatch(combined, /SFSpeechRecognizer|AVAudioEngine/);
  assert.doesNotMatch(combined, /AGENT_UI_LEGACY_SPEECH/);
  assert.doesNotMatch(combined, /MediaRecorder|getUserMedia|transcribe-voice-recording|captureInRenderer|start-voice-dictation/);
});

test('voice input permission failures are actionable for manual testers', () => {
  const message = formatVoiceCaptureErrorForUser('PortAudioError: Error opening InputStream: Internal PortAudio error');

  assert.match(message, /System Settings > Privacy & Security > Microphone/);
  assert.match(message, /agent-UI/);
  assert.match(message, /input device/);
});
