import { useState, useRef, useCallback } from "react";

// ── helpers ───────────────────────────────────────────────────────────────────

function tokenise(text) {
  return text.match(/[\w']+|[^\w']+/g) || [];
}

async function claudeFetch(body) {
  const apiKey = typeof import.meta !== "undefined" && import.meta.env?.VITE_ANTHROPIC_API_KEY;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, max_tokens: 1000 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

async function callClaude(messages, system = "") {
  try {
    const body = { model: "claude-sonnet-4-6", max_tokens: 1000, messages };
    if (system) body.system = system;
    const data = await claudeFetch(body);
    return data.content?.map((b) => b.text || "").join("") || "";
  } catch {
    return "";
  }
}

function localImageryFallback(text) {
  const STOP = new Set([
    "a","an","the","and","or","but","in","on","at","to","for","of","with",
    "by","from","up","about","into","through","during","is","are","was","were",
    "be","been","being","have","has","had","do","does","did","will","would",
    "could","should","may","might","shall","can","need","dare","ought","used",
    "i","you","he","she","it","we","they","me","him","her","us","them",
    "my","your","his","its","our","their","this","that","these","those",
    "what","which","who","whom","whose","when","where","why","how",
    "all","each","every","both","few","more","most","other","some","such",
    "no","not","only","same","so","than","too","very","just","as","if",
    "then","there","here","now","also","still","well","even","back","any",
    "good","new","first","last","long","great","little","own","right","big",
    "high","different","small","large","next","early","young","important",
    "public","private","real","best","free","sure","better","true","enough",
  ]);
  const words = text.match(/[\w']+/g) || [];
  return new Set(
    words.map(w => w.toLowerCase().replace(/[^a-z']/g, "")).filter(w => w.length > 3 && !STOP.has(w))
  );
}

async function fetchImageryWords(text) {
  try {
    const data = await claudeFetch({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system:
        "You are a linguist specialising in memory and imagery. " +
        "When given a passage, return ONLY a JSON array of the high-imagery words — " +
        "concrete nouns and vivid action verbs that evoke a clear mental picture. " +
        "Exclude: articles, prepositions, conjunctions, auxiliary verbs (is/was/have/do), " +
        "pronouns, adjectives, adverbs, and abstract/low-imagery words. " +
        "Return lowercase words exactly as they appear (no punctuation). " +
        "No explanation, no markdown, just the JSON array.",
      messages: [{ role: "user", content: `Passage:\n${text}` }],
    });
    const raw = data.content?.map((b) => b.text || "").join("") || "[]";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      return new Set(parsed.map((w) => w.toLowerCase()));
    }
    throw new Error("Empty");
  } catch {
    return localImageryFallback(text);
  }
}

function pickWordsToRemove(tokens, removedIndices, level, imageryWordSet) {
  const eligible = tokens
    .map((t, i) => (/[\w']+/.test(t) && imageryWordSet.has(t.toLowerCase()) ? i : null))
    .filter((i) => i !== null && !removedIndices.has(i));
  const totalImagery = tokens.filter(
    (t) => /[\w']+/.test(t) && imageryWordSet.has(t.toLowerCase())
  ).length;
  const targetTotal = Math.min(
    Math.round(totalImagery * (0.3 + (level - 1) * 0.25)),
    totalImagery
  );
  const toAdd = Math.max(0, targetTotal - removedIndices.size);
  const picked = new Set(removedIndices);
  if (eligible.length > 0 && toAdd > 0) {
    const step = Math.max(1, Math.floor(eligible.length / toAdd));
    for (let i = 0; i < eligible.length && picked.size - removedIndices.size < toAdd; i += step) {
      picked.add(eligible[i]);
    }
  }
  return picked;
}

// ── component ─────────────────────────────────────────────────────────────────

export default function RecallTrainer() {
  const [screen, setScreen] = useState("upload");
  const [rawText, setRawText] = useState("");
  const [tokens, setTokens] = useState([]);
  const [imageryWords, setImageryWords] = useState(new Set());
  const [analysing, setAnalysing] = useState(false);
  const [removedIndices, setRemovedIndices] = useState(new Set());
  const [level, setLevel] = useState(1);
  const [currentBlankIdx, setCurrentBlankIdx] = useState(null);
  const [blanksOrder, setBlanksOrder] = useState([]);
  const [blanksStatus, setBlanksStatus] = useState({});
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [hint, setHint] = useState("");
  const [hintStage, setHintStage] = useState(0); // 0=none, 1=word/def, 2+=letters
  const [hintUsed, setHintUsed] = useState({});
  const [revealUsed, setRevealUsed] = useState({});
  const [feedback, setFeedback] = useState(null);
  const [scoreData, setScoreData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [roundHistory, setRoundHistory] = useState([]);
  const [micBlocked, setMicBlocked] = useState(false);
  const [useTyping, setUseTyping] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);

  // ── advance to next blank ─────────────────────────────────────────────────

  const advanceBlank = useCallback(() => {
    setFeedback(null);
    setHint("");
    setHintStage(0);
    setTranscript("");
    setBlanksOrder((order) => {
      const next = order.slice(1);
      if (next.length === 0) {
        finishRound();
        return [];
      }
      setCurrentBlankIdx(next[0]);
      return next;
    });
  }, []); // eslint-disable-line

  // ── check answer ──────────────────────────────────────────────────────────

  const checkAnswer = useCallback((spoken) => {
    if (currentBlankIdx === null) return;
    const correct = tokens[currentBlankIdx].toLowerCase().replace(/[^a-z']/g, "");
    const spokenClean = spoken.toLowerCase().replace(/[^a-z']/g, "");
    if (spokenClean === correct) {
      setFeedback({ type: "correct", msg: "✓ Correct!" });
      const updated = { ...blanksStatus, [currentBlankIdx]: "correct" };
      setBlanksStatus(updated);
      setTimeout(() => advanceBlank(), 900);
    } else {
      setFeedback({ type: "wrong", msg: `Heard "${spoken}" — try again` });
    }
  }, [currentBlankIdx, tokens, blanksStatus, advanceBlank]);

  // ── hints (multi-tap) ─────────────────────────────────────────────────────

  const tapHint = async () => {
    if (currentBlankIdx === null || loading) return;
    const word = tokens[currentBlankIdx];
    const nextStage = hintStage + 1;
    setHintStage(nextStage);
    setHintUsed((prev) => ({ ...prev, [currentBlankIdx]: true }));

    if (nextStage === 1) {
      // Stage 1: related word or short definition
      setLoading(true);
      try {
        const body = {
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content:
              `For the word "${word}", give a single closely related word (synonym or strong association). ` +
              `If none exists, give a definition of 8 words or fewer. ` +
              `Do NOT use the word "${word}". Reply with just the word or definition, nothing else.`,
          }]
        };
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setHint(`API error: ${data?.error?.message || res.status}`);
        } else {
          const reply = data.content?.map(b => b.text || "").join("").trim();
          setHint(reply || "(empty response)");
        }
      } catch (e) {
        setHint(`Network error: ${e.message}`);
      }
      setLoading(false);
    } else {
      // Stage 2+: reveal one more letter each tap
      const letters = word.replace(/[^a-zA-Z']/g, "").split("");
      const revealed = nextStage - 1; // how many letters to show
      const display = letters
        .map((l, i) => (i < revealed ? l : "_"))
        .join(" ");
      setHint(`${display}`);
    }
  };

  // ── reveal ────────────────────────────────────────────────────────────────

  const revealWord = () => {
    if (currentBlankIdx === null) return;
    const word = tokens[currentBlankIdx];
    setRevealUsed((prev) => ({ ...prev, [currentBlankIdx]: true }));
    setFeedback({ type: "reveal", msg: `The word is: "${word}"` });
    const updated = { ...blanksStatus, [currentBlankIdx]: "skipped" };
    setBlanksStatus(updated);
    setTimeout(() => advanceBlank(), 1500);
  };

  // ── finish round ──────────────────────────────────────────────────────────

  const finishRound = useCallback(() => {
    setBlanksOrder([]);
    setCurrentBlankIdx(null);
    const total = removedIndices.size;
    const correct = Object.values(blanksStatus).filter((v) => v === "correct").length;
    const hints = Object.keys(hintUsed).length;
    const reveals = Object.keys(revealUsed).length;
    setRoundHistory((h) => [...h, { level, correct, total, hints, reveals }]);
    setScoreData({ level, correct, total, hints, reveals });
    setScreen("score");
  }, [blanksStatus, removedIndices, level, hintUsed, revealUsed]);

  // ── start game ────────────────────────────────────────────────────────────

  const startGame = async () => {
    setAnalysing(true);
    const t = tokenise(rawText);
    setTokens(t);
    setLevel(1);
    setRoundHistory([]);
    const iw = await fetchImageryWords(rawText);
    setImageryWords(iw);
    setAnalysing(false);
    beginLevel(t, new Set(), 1, iw);
    setScreen("game");
  };

  const beginLevel = (t, existingRemoved, lvl, iw) => {
    const iwSet = iw || imageryWords;
    const newRemoved = pickWordsToRemove(t, existingRemoved, lvl, iwSet);
    setRemovedIndices(newRemoved);
    setLevel(lvl);
    setHintUsed({});
    setRevealUsed({});
    setFeedback(null);
    setHint("");
    setHintStage(0);
    setTranscript("");
    const wordIdxs = [...newRemoved].sort((a, b) => a - b);
    const initialStatus = {};
    wordIdxs.forEach((i) => (initialStatus[i] = "pending"));
    setBlanksStatus(initialStatus);
    setBlanksOrder(wordIdxs);
    if (wordIdxs.length > 0) setCurrentBlankIdx(wordIdxs[0]);
  };

  const nextLevel = () => {
    setScreen("game");
    setScoreData(null);
    beginLevel(tokens, removedIndices, level + 1, imageryWords);
  };

  const restart = () => {
    setRawText("");
    setTokens([]);
    setRemovedIndices(new Set());
    setLevel(1);
    setRoundHistory([]);
    setScreen("upload");
  };

  // ── audio recording ───────────────────────────────────────────────────────

  const transcribeAudio = useCallback(async (audioBlob) => {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    const base64Audio = btoa(binary);
    try {
      const data = await claudeFetch({
        model: "claude-sonnet-4-6",
        max_tokens: 50,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "This is a voice recording of someone saying a single English word or short phrase. Transcribe ONLY what was spoken — return just the word(s), lowercase, no punctuation, no explanation." },
            { type: "document", source: { type: "base64", media_type: audioBlob.type || "audio/webm", data: base64Audio } }
          ]
        }]
      }, 15000);
      return data.content?.map(b => b.text || "").join("").trim().toLowerCase() || "";
    } catch {
      return "";
    }
  }, []);

  const startListening = useCallback(async () => {
    setListening(true);
    setTranscript("");
    setFeedback(null);
    setHint("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"].find(m => MediaRecorder.isTypeSupported(m)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
        setListening(false);
        setTranscript("Transcribing…");
        const spoken = await transcribeAudio(blob);
        if (spoken) {
          setTranscript(spoken);
          checkAnswer(spoken);
        } else {
          setTranscript("");
          setFeedback({ type: "wrong", msg: "Couldn't hear that — tap again to try" });
        }
      };
      recorder.start();
      setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 4000);
    } catch {
      setListening(false);
      setMicBlocked(true);
    }
  }, [transcribeAudio, checkAnswer]);

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  }, []);

  // ── render passage ────────────────────────────────────────────────────────

  const renderPassage = () => tokens.map((token, i) => {
    if (removedIndices.has(i) && /[\w']+/.test(token)) {
      const status = blanksStatus[i] || "pending";
      const isCurrent = i === currentBlankIdx;
      return (
        <span key={i} style={{
          display: "inline",
          borderBottom: "2px solid",
          borderColor: status === "correct" ? "#4CAF82" : status === "skipped" ? "#888" : isCurrent ? "#F5A623" : "#3A3F52",
          paddingBottom: "1px",
          margin: "0 1px",
          backgroundColor: status === "correct" ? "rgba(76,207,130,0.08)" : status === "skipped" ? "rgba(136,136,136,0.08)" : isCurrent ? "rgba(245,166,35,0.12)" : "transparent",
          animation: isCurrent ? "pulse 1.8s ease-in-out infinite" : "none",
          minWidth: (status === "correct" || status === "skipped") ? undefined : `${Math.max(token.length * 0.65, 2)}ch`,
          color: status === "correct" ? "#4CAF82" : status === "skipped" ? "#888" : "transparent",
          fontStyle: status === "skipped" ? "italic" : "normal",
        }}>
          {(status === "correct" || status === "skipped") ? token : "\u00A0".repeat(Math.max(token.length, 2))}
        </span>
      );
    }
    return <span key={i} style={{ color: "#F2E8D5" }}>{token}</span>;
  });

  // ── screens ───────────────────────────────────────────────────────────────

  if (screen === "upload") return (
    <div style={S.root}>
      <style>{css}</style>
      <div style={S.uploadCard}>
        <div style={S.logo}>◎ Recall</div>
        <p style={S.tagline}>Memorise anything. Word by word.</p>
        <textarea ref={textareaRef} style={S.textarea} placeholder="Paste the passage you want to memorise…"
          value={rawText} onChange={(e) => setRawText(e.target.value)} rows={8} />
        <p style={S.charCount}>{rawText.trim().split(/\s+/).filter(Boolean).length} words</p>
        <button style={{ ...S.btn, ...S.btnPrimary, opacity: rawText.trim().length < 10 || analysing ? 0.4 : 1 }}
          disabled={rawText.trim().length < 10 || analysing} onClick={startGame}>
          {analysing ? "✦ Analysing passage…" : "Begin Training →"}
        </button>
      </div>
    </div>
  );

  if (screen === "score") {
    const { correct, total, hints, reveals } = scoreData;
    const pct = Math.round((correct / total) * 100);
    const allDone = [...removedIndices].length >= tokens.filter(t => /[\w']+/.test(t) && imageryWords.has(t.toLowerCase())).length;
    return (
      <div style={S.root}>
        <style>{css}</style>
        <div style={S.scoreCard}>
          <div style={S.logo}>◎ Recall</div>
          <div style={S.levelBadge}>Level {level} complete</div>
          <div style={S.bigScore}>{pct}%</div>
          <p style={S.scoreLabel}>{correct} of {total} words recalled</p>
          <div style={S.statRow}>
            <span>💡 {hints} hint{hints !== 1 ? "s" : ""}</span>
            <span>👁 {reveals} reveal{reveals !== 1 ? "s" : ""}</span>
          </div>
          {roundHistory.length > 1 && (
            <div style={S.history}>
              {roundHistory.map((r, i) => (
                <div key={i} style={S.historyRow}>
                  <span style={{ color: "#888" }}>L{r.level}</span>
                  <span>{r.correct}/{r.total}</span>
                  <div style={S.histBar}><div style={{ ...S.histFill, width: `${Math.round((r.correct / r.total) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
          {allDone ? (
            <div>
              <p style={{ color: "#4CAF82", textAlign: "center", marginBottom: 16 }}>🎉 Full recall achieved!</p>
              <button style={{ ...S.btn, ...S.btnPrimary }} onClick={restart}>Train a new passage</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
              <button style={{ ...S.btn, ...S.btnPrimary }} onClick={nextLevel}>Next level — more gaps →</button>
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={restart}>Start over</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const totalBlanks = removedIndices.size;
  const done = totalBlanks - blanksOrder.length;

  return (
    <div style={S.root}>
      <style>{css}</style>

      {micBlocked && (
        <div style={S.modalOverlay}>
          <div style={S.modalCard}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🎙</div>
            <h2 style={S.modalTitle}>Microphone blocked</h2>
            <p style={S.modalBody}>Safari caches permissions — update Settings <em>then reload this page</em>.</p>
            <ol style={S.modalSteps}>
              <li>Open <strong style={{ color: "#F2E8D5" }}>Settings</strong> on your iPhone</li>
              <li>Tap <strong style={{ color: "#F2E8D5" }}>Apps → Safari → Microphone</strong></li>
              <li>Select <strong style={{ color: "#F5A623" }}>Allow</strong></li>
              <li><strong style={{ color: "#F5A623" }}>Reload this page</strong></li>
            </ol>
            <p style={{ ...S.modalBody, marginBottom: 16 }}>Or type your answers instead:</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
              <button style={{ ...S.btn, ...S.btnPrimary }} onClick={() => { setMicBlocked(false); setUseTyping(true); }}>⌨️ Switch to typing</button>
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setMicBlocked(false)}>Try mic again</button>
            </div>
          </div>
        </div>
      )}

      <div style={S.gameHeader}>
        <div style={S.logo}>◎ Recall</div>
        <div style={S.levelBadge}>Level {level}</div>
        <div style={S.progress}><div style={{ ...S.progressFill, width: `${totalBlanks > 0 ? (done / totalBlanks) * 100 : 0}%` }} /></div>
        <span style={{ color: "#888", fontSize: 12 }}>{done}/{totalBlanks}</span>
      </div>

      <div style={S.passageWrap}>
        <p style={S.passage}>{renderPassage()}</p>
      </div>

      {currentBlankIdx !== null && (
        <div style={S.controls}>
          {feedback && (
            <div style={{
              ...S.feedbackBox,
              background: feedback.type === "correct" ? "rgba(76,207,130,0.15)" : feedback.type === "reveal" ? "rgba(100,100,255,0.15)" : "rgba(255,100,100,0.12)",
              borderColor: feedback.type === "correct" ? "#4CAF82" : feedback.type === "reveal" ? "#7B8FF5" : "#F56060",
              color: feedback.type === "correct" ? "#4CAF82" : feedback.type === "reveal" ? "#aab" : "#F56060",
            }}>{feedback.msg}</div>
          )}

          {hint && (
            <div style={S.hintBox}>
              <span style={{ opacity: 0.6, fontSize: 11, fontFamily: "system-ui, sans-serif", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                {hintStage === 1 ? "Related word" : `Letters (${hintStage - 1} of ${tokens[currentBlankIdx]?.replace(/[^a-zA-Z']/g,"").length})`}
              </span>
              <span style={{ fontFamily: hintStage > 1 ? "monospace" : "inherit", fontSize: hintStage > 1 ? 22 : 14, letterSpacing: hintStage > 1 ? "0.2em" : "normal" }}>
                {hint}
              </span>
            </div>
          )}

          {transcript && transcript !== "Transcribing…" && !feedback && (
            <div style={S.transcriptBox}>Heard: "{transcript}"</div>
          )}
          {transcript === "Transcribing…" && (
            <div style={{ ...S.transcriptBox, color: "#F5A623" }}>✦ Transcribing…</div>
          )}

          <button style={{ ...S.btn, ...S.btnSpeak, ...(listening ? S.btnListening : {}) }}
            onClick={listening ? stopListening : startListening}
            disabled={transcript === "Transcribing…" || useTyping}>
            {transcript === "Transcribing…" ? "✦ Transcribing…" : listening ? "⏹ Tap to stop" : "🎙 Speak the word"}
          </button>

          {useTyping && (
            <div style={{ display: "flex", gap: 8 }}>
              <input style={S.typeInput} type="text" placeholder="Type the missing word…"
                value={typedAnswer} onChange={e => setTypedAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && typedAnswer.trim()) { const a = typedAnswer.trim(); setTypedAnswer(""); checkAnswer(a); } }}
                autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <button style={{ ...S.btn, ...S.btnPrimary, width: "auto", padding: "0 20px" }}
                onClick={() => { if (typedAnswer.trim()) { const a = typedAnswer.trim(); setTypedAnswer(""); checkAnswer(a); } }}>↵</button>
            </div>
          )}

          <div style={S.secondaryBtns}>
            <button style={{ ...S.btn, ...S.btnGhost }} onClick={revealWord} disabled={listening}>👁 Reveal</button>
            <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => { setUseTyping(t => !t); setTypedAnswer(""); }}>{useTyping ? "🎙" : "⌨️"}</button>
          </div>
        </div>
      )}

      {/* Floating Hints button */}
      {currentBlankIdx !== null && (
        <button style={S.floatingHint} onClick={tapHint} disabled={loading}>
          {loading ? "…" : hintStage === 0 ? "Hints" : hintStage === 1 ? "Letter?" : `+1 letter`}
        </button>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const S = {
  root: { minHeight: "100vh", background: "#0F1117", color: "#F2E8D5", fontFamily: "'Georgia', serif", display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px 48px" },
  logo: { fontFamily: "system-ui, sans-serif", fontSize: 13, letterSpacing: "0.18em", color: "#F5A623", textTransform: "uppercase", marginBottom: 8 },
  tagline: { color: "#888", fontSize: 14, fontFamily: "system-ui, sans-serif", marginBottom: 28, textAlign: "center" },
  uploadCard: { width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 48 },
  textarea: { width: "100%", background: "#181C27", border: "1px solid #2A2F40", borderRadius: 8, color: "#F2E8D5", fontFamily: "'Georgia', serif", fontSize: 16, lineHeight: 1.7, padding: "16px", resize: "vertical", outline: "none", boxSizing: "border-box" },
  charCount: { color: "#555", fontSize: 12, alignSelf: "flex-end", fontFamily: "system-ui, sans-serif", marginBottom: 20 },
  btn: { border: "none", borderRadius: 8, padding: "14px 24px", fontSize: 15, cursor: "pointer", fontFamily: "system-ui, sans-serif", fontWeight: 500, transition: "opacity 0.15s", width: "100%" },
  btnPrimary: { background: "#F5A623", color: "#0F1117" },
  btnSpeak: { background: "#1E2436", color: "#F2E8D5", border: "1px solid #F5A623", fontSize: 16 },
  btnListening: { background: "rgba(245,166,35,0.15)", borderColor: "#F5A623", color: "#F5A623" },
  btnGhost: { background: "transparent", color: "#888", border: "1px solid #2A2F40", padding: "10px 12px", fontSize: 13 },
  gameHeader: { width: "100%", maxWidth: 680, display: "flex", alignItems: "center", gap: 12, marginBottom: 24 },
  levelBadge: { fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.12em", color: "#F5A623", background: "rgba(245,166,35,0.12)", borderRadius: 20, padding: "3px 10px" },
  progress: { flex: 1, height: 3, background: "#1E2436", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", background: "#F5A623", borderRadius: 2, transition: "width 0.4s ease" },
  passageWrap: { width: "100%", maxWidth: 680, background: "#181C27", border: "1px solid #1E2436", borderRadius: 12, padding: "28px", marginBottom: 24 },
  passage: { fontSize: 19, lineHeight: 2, margin: 0, letterSpacing: "0.01em" },
  controls: { width: "100%", maxWidth: 680, display: "flex", flexDirection: "column", gap: 12 },
  feedbackBox: { padding: "12px 16px", borderRadius: 8, border: "1px solid", fontFamily: "system-ui, sans-serif", fontSize: 14, textAlign: "center" },
  hintBox: { padding: "12px 16px", borderRadius: 8, background: "rgba(245,166,35,0.08)", border: "1px solid rgba(245,166,35,0.2)", color: "#F5A623", fontFamily: "system-ui, sans-serif", fontSize: 14 },
  floatingHint: { position: "fixed", bottom: 28, right: 24, background: "#1E2436", border: "1px solid #3A3F52", borderRadius: 24, color: "#F2E8D5", fontFamily: "system-ui, sans-serif", fontWeight: 600, fontSize: 14, padding: "12px 20px", cursor: "pointer", zIndex: 50, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", letterSpacing: "0.03em", transition: "background 0.15s, border-color 0.15s" },
  transcriptBox: { padding: "10px 16px", borderRadius: 8, background: "#1E2436", color: "#888", fontFamily: "system-ui, sans-serif", fontSize: 13, textAlign: "center" },
  secondaryBtns: { display: "flex", gap: 8 },
  scoreCard: { width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 48, gap: 16 },
  bigScore: { fontSize: 72, fontWeight: 700, color: "#F5A623", lineHeight: 1 },
  scoreLabel: { color: "#888", fontFamily: "system-ui, sans-serif", fontSize: 14, margin: 0 },
  statRow: { display: "flex", gap: 24, fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#555" },
  history: { width: "100%", display: "flex", flexDirection: "column", gap: 8, fontFamily: "system-ui, sans-serif", fontSize: 13, marginBottom: 8 },
  historyRow: { display: "flex", alignItems: "center", gap: 12, color: "#F2E8D5" },
  histBar: { flex: 1, height: 4, background: "#1E2436", borderRadius: 2, overflow: "hidden" },
  histFill: { height: "100%", background: "#F5A623", borderRadius: 2 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(10,12,18,0.92)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24 },
  modalCard: { background: "#181C27", border: "1px solid #2A2F40", borderRadius: 16, padding: "32px 24px", maxWidth: 380, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" },
  modalTitle: { fontFamily: "system-ui, sans-serif", fontSize: 20, fontWeight: 600, color: "#F2E8D5", margin: "0 0 12px" },
  modalBody: { fontFamily: "system-ui, sans-serif", fontSize: 14, color: "#888", margin: "0 0 20px", lineHeight: 1.6 },
  modalSteps: { fontFamily: "system-ui, sans-serif", fontSize: 14, color: "#888", textAlign: "left", lineHeight: 2, paddingLeft: 20, margin: "0 0 16px", width: "100%" },
  typeInput: { flex: 1, background: "#181C27", border: "1px solid #F5A623", borderRadius: 8, color: "#F2E8D5", fontFamily: "'Georgia', serif", fontSize: 16, padding: "12px 14px", outline: "none" },
};

const css = `
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button:not(:disabled):hover { opacity: 0.85; }
  textarea:focus { border-color: #F5A623 !important; }
  * { box-sizing: border-box; }
`;
