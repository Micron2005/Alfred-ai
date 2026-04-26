// Minimal ambient type stub. The package ships its own JS but no
// declaration file, so we declare just enough surface area for
// ``useWakeWord`` to consume it. The hook re-types the engine to its
// own ``WakeWordEngineLike`` interface, so this only needs to be loose.
declare module "openwakeword-wasm-browser" {
  export interface WakeWordEngineOptions {
    keywords?: string[];
    baseAssetUrl?: string;
    ortWasmPath?: string;
    detectionThreshold?: number;
    cooldownMs?: number;
    [key: string]: unknown;
  }

  export class WakeWordEngine {
    constructor(options?: WakeWordEngineOptions);
    load(): Promise<void>;
    start(opts?: { deviceId?: string; gain?: number }): Promise<void>;
    stop(): Promise<void>;
    on(event: string, handler: (payload: unknown) => void): () => void;
    off(event: string, handler: (payload: unknown) => void): void;
    setActiveKeywords(keywords: string[]): void;
    setGain(value: number): void;
  }

  export default WakeWordEngine;
}
