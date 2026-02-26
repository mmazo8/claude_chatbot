import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production" ? false : "http://localhost:5173",
  })
);

// ── Password protection middleware ──────────────────────────────────────────
app.use((req, res, next) => {
  // Skip auth check for the auth endpoint itself
  if (req.path === "/api/auth") return next();

  const token = req.headers["x-auth-token"];
  if (!token || token !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Auth endpoint ────────────────────────────────────────────────────────────
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    res.json({ success: true, token: process.env.APP_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: "Invalid password" });
  }
});

// ── Chat endpoint (streaming) ────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages, system, model, temperature, max_tokens } = req.body;

  // Set up SSE headers for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const requestBody = {
      model: model || "claude-sonnet-4-20250514",
      max_tokens: max_tokens || 8192,
      temperature: temperature ?? 1,
      stream: true,
      messages: messages.map((msg) => {
        // Apply cache_control to the last user message for prompt caching
        if (
          msg.role === "user" &&
          messages.indexOf(msg) === messages.length - 1
        ) {
          return {
            role: msg.role,
            content: [
              {
                type: "text",
                text: msg.content,
                cache_control: { type: "ephemeral" },
              },
            ],
          };
        }
        return msg;
      }),
    };

    // Add system prompt with cache_control if provided
    if (system && system.trim()) {
      requestBody.system = [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ];
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-1m-2025-08-07,compact-2026-01-12",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.json();
      res.write(
        `data: ${JSON.stringify({ type: "error", error: error.error?.message || "API error" })}\n\n`
      );
      res.end();
      return;
    }

    // Stream the response back to the client
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);

            // Stream text deltas
            if (
              parsed.type === "content_block_delta" &&
              parsed.delta?.type === "text_delta"
            ) {
              res.write(
                `data: ${JSON.stringify({ type: "text", text: parsed.delta.text })}\n\n`
              );
            }

            // Send usage stats at the end
            if (parsed.type === "message_delta" && parsed.usage) {
              res.write(
                `data: ${JSON.stringify({ type: "usage", usage: parsed.usage })}\n\n`
              );
            }

            // Send final usage (includes cache stats)
            if (parsed.type === "message_start" && parsed.message?.usage) {
              res.write(
                `data: ${JSON.stringify({ type: "usage_start", usage: parsed.message.usage })}\n\n`
              );
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Error:", err);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`
    );
    res.end();
  }
});

// ── Serve React frontend in production ──────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../client/dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../client/dist/index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});