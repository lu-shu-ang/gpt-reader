import "./styles.css";
import {
  type HeadingDepth,
  type TocSettings,
  headingDepths,
  getSettings,
  mergeSettings,
  saveSettings
} from "../shared/settings";

const app = document.getElementById("app");

let settings: TocSettings;

const render = (): void => {
  if (!app) {
    return;
  }

  app.innerHTML = `
    <section class="popup-shell">
      <header>
        <div>
          <p>GPT Reader</p>
          <h1>ChatGPT 回答目录</h1>
        </div>
        <label class="switch" title="启用目录">
          <input type="checkbox" data-setting-enabled ${settings.enabled ? "checked" : ""} />
          <span></span>
        </label>
      </header>

      <div class="panel">
        <div class="field">
          <div>
            <strong>目录最大层级</strong>
            <small>控制当前回答最多展开到几级标题。</small>
          </div>
          <div class="depth-grid">
            ${headingDepths
              .map(
                (depth) => `
                  <button
                    type="button"
                    data-setting-depth="${depth}"
                    class="${depth === settings.maxDepth ? "is-active" : ""}"
                  >
                    ${depth}
                  </button>
                `
              )
              .join("")}
          </div>
        </div>

        <label class="check-row">
          <span>
            <strong>只展开当前回答</strong>
            <small>其他回答仅显示第一层标题，避免目录过长。</small>
          </span>
          <input
            type="checkbox"
            data-setting-expand-current
            ${settings.expandCurrentOnly ? "checked" : ""}
          />
        </label>
      </div>

      <footer>
        <span class="status-dot"></span>
        <span>${settings.enabled ? "已在 ChatGPT 页面启用" : "目录已关闭"}</span>
      </footer>
    </section>
  `;
};

const updateSettings = async (patch: Partial<TocSettings>): Promise<void> => {
  settings = mergeSettings(settings, patch);
  render();
  await saveSettings(settings);
};

const init = async (): Promise<void> => {
  settings = await getSettings();
  render();

  app?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const depthButton = target.closest<HTMLButtonElement>("[data-setting-depth]");
    if (!depthButton) {
      return;
    }

    void updateSettings({
      maxDepth: Number(depthButton.dataset.settingDepth) as HeadingDepth
    });
  });

  app?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;

    if (target.matches("[data-setting-enabled]")) {
      void updateSettings({ enabled: target.checked });
    }

    if (target.matches("[data-setting-expand-current]")) {
      void updateSettings({ expandCurrentOnly: target.checked });
    }
  });
};

void init();
