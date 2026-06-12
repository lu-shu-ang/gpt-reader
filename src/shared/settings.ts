export type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

export type TocSettings = {
  enabled: boolean;
  maxDepth: HeadingDepth;
  expandCurrentOnly: boolean;
};

export const DEFAULT_SETTINGS: TocSettings = {
  enabled: true,
  maxDepth: 2,
  expandCurrentOnly: true
};

const SETTINGS_KEY = "gptReaderSettings";

type SettingsPatch = Partial<TocSettings>;

const isDepth = (value: unknown): value is HeadingDepth =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 6;

const normalizeSettings = (value: unknown): TocSettings => {
  const input = typeof value === "object" && value !== null ? (value as SettingsPatch) : {};

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
    maxDepth: isDepth(input.maxDepth) ? input.maxDepth : DEFAULT_SETTINGS.maxDepth,
    expandCurrentOnly:
      typeof input.expandCurrentOnly === "boolean"
        ? input.expandCurrentOnly
        : DEFAULT_SETTINGS.expandCurrentOnly
  };
};

const canUseChromeStorage = (): boolean =>
  typeof chrome !== "undefined" &&
  Boolean(chrome.storage?.sync?.get) &&
  Boolean(chrome.storage?.sync?.set);

export const getSettings = async (): Promise<TocSettings> => {
  if (!canUseChromeStorage()) {
    return DEFAULT_SETTINGS;
  }

  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
};

export const saveSettings = async (settings: TocSettings): Promise<void> => {
  if (!canUseChromeStorage()) {
    return;
  }

  await chrome.storage.sync.set({
    [SETTINGS_KEY]: normalizeSettings(settings)
  });
};

export const mergeSettings = (current: TocSettings, patch: SettingsPatch): TocSettings =>
  normalizeSettings({
    ...current,
    ...patch
  });

export const subscribeSettings = (listener: (settings: TocSettings) => void): (() => void) => {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
    return () => undefined;
  }

  const handleChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ): void => {
    if (areaName !== "sync" || !changes[SETTINGS_KEY]) {
      return;
    }

    listener(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };

  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
};

export const headingDepths: HeadingDepth[] = [1, 2, 3, 4, 5, 6];
