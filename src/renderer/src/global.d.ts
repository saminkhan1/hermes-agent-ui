export {};

declare global {
  interface Window {
    agentUI?: Record<string, (...args: any[]) => any>;
  }

  interface Navigator {
    userAgentData?: {
      platform?: string;
    };
  }
}
