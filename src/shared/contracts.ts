type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type MutableJsonObject = Record<string, LooseBoundaryValue>;

export type LocalDesktopGatewayEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'attachment.created'
  | 'typing.started'
  | 'typing.stopped';

export type LocalDesktopProcessingOutcome = 'success' | 'failure' | 'cancelled';

type LocalDesktopGatewayEventBase = {
  seq: number;
  type: LocalDesktopGatewayEventType;
  conversation_id: string;
  message_id: string | null;
  created_at: number;
};

export type LocalDesktopMessageCreatedEvent = LocalDesktopGatewayEventBase & {
  type: 'message.created';
  text: string;
  reply_to: string | null;
  metadata: JsonObject;
};

export type LocalDesktopMessageUpdatedEvent = LocalDesktopGatewayEventBase & {
  type: 'message.updated';
  text: string;
  finalize: boolean;
};

export type LocalDesktopMessageEvent = LocalDesktopMessageCreatedEvent | LocalDesktopMessageUpdatedEvent;

export type LocalDesktopMessageDeletedEvent = LocalDesktopGatewayEventBase & {
  type: 'message.deleted';
};

export type LocalDesktopAttachmentEvent = LocalDesktopGatewayEventBase & {
  type: 'attachment.created';
  attachment_type: 'image' | 'document' | 'voice' | 'video';
  ref: string;
  caption: string | null;
  reply_to: string | null;
  metadata: JsonObject;
};

export type LocalDesktopTypingStartedEvent = LocalDesktopGatewayEventBase & {
  type: 'typing.started';
} & ({ metadata: JsonObject } | { inbound_message_id: string | null });

export type LocalDesktopTypingStoppedEvent = LocalDesktopGatewayEventBase & {
  type: 'typing.stopped';
} & ({ transient: boolean } | { inbound_message_id: string | null; outcome: LocalDesktopProcessingOutcome });

export type LocalDesktopTypingEvent = LocalDesktopTypingStartedEvent | LocalDesktopTypingStoppedEvent;

export type LocalDesktopEventPayloadByType = {
  'message.created': Omit<LocalDesktopMessageCreatedEvent, keyof LocalDesktopGatewayEventBase | 'type'>;
  'message.updated': Omit<LocalDesktopMessageUpdatedEvent, keyof LocalDesktopGatewayEventBase | 'type'>;
  'message.deleted': Omit<LocalDesktopMessageDeletedEvent, keyof LocalDesktopGatewayEventBase | 'type'>;
  'attachment.created': Omit<LocalDesktopAttachmentEvent, keyof LocalDesktopGatewayEventBase | 'type'>;
  'typing.started': Omit<LocalDesktopTypingStartedEvent, keyof LocalDesktopGatewayEventBase | 'type'>;
  'typing.stopped': Omit<LocalDesktopTypingStoppedEvent, keyof LocalDesktopGatewayEventBase | 'type'>;
};

export type LocalDesktopGatewayEvent =
  | LocalDesktopMessageEvent
  | LocalDesktopMessageDeletedEvent
  | LocalDesktopAttachmentEvent
  | LocalDesktopTypingEvent;

export type LocalDesktopInboundMessage = {
  conversation_id: string;
  message_id: string;
  text: string;
  chat_name?: string | null;
  metadata?: JsonObject;
};

export type LocalDesktopMessageAcceptedResponse = {
  ok: true;
  accepted: true;
  duplicate: boolean;
};

export type LocalDesktopHealthResponse = {
  ok: true;
  status: 'ok';
  platform: 'local_desktop';
  latest_seq: number;
};

export type LocalDesktopErrorResponse = {
  ok: false;
  error:
    | 'unauthorized'
    | 'invalid_json'
    | 'invalid_request'
    | 'missing_conversation_id'
    | 'missing_message_id'
    | 'missing_text'
    | 'duplicate_message_conflict'
    | 'replay_window_expired';
  message: string;
};

type AttachmentDescriptor = {
  status?: 'ready' | 'blocked' | string;
  source?: 'local' | 'remote' | string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  size?: number | null;
  extension?: string;
  reason?: string;
};

export type AgentConversationItemKind = 'user' | 'assistant' | 'error' | 'attachment';

export type AgentConversationItem = {
  kind: AgentConversationItemKind;
  at?: number;
  text?: string;
  messageId?: string;
  seq?: number;
  createdAt?: LooseBoundaryValue;
  replyTo?: string;
  finalize?: boolean;
  metadata?: JsonObject;
  attachmentType?: string;
  ref?: string;
  caption?: string;
  attachment?: AttachmentDescriptor;
};

export type AgentTypingState = {
  active: boolean;
  startedAt?: number;
  stoppedAt?: number;
  messageId?: string | null;
  seq?: number;
  metadata?: JsonObject;
};

export type AgentConversationSnapshot = {
  conversationId: string;
  prompt: string;
  pointerContext: JsonObject | null;
  items: AgentConversationItem[];
  runStatus: string;
  endResult?: LooseBoundaryValue;
  durationMs?: number;
  gatewayConversationId?: string | null;
  startedAt: number;
  lastGatewayStopSeq?: number;
  typing: AgentTypingState;
  activeAssistantBubble: boolean;
  hydratedFromGateway: boolean;
};

export type HermesAuthProvider = {
  id?: string;
  slug?: string;
  name?: string;
  auth_type?: string;
  oauth_capable?: boolean;
  models?: string[];
  total_models?: number;
};

export type HermesAuthStatus = {
  ok?: boolean;
  error?: string;
  ready?: boolean;
  needs_auth?: boolean;
  needs_model?: boolean;
  current_provider?: string;
  current_model?: string;
  providers?: HermesAuthProvider[];
  provider_catalog?: HermesAuthProvider[];
};

export type HermesAuthFlow = {
  state?: 'idle' | 'waiting' | 'stale' | 'failed' | 'success' | string;
  sessionId?: string;
  latestUrl?: string;
  userCode?: string;
  provider?: string;
  lastError?: string;
  hidden?: boolean;
};

export type HermesAuthEvent = HermesAuthFlow & {
  type?: 'started' | 'output' | 'exit' | 'error' | string;
  authFlow?: HermesAuthFlow;
  urls?: string[];
  text?: string;
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export type HermesAuthContext = {
  hasPendingRun?: boolean;
  authFlow?: HermesAuthFlow;
  reason?: string;
};

export type AgentUIPayload = Record<string, LooseBoundaryValue>;
