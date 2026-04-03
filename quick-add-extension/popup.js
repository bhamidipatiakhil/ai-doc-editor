const STORAGE_KEYS = {
	baseUrl: "aiDocBaseUrl",
	includeSource: "aiDocIncludeSource",
	quickText: "aiDocQuickText"
};

const quickTextEl = document.getElementById("quickText");
const baseUrlEl = document.getElementById("baseUrl");
const includeSourceEl = document.getElementById("includeSource");
const statusEl = document.getElementById("status");
const pasteNowEl = document.getElementById("pasteNow");
const aiPolishEl = document.getElementById("aiPolish");
const captureSelectionEl = document.getElementById("captureSelection");

function setStatus(message, isError = false) {
	statusEl.textContent = message;
	statusEl.style.color = isError ? "#fca5a5" : "#93c5fd";
}

function normalizeBaseUrl(url) {
	return (url || "http://localhost:3000").trim().replace(/\/$/, "");
}

function buildSourceCapsule(tab, includeSource) {
	if (!includeSource) return "";
	const capturedAt = new Date().toISOString();
	const source = tab?.url || "unknown";
	return `\n\n---\nSource Capsule\n- URL: ${source}\n- Captured: ${capturedAt}`;
}

async function getActiveTab() {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
	return tabs[0] || null;
}

async function insertIntoActiveTab(textToInsert) {
	const tab = await getActiveTab();
	if (!tab?.id) {
		throw new Error("No active tab found.");
	}

	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: (text) => {
			const detail = { text };
			window.dispatchEvent(new CustomEvent("ai-doc-quick-add", { detail }));

			const editor = document.querySelector(".doc-editor[contenteditable='true'], .doc-editor[contenteditable]");
			if (editor) {
				editor.focus();
				const escaped = text
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;")
					.split(/\n\n+/)
					.map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`)
					.join("");
				document.execCommand("insertHTML", false, escaped);
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				return { ok: true, method: "editor" };
			}

			const active = document.activeElement;
			if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text"))) {
				const start = active.selectionStart || 0;
				const end = active.selectionEnd || 0;
				const before = active.value.slice(0, start);
				const after = active.value.slice(end);
				active.value = `${before}${text}${after}`;
				active.dispatchEvent(new Event("input", { bubbles: true }));
				return { ok: true, method: "textbox" };
			}

			return { ok: false, method: "none" };
		},
		args: [textToInsert],
	});

	return result;
}

async function captureSelectionFromTab() {
	const tab = await getActiveTab();
	if (!tab?.id) throw new Error("No active tab found.");

	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: () => (window.getSelection?.().toString() || "").trim(),
	});

	if (!result) {
		setStatus("No selected text found in the current tab.", true);
		return;
	}

	quickTextEl.value = quickTextEl.value ? `${quickTextEl.value}\n\n${result}` : result;
	await chrome.storage.local.set({ [STORAGE_KEYS.quickText]: quickTextEl.value });
	setStatus("Selection captured into Quick Add box.");
}

async function callAiGenerate(baseUrl, promptText) {
	const res = await fetch(`${baseUrl}/api/generate-doc`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt: `Improve readability and structure while preserving intent:\n\n${promptText}`,
			mode: "append",
			docContent: "",
			selection: null,
		}),
	});

	if (!res.ok) {
		throw new Error("AI API request failed. Make sure AI Doc Web is running.");
	}

	const data = await res.json();
	return (data?.text || "").trim();
}

async function runPaste(polishWithAi) {
	const rawText = quickTextEl.value.trim();
	if (!rawText) {
		setStatus("Add some text first.", true);
		return;
	}

	const baseUrl = normalizeBaseUrl(baseUrlEl.value);
	const includeSource = Boolean(includeSourceEl.checked);
	const tab = await getActiveTab();
	const sourceCapsule = buildSourceCapsule(tab, includeSource);

	setStatus(polishWithAi ? "Generating AI version..." : "Pasting...");

	let finalText = `${rawText}${sourceCapsule}`;
	if (polishWithAi) {
		finalText = await callAiGenerate(baseUrl, finalText);
		if (!finalText) {
			setStatus("AI returned empty text.", true);
			return;
		}
	}

	const result = await insertIntoActiveTab(finalText);
	if (!result?.ok) {
		setStatus("Open AI Doc Web tab and focus editor, then try again.", true);
		return;
	}

	setStatus(polishWithAi ? "AI text pasted successfully." : "Text pasted successfully.");
}

async function loadStoredState() {
	const saved = await chrome.storage.local.get([
		STORAGE_KEYS.baseUrl,
		STORAGE_KEYS.includeSource,
		STORAGE_KEYS.quickText,
	]);

	if (saved[STORAGE_KEYS.baseUrl]) {
		baseUrlEl.value = saved[STORAGE_KEYS.baseUrl];
	}

	if (typeof saved[STORAGE_KEYS.includeSource] === "boolean") {
		includeSourceEl.checked = saved[STORAGE_KEYS.includeSource];
	}

	if (saved[STORAGE_KEYS.quickText]) {
		quickTextEl.value = saved[STORAGE_KEYS.quickText];
	}
}

function wirePersistence() {
	baseUrlEl.addEventListener("input", () => {
		chrome.storage.local.set({ [STORAGE_KEYS.baseUrl]: normalizeBaseUrl(baseUrlEl.value) });
	});

	includeSourceEl.addEventListener("change", () => {
		chrome.storage.local.set({ [STORAGE_KEYS.includeSource]: includeSourceEl.checked });
	});

	quickTextEl.addEventListener("input", () => {
		chrome.storage.local.set({ [STORAGE_KEYS.quickText]: quickTextEl.value });
	});
}

pasteNowEl.addEventListener("click", async () => {
	try {
		await runPaste(false);
	} catch (error) {
		setStatus(error?.message || "Paste failed.", true);
	}
});

aiPolishEl.addEventListener("click", async () => {
	try {
		await runPaste(true);
	} catch (error) {
		setStatus(error?.message || "AI polish failed.", true);
	}
});

captureSelectionEl.addEventListener("click", async () => {
	try {
		await captureSelectionFromTab();
	} catch (error) {
		setStatus(error?.message || "Could not capture selection.", true);
	}
});

loadStoredState();
wirePersistence();
