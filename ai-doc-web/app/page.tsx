"use client";

import { useState, useEffect, useRef } from "react";

const DOC_STORAGE_KEY = "ai-doc-gen-content";
const DOC_SAVED_KEY = "ai-doc-gen-saved";
const WORD_LIKE_FONTS = [
  "Calibri",
  "Arial",
  "Times New Roman",
  "Cambria",
  "Georgia",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Segoe UI",
  "Courier New",
  "Garamond",
  "Book Antiqua",
];

type AiMode =
  | "append"
  | "edit_selection"
  | "rewrite_document"
  | "summarize_document";

type TonePreset =
  | "neutral"
  | "formal"
  | "friendly"
  | "bold"
  | "concise";

type Variant = {
  id: string;
  label: string;
  mode: AiMode;
  createdAt: number;
  content: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
};

type ChatActionMode = "chat" | "append" | "rewrite_document" | "summarize_document" | "edit_selection";

type QuickAddEventPayload = {
  text?: string;
};

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** Convert markdown (from AI) to HTML for the rich editor */
function markdownToHtml(md: string): string {
  if (!md.trim()) return "";
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  let listTag = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      if (inList) {
        out.push(listTag === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      out.push("<p><br></p>");
      continue;
    }
    if (/^#\s/.test(t) && !t.startsWith("##")) {
      if (inList) {
        out.push(listTag === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      out.push(`<h1 class="doc-h1">${escapeHtml(t.slice(2))}</h1>`);
    } else if (/^##\s/.test(t) && !t.startsWith("###")) {
      if (inList) {
        out.push(listTag === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      out.push(`<h2 class="doc-h2">${escapeHtml(t.slice(3))}</h2>`);
    } else if (/^###\s/.test(t) && !t.startsWith("####")) {
      if (inList) {
        out.push(listTag === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      out.push(`<h3 class="doc-h3">${escapeHtml(t.slice(4))}</h3>`);
    } else if (/^####\s/.test(t)) {
      if (inList) {
        out.push(listTag === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      out.push(`<h4 class="doc-h4">${escapeHtml(t.slice(5))}</h4>`);
    } else if (/^[-*•]\s/.test(t)) {
      if (!inList || listTag !== "ul") {
        if (inList) out.push(listTag === "ul" ? "</ul>" : "</ol>");
        out.push('<ul class="doc-list">');
        listTag = "ul";
        inList = true;
      }
      const inner = t.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
      out.push(`<li class="doc-list-item">${inner}</li>`);
    } else if (/^\d+\.\s/.test(t)) {
      if (!inList || listTag !== "ol") {
        if (inList) out.push(listTag === "ul" ? "</ul>" : "</ol>");
        out.push('<ol class="doc-list">');
        listTag = "ol";
        inList = true;
      }
      const inner = t.replace(/^\d+\.\s/, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
      out.push(`<li class="doc-list-item">${inner}</li>`);
    } else {
      if (inList) {
        out.push(listTag === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
      const inner = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
      out.push(`<p class="doc-p">${inner}</p>`);
    }
  }
  if (inList) out.push(listTag === "ul" ? "</ul>" : "</ol>");
  return out.join("");
}

/** Get plain text from HTML for API and selection context */
function htmlToPlainText(html: string): string {
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? div.innerText ?? "").replace(/\s+/g, " ").trim();
}

/** Extract sections (headings + preview) from HTML for document map */
function getDocSections(html: string): { title: string; preview: string }[] {
  if (!html.trim()) return [];
  if (typeof document === "undefined") return [];
  const div = document.createElement("div");
  div.innerHTML = html;
  const sections: { title: string; preview: string }[] = [];
  const headings = div.querySelectorAll("h1, h2, h3, h4");
  headings.forEach((h) => {
    const title = (h.textContent ?? "").trim();
    let preview = "";
    let next: Element | null = h.nextElementSibling;
    for (let i = 0; i < 3 && next; i++) {
      preview += (next.textContent ?? "").trim() + " ";
      next = next.nextElementSibling;
    }
    sections.push({ title: title || "Untitled", preview: preview.slice(0, 120).trim() });
  });
  return sections.slice(0, 12);
}

function getDocStats(html: string): { words: number; chars: number; readingMinutes: number } {
  const plain = htmlToPlainText(html);
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  const chars = plain.length;
  const readingMinutes = Math.max(1, Math.ceil(words / 200));
  return { words, chars, readingMinutes };
}

function extractQuotedTokens(input: string): string[] {
  return [...input.matchAll(/["']([^"']+)["']/g)]
    .map((m) => m[1]?.trim())
    .filter((v): v is string => Boolean(v));
}

function buildPromptInsights(input: string): { toneHint: string; actionHint: string; ambiguities: string[] } {
  const raw = input.trim();
  if (!raw) {
    return {
      toneHint: "neutral",
      actionHint: "No clear action detected",
      ambiguities: ["Prompt is empty"],
    };
  }

  const lower = raw.toLowerCase();
  const toneHint =
    /formal|professional/.test(lower)
      ? "formal"
      : /friendly|warm|casual/.test(lower)
      ? "friendly"
      : /concise|short|brief/.test(lower)
      ? "concise"
      : "neutral";

  const actionHint =
    /summari[sz]e/.test(lower)
      ? "Summarize"
      : /rewrite|rephrase/.test(lower)
      ? "Rewrite"
      : /fix|correct|grammar/.test(lower)
      ? "Correct language"
      : /add|append|insert|include/.test(lower)
      ? "Append content"
      : "General edit";

  const ambiguities: string[] = [];
  if (/can you|could you|would you|please/i.test(raw)) ambiguities.push("Polite phrasing may reduce instruction precision");
  if (raw.length < 12) ambiguities.push("Very short prompt may be under-specified");
  if (!/[.!?]/.test(raw) && raw.split(" ").length < 5) ambiguities.push("Consider adding explicit expected output format");

  return { toneHint, actionHint, ambiguities };
}

function clarifyPrompt(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  const stripped = raw.replace(/^(can you|could you|would you|please)\s*/i, "").trim();
  if (/(add|append|insert|include)\b/i.test(lowered)) {
    return `Append only the requested content. Output final text only without confirmation. Instruction: ${stripped}`;
  }
  return `Execute this instruction directly and output only the result text: ${stripped}`;
}

function sanitizeGeneratedTextForAppend(rawText: string, originalPrompt: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return "";

  const promptLower = originalPrompt.toLowerCase();
  const maybeAppendCommand = /\b(add|append|insert|include|put|write)\b/.test(promptLower);
  if (!maybeAppendCommand) return trimmed;

  if (/^(yes|sure|certainly|absolutely|of course|okay|alright)\b/i.test(trimmed) || /^i\s+(can|will|would)\b/i.test(trimmed)) {
    const quoted = extractQuotedTokens(originalPrompt);
    if (quoted.length > 0) return quoted.join("\n\n");

    const simple = originalPrompt.match(/\b(?:add|append|insert|include|put|write)\s+([\w-]{1,40})\b/i);
    if (simple?.[1]) return simple[1];
  }

  return trimmed;
}

function sanitizeChatInsertText(rawText: string): string {
  const stripped = (rawText || "")
    .replace(/<\/?(div|p|span|section|article|ul|ol|li|br)[^>]*>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped;
}

function buildChatDocContextPayload(docHtml: string): string {
  const plain = htmlToPlainText(docHtml).trim();
  const sections = getDocSections(docHtml)
    .map((section) => section.title)
    .filter(Boolean)
    .slice(0, 8);
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;

  return [
    `DOC_CONTEXT_AVAILABLE: ${plain ? "true" : "false"}`,
    `DOC_WORD_COUNT: ${words}`,
    `DOC_SECTION_TITLES: ${sections.length ? sections.join(" | ") : "none"}`,
    "DOC_EXCERPT_START",
    plain.slice(0, 6000),
    "DOC_EXCERPT_END",
  ].join("\n");
}

function loadDoc(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(DOC_STORAGE_KEY) ?? "";
}

function saveDoc(content: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(DOC_STORAGE_KEY, content);
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [docContent, setDocContent] = useState("");
  const [quickText, setQuickText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [, setUndoStack] = useState<string[]>([]);
  const [aiMode, setAiMode] = useState<AiMode>("append");
  const [tone, setTone] = useState<TonePreset>("neutral");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [fontFamily, setFontFamily] = useState<string>("Calibri");
  const [customFontFamily, setCustomFontFamily] = useState<string>("");
  const [fontSizePx, setFontSizePx] = useState<number>(15);
  const [textColor, setTextColor] = useState<string>("#1e293b");
  const [highlightColor, setHighlightColor] = useState<string>("#fff59d");
  const [lineSpacing, setLineSpacing] = useState<string>("1.6");
  type UiTheme = "ocean" | "glacier" | "ember";

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [useDocContextForChat, setUseDocContextForChat] = useState(true);
  const [strictMode, setStrictMode] = useState(true);
  const [chatDockOpen, setChatDockOpen] = useState(true);
  const [chatActionMode, setChatActionMode] = useState<ChatActionMode>("chat");
  const [uiTheme, setUiTheme] = useState<UiTheme>("ocean");
  const editorRef = useRef<HTMLDivElement>(null);
  const programmaticContentRef = useRef(false);
  const savedRangeRef = useRef<Range | null>(null);

  const chatQuickPrompts = [
    "Find weak sentences and suggest stronger rewrites.",
    "Turn this into an executive summary in 5 bullets.",
    "What facts look ambiguous or missing in this document?",
    "Generate a cleaner structure with section headings.",
  ];

  function restoreEditorSelection() {
    editorRef.current?.focus();
    if (!savedRangeRef.current) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(savedRangeRef.current);
  }

  function applyStyleToClosestBlock(style: Partial<CSSStyleDeclaration>): boolean {
    if (!editorRef.current) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const anchor = selection.anchorNode;
    if (!anchor) return false;

    let current: HTMLElement | null =
      anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as HTMLElement)
        : anchor.parentElement;

    while (current && current !== editorRef.current) {
      if (["P", "DIV", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE"].includes(current.tagName)) {
        Object.entries(style).forEach(([key, value]) => {
          if (typeof value === "string" && value) {
            current?.style.setProperty(key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`), value);
          }
        });
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  useEffect(() => {
    const isSaved = localStorage.getItem(DOC_SAVED_KEY);
    let raw = isSaved === "true" ? loadDoc() : "";
    if (raw && !raw.trim().startsWith("<")) {
      raw = markdownToHtml(raw);
    }
    if (!raw.trim()) raw = "<p><br></p>";
    programmaticContentRef.current = true;
    setDocContent(raw);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<QuickAddEventPayload>;
      const incoming = customEvent.detail?.text;
      if (!incoming || !incoming.trim()) return;
      setUndoStack((prev) => [...prev, docContent]);
      appendToDoc(incoming);
    };

    window.addEventListener("ai-doc-quick-add", handler as EventListener);
    return () => {
      window.removeEventListener("ai-doc-quick-add", handler as EventListener);
    };
  }, [docContent]);

  useEffect(() => {
    if (!programmaticContentRef.current || !editorRef.current) return;
    editorRef.current.innerHTML = docContent;
    programmaticContentRef.current = false;
  }, [docContent]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (!editorRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (editorRef.current.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange();
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  useEffect(() => {
    // Inject document editor styles
    const styleId = 'doc-preview-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .doc-preview h1.doc-h1 {
          font-size: 2rem;
          font-weight: 700;
          color: #fbbf24;
          margin-top: 1.5rem;
          margin-bottom: 0.75rem;
          line-height: 1.2;
          border-bottom: 2px solid rgba(251, 191, 36, 0.2);
          padding-bottom: 0.5rem;
        }
        .doc-preview h2.doc-h2 {
          font-size: 1.5rem;
          font-weight: 600;
          color: #60a5fa;
          margin-top: 1.25rem;
          margin-bottom: 0.5rem;
          line-height: 1.3;
        }
        .doc-preview h3.doc-h3 {
          font-size: 1.25rem;
          font-weight: 600;
          color: #34d399;
          margin-top: 1rem;
          margin-bottom: 0.5rem;
          line-height: 1.4;
        }
        .doc-preview h4.doc-h4 {
          font-size: 1.1rem;
          font-weight: 600;
          color: #a78bfa;
          margin-top: 0.75rem;
          margin-bottom: 0.5rem;
          line-height: 1.4;
        }
        .doc-preview p.doc-paragraph {
          margin-top: 0.75rem;
          margin-bottom: 0.75rem;
          line-height: 1.7;
          color: #e2e8f0;
        }
        .doc-preview ul {
          margin-left: 1.5rem;
          margin-top: 0.5rem;
          margin-bottom: 0.75rem;
          list-style: none;
        }
        .doc-preview li.doc-list-item {
          position: relative;
          padding-left: 1.25rem;
          margin-top: 0.25rem;
          margin-bottom: 0.25rem;
          line-height: 1.6;
          color: #cbd5e1;
        }
        .doc-preview li.doc-list-item::before {
          content: "•";
          position: absolute;
          left: 0;
          color: #60a5fa;
          font-weight: bold;
          font-size: 1.2rem;
        }
        .doc-preview strong {
          font-weight: 600;
          color: #fbbf24;
        }
        .doc-preview em {
          font-style: italic;
          color: #a78bfa;
        }
        .doc-preview br {
          margin: 0.5rem 0;
        }
        .doc-editor h1, .doc-editor h1.doc-h1 {
          font-size: 1.75rem;
          font-weight: 700;
          color: #1e293b;
          margin: 1rem 0 0.5rem;
          line-height: 1.25;
          border-bottom: 2px solid #e2e8f0;
          padding-bottom: 0.35rem;
        }
        .doc-editor h2, .doc-editor h2.doc-h2 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #334155;
          margin: 0.9rem 0 0.45rem;
          line-height: 1.3;
        }
        .doc-editor h3, .doc-editor h3.doc-h3 {
          font-size: 1.2rem;
          font-weight: 600;
          color: #475569;
          margin: 0.75rem 0 0.4rem;
          line-height: 1.35;
        }
        .doc-editor h4, .doc-editor h4.doc-h4 {
          font-size: 1.05rem;
          font-weight: 600;
          color: #64748b;
          margin: 0.6rem 0 0.35rem;
          line-height: 1.4;
        }
        .doc-editor p, .doc-editor p.doc-p {
          margin: 0.5rem 0;
          line-height: 1.6;
        }
        .doc-editor ul, .doc-editor ol {
          margin: 0.5rem 0 0.5rem 1.5rem;
          padding-left: 0.5rem;
        }
        .doc-editor li {
          margin: 0.2rem 0;
          line-height: 1.5;
        }
      `;
      document.head.appendChild(style);
    }
  }, []);

  function persistDoc(content: string) {
    const html = content.trim().startsWith("<") ? content : markdownToHtml(content);
    setDocContent(html);
    saveDoc(html);
    programmaticContentRef.current = true;
  }

  function handleUndo() {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      programmaticContentRef.current = true;
      setDocContent(last);
      return prev.slice(0, -1);
    });
  }

  function appendToDoc(htmlOrMarkdown: string) {
    const html = htmlOrMarkdown.trim().startsWith("<") ? htmlOrMarkdown : markdownToHtml(htmlOrMarkdown);
    setDocContent(prev => {
      const sep = prev.trim() ? "<p><br></p>" : "";
      const next = prev.replace(/<p><br><\/p>\s*$/, "") + sep + html;
      saveDoc(next);
      return next;
    });
    programmaticContentRef.current = true;
  }

  function handleAddToDoc() {
    if (!quickText.trim()) return;
    const wrapped = quickText.trim().split(/\n\n+/).map(p => `<p class="doc-p">${escapeHtml(p.replace(/\n/g, "<br>"))}</p>`).join("");
    appendToDoc(wrapped);
    setQuickText("");
  }

  function applyFormatting(command: string, value?: string) {
    restoreEditorSelection();
    document.execCommand(command, false, value);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function insertBlockFormat(tag: string) {
    restoreEditorSelection();
    document.execCommand("formatBlock", false, tag);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function applyFontFamily(nextFont: string) {
    restoreEditorSelection();
    document.execCommand("fontName", false, nextFont);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function applyInlineStyle(style: Partial<CSSStyleDeclaration>) {
    restoreEditorSelection();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      const applied = applyStyleToClosestBlock(style);
      if (applied && editorRef.current) {
        setUndoStack(prev => [...prev, docContent]);
        setDocContent(editorRef.current.innerHTML);
        saveDoc(editorRef.current.innerHTML);
      }
      return;
    }

    const span = document.createElement("span");
    Object.entries(style).forEach(([key, value]) => {
      if (typeof value === "string" && value) {
        span.style.setProperty(key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`), value);
      }
    });

    const extracted = range.extractContents();
    span.appendChild(extracted);
    range.insertNode(span);
    sel.removeAllRanges();

    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function applyFontSize(nextSize: number) {
    setFontSizePx(nextSize);
    applyInlineStyle({ fontSize: `${nextSize}px` });
  }

  function applyTextColor(nextColor: string) {
    setTextColor(nextColor);
    restoreEditorSelection();
    document.execCommand("foreColor", false, nextColor);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function applyHighlight(nextColor: string) {
    setHighlightColor(nextColor);
    restoreEditorSelection();
    document.execCommand("hiliteColor", false, nextColor);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function applyLineSpacing(nextLineSpacing: string) {
    setLineSpacing(nextLineSpacing);
    restoreEditorSelection();
    applyStyleToClosestBlock({ lineHeight: nextLineSpacing });

    if (!editorRef.current) return;

    setUndoStack(prev => [...prev, docContent]);
    setDocContent(editorRef.current.innerHTML);
    saveDoc(editorRef.current.innerHTML);
  }

  function insertOrEditLink() {
    const url = window.prompt("Enter URL", "https://");
    if (!url) return;
    restoreEditorSelection();
    document.execCommand("createLink", false, url);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  function clearFormatting() {
    restoreEditorSelection();
    document.execCommand("removeFormat", false);
    document.execCommand("unlink", false);
    if (editorRef.current) {
      setUndoStack(prev => [...prev, docContent]);
      setDocContent(editorRef.current.innerHTML);
      saveDoc(editorRef.current.innerHTML);
    }
  }

  async function generateDoc(overridePrompt?: string, overrideMode?: AiMode) {
    const basePrompt = (overridePrompt ?? prompt).trim();
    if (!basePrompt) return;

    let cleanPrompt = basePrompt;
    let isNewDoc = false;

    if (basePrompt.toLowerCase().includes("/new")) {
      isNewDoc = true;
      cleanPrompt = basePrompt.replace(/\/new/gi, "").trim();
    }

    if (!cleanPrompt) return;

    const tonePrefix =
      tone === "formal"
        ? "Write in a professional, formal tone.\n\n"
        : tone === "friendly"
        ? "Write in a warm, friendly, conversational tone.\n\n"
        : tone === "bold"
        ? "Write with bold, confident, high-impact language.\n\n"
        : tone === "concise"
        ? "Write in a very concise, tight, no-fluff style.\n\n"
        : "";
    const preferredFont = (customFontFamily.trim() || fontFamily).trim();
    const accuracyPrefix =
      "ACCURACY REQUIREMENTS:\n" +
      "- Do not invent facts, names, dates, numbers, references, or claims not present in provided context.\n" +
      "- Preserve all entities, dates, numeric values, and constraints exactly unless the user explicitly asks to change them.\n" +
      "- If critical data is missing, add a [MISSING DETAIL: ...] placeholder instead of guessing.\n\n";
    const formatPrefix =
      `STYLE TARGET:\n- Preferred font: ${preferredFont}\n- Preferred font size: ${fontSizePx}px\n- Preferred line spacing: ${lineSpacing}\n\n`;
    cleanPrompt = accuracyPrefix + tonePrefix + formatPrefix + cleanPrompt;

    setGenerating(true);

    const currentDoc = editorRef.current?.innerHTML ?? docContent;
    const currentDocPlain = htmlToPlainText(currentDoc);
    const currentMode = overrideMode ?? aiMode;
    let selectedPlain = "";
    if (currentMode === "edit_selection" && typeof window.getSelection !== "undefined") {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) selectedPlain = sel.toString().trim();
    }

    try {
      const res = await fetch("/api/generate-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleanPrompt,
          mode: currentMode,
          docContent: currentDocPlain,
          selection: selectedPlain ? { text: selectedPlain } : null,
          strictMode,
        }),
      });

      if (!res.ok) return;

      const data = await res.json();
      const text = (currentMode === "append"
        ? sanitizeGeneratedTextForAppend(String(data.text ?? ""), basePrompt)
        : String(data.text ?? "").trim());
      if (!text) return;

      const htmlFromAi = markdownToHtml(text);

      if (isNewDoc && currentMode === "append") {
        persistDoc(htmlFromAi);
        localStorage.removeItem(DOC_SAVED_KEY);
        return;
      }

      setVariants(prev => [
        {
          id: String(Date.now()) + "-" + prev.length,
          label: `${currentMode === "append" ? "New section" : currentMode === "edit_selection" ? "Edited selection" : currentMode === "rewrite_document" ? "Full rewrite" : "Summary"} • ${new Date().toLocaleTimeString()}`,
          mode: currentMode,
          createdAt: Date.now(),
          content: text,
        },
        ...prev.slice(0, 14),
      ]);

      setUndoStack(prev => [...prev, docContent]);

      if (currentMode === "edit_selection" && selectedPlain && editorRef.current) {
        document.execCommand("insertHTML", false, htmlFromAi);
        const newHtml = editorRef.current.innerHTML;
        setDocContent(newHtml);
        saveDoc(newHtml);
      } else if (currentMode === "append") {
        appendToDoc(htmlFromAi);
      } else if (currentMode === "rewrite_document") {
        persistDoc(htmlFromAi);
      } else if (currentMode === "summarize_document") {
        appendToDoc(htmlFromAi);
      } else {
        appendToDoc(htmlFromAi);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setGenerating(false);
    }
  }

  async function sendChatMessage() {
    const message = chatInput.trim();
    if (!message || chatLoading) return;

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      role: "user",
      text: message,
      createdAt: Date.now(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    setChatLoading(true);

    try {
      const currentDocHtml = editorRef.current?.innerHTML ?? docContent;
      const currentDocPlain = htmlToPlainText(currentDocHtml).trim();

      if (chatActionMode !== "chat") {
        const selectedPlain =
          chatActionMode === "edit_selection" && typeof window.getSelection !== "undefined"
            ? window.getSelection()?.toString().trim() ?? ""
            : "";

        if (chatActionMode === "edit_selection" && !selectedPlain) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: String(Date.now() + 20),
              role: "assistant",
              text: "Please select text in the document first, then run Edit Selection mode.",
              createdAt: Date.now(),
            },
          ]);
          return;
        }

        const agentPrompt = message;
        const res = await fetch("/api/generate-doc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: agentPrompt,
            mode: chatActionMode,
            docContent: currentDocPlain,
            selection: selectedPlain ? { text: selectedPlain } : null,
            strictMode,
          }),
        });

        const data = await res.json();
        let generatedText = String(data?.text ?? "").trim();
        if (!generatedText) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: String(Date.now() + 21),
              role: "assistant",
              text: "Agent did not return content. Please try a clearer instruction.",
              createdAt: Date.now(),
            },
          ]);
          return;
        }

        if (chatActionMode === "append") {
          generatedText = sanitizeGeneratedTextForAppend(generatedText, message);
        }

        const htmlFromAi = markdownToHtml(generatedText);
        setUndoStack((prev) => [...prev, docContent]);

        if (chatActionMode === "edit_selection" && selectedPlain && editorRef.current) {
          restoreEditorSelection();
          document.execCommand("insertHTML", false, htmlFromAi);
          const newHtml = editorRef.current.innerHTML;
          setDocContent(newHtml);
          saveDoc(newHtml);
        } else if (chatActionMode === "append") {
          appendToDoc(htmlFromAi);
        } else if (chatActionMode === "rewrite_document") {
          persistDoc(htmlFromAi);
        } else if (chatActionMode === "summarize_document") {
          appendToDoc(htmlFromAi);
        }

        setVariants((prev) => [
          {
            id: String(Date.now()) + "-agent-" + prev.length,
            label: `${chatActionMode === "append" ? "Agent append" : chatActionMode === "edit_selection" ? "Agent selection edit" : chatActionMode === "rewrite_document" ? "Agent full rewrite" : "Agent summary"} • ${new Date().toLocaleTimeString()}`,
            mode: chatActionMode === "append" ? "append" : chatActionMode === "edit_selection" ? "edit_selection" : chatActionMode === "rewrite_document" ? "rewrite_document" : "summarize_document",
            createdAt: Date.now(),
            content: generatedText,
          },
          ...prev.slice(0, 14),
        ]);

        setChatMessages((prev) => [
          ...prev,
          {
            id: String(Date.now() + 22),
            role: "assistant",
            text: `✅ Applied in ${chatActionMode.replace("_", " ")} mode.\n\n${generatedText}`,
            createdAt: Date.now(),
          },
        ]);
        return;
      }

      const contextPayload = useDocContextForChat && currentDocPlain
        ? buildChatDocContextPayload(currentDocHtml)
        : "";

      const historyPayload = [...chatMessages, userMsg]
        .slice(-10)
        .map((item) => ({ role: item.role, content: item.text }));

      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          docContext: contextPayload,
          history: historyPayload,
        }),
      });

      const data = await res.json();
      const assistantText = (data?.text ?? "").trim() || "I could not generate a response.";

      const assistantMsg: ChatMessage = {
        id: String(Date.now() + 1),
        role: "assistant",
        text: assistantText,
        createdAt: Date.now(),
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + 2),
          role: "assistant",
          text: "There was a problem reaching AI chat. Please try again.",
          createdAt: Date.now(),
        },
      ]);
      console.error(error);
    } finally {
      setChatLoading(false);
    }
  }

  const themeBackgrounds: Record<UiTheme, string> = {
    ocean: "radial-gradient(circle at 20% 20%, rgba(16,185,129,0.18), transparent 35%), radial-gradient(circle at 80% 0%, rgba(59,130,246,0.15), transparent 32%), linear-gradient(to bottom right, #020617, #0f172a, #020617)",
    glacier: "radial-gradient(circle at 30% 20%, rgba(56,189,248,0.25), transparent 40%), radial-gradient(circle at 70% 15%, rgba(147,197,253,0.22), transparent 36%), linear-gradient(to top right, #0c4a6e, #1e293b, #0f172a)",
    ember: "radial-gradient(circle at 20% 30%, rgba(252,165,165,0.25), transparent 35%), radial-gradient(circle at 80% 25%, rgba(251,191,36,0.17), transparent 36%), linear-gradient(to bottom right, #1e293b, #4c1d95, #0f172a)",
  };

  const sections = getDocSections(docContent);
  const docStats = getDocStats(docContent);
  const promptInsights = buildPromptInsights(prompt);
  const liveDocPlain = htmlToPlainText(editorRef.current?.innerHTML ?? docContent);
  const isChatLinkedToDoc = useDocContextForChat && liveDocPlain.trim().length > 0;

  return (
    <div
      className="min-h-screen text-slate-50 transition-all duration-500"
      style={{ background: themeBackgrounds[uiTheme] }}
    >
      <div className="p-8 max-w-6xl mx-auto">
        <header className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight bg-gradient-to-r from-emerald-300 via-cyan-300 to-violet-300 bg-clip-text text-transparent">
              AI Doc Studio
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Craft, refine, and experiment with documents using focused AI tools.
            </p>
          </div>
          <div className="hidden sm:flex flex-col items-end gap-2">
            <div className="flex items-center gap-2 text-xs text-emerald-200/90 bg-emerald-500/10 border border-emerald-400/20 rounded-full px-3 py-1">
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400 mr-1" />
              Precision editing engine ready
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-300">
              <label htmlFor="uiTheme" className="font-medium">Theme</label>
              <select
                id="uiTheme"
                value={uiTheme}
                onChange={(e) => setUiTheme(e.target.value as UiTheme)}
                className="rounded border border-slate-700 bg-slate-900 text-slate-100 px-2 py-1 text-xs"
              >
                <option value="ocean">Ocean glow</option>
                <option value="glacier">Glacier frost</option>
                <option value="ember">Ember haze</option>
              </select>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)] gap-8">
          {/* LEFT: main editor */}
          <div className="space-y-6">
            {/* QUICK ADD */}
            <section className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4 shadow-sm shadow-slate-900/40 backdrop-blur-md">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  Quick scratchpad
                </h2>
                <span className="text-[11px] text-slate-500">
                  Draft ideas, then inject them into the doc.
                </span>
              </div>
              <textarea
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
                placeholder="Jot down raw thoughts, bullets, or a rough paragraph..."
                rows={4}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/70"
              />

              <button
                onClick={handleAddToDoc}
                className="mt-3 inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white transition-colors"
              >
                Add to document
              </button>
            </section>

            {/* DOCUMENT */}
            <section className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4 shadow-sm shadow-slate-900/40 backdrop-blur-md">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-100">
                  Document
                </h2>
                <span className="text-[11px] text-slate-500">
                  Click toolbar to format — real headings, bold, lists
                </span>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-300 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                <span>Words: <strong className="text-slate-100">{docStats.words}</strong></span>
                <span>Chars: <strong className="text-slate-100">{docStats.chars}</strong></span>
                <span>Read time: <strong className="text-slate-100">~{docStats.readingMinutes} min</strong></span>
              </div>

              {/* Word-style formatting toolbar */}
              <div className="flex flex-col gap-2 p-2 rounded-t-lg border border-b-0 border-slate-700 bg-slate-800/80">
                <div className="flex flex-wrap items-center gap-1">
                <select
                  className="h-8 min-w-[130px] rounded px-2 text-xs font-medium bg-slate-700 border border-slate-600 text-slate-200 focus:ring-2 focus:ring-emerald-500/50 focus:outline-none cursor-pointer"
                  value={fontFamily}
                  onChange={(e) => {
                    const next = e.target.value;
                    setFontFamily(next);
                    if (next !== "Custom") {
                      setCustomFontFamily("");
                      applyFontFamily(next);
                    }
                  }}
                  title="Font family"
                >
                  {WORD_LIKE_FONTS.map((font) => (
                    <option key={font} value={font}>{font}</option>
                  ))}
                  <option value="Custom">Custom font…</option>
                </select>
                {fontFamily === "Custom" && (
                  <input
                    value={customFontFamily}
                    onChange={(e) => setCustomFontFamily(e.target.value)}
                    onBlur={() => {
                      const custom = customFontFamily.trim();
                      if (custom) applyFontFamily(custom);
                    }}
                    placeholder="Type installed font name"
                    className="h-8 min-w-[160px] rounded px-2 text-xs bg-slate-700 border border-slate-600 text-slate-200 outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                )}
                <input
                  type="number"
                  min={8}
                  max={96}
                  value={fontSizePx}
                  onChange={(e) => {
                    const next = Math.max(8, Math.min(96, Number(e.target.value || 15)));
                    applyFontSize(next);
                  }}
                  className="h-8 w-[68px] rounded px-2 text-xs bg-slate-700 border border-slate-600 text-slate-200 outline-none focus:ring-2 focus:ring-emerald-500/50"
                  title="Font size in px"
                />
                <select
                  className="h-8 min-w-[120px] rounded px-2 text-xs font-medium bg-slate-700 border border-slate-600 text-slate-200 focus:ring-2 focus:ring-emerald-500/50 focus:outline-none cursor-pointer"
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    if (v) insertBlockFormat(v);
                  }}
                  title="Paragraph & headings"
                >
                  <option value="">Paragraph</option>
                  <option value="h1">Heading 1</option>
                  <option value="h2">Heading 2</option>
                  <option value="h3">Heading 3</option>
                  <option value="h4">Heading 4</option>
                  <option value="p">Normal</option>
                </select>
                <div className="w-px h-5 bg-slate-600 mx-1" />
                <label className="h-8 flex items-center gap-1 rounded px-2 text-[11px] bg-slate-700 border border-slate-600 text-slate-200">
                  A
                  <input
                    type="color"
                    value={textColor}
                    onChange={(e) => applyTextColor(e.target.value)}
                    className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
                    title="Text color"
                  />
                </label>
                <label className="h-8 flex items-center gap-1 rounded px-2 text-[11px] bg-slate-700 border border-slate-600 text-slate-200">
                  H
                  <input
                    type="color"
                    value={highlightColor}
                    onChange={(e) => applyHighlight(e.target.value)}
                    className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
                    title="Highlight color"
                  />
                </label>
                <select
                  className="h-8 min-w-[86px] rounded px-2 text-xs bg-slate-700 border border-slate-600 text-slate-200 focus:ring-2 focus:ring-emerald-500/50 focus:outline-none cursor-pointer"
                  value={lineSpacing}
                  onChange={(e) => applyLineSpacing(e.target.value)}
                  title="Line spacing"
                >
                  <option value="1">1.0</option>
                  <option value="1.15">1.15</option>
                  <option value="1.5">1.5</option>
                  <option value="1.6">1.6</option>
                  <option value="2">2.0</option>
                </select>
                <div className="w-px h-5 bg-slate-600 mx-1" />
                </div>

                <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("bold")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 font-bold text-sm"
                  title="Bold"
                >
                  B
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("italic")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 italic text-sm"
                  title="Italic"
                >
                  I
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("underline")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 underline text-sm"
                  title="Underline"
                >
                  U
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("strikeThrough")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 line-through text-sm"
                  title="Strikethrough"
                >
                  S
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("subscript")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-[10px]"
                  title="Subscript"
                >
                  X₂
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("superscript")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-[10px]"
                  title="Superscript"
                >
                  X²
                </button>
                <div className="w-px h-5 bg-slate-600 mx-1" />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("insertUnorderedList")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Bullet list"
                >
                  •
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("insertOrderedList")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Numbered list"
                >
                  1.
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("indent")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Increase indent"
                >
                  ⇥
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("outdent")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Decrease indent"
                >
                  ⇤
                </button>
                <div className="w-px h-5 bg-slate-600 mx-1" />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("justifyLeft")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Align left"
                >
                  ≡
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("justifyCenter")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Align center"
                >
                  ≡
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("justifyRight")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Align right"
                >
                  ≡
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyFormatting("justifyFull")}
                  className="h-8 w-8 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-sm"
                  title="Justify"
                >
                  ☰
                </button>
                <div className="w-px h-5 bg-slate-600 mx-1" />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={insertOrEditLink}
                  className="h-8 px-2 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-xs"
                  title="Insert link"
                >
                  Link
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearFormatting}
                  className="h-8 px-2 rounded flex items-center justify-center hover:bg-slate-600 text-slate-200 text-xs"
                  title="Clear formatting"
                >
                  Clear
                </button>
                </div>
              </div>

              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                className="doc-editor min-h-[320px] max-h-[520px] overflow-y-auto rounded-b-lg border border-slate-700 bg-white text-slate-900 p-4 text-[15px] leading-relaxed outline-none focus:ring-2 focus:ring-emerald-500/50"
                onInput={() => {
                  if (!editorRef.current) return;
                  setUndoStack(prev => [...prev, docContent]);
                  setDocContent(editorRef.current.innerHTML);
                  saveDoc(editorRef.current.innerHTML);
                }}
                onBlur={() => {
                  if (editorRef.current) {
                    saveDoc(editorRef.current.innerHTML);
                  }
                }}
              />

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={handleUndo}
                  className="px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-xs font-medium text-slate-950 transition-colors"
                >
                  Undo
                </button>

                <button
                  onClick={() => {
                    saveDoc(docContent);
                    localStorage.setItem(DOC_SAVED_KEY, "true");
                  }}
                  className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white transition-colors"
                >
                  Save snapshot
                </button>

                <button
                  onClick={() => {
                    programmaticContentRef.current = true;
                    setDocContent("<p><br></p>");
                    localStorage.removeItem(DOC_STORAGE_KEY);
                    localStorage.removeItem(DOC_SAVED_KEY);
                  }}
                  className="ml-auto px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white transition-colors"
                >
                  Reset document
                </button>
              </div>
            </section>

            {/* AI GENERATE */}
            <section className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4 shadow-sm shadow-slate-900/40 backdrop-blur-md">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  Precision AI edit
                </h2>
                <span className="text-[11px] text-slate-500">
                  Tell the AI exactly what to do; it respects mode + tone.
                </span>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the change: “strengthen opening”, “rewrite selection in formal tone”, “summarize doc in 5 bullets”, “extend conclusion with next steps”..."
                rows={3}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/70 mb-3"
              />

              <div className="mb-3 flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
                  <input
                    type="checkbox"
                    checked={strictMode}
                    onChange={(e) => setStrictMode(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Strict mode
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-slate-300">
                    AI mode
                  </label>
                  <select
                    value={aiMode}
                    onChange={(e) => setAiMode(e.target.value as AiMode)}
                    className="border border-slate-700 bg-slate-900 text-xs px-2 py-1 rounded-md"
                  >
                    <option value="append">Append new content</option>
                    <option value="edit_selection">Edit selected text</option>
                    <option value="rewrite_document">Rewrite whole document</option>
                    <option value="summarize_document">Summarize document</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-300">
                    Tone
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {(["neutral", "formal", "friendly", "bold", "concise"] as TonePreset[]).map(preset => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setTone(preset)}
                        className={`px-2 py-1 rounded-full text-[11px] border transition-colors ${
                          tone === preset
                            ? "border-emerald-400 bg-emerald-500/10 text-emerald-200"
                            : "border-slate-700 text-slate-400 hover:border-emerald-400/70 hover:text-emerald-200"
                        }`}
                      >
                        {preset === "neutral"
                          ? "Neutral"
                          : preset === "formal"
                          ? "Formal"
                          : preset === "friendly"
                          ? "Friendly"
                          : preset === "bold"
                          ? "Bold"
                          : "Concise"}
                      </button>
                    ))}
                  </div>
                </div>

                {aiMode === "edit_selection" && (
                  <span className="text-[11px] text-slate-500">
                    Highlight text in the document, then describe how to transform it.
                  </span>
                )}
              </div>

              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => generateDoc("Correct grammar and tighten clarity without changing meaning.", "rewrite_document")}
                  className="px-2 py-1 rounded-full text-[11px] border border-slate-700 text-slate-300 hover:border-emerald-400/70 hover:text-emerald-200"
                >
                  Fix grammar
                </button>
                <button
                  type="button"
                  onClick={() => generateDoc("Rewrite in plain language for broad audience readability.", "rewrite_document")}
                  className="px-2 py-1 rounded-full text-[11px] border border-slate-700 text-slate-300 hover:border-emerald-400/70 hover:text-emerald-200"
                >
                  Simplify
                </button>
                <button
                  type="button"
                  onClick={() => generateDoc("Extract key action items with owners and deadlines where available.", "summarize_document")}
                  className="px-2 py-1 rounded-full text-[11px] border border-slate-700 text-slate-300 hover:border-emerald-400/70 hover:text-emerald-200"
                >
                  Action items
                </button>
              </div>

              <button
                onClick={() => generateDoc()}
                disabled={generating}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {generating ? "Shaping text…" : "Run AI edit"}
              </button>
            </section>
          </div>

          {/* RIGHT: intelligence panel */}
          <aside className="space-y-4 lg:space-y-6">
            {/* DOCUMENT MAP */}
            <section className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4 shadow-sm shadow-slate-900/40">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  Document map
                </h2>
                <span className="text-[11px] text-slate-500">
                  Live outline from your current text.
                </span>
              </div>
              {sections.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Start writing or generating and the structure map will build itself.
                </p>
              ) : (
                <ol className="space-y-2 text-xs">
                  {sections.map((section, idx) => (
                    <li
                      key={idx}
                      className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
                    >
                      <p className="font-semibold text-slate-100 truncate">
                        {section.title}
                      </p>
                      {section.preview && (
                        <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                          {section.preview}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* AI VARIANTS */}
            <section className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4 shadow-sm shadow-slate-900/40">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  Alternate futures
                </h2>
                <span className="text-[11px] text-slate-500">
                  Every AI run is saved as a reusable variant.
                </span>
              </div>
              {variants.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Run an AI edit to start building a shelf of alternate versions, summaries, and sections.
                </p>
              ) : (
                <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                  {variants.map(variant => (
                    <div
                      key={variant.id}
                      className="group rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs flex flex-col gap-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-slate-100 truncate">
                          {variant.label}
                        </p>
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">
                          {variant.mode === "append"
                            ? "Append"
                            : variant.mode === "edit_selection"
                            ? "Selection"
                            : variant.mode === "rewrite_document"
                            ? "Rewrite"
                            : "Summary"}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 line-clamp-2">
                        {variant.content}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => appendToDoc(variant.content)}
                          className="px-2 py-1 rounded-md bg-emerald-600/90 hover:bg-emerald-500 text-[11px] font-medium text-white transition-colors"
                        >
                          Append to doc
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            // Replace whole document with this variant as an experiment
                            setUndoStack(prev => [...prev, docContent]);
                            persistDoc(variant.content);
                          }}
                          className="px-2 py-1 rounded-md border border-slate-700 text-[11px] text-slate-200 hover:border-emerald-400/80 transition-colors"
                        >
                          Try as full doc
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-4 shadow-sm shadow-slate-900/40">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-slate-100">Prompt intelligence</h2>
                <span className="text-[11px] text-cyan-300">Unique</span>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs space-y-2">
                <p className="text-slate-300">Detected action: <strong className="text-slate-100">{promptInsights.actionHint}</strong></p>
                <p className="text-slate-300">Tone signal: <strong className="text-slate-100">{promptInsights.toneHint}</strong></p>
                <p className="text-slate-300">Quoted tokens: <strong className="text-slate-100">{extractQuotedTokens(prompt).join(", ") || "None"}</strong></p>
                {promptInsights.ambiguities.length > 0 ? (
                  <ul className="text-slate-400 list-disc pl-4 space-y-1">
                    {promptInsights.ambiguities.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-emerald-300">Prompt looks specific enough.</p>
                )}
                <div className="pt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPrompt(clarifyPrompt(prompt))}
                    className="px-2 py-1 rounded-md bg-cyan-600 hover:bg-cyan-500 text-[11px] font-medium text-white"
                  >
                    Auto-clarify prompt
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt("Append exactly this text: \"hi\". Output only final text.")}
                    className="px-2 py-1 rounded-md border border-slate-700 text-[11px] text-slate-200 hover:border-cyan-400/70"
                  >
                    Load safe example
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">Strict mode is currently <strong className="text-slate-200">{strictMode ? "ON" : "OFF"}</strong>.</p>
              </div>
            </section>
          </aside>
        </div>

        <div className="fixed bottom-4 right-4 z-50 w-[360px] max-w-[calc(100vw-1.5rem)]">
          <div className="rounded-2xl border border-cyan-400/25 bg-gradient-to-b from-slate-900/95 via-slate-900/95 to-slate-950/95 shadow-[0_18px_55px_rgba(6,182,212,0.20)] backdrop-blur-xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70 bg-gradient-to-r from-cyan-500/15 to-emerald-500/10">
              <div>
                <p className="text-xs font-semibold tracking-wide text-cyan-200">AI CHAT AGENT</p>
                <p className="text-[10px] text-slate-400">Bottom-right assistant • does not auto-write to doc</p>
                <p className={`text-[10px] ${isChatLinkedToDoc ? "text-emerald-300" : "text-amber-300"}`}>
                  {isChatLinkedToDoc
                    ? `Linked to current doc (${liveDocPlain.split(/\s+/).filter(Boolean).length} words)`
                    : "Doc link missing: enable context and add document text"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setChatDockOpen((prev) => !prev)}
                className="h-7 w-7 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
              >
                {chatDockOpen ? "−" : "+"}
              </button>
            </div>

            {chatDockOpen && (
              <div className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <label className="inline-flex items-center gap-2 text-[11px] text-slate-300">
                    <input
                      id="useDocContextForChatDock"
                      type="checkbox"
                      checked={useDocContextForChat}
                      onChange={(e) => setUseDocContextForChat(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    Use doc context
                  </label>
                  <select
                    value={chatActionMode}
                    onChange={(e) => setChatActionMode(e.target.value as ChatActionMode)}
                    className="rounded-md border border-slate-700 bg-slate-900 text-[11px] text-slate-200 px-2 py-1"
                    title="Agent action mode"
                  >
                    <option value="chat">Chat only</option>
                    <option value="append">Agent append</option>
                    <option value="rewrite_document">Agent rewrite doc</option>
                    <option value="summarize_document">Agent summarize</option>
                    <option value="edit_selection">Agent edit selection</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setChatMessages([])}
                    className="text-[11px] text-rose-300 hover:text-rose-200"
                  >
                    Clear
                  </button>
                </div>

                <div className="mb-2 rounded-lg border border-slate-800 bg-slate-950/70 p-2 max-h-[240px] overflow-y-auto space-y-2">
                  {chatMessages.length === 0 ? (
                    <p className="text-[11px] text-slate-500">Ask for fixes, rewrites, or exact output. Use Insert when needed.</p>
                  ) : (
                    chatMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`rounded-md px-2.5 py-2 text-[11px] ${
                          msg.role === "user"
                            ? "bg-gradient-to-r from-cyan-500/20 to-emerald-500/15 border border-cyan-400/35 text-cyan-100"
                            : "bg-slate-800 border border-slate-700 text-slate-100"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="font-semibold uppercase tracking-wide text-[9px] opacity-80">{msg.role === "user" ? "You" : "AI"}</span>
                          {msg.role === "assistant" && (
                            <button
                              type="button"
                                onClick={() => appendToDoc(sanitizeChatInsertText(msg.text))}
                              className="px-1.5 py-0.5 rounded bg-emerald-600/90 hover:bg-emerald-500 text-[10px] font-medium text-white"
                            >
                              Insert
                            </button>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                      </div>
                    ))
                  )}
                  {chatLoading && (
                    <div className="rounded-md px-2.5 py-2 text-[11px] bg-slate-800 border border-slate-700 text-slate-300">
                      Thinking<span className="animate-pulse">...</span>
                    </div>
                  )}
                </div>

                <div className="mb-2 flex flex-wrap gap-1.5">
                  {chatQuickPrompts.slice(0, 3).map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setChatInput(suggestion)}
                      className="px-2 py-1 rounded-full text-[10px] border border-slate-700 text-slate-300 hover:border-cyan-400/70 hover:text-cyan-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>

                <div className="mb-2 rounded-md border border-slate-800 bg-slate-950/80 px-2 py-1.5 text-[10px] text-slate-400">
                  Mode: <strong className="text-slate-200">{chatActionMode === "chat" ? "Chat only" : `Agent ${chatActionMode.replace("_", " ")}`}</strong>
                  {chatActionMode !== "chat" && " • Send will directly apply result to your document."}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendChatMessage();
                      }
                    }}
                    placeholder="Message AI agent..."
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950/80 p-2 text-xs outline-none focus:ring-2 focus:ring-cyan-500/70"
                  />
                  <button
                    type="button"
                    onClick={sendChatMessage}
                    disabled={chatLoading}
                    className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs font-medium text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {chatLoading ? "..." : "Send"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
