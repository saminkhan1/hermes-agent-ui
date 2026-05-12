export {};

declare global {
  interface Window {
    agentUI: Record<string, (...args: LooseBoundaryValue[]) => LooseBoundaryValue>;
  }

  interface Navigator {
    userAgentData?: {
      platform?: string;
    };
  }
}
