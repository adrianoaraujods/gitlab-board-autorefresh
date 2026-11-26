/**
 * Options Page. Domain list (add, remove, validate, grant), refresh interval,
 * tab mode and detection.
 */
import { originMatchPattern, parseDomainOrigin } from "../core/domain-origin";
import { parseIntervalSeconds } from "../core/refresh-interval";
import { normalizeDetection, normalizeSafetyNetMinutes, normalizeTabMode } from "../core/refresh-scheduler";
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from "../shared/settings";

const list = document.querySelector<HTMLUListElement>("#domain-list")!;
const form = document.querySelector<HTMLFormElement>("#add-domain-form")!;
const input = document.querySelector<HTMLInputElement>("#domain-input")!;
const errorText = document.querySelector<HTMLParagraphElement>("#domain-error")!;

/** What to redraw when each setting changes (also all run once at startup). */
const renderers: Partial<Record<keyof Settings, () => Promise<void>>> = {};

/**
 * Wires one setting: on `change` of `control` saves `read()` and redraws; a
 * failed save shows its message in `error`. `renderControl` draws the stored value.
 */
function bindSetting(
  key: keyof Settings,
  control: HTMLElement,
  errorElement: HTMLElement,
  read: () => Partial<Settings>,
  renderControl: (settings: Settings) => void,
): void {
  const renderSetting = async () => renderControl(await loadSettings());
  renderers[key] = renderSetting;
  control.addEventListener("change", () => {
    errorElement.hidden = true;
    saveSettings(read()).then(
      () => void renderSetting(),
      (error: unknown) => {
        errorElement.textContent = errorMessage(error);
        errorElement.hidden = false;
        void renderSetting();
      },
    );
  });
}

async function render(): Promise<void> {
  const { domains } = await loadSettings();
  const items = await Promise.all(domains.map(renderDomain));
  list.replaceChildren(...items);
}

async function renderDomain(origin: string): Promise<HTMLLIElement> {
  const pattern = originMatchPattern(origin);
  const granted = await chrome.permissions.contains({ origins: [pattern] });

  const item = document.createElement("li");
  const name = Object.assign(document.createElement("span"), { className: "origin", textContent: origin });
  const status = Object.assign(document.createElement("span"), {
    className: granted ? "status granted" : "status",
    textContent: granted ? "Access granted" : "No access",
  });
  item.append(name, status);

  if (!granted) {
    const grant = Object.assign(document.createElement("button"), { type: "button", textContent: "Grant" });
    // permissions.request must run directly in the click handler (user gesture).
    grant.addEventListener("click", () => {
      chrome.permissions.request({ origins: [pattern] }).then(render, showError);
    });
    item.append(grant);
  }

  const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "Remove" });
  remove.addEventListener("click", () => void removeDomain(origin).catch(showError));
  item.append(remove);
  return item;
}

async function removeDomain(origin: string): Promise<void> {
  const { domains } = await loadSettings();
  await saveSettings({ domains: domains.filter((d) => d !== origin) });
  await chrome.permissions.remove({ origins: [originMatchPattern(origin)] });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void addDomain(input.value).catch(showError);
});

async function addDomain(value: string): Promise<void> {
  const result = parseDomainOrigin(value);
  if (!result.ok) return showError(result.error);
  const { domains } = await loadSettings();
  if (domains.includes(result.origin)) return showError(`${result.origin} is already in the list.`);
  await saveSettings({ domains: [...domains, result.origin] });
  input.value = "";
  showError(null);
}

function showError(error: unknown): void {
  const message = error === null ? "" : errorMessage(error);
  errorText.textContent = message;
  errorText.hidden = message === "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const intervalForm = document.querySelector<HTMLFormElement>("#interval-form")!;
const intervalInput = document.querySelector<HTMLInputElement>("#interval-input")!;
const intervalError = document.querySelector<HTMLParagraphElement>("#interval-error")!;
const intervalSaved = document.querySelector<HTMLParagraphElement>("#interval-saved")!;

async function renderInterval(): Promise<void> {
  const { intervalSeconds } = await loadSettings();
  if (document.activeElement !== intervalInput) intervalInput.value = String(intervalSeconds);
}

intervalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  intervalSaved.hidden = true;
  const result = parseIntervalSeconds(intervalInput.value);
  intervalError.textContent = result.ok ? "" : result.error;
  intervalError.hidden = result.ok;
  if (!result.ok) return;
  saveSettings({ intervalSeconds: result.seconds }).then(
    () => (intervalSaved.hidden = false),
    (error: unknown) => {
      intervalError.textContent = errorMessage(error);
      intervalError.hidden = false;
    },
  );
});

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(id)!;

const modeFieldset = byId<HTMLFieldSetElement>("#mode-fieldset");
bindSetting(
  "mode",
  modeFieldset,
  byId("#mode-error"),
  () => ({ mode: normalizeTabMode(checkedRadio(modeFieldset)) }),
  ({ mode }) => checkRadio(modeFieldset, "mode", mode),
);

const detectionFieldset = byId<HTMLFieldSetElement>("#detection-fieldset");
bindSetting(
  "detection",
  detectionFieldset,
  byId("#detection-error"),
  () => ({ detection: normalizeDetection(checkedRadio(detectionFieldset)) }),
  ({ detection }) => checkRadio(detectionFieldset, "detection", detection),
);

const updateInPlaceInput = byId<HTMLInputElement>("#update-in-place-input");
bindSetting(
  "updateInPlace",
  updateInPlaceInput,
  byId("#update-in-place-error"),
  () => ({ updateInPlace: updateInPlaceInput.checked }),
  ({ updateInPlace }) => (updateInPlaceInput.checked = updateInPlace),
);

const ownEditsInput = byId<HTMLInputElement>("#own-edits-input");
bindSetting(
  "refreshAfterOwnEdits",
  ownEditsInput,
  byId("#own-edits-error"),
  () => ({ refreshAfterOwnEdits: ownEditsInput.checked }),
  ({ refreshAfterOwnEdits }) => (ownEditsInput.checked = refreshAfterOwnEdits),
);

const safetyNetInput = byId<HTMLInputElement>("#safety-net-input");
bindSetting(
  "safetyNetMinutes",
  safetyNetInput,
  byId("#safety-net-error"),
  () => ({ safetyNetMinutes: normalizeSafetyNetMinutes(safetyNetInput.value) }),
  ({ safetyNetMinutes }) => (safetyNetInput.value = String(safetyNetMinutes)),
);

/** The value of the checked radio in a fieldset (the change event's target is that radio). */
function checkedRadio(fieldset: HTMLFieldSetElement): string {
  return fieldset.querySelector<HTMLInputElement>("input:checked")?.value ?? "";
}

function checkRadio(fieldset: HTMLFieldSetElement, name: string, value: string): void {
  for (const radio of fieldset.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    radio.checked = radio.value === value;
  }
}

renderers.domains = render;
renderers.intervalSeconds = renderInterval;
onSettingsChanged((keys) => {
  for (const key of keys) void renderers[key]?.();
});
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());
for (const renderSetting of Object.values(renderers)) void renderSetting();
