/**
 * Options Page. Domain list (add, remove, validate, grant). Later tickets add
 * the refresh interval (#3) and the tab mode selector (#6).
 */
import { originMatchPattern, parseDomainOrigin } from "../core/domain-origin";
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
  const message = error === null ? "" : error instanceof Error ? error.message : String(error);
  errorText.textContent = message;
  errorText.hidden = message === "";
}

onSettingsChanged(() => void render());
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());
void render();
