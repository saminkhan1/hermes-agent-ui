export type ReliabilityOwner = 'app' | 'hermes_boundary' | 'hermes_voice' | 'hermes_provider';
export type ReliabilityStageDef = {
  id: string;
  label: string;
  owner: ReliabilityOwner;
};

export const EVENTS: Readonly<Record<string, string>>;
export const OWNER: Readonly<Record<string, ReliabilityOwner>>;
export const STAGE_DEFS: readonly ReliabilityStageDef[];
export const SCHEMA_VERSION: number;
