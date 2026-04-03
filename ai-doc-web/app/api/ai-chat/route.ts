function isDocumentDependentQuery(message: string): boolean {
  return /(this document|current document|my document|in the document|in the doc|rewrite this|summarize this|edit this|improve this paragraph|selected text)/i.test(message);
}

function looksLikeMissingDocReply(text: string): boolean {
  return /(document is empty|need .*document|provide .*document|what document|missing document|no document context)/i.test(text);
}

function sanitizeAssistantText(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";

  const withoutTags = trimmed.replace(/<\/?(div|p|span|section|article|ul|ol|li|br)[^>]*>/gi, "\n");
  const compact = withoutTags.replace(/\n{3,}/g, "\n\n").trim();
  return compact || trimmed;
}

export async function POST(req: Request) {
  try {
    const {
      message,
      docContext = "",
      history = [],
    } = await req.json() as {
      message?: string;
      docContext?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    };

    if (!message?.trim()) {
      return Response.json({ text: "Message is required" }, { status: 400 });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
          .slice(-10)
      : [];

    const chatHistoryMessages = safeHistory.map((item) => ({
      role: item.role,
      content: item.content,
    }));

    const contextBlock = docContext?.trim()
      ? `\n\nDOCUMENT CONTEXT:\n${docContext}`
      : "";

    const userMessage = `${message}${contextBlock}`;

    const baseMessages = [
      {
        role: "system" as const,
        content: `
You are an AI assistant for document work.

Environment context:
- You are inside AI Doc Studio.
- If DOCUMENT CONTEXT indicates DOC_CONTEXT_AVAILABLE: true, that is the user's active document.
- In that case, NEVER ask "what document?" or claim document is missing.
- Refer to it as "your current document".
- If DOC_CONTEXT_AVAILABLE: false, only ask for document context when the user request explicitly depends on that document.

Behavior rules:
- Respond conversationally and clearly.
- Help users solve writing, structure, formatting, and clarity problems.
- Be accurate: do not invent facts, names, dates, or citations.
- If information is missing, ask a concise follow-up question.
- Keep answers practical and focused.
- Do not rewrite the full document unless explicitly asked.
- You can provide edit-ready outputs; app controls decide whether to apply changes.
- Avoid generic confirmation-only replies (e.g., "Yes, I can do that").
- Provide the actual helpful output immediately, then optional next step in one line.
- Return plain text or markdown only; never return HTML tags.
- If user asks for N points, provide exactly N bullet points.
`,
      },
      ...chatHistoryMessages,
    ];

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [...baseMessages, { role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      return Response.json({ text: "OpenRouter API error" }, { status: 500 });
    }

    const data = await res.json();
    let text = sanitizeAssistantText(data?.choices?.[0]?.message?.content ?? "No response");

    if (!isDocumentDependentQuery(message) && looksLikeMissingDocReply(text)) {
      const retry = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openrouter/free",
          messages: [
            ...baseMessages,
            {
              role: "user",
              content: `${message}\n\nAnswer this directly without requiring document context.`,
            },
          ],
        }),
      });

      if (retry.ok) {
        const retryData = await retry.json();
        text = sanitizeAssistantText(retryData?.choices?.[0]?.message?.content ?? text);
      }
    }

    return Response.json({ text });
  } catch (error) {
    console.error("AI Chat Error:", error);
    return Response.json({ text: "Error generating chat response" }, { status: 500 });
  }
}
