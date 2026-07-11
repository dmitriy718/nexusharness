type NexusHarnessBuild = {
  version: string;
  commit: string;
  builtAt: string | null;
  mode: string;
};

declare const __NEXUSHARNESS_BUILD__: NexusHarnessBuild;
