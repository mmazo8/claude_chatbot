import { useState, useRef, useEffect, useCallback, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./app.css";

const MODELS = [
  { id: "claude-opus-4-6",    label: "Claude Opus 4.6 (1M ctx)" },
  { id: "claude-sonnet-4-6",  label: "Claude Sonnet 4.6 (1M ctx)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];
const DEFAULT_MODEL      = MODELS[0].id;
const DEFAULT_MAX_TOKENS = 32000;

// ── API helpers ───────────────────────────────────────────────────────────────
function apiHeaders(token, username) {
  return { "Content-Type": "application/json", "x-auth-token": token, "x-username": username };
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function newConvoObj(model = DEFAULT_MODEL) {
  return {
    id: Date.now().toString(),
    title: "New conversation",
    model,
    system: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    messages: [],
  };
}

function titleFromMessages(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const text = typeof first.content === "string" ? first.content : "";
  return text.slice(0, 40) + (text.length > 40 ? "…" : "");
}

// ── FIX 2: Draft helpers — persist unsent input per conversation ──────────────
const DRAFT_PREFIX = "draft_";
function loadDraft(convoId) {
  try { return localStorage.getItem(DRAFT_PREFIX + convoId) || ""; }
  catch { return ""; }
}
function saveDraft(convoId, text) {
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + convoId, text);
    else      localStorage.removeItem(DRAFT_PREFIX + convoId);
  } catch {}
}

// ── Login Screen ──────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const res  = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, username }) });
      const data = await res.json();
      if (data.success) onLogin(data.token, data.username);
      else setError(data.error || "Invalid credentials");
    } catch { setError("Connection error"); }
    setLoading(false);
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="login-logo"><span className="logo-bracket">[</span><span className="logo-text">WORKBENCH</span><span className="logo-bracket">]</span></div>
        <p className="login-sub">Claude API Interface</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input type="text"     placeholder="username"  value={username}  onChange={(e) => setUsername(e.target.value)}  className="login-input" autoFocus />
          <input type="password" placeholder="password"  value={password}  onChange={(e) => setPassword(e.target.value)}  className="login-input" />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>{loading ? "authenticating..." : "enter"}</button>
        </form>
      </div>
    </div>
  );
}

// ── Token Counter (message-level tags) ───────────────────────────────────────
// memo: never re-renders unless usage or showTokens actually change
const TokenDisplay = memo(function TokenDisplay({ usage, showTokens }) {
  if (!usage || !showTokens) return null;
  return (
    <div className="token-display">
      {usage.input_tokens        != null && <span className="token-chip input">↑ {usage.input_tokens.toLocaleString()}</span>}
      {usage.output_tokens       != null && <span className="token-chip output">↓ {usage.output_tokens.toLocaleString()}</span>}
      {usage.cache_read_input_tokens  > 0 && <span className="token-chip cache-read">⚡ {usage.cache_read_input_tokens.toLocaleString()} cached</span>}
      {usage.cache_creation_input_tokens > 0 && <span className="token-chip cache-write">📝 {usage.cache_creation_input_tokens.toLocaleString()} written</span>}
    </div>
  );
});

// ── Message Bubble ────────────────────────────────────────────────────────────
// memo: skips re-render on every keystroke — only re-renders when msg or
// showTokens actually change (i.e. during streaming or when toggle flipped)
const Message = memo(function Message({ msg, showTokens }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(msg.content); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className={`message message-${msg.role}`}>
      <div className="message-header">
        <span className="message-role">{msg.role === "user" ? "you" : "claude"}</span>
        <button className="copy-btn" onClick={copy}>{copied ? "copied!" : "copy"}</button>
      </div>
      <div className="message-content">
        {msg.role === "assistant"
          ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          : <p style={{ whiteSpace: "pre-wrap" }}>{msg.content}</p>}
      </div>
      {msg.usage && <TokenDisplay usage={msg.usage} showTokens={showTokens} />}
    </div>
  );
});

// ── Chat Input ────────────────────────────────────────────────────────────────
// Isolated into its own memo component so that typing only re-renders this
// small subtree — the message list above is completely unaffected by input state.
const ChatInput = memo(function ChatInput({
  input, onInput, onKeyDown, streaming, onStop, onSend,
  promptTokens, promptTokensLoading,
}) {
  return (
    <div className="input-area">
      <textarea
        className="chat-input"
        placeholder="send a message..."
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={streaming}
      />
      <div className="input-actions">
        <span className="input-hint">⌘↵ to send</span>
        <span className="token-count" title="estimated input tokens">
          {promptTokensLoading ? "counting…" : (promptTokens !== null ? `${promptTokens.toLocaleString()} tokens` : "")}
        </span>
        {streaming
          ? <button className="stop-btn" onClick={onStop}>◼ stop</button>
          : <button className="send-btn" onClick={onSend} disabled={!input.trim()}>send ↵</button>}
      </div>
    </div>
  );
});

// ── Conversation List Item ────────────────────────────────────────────────────
function ConvoItem({ convo, active, onSelect, onDelete, onRename }) {
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(convo.title);
  const inputRef = useRef(null);

  // Coerce updated_at to number — DB returns it as a string
  const ts      = Number(convo.updated_at);
  const dateObj = new Date(ts);
  const date    = isNaN(dateObj.getTime())
    ? ""
    : dateObj.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const startEdit = (e) => { e.stopPropagation(); setEditVal(convo.title); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0); };
  const commitEdit = () => { if (editVal.trim()) onRename(convo.id, editVal.trim()); setEditing(false); };
  const editKeyDown = (e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); };

  return (
    <div className={`convo-item ${active ? "convo-active" : ""}`} onClick={() => !editing && onSelect(convo.id)}>
      <div className="convo-item-body">
        {editing
          ? <input ref={inputRef} className="convo-rename-input" value={editVal} onChange={(e) => setEditVal(e.target.value)} onBlur={commitEdit} onKeyDown={editKeyDown} onClick={(e) => e.stopPropagation()} />
          : <span className="convo-title" onDoubleClick={startEdit} title="Double-click to rename">{convo.title}</span>}
        <span className="convo-date">{date}</span>
      </div>
      {!editing && (confirm
        ? <div className="convo-confirm" onClick={(e) => e.stopPropagation()}>
            <button className="convo-confirm-yes" onClick={() => onDelete(convo.id)}>delete</button>
            <button className="convo-confirm-no"  onClick={() => setConfirm(false)}>cancel</button>
          </div>
        : <div className="convo-actions" onClick={(e) => e.stopPropagation()}>
            <button className="convo-action-btn"              onClick={startEdit}           title="Rename">✎</button>
            <button className="convo-action-btn convo-delete" onClick={() => setConfirm(true)} title="Delete">✕</button>
          </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [token,    setToken]    = useState(() => sessionStorage.getItem("auth_token")   || "");
  const [username, setUsername] = useState(() => sessionStorage.getItem("auth_username") || "");
  const [convos,   setConvos]   = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loadingConvos, setLoadingConvos] = useState(false);

  const [msgCache, setMsgCache] = useState({});

  const [input,       setInput]       = useState("");
  const [temperature, setTemperature] = useState(1);
  const [maxTokens,   setMaxTokens]   = useState(DEFAULT_MAX_TOKENS);
  const [streaming,   setStreaming]   = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [systemOpen,  setSystemOpen]  = useState(true);
  const [theme,       setTheme]       = useState(() => localStorage.getItem("theme") || "dark");

  // Token tags toggle
  const [showTokens, setShowTokens] = useState(() => {
    const saved = localStorage.getItem("show_tokens");
    return saved === null ? true : saved === "true";
  });
  const toggleShowTokens = () => setShowTokens((v) => {
    const next = !v;
    localStorage.setItem("show_tokens", String(next));
    return next;
  });

  // FIX 1: prompt token counter state
  const [promptTokens,        setPromptTokens]        = useState(null);
  const [promptTokensLoading, setPromptTokensLoading] = useState(false);
  const tokenCountReqRef = useRef(0);

  const bottomRef      = useRef(null);
  const abortRef       = useRef(null);
  // FIX 2: track previous activeId so we can save draft before switching
  const prevActiveIdRef = useRef(null);
  // FIX 3: keep a ref to msgCache so the token-count effect doesn't need it as a dep
  const msgCacheRef    = useRef(msgCache);
  useEffect(() => { msgCacheRef.current = msgCache; }, [msgCache]);

  const activeConvo = convos.find((c) => c.id === activeId) || null;
  const messages    = msgCache[activeId] || [];
  const system      = activeConvo?.system || "";
  const model       = activeConvo?.model  || DEFAULT_MODEL;

  // ── Theme ──
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("theme", theme); }, [theme]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  const toggleTheme = () => setTheme((t) => t === "dark" ? "light" : "dark");

  // ── FIX 2: save draft on convo switch, restore draft for incoming convo ──────
  useEffect(() => {
    const prev = prevActiveIdRef.current;
    // Save whatever was typed in the previous conversation before leaving
    if (prev && prev !== activeId) {
      saveDraft(prev, input);
    }
    // Restore the saved draft (or empty string) for the newly-active conversation
    if (activeId) {
      setInput(loadDraft(activeId));
    }
    prevActiveIdRef.current = activeId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── FIX 1 + FIX 3: prompt token counter — debounced, no `messages` dep ──────
  // Reading messages via msgCacheRef instead of the `messages` variable means
  // this effect does NOT re-subscribe on every streaming update, which was the
  // cause of the typing lag in long conversations.
  useEffect(() => {
    const trimmed = input.trim();

    if (!activeId || !trimmed || streaming) {
      setPromptTokens(null);
      setPromptTokensLoading(false);
      return;
    }

    const reqId = ++tokenCountReqRef.current;
    setPromptTokensLoading(true);

    // 600 ms debounce — rapid typing won't fire a request per keystroke
    const timer = setTimeout(() => {
      (async () => {
        try {
          const currentMessages = (msgCacheRef.current[activeId] || [])
            .filter((m) => !m.streaming && m.content);

          const data = await apiFetch("/api/count-tokens", {
            method: "POST",
            headers: apiHeaders(token, username),
            body: JSON.stringify({
              model,
              system,
              messages: [...currentMessages, { role: "user", content: trimmed }],
            }),
          });

          if (tokenCountReqRef.current !== reqId) return;
          setPromptTokens(data.input_tokens);
        } catch {
          if (tokenCountReqRef.current !== reqId) return;
          setPromptTokens(null);
        } finally {
          if (tokenCountReqRef.current === reqId) setPromptTokensLoading(false);
        }
      })();
    }, 600);

    return () => clearTimeout(timer);
    // NOTE: `messages` deliberately omitted — read via ref to avoid lag
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, activeId, model, system, streaming, token, username]);

  // ── Load conversations on login ──
  useEffect(() => {
    if (!token || !username) return;
    loadConversations();
  }, [token, username]);

  const loadConversations = async () => {
    setLoadingConvos(true);
    try {
      const data = await apiFetch("/api/conversations", { headers: apiHeaders(token, username) });
      setConvos(data);
      if (data.length > 0) setActiveId(data[0].id);
    } catch (err) { console.error("Failed to load conversations:", err); }
    setLoadingConvos(false);
  };

  // ── Load messages when switching conversations ──
  useEffect(() => {
    if (!activeId || msgCache[activeId]) return;
    loadMessages(activeId);
  }, [activeId]);

  const loadMessages = async (id) => {
    try {
      const data = await apiFetch(`/api/conversations/${id}`, { headers: apiHeaders(token, username) });
      setMsgCache((prev) => ({ ...prev, [id]: data.messages || [] }));
      setConvos((prev) => prev.map((c) => c.id === id ? { ...c, system: data.system, model: data.model } : c));
    } catch (err) { console.error("Failed to load messages:", err); }
  };

  // ── Auth ──
  const handleLogin = (t, u) => {
    sessionStorage.setItem("auth_token",   t);
    sessionStorage.setItem("auth_username", u);
    setToken(t); setUsername(u);
  };
  const handleLogout = () => {
    sessionStorage.removeItem("auth_token");
    sessionStorage.removeItem("auth_username");
    setToken(""); setUsername(""); setConvos([]); setActiveId(null); setMsgCache({});
  };

  // ── Conversations ──
  const newChat = async () => {
    const convo = newConvoObj();
    try {
      await apiFetch("/api/conversations", { method: "POST", headers: apiHeaders(token, username), body: JSON.stringify(convo) });
      setConvos((prev) => [convo, ...prev]);
      setMsgCache((prev) => ({ ...prev, [convo.id]: [] }));
      setActiveId(convo.id);
      // input is cleared by the activeId effect (no draft for a new convo)
    } catch (err) { console.error("Failed to create conversation:", err); }
  };

  // FIX 2: removed setInput("") from selectConvo — handled by the activeId effect
  const selectConvo = (id) => { if (streaming) stopStreaming(); setActiveId(id); };

  const deleteConvo = async (id) => {
    saveDraft(id, ""); // clean up any draft for the deleted convo
    try {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE", headers: apiHeaders(token, username) });
      setConvos((prev) => prev.filter((c) => c.id !== id));
      setMsgCache((prev) => { const n = { ...prev }; delete n[id]; return n; });
      if (activeId === id) {
        const remaining = convos.filter((c) => c.id !== id);
        setActiveId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) { console.error("Failed to delete:", err); }
  };

  const renameConvo = async (id, title) => {
    setConvos((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
    try { await apiFetch(`/api/conversations/${id}`, { method: "PATCH", headers: apiHeaders(token, username), body: JSON.stringify({ title }) }); }
    catch (err) { console.error("Failed to rename:", err); }
  };

  const updateConvoMeta = async (field, value) => {
    if (!activeId) {
      const convo = newConvoObj();
      convo[field] = value;
      try {
        await apiFetch("/api/conversations", { method: "POST", headers: apiHeaders(token, username), body: JSON.stringify(convo) });
        setConvos((prev) => [convo, ...prev]);
        setMsgCache((prev) => ({ ...prev, [convo.id]: [] }));
        setActiveId(convo.id);
      } catch (err) { console.error(err); }
    } else {
      setConvos((prev) => prev.map((c) => c.id === activeId ? { ...c, [field]: value } : c));
      try { await apiFetch(`/api/conversations/${activeId}`, { method: "PATCH", headers: apiHeaders(token, username), body: JSON.stringify({ [field]: value }) }); }
      catch (err) { console.error(err); }
    }
  };

  const clearConversation = async () => {
    if (streaming) stopStreaming();
    if (!activeId) return;
    await deleteConvo(activeId);
    await newChat();
  };

  // ── Send message ──
  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;

    let currentId    = activeId;
    let currentConvo = activeConvo;

    if (!currentId) {
      const convo = newConvoObj(DEFAULT_MODEL);
      try {
        await apiFetch("/api/conversations", { method: "POST", headers: apiHeaders(token, username), body: JSON.stringify(convo) });
        setConvos((prev) => [convo, ...prev]);
        setMsgCache((prev) => ({ ...prev, [convo.id]: [] }));
        setActiveId(convo.id);
        currentId    = convo.id;
        currentConvo = convo;
      } catch (err) { console.error(err); return; }
    }

    const currentMessages = msgCache[currentId] || [];
    const userMsg     = { role: "user", content: input.trim() };
    const newMessages = [...currentMessages, userMsg];

    setMsgCache((prev) => ({ ...prev, [currentId]: [...newMessages, { role: "assistant", content: "", streaming: true }] }));

    if (currentMessages.length === 0) {
      const title = titleFromMessages(newMessages);
      setConvos((prev) => prev.map((c) => c.id === currentId ? { ...c, title } : c));
      apiFetch(`/api/conversations/${currentId}`, { method: "PATCH", headers: apiHeaders(token, username), body: JSON.stringify({ title }) }).catch(console.error);
    }

    // Clear input + draft now that the message is being sent
    setInput("");
    saveDraft(currentId, "");
    setPromptTokens(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let fullText = "", usageData = {};

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: apiHeaders(token, username),
        body: JSON.stringify({ messages: newMessages, system: currentConvo?.system || "", model: currentConvo?.model || DEFAULT_MODEL, temperature, max_tokens: maxTokens }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Request failed");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === "text") {
              fullText += parsed.text;
              setMsgCache((prev) => {
                const msgs = [...(prev[currentId] || [])];
                msgs[msgs.length - 1] = { role: "assistant", content: fullText, streaming: true };
                return { ...prev, [currentId]: msgs };
              });
            }
            if (parsed.type === "usage_start") usageData = { ...usageData, ...parsed.usage };
            if (parsed.type === "usage")       usageData = { ...usageData, ...parsed.usage };
            if (parsed.type === "done") {
              const assistantMsg = { role: "assistant", content: fullText, usage: usageData };
              setMsgCache((prev) => {
                const msgs = [...(prev[currentId] || [])];
                msgs[msgs.length - 1] = assistantMsg;
                return { ...prev, [currentId]: msgs };
              });
              const userTs = Date.now();
              const assistantTs = userTs + 1;
              try {
                await apiFetch(`/api/conversations/${currentId}/messages`, { method: "POST", headers: apiHeaders(token, username), body: JSON.stringify({ ...userMsg, created_at: userTs }) });
                await apiFetch(`/api/conversations/${currentId}/messages`, { method: "POST", headers: apiHeaders(token, username), body: JSON.stringify({ ...assistantMsg, created_at: assistantTs }) });
              } catch (e) { console.error("Failed to save messages:", e); }
            }
            if (parsed.type === "error") {
              setMsgCache((prev) => { const msgs = [...(prev[currentId] || [])]; msgs[msgs.length - 1] = { role: "assistant", content: `⚠️ Error: ${parsed.error}`, streaming: false }; return { ...prev, [currentId]: msgs }; });
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMsgCache((prev) => { const msgs = [...(prev[currentId] || [])]; msgs[msgs.length - 1] = { role: "assistant", content: `⚠️ Error: ${err.message}`, streaming: false }; return { ...prev, [currentId]: msgs }; });
      }
    }
    setStreaming(false);
  }, [input, msgCache, activeId, activeConvo, streaming, token, username, temperature, maxTokens]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    setStreaming(false);
    if (!activeId) return;
    setMsgCache((prev) => {
      const msgs = [...(prev[activeId] || [])];
      const last = msgs[msgs.length - 1];
      if (last?.streaming) msgs[msgs.length - 1] = { ...last, streaming: false };
      return { ...prev, [activeId]: msgs };
    });
  };

  // Both handlers are stable so ChatInput's memo comparison always passes
  const handleKeyDown = useCallback((e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); } }, [sendMessage]);
  const handleInput   = useCallback((val) => setInput(val), []);

  if (!token || !username) return <LoginScreen onLogin={handleLogin} />;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)}>{sidebarOpen ? "◀" : "▶"}</button>
          <span className="header-title"><span className="logo-bracket">[</span>WORKBENCH<span className="logo-bracket">]</span></span>
          <span className="header-user">@{username}</span>
        </div>
        <div className="header-right">
          <select value={model} onChange={(e) => updateConvoMeta("model", e.target.value)} className="model-select">
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <button className="header-btn theme-btn"  onClick={toggleTheme}       title="toggle theme">{theme === "dark" ? "☀" : "☾"}</button>
          <button className="header-btn clear-btn"  onClick={clearConversation}>clear</button>
          <button className="header-btn logout-btn" onClick={handleLogout}>logout</button>
        </div>
      </header>

      <div className="main-layout">
        {sidebarOpen && (
          <aside className="sidebar">
            <div className="sidebar-section convo-section">
              <div className="convo-section-header">
                <p className="section-label" style={{marginBottom: 0}}>conversations</p>
                <button className="new-chat-sidebar-btn" onClick={newChat}>+ new</button>
              </div>
              {loadingConvos && <p className="convo-empty">loading...</p>}
              {!loadingConvos && convos.length === 0 && <p className="convo-empty">no conversations yet</p>}
              <div className="convo-list">
                {convos.map((c) => (
                  <ConvoItem key={c.id} convo={c} active={c.id === activeId} onSelect={selectConvo} onDelete={deleteConvo} onRename={renameConvo} />
                ))}
              </div>
            </div>

            <div className="sidebar-section system-section">
              <button className="section-toggle" onClick={() => setSystemOpen((v) => !v)}>
                system prompt {systemOpen ? "▾" : "▸"}
              </button>
              {systemOpen && (
                <textarea className="system-textarea" placeholder="You are a helpful assistant..." value={system}
                  onChange={(e) => updateConvoMeta("system", e.target.value)} />
              )}
            </div>

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

            <div className="sidebar-section">
              <p className="section-label">display</p>
              <div className="toggle-row">
                <span className="toggle-label">token tags</span>
                <button className={`toggle-btn ${showTokens ? "toggle-on" : "toggle-off"}`} onClick={toggleShowTokens}>
                  {showTokens ? "on" : "off"}
                </button>
              </div>
            </div>

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
            {messages.map((msg, i) => <Message key={i} msg={msg} showTokens={showTokens} />)}
            {streaming && messages[messages.length - 1]?.streaming && <div className="streaming-indicator"><span /><span /><span /></div>}
            <div ref={bottomRef} />
          </div>

          <ChatInput
            input={input}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            streaming={streaming}
            onStop={stopStreaming}
            onSend={sendMessage}
            promptTokens={promptTokens}
            promptTokensLoading={promptTokensLoading}
          />
        </main>
      </div>
    </div>
  );
}