'use strict';

import type { MutableJsonObject } from '../shared/contracts.ts';

import { createRequire } from 'node:module';
import { recordTrace } from './eval-trace';

const nodeRequire = createRequire(__filename);
const schema = nodeRequire('./reliability-schema.js') as {
  EVENTS: Record<string, string>;
  SCHEMA_VERSION: number;
};
const { EVENTS, SCHEMA_VERSION } = schema;

function emit(type: string, payload: MutableJsonObject = {}) {
  const tracePayload = {
    schema: `agent-ui.reliability.v${SCHEMA_VERSION}`,
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  return recordTrace(type, tracePayload);
}

const telemetry = {
  appReady: (payload: MutableJsonObject = {}) => emit(EVENTS.APP_READY, payload),
  authHandoffOpening: (payload: MutableJsonObject = {}) => emit(EVENTS.AUTH_HANDOFF_OPENING, payload),
  authHandoffRequested: (payload: MutableJsonObject = {}) => emit(EVENTS.AUTH_HANDOFF_REQUESTED, payload),
  authWindowDomLoaded: (payload: MutableJsonObject = {}) => emit(EVENTS.AUTH_WINDOW_DOM_LOADED, payload),
  authWindowRequested: (payload: MutableJsonObject = {}) => emit(EVENTS.AUTH_WINDOW_REQUESTED, payload),
  authWindowShownAndFocused: (payload: MutableJsonObject = {}) => emit(EVENTS.AUTH_WINDOW_SHOWN_AND_FOCUSED, payload),
  catSpawnSent: (payload: MutableJsonObject = {}) => emit(EVENTS.CAT_SPAWN_SENT, payload),
  cleanupDismissCompleted: (payload: MutableJsonObject = {}) => emit(EVENTS.CLEANUP_DISMISS_COMPLETED, payload),
  cleanupModalClosed: (payload: MutableJsonObject = {}) => emit(EVENTS.CLEANUP_MODAL_CLOSED, payload),
  contextCaptureCompleted: (payload: MutableJsonObject = {}) => emit(EVENTS.CONTEXT_CAPTURE_COMPLETED, payload),
  contextCaptureFailed: (payload: MutableJsonObject = {}) => emit(EVENTS.CONTEXT_CAPTURE_FAILED, payload),
  contextCaptureReady: (payload: MutableJsonObject = {}) => emit(EVENTS.CONTEXT_CAPTURE_READY, payload),
  contextCaptureStarted: (payload: MutableJsonObject = {}) => emit(EVENTS.CONTEXT_CAPTURE_STARTED, payload),
  contextSnapshotCreated: (payload: MutableJsonObject = {}) => emit(EVENTS.CONTEXT_SNAPSHOT_CREATED, payload),
  gatewayFirstEvent: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_FIRST_EVENT, payload),
  gatewayHydrationCompleted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_HYDRATION_COMPLETED, payload),
  gatewayHydrationStarted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_HYDRATION_STARTED, payload),
  gatewayMessagePostAccepted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_MESSAGE_POST_ACCEPTED, payload),
  gatewayMessagePostFailed: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_MESSAGE_POST_FAILED, payload),
  gatewayMessagePostRequested: (payload: MutableJsonObject = {}) =>
    emit(EVENTS.GATEWAY_MESSAGE_POST_REQUESTED, payload),
  gatewayPrewarmCompleted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_PREWARM_COMPLETED, payload),
  gatewayPrewarmStarted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_PREWARM_STARTED, payload),
  gatewayReadyCheckCompleted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_READY_CHECK_COMPLETED, payload),
  gatewayReadyCheckJoined: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_READY_CHECK_JOINED, payload),
  gatewayReadyCheckReused: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_READY_CHECK_REUSED, payload),
  gatewayReadyCheckStarted: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_READY_CHECK_STARTED, payload),
  gatewayReplayExpired: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_REPLAY_EXPIRED, payload),
  gatewayRuntimeReady: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_RUNTIME_READY, payload),
  gatewayTerminalized: (payload: MutableJsonObject = {}) => emit(EVENTS.GATEWAY_TERMINALIZED, payload),
  modalDomLoaded: (payload: MutableJsonObject = {}) => emit(EVENTS.MODAL_DOM_LOADED, payload),
  modalShowRequested: (payload: MutableJsonObject = {}) => emit(EVENTS.MODAL_SHOW_REQUESTED, payload),
  modalShownAndFocused: (payload: MutableJsonObject = {}) => emit(EVENTS.MODAL_SHOWN_AND_FOCUSED, payload),
  rendererEvent: (type: string, payload: MutableJsonObject = {}) => recordTrace(type, payload),
  sessionWindowOpenBlocked: (payload: MutableJsonObject = {}) => emit(EVENTS.SESSION_WINDOW_OPEN_BLOCKED, payload),
  shortcutInvoked: (payload: MutableJsonObject = {}) => emit(EVENTS.SHORTCUT_INVOKED, payload),
  shortcutReceived: (payload: MutableJsonObject = {}) => emit(EVENTS.SHORTCUT_RECEIVED, payload),
  shortcutRegistered: (payload: MutableJsonObject = {}) => emit(EVENTS.SHORTCUT_REGISTERED, payload),
  submitContextReady: (payload: MutableJsonObject = {}) => emit(EVENTS.SUBMIT_CONTEXT_READY, payload),
  submitRejected: (payload: MutableJsonObject = {}) => emit(EVENTS.SUBMIT_REJECTED, payload),
  submitRequested: (payload: MutableJsonObject = {}) => emit(EVENTS.SUBMIT_REQUESTED, payload),
  terminalStateRendered: (payload: MutableJsonObject = {}) => emit(EVENTS.TERMINAL_STATE_RENDERED, payload),
  voiceFinalTranscript: (payload: MutableJsonObject = {}) => emit(EVENTS.VOICE_FINAL_TRANSCRIPT, payload),
  voicePartialTranscript: (payload: MutableJsonObject = {}) => emit(EVENTS.VOICE_PARTIAL_TRANSCRIPT, payload),
  voiceSessionRecordingRequested: (payload: MutableJsonObject = {}) =>
    emit(EVENTS.VOICE_SESSION_RECORDING_REQUESTED, payload),
  voiceSessionRejected: (payload: MutableJsonObject = {}) => emit(EVENTS.VOICE_SESSION_REJECTED, payload),
  voiceSessionTranscriptReady: (payload: MutableJsonObject = {}) =>
    emit(EVENTS.VOICE_SESSION_TRANSCRIPT_READY, payload),
  voiceStarted: (payload: MutableJsonObject = {}) => emit(EVENTS.VOICE_STARTED, payload),
};

export { EVENTS, telemetry };
