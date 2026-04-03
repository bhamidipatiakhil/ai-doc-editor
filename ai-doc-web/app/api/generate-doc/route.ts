function looksLikeMetaAssistantReply(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    /^(yes|sure|certainly|absolutely|of course|okay|alright)\b/.test(trimmed) ||
    /^i\s+(can|will|would|have|am)\b/.test(trimmed) ||
    /(to your document|let me|i can add|i can help)/.test(trimmed)
  );
}

function extractQuotedInsertFromPrompt(prompt: string): string {
  const addLike = /(add|append|insert|include|put|write)\b/i.test(prompt);
  if (!addLike) return "";
  const matches = [...prompt.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]?.trim()).filter(Boolean);
  return matches.join("\n\n").trim();
}

function extractSimpleAppendTarget(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const addLike = /\b(add|append|insert|include|put|write)\b/.test(lower);
  if (!addLike) return "";

  const quoted = extractQuotedInsertFromPrompt(prompt);
  if (quoted) return quoted;

  const match = normalized.match(/\b(?:add|append|insert|include|put|write)\s+([\w-]{1,40})\b/i);
  if (!match) return "";
  const token = match[1]?.trim() ?? "";
  if (!token) return "";
  if (/^(to|into|in|on|for|with|document)$/i.test(token)) return "";
  return token;
}

export async function POST(req: Request) {
  try {
    const {
      prompt,
      mode = "append",
      docContent = "",
      selection = null,
      strictMode = false,
    } = await req.json() as {
      prompt?: string;
      mode?: "append" | "edit_selection" | "rewrite_document" | "summarize_document";
      docContent?: string;
      selection?: { start?: number; end?: number; text?: string } | null;
      strictMode?: boolean;
    };

    if (!prompt) {
      return Response.json({ text: "Prompt is required" }, { status: 400 });
    }

    const selectedText =
      selection && typeof (selection as { text?: string }).text === "string"
        ? (selection as { text: string }).text
        : selection && typeof selection.start === "number" && typeof selection.end === "number"
          ? (docContent as string).slice(selection.start, selection.end)
          : "";

    if (strictMode && mode === "append") {
      const deterministicAppend = extractSimpleAppendTarget(prompt);
      if (deterministicAppend) {
        return Response.json({ text: deterministicAppend });
      }
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          {
            role: "system",
            content: `
You are an expert document editor and writer.

Your job is to apply precise edits to a document or generate new sections,
following the requested MODE and USER_INSTRUCTION exactly.

GENERAL FORMATTING RULES:
- ALWAYS use markdown-style headings for document structure:
  * Use "# " for main title (H1)
  * Use "## " for major sections (H2)
  * Use "### " for subsections (H3)
  * Use "#### " for sub-subsections (H4)
- Use "- " or "* " for bullet lists
- Use "**text**" for bold emphasis
- Use "*text*" for italic emphasis
- Leave blank lines between sections
- Use short readable paragraphs
- Structure documents hierarchically with proper heading levels

ACCURACY RULES (HIGHEST PRIORITY):
- Use only information present in USER_INSTRUCTION, CURRENT_DOCUMENT, and SELECTED_TEXT.
- Do NOT fabricate people, organizations, dates, numbers, legal claims, citations, or references.
- Preserve existing factual details exactly unless user explicitly asks to change them.
- If required detail is missing, insert: [MISSING DETAIL: <what is needed>]
- Never output uncertain statements as facts.

ABSOLUTE OUTPUT RULES:
- Return ONLY final document text.
- DO NOT explain anything.
- DO NOT show thinking or reasoning.
- DO NOT mention instructions, rules, or the user.
- DO NOT add commentary.
- NEVER respond with assistant-style confirmations such as "Yes, I can...".
- If instruction is like "can you add 'X'", output only X (or transformed X), not confirmation text.
- If user asks to make document blank → return empty string.
- STRICT MODE:
  - If STRICT_MODE is true, output must be maximally literal and instruction-following.
  - For append-like commands that ask to add exact text, output only that text.

EDITING MODES (CRITICAL):
- MODE = append
  - Treat USER_INSTRUCTION as a description of new content to ADD.
  - DO NOT rewrite existing document text.
  - Generate new content that can be appended after the current document.

- MODE = edit_selection
  - You receive:
      CURRENT_DOCUMENT and SELECTED_TEXT.
  - Rewrite ONLY the SELECTED_TEXT according to USER_INSTRUCTION.
  - Preserve the surrounding context implied by CURRENT_DOCUMENT.
  - Return ONLY the rewritten text that should replace SELECTED_TEXT
    (do NOT return the whole document).

- MODE = rewrite_document
  - Rewrite the ENTIRE CURRENT_DOCUMENT according to USER_INSTRUCTION.
  - Keep the original meaning unless the instruction asks otherwise.
  - Return the full rewritten document.

- MODE = summarize_document
  - Read CURRENT_DOCUMENT carefully.
  - Return a clear, concise summary that preserves all key details.
  - Use bullet points "•" if it helps readability.

Always follow MODE exactly. Output must be clean document text only.

`
          },
          {
            role: "user",
            content: `
MODE: ${mode}
STRICT_MODE: ${strictMode ? "true" : "false"}

USER_INSTRUCTION:
${prompt}

CURRENT_DOCUMENT:
${docContent}

SELECTED_TEXT:
${selectedText}

`
          }
        ]
      })
    });

    if (!res.ok) {
      return Response.json({ text: "OpenRouter API error" }, { status: 500 });
    }

    const data = await res.json();

    let text = (data?.choices?.[0]?.message?.content ?? "No response").trim();

    if (mode === "append" && looksLikeMetaAssistantReply(text)) {
      const quotedFallback = extractQuotedInsertFromPrompt(prompt);
      if (quotedFallback) {
        text = quotedFallback;
      } else {
        text = text
          .replace(/^(yes|sure|certainly|absolutely|of course|okay|alright)[,!.\s]*/i, "")
          .replace(/^i\s+(can|will|would)\s+/i, "")
          .replace(/\s+to\s+your\s+document\.?$/i, "")
          .trim();
      }
    }

    return Response.json({ text });

  } catch (error) {
    console.error("Generate Doc Error:", error);
    return Response.json({ text: "Error generating text" }, { status: 500 });
  }
}
