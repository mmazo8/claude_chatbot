import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./app.css";

const MODELS = [
  { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5-20251022", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const DEFAULT_MODEL = MODELS[0].id;
const DEFAULT_MAX_TOKENS = 32000;

// ── Storage helpers ───────────────────────────────────────────────────────────
const STORAGE_KEY = "workbench_conversations";
function loadConversations() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveConversations(convos) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(convos));
}
function newConversation() {
  return {
    id: Date.now().toString(),
    title: "New conversation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    system: "",
    model: DEFAULT_MODEL,
  };
}
function titleFromMessages(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const text = typeof first.content === "string" ? first.content : first.content?.[0]?.text || "";
  return text.slice(0, 40) + (text.length > 40 ? "…" : "");
}

// ── Login Screen ──────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await res.json();
      if (data.success) onLogin(data.token);
      else setError("Invalid password");
    } catch { setError("Connection error"); }
    setLoading(false);
  };
  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="login-logo"><span className="logo-bracket">[</span><span className="logo-text">WORKBENCH</span><span className="logo-bracket">]</span></div>
        <p className="login-sub">Claude API Interface</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input type="password" placeholder="enter password" value={password} onChange={(e) => setPassword(e.target.value)} className="login-input" autoFocus />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>{loading ? "authenticating..." : "enter"}</button>
        </form>
      </div>
    </div>
  );
}

// ── Token Counter ─────────────────────────────────────────────────────────────
function TokenDisplay({ usage }) {
  if (!usage) return null;
  return (
    <div className="token-display">
      {usage.input_tokens != null && <span className="token-chip input">↑ {usage.input_tokens.toLocaleString()}</span>}
      {usage.output_tokens != null && <span className="token-chip output">↓ {usage.output_tokens.toLocaleString()}</span>}
      {usage.cache_read_input_tokens > 0 && <span className="token-chip cache-read">⚡ {usage.cache_read_input_tokens.toLocaleString()} cached</span>}
      {usage.cache_creation_input_tokens > 0 && <span className="token-chip cache-write">📝 {usage.cache_creation_input_tokens.toLocaleString()} written</span>}
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────────────────────
function Message({ msg }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(msg.content); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className={`message message-${msg.role}`}>
      <div className="message-header">
        <span className="message-role">{msg.role === "user" ? "you" : "claude"}</span>
        {msg.role === "assistant" && <button className="copy-btn" onClick={copy}>{copied ? "copied!" : "copy"}</button>}
      </div>
      <div className="message-content">
        {msg.role === "assistant"
          ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          : <p style={{ whiteSpace: "pre-wrap" }}>{msg.content}</p>}
      </div>
      {msg.usage && <TokenDisplay usage={msg.usage} />}
    </div>
  );
}

// ── Conversation List Item ────────────────────────────────────────────────────
function ConvoItem({ convo, active, onSelect, onDelete, onRename }) {
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(convo.title);
  const inputRef = useRef(null);
  const date = new Date(convo.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const startEdit = (e) => { e.stopPropagation(); setEditVal(convo.title); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0); };
  const commitEdit = () => { if (editVal.trim()) onRename(convo.id, editVal.trim()); setEditing(false); };
  const editKeyDown = (e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); };

  return (
    <div className={`convo-item ${active ? "convo-active" : ""}`} onClick={() => !editing && onSelect(convo.id)}>
      <div className="convo-item-body">
        {editing ? (
          <input
            ref={inputRef}
            className="convo-rename-input"
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={editKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="convo-title" onDoubleClick={startEdit} title="Double-click to rename">{convo.title}</span>
        )}
        <span className="convo-date">{date}</span>
      </div>
      {!editing && (
        confirm ? (
          <div className="convo-confirm" onClick={(e) => e.stopPropagation()}>
            <button className="convo-confirm-yes" onClick={() => onDelete(convo.id)}>delete</button>
            <button className="convo-confirm-no" onClick={() => setConfirm(false)}>cancel</button>
          </div>
        ) : (
          <div className="convo-actions" onClick={(e) => e.stopPropagation()}>
            <button className="convo-action-btn" onClick={startEdit} title="Rename">✎</button>
            <button className="convo-action-btn convo-delete" onClick={() => setConfirm(true)} title="Delete">✕</button>
          </div>
        )
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("auth_token") || "");
  const [conversations, setConversations] = useState(() => loadConversations());
  const [activeId, setActiveId] = useState(() => { const c = loadConversations(); return c.length > 0 ? c[0].id : null; });
  const [input, setInput] = useState("");
  const [temperature, setTemperature] = useState(1);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [systemOpen, setSystemOpen] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const bottomRef = useRef(null);
  const abortRef = useRef(null);

  const activeConvo = conversations.find((c) => c.id === activeId) || null;
  const messages = activeConvo?.messages || [];
  const system = activeConvo?.system || "";
  const model = activeConvo?.model || DEFAULT_MODEL;

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("theme", theme); }, [theme]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { saveConversations(conversations); }, [conversations]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const updateActiveConvo = (updater) => {
    if (!activeId) {
      const convo = newConversation();
      const updated = { ...updater(convo), updatedAt: Date.now() };
      setConversations((prev) => [updated, ...prev]);
      setActiveId(updated.id);
    } else {
      setConversations((prev) => prev.map((c) => c.id === activeId ? { ...updater(c), updatedAt: Date.now() } : c));
    }
  };

  const handleLogin = (t) => { sessionStorage.setItem("auth_token", t); setToken(t); };
  const handleLogout = () => { sessionStorage.removeItem("auth_token"); setToken(""); };

  const newChat = () => { const c = newConversation(); setConversations((prev) => [c, ...prev]); setActiveId(c.id); setInput(""); };
  const selectConvo = (id) => { if (streaming) stopStreaming(); setActiveId(id); setInput(""); };
  const deleteConvo = (id) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) { const r = conversations.filter((c) => c.id !== id); setActiveId(r.length > 0 ? r[0].id : null); }
  };
  const renameConvo = (id, title) => setConversations((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
  const clearConversation = () => { if (streaming) stopStreaming(); if (!activeConvo) return; updateActiveConvo((c) => ({ ...c, messages: [], title: "New conversation" })); };

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;
    let currentId = activeId;
    if (!currentId) {
      const convo = newConversation();
      setConversations((prev) => [convo, ...prev]);
      setActiveId(convo.id);
      currentId = convo.id;
    }
    const userMsg = { role: "user", content: input.trim() };
    const currentMessages = conversations.find((c) => c.id === currentId)?.messages || [];
    const newMessages = [...currentMessages, userMsg];
    setConversations((prev) => prev.map((c) => c.id === currentId ? {
      ...c,
      messages: [...newMessages, { role: "assistant", content: "", streaming: true }],
      title: c.messages.length === 0 ? titleFromMessages(newMessages) : c.title,
      updatedAt: Date.now(),
    } : c));
    setInput("");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const currentConvo = conversations.find((c) => c.id === currentId);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": token },
        body: JSON.stringify({ messages: newMessages, system: currentConvo?.system || "", model: currentConvo?.model || DEFAULT_MODEL, temperature, max_tokens: maxTokens }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Request failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "", usageData = {};
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === "text") {
              fullText += parsed.text;
              setConversations((prev) => prev.map((c) => { if (c.id !== currentId) return c; const msgs = [...c.messages]; msgs[msgs.length - 1] = { role: "assistant", content: fullText, streaming: true }; return { ...c, messages: msgs }; }));
            }
            if (parsed.type === "usage_start") usageData = { ...usageData, ...parsed.usage };
            if (parsed.type === "usage") usageData = { ...usageData, ...parsed.usage };
            if (parsed.type === "done") setConversations((prev) => prev.map((c) => { if (c.id !== currentId) return c; const msgs = [...c.messages]; msgs[msgs.length - 1] = { role: "assistant", content: fullText, streaming: false, usage: usageData }; return { ...c, messages: msgs, updatedAt: Date.now() }; }));
            if (parsed.type === "error") setConversations((prev) => prev.map((c) => { if (c.id !== currentId) return c; const msgs = [...c.messages]; msgs[msgs.length - 1] = { role: "assistant", content: `⚠️ Error: ${parsed.error}`, streaming: false }; return { ...c, messages: msgs }; }));
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") setConversations((prev) => prev.map((c) => { if (c.id !== currentId) return c; const msgs = [...c.messages]; msgs[msgs.length - 1] = { role: "assistant", content: `⚠️ Error: ${err.message}`, streaming: false }; return { ...c, messages: msgs }; }));
    }
    setStreaming(false);
  }, [input, conversations, activeId, streaming, token, temperature, maxTokens]);

  const stopStreaming = () => {
    abortRef.current?.abort(); setStreaming(false);
    setConversations((prev) => prev.map((c) => { if (c.id !== activeId) return c; const msgs = [...c.messages]; const last = msgs[msgs.length - 1]; if (last?.streaming) msgs[msgs.length - 1] = { ...last, streaming: false }; return { ...c, messages: msgs }; }));
  };

  const handleKeyDown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); } };

  if (!token) return <LoginScreen onLogin={handleLogin} />;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)}>{sidebarOpen ? "◀" : "▶"}</button>
          <span className="header-title"><span className="logo-bracket">[</span>WORKBENCH<span className="logo-bracket">]</span></span>
        </div>
        <div className="header-right">
          <select value={model} onChange={(e) => updateActiveConvo((c) => ({ ...c, model: e.target.value }))} className="model-select">
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <button className="header-btn theme-btn" onClick={toggleTheme} title="toggle theme">{theme === "dark" ? "☀" : "☾"}</button>
          <button className="header-btn clear-btn" onClick={clearConversation}>clear</button>
          <button className="header-btn new-chat-header-btn" onClick={newChat}>+ new</button>
          <button className="header-btn logout-btn" onClick={handleLogout}>logout</button>
        </div>
      </header>

      <div className="main-layout">
        {sidebarOpen && (
          <aside className="sidebar">
            {/* Conversation History */}
            <div className="sidebar-section convo-section">
              <p className="section-label">conversations</p>
              {conversations.length === 0 && <p className="convo-empty">no saved conversations</p>}
              <div className="convo-list">
                {conversations.map((c) => (
                  <ConvoItem key={c.id} convo={c} active={c.id === activeId} onSelect={selectConvo} onDelete={deleteConvo} onRename={renameConvo} />
                ))}
              </div>
            </div>

            {/* System Prompt */}
            <div className="sidebar-section system-section">
              <button className="section-toggle" onClick={() => setSystemOpen((v) => !v)}>
                system prompt {systemOpen ? "▾" : "▸"}
              </button>
              {systemOpen && (
                <textarea
                  className="system-textarea"
                  placeholder="You are a helpful assistant..."
                  value={system}
                  onChange={(e) => updateActiveConvo((c) => ({ ...c, system: e.target.value }))}
                />
              )}
            </div>

            {/* Parameters */}
            <div className="sidebar-section">
              <p className="section-label">parameters</p>
              <div className="param-row">
                <label>temperature <span className="param-value">{temperature}</span></label>
                <input type="range" min="0" max="1" step="0.01" value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} className="slider" />
              </div>
              <div className="param-row">
                <label>max tokens <span className="param-value">{maxTokens.toLocaleString()}</span></label>
                <input type="range" min="256" max="32000" step="256" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value))} className="slider" />
              </div>
            </div>

            {/* Beta Badges */}
            <div className="sidebar-section">
              <p className="section-label">active features</p>
              <div className="badge-list">
                <span className="badge">context-1m</span>
                <span className="badge">compact</span>
                <span className="badge">cache_control</span>
              </div>
            </div>
          </aside>
        )}

        <main className="chat-area">
          <div className="messages">
            {messages.length === 0 && (
              <div className="empty-state">
                <p>start a conversation</p>
                <p className="empty-hint">⌘↵ or Ctrl↵ to send</p>
              </div>
            )}
            {messages.map((msg, i) => <Message key={i} msg={msg} />)}
            {streaming && messages[messages.length - 1]?.streaming && (
              <div className="streaming-indicator"><span /><span /><span /></div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="input-area">
            <textarea className="chat-input" placeholder="send a message..." value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} rows={3} disabled={streaming} />
            <div className="input-actions">
              <span className="input-hint">⌘↵ to send</span>
              {streaming
                ? <button className="stop-btn" onClick={stopStreaming}>◼ stop</button>
                : <button className="send-btn" onClick={sendMessage} disabled={!input.trim()}>send ↵</button>}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}