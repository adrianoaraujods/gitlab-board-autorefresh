/**
 * Options Page. Domain list (add, remove, validate, grant), refresh interval,
 * tab mode and detection.
 */
import { originMatchPattern, parseDomainOrigin } from "../core/domain-origin";
import { parseIntervalSeconds } from "../core/refresh-interval";
import { normalizeDetection, normalizeSafetyNetMinutes, normalizeTabMode } from "../core/refresh-scheduler";
import { loadSettings, onSettingsChanged, saveSettings } from "../shared/settings";

const list = document.querySelector<HTMLUListElement>("#domain-list")!;
const form = document.querySelector<HTMLFormElement>("#add-domain-form")!;
const input = document.querySelector<HTMLInputElement>("#domain-input")!;
const errorText = document.querySelector<HTMLParagraphElement>("#domain-error")!;

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

const modeFieldset = document.querySelector<HTMLFieldSetElement>("#mode-fieldset")!;
const modeError = document.querySelector<HTMLParagraphElement>("#mode-error")!;

async function renderMode(): Promise<void> {
  const { mode } = await loadSettings();
  for (const radio of modeFieldset.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.checked = radio.value === mode;
  }
}

modeFieldset.addEventListener("change", (event) => {
  const radio = event.target as HTMLInputElement;
  const mode = normalizeTabMode(radio.value);
  modeError.hidden = true;
  saveSettings({ mode }).catch((error: unknown) => {
    modeError.textContent = errorMessage(error);
    modeError.hidden = false;
    void renderMode();
void renderDetection();
  });
});

const detectionFieldset = document.querySelector<HTMLFieldSetElement>("#detection-fieldset")!;
const detectionError = document.querySelector<HTMLParagraphElement>("#detection-error")!;

async function renderDetection(): Promise<void> {
  const { detection } = await loadSettings();
  for (const radio of detectionFieldset.querySelectorAll<HTMLInputElement>('input[name="detection"]')) {
    radio.checked = radio.value === detection;
  }
}

detectionFieldset.addEventListener("change", (event) => {
  const radio = event.target as HTMLInputElement;
  const detection = normalizeDetection(radio.value);
  detectionError.hidden = true;
  saveSettings({ detection }).catch((error: unknown) => {
    detectionError.textContent = errorMessage(error);
    detectionError.hidden = false;
    void renderDetection();
  });
});

const ownEditsInput = document.querySelector<HTMLInputElement>("#own-edits-input")!;
const ownEditsError = document.querySelector<HTMLParagraphElement>("#own-edits-error")!;

async function renderOwnEdits(): Promise<void> {
  ownEditsInput.checked = (await loadSettings()).refreshAfterOwnEdits;
}

ownEditsInput.addEventListener("change", () => {
  ownEditsError.hidden = true;
  saveSettings({ refreshAfterOwnEdits: ownEditsInput.checked }).catch((error: unknown) => {
    ownEditsError.textContent = errorMessage(error);
    ownEditsError.hidden = false;
    void renderOwnEdits();
  });
});

onSettingsChanged((keys) => {
  if (keys.includes("domains")) void render();
  if (keys.includes("intervalSeconds")) void renderInterval();
  if (keys.includes("mode")) void renderMode();
void renderDetection();
  if (keys.includes("detection")) void renderDetection();
  if (keys.includes("refreshAfterOwnEdits")) void renderOwnEdits();
});
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());
void render();
void renderInterval();
void renderMode();
void renderDetection();
void renderOwnEdits();

const safetyNetInput = document.querySelector<HTMLInputElement>("#safety-net-input")!;
const safetyNetError = document.querySelector<HTMLParagraphElement>("#safety-net-error")!;

async function renderSafetyNet(): Promise<void> {
  safetyNetInput.value = String((await loadSettings()).safetyNetMinutes);
}

safetyNetInput.addEventListener("change", () => {
  safetyNetError.hidden = true;
  const safetyNetMinutes = normalizeSafetyNetMinutes(safetyNetInput.value);
  saveSettings({ safetyNetMinutes }).then(
    () => void renderSafetyNet(),
    (error: unknown) => {
      safetyNetError.textContent = errorMessage(error);
      safetyNetError.hidden = false;
    },
  );
});

onSettingsChanged((keys) => {
  if (keys.includes("safetyNetMinutes")) void renderSafetyNet();
});
void renderSafetyNet();
