// App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import wordsCsv from "./words.csv?raw"; // CSV: A=No. / B=英単語 / C=日本語 / D=Unit
// ★ 認証用：生徒番号CSV（B列の2行目以降）
import studentsNumbersCsv from "./students.number.csv?raw";

// ========= 設定 =========
const QUESTION_COUNT = 20;
const TOTAL_TIME_SEC_DEFAULT = 300; // 全体5分
const USE_TOTAL_TIMER = true;
const SKIP_HEADER = false;                 // CSV 先頭にヘッダーがあるなら true
const TARGET_SHEET_NAME = "英単語ログ";
const MODE_FIXED = "日本語→英単語";
const APP_NAME = import.meta.env.VITE_APP_NAME;

// 手入力補助用の候補（入力は自由。これ以外でもOK）
const SUGGEST_UNITS = [
  "Unit１","Unit２","Unit３","Unit４","Unit５","Unit６","Unit７","Unit８"
];

// ========= ユーティリティ =========
function canonLevelLabel(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKC")    // 全角→半角など互換正規化
    .toLowerCase()        // 大小無視
    .replace(/\s+/g, "")  // 空白無視
    .replace(/[-_]/g, "");// ハイフン/アンダースコア無視
}

function parseCsvRaw(csvText) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < csvText.length) {
    const c = csvText[i];
    if (inQuotes) {
      if (c === '"') {
        if (csvText[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") pushField();
      else if (c === "\n" || c === "\r") {
        if (field !== "" || row.length > 0) pushField();
        if (row.length) pushRow();
        if (c === "\r" && csvText[i + 1] === "\n") i++;
      } else field += c;
    }
    i++;
  }
  if (field !== "" || row.length > 0) { pushField(); pushRow(); }
  return rows;
}

function trimSpaces(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function normalizeEn(s) { return trimSpaces(s).toLowerCase(); }

function splitAnswerCandidates(s) {
  if (!s) return [];
  const DELIMS = /[\/／,、;|]/g;
  return s.split(DELIMS).map(part => normalizeEn(part)).filter(Boolean);
}

function judgeAnswerJPtoEN(user, item) {
  const userNorm = normalizeEn(user);
  const candidates = splitAnswerCandidates(item.en); // 例: "color/colour" → ["color","colour"]
  return candidates.includes(userNorm);
}

function sampleUnique(arr, k) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// ========= メインコンポーネント =========
function App() {
  // ★ 認証関連 state
  const [authIds, setAuthIds] = useState(new Set());
  const [studentNumber, setStudentNumber] = useState("");
  const [authLoaded, setAuthLoaded] = useState(false);

  // 送信UI
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sent, setSent] = useState(false);

  // 手入力ユニット
  const [difficulty, setDifficulty] = useState(""); // 完全手入力

  // グローバル state
  const [name, setName] = useState("");
  const [allItems, setAllItems] = useState([]);
  const [items, setItems] = useState([]);
  const [answers, setAnswers] = useState([]);
  // ★ 初期ステップを「auth」に変更
  const [step, setStep] = useState("auth"); // auth | start | quiz | result
  const [qIndex, setQIndex] = useState(0);

  // 入力欄
  const [value, setValue] = useState("");

  // timers
  const [totalLeft, setTotalLeft] = useState(TOTAL_TIME_SEC_DEFAULT);
  const totalTimerRef = useRef(null);
  const totalPausedRef = useRef(false); // ★全体タイマー一時停止フラグ

  // ★ 生徒番号CSVの読み込み（B列の2行目以降を有効IDに）
  useEffect(() => {
    try {
      const rows = parseCsvRaw(studentsNumbersCsv);
      // 2行目以降のB列（index=1）
      const ids = new Set(
        rows.slice(1).map(r => String(r[1] ?? "").trim()).filter(Boolean)
      );
      setAuthIds(ids);
    } catch (e) {
      console.error("students.number.csv の読み込み/解析に失敗:", e);
      setAuthIds(new Set()); // 全NG
    } finally {
      setAuthLoaded(true);
    }
  }, []);

  // CSV読み込み（No./英単語/日本語/Unit）
  useEffect(() => {
    let rows = parseCsvRaw(wordsCsv);
    if (!rows || !rows.length) {
      setAllItems([]);
      return;
    }

    // ヘッダー除去（1行目に "No.,英単語,日本語,Unit" がある前提）
    const header = rows[0].map(String);
    const looksHeader =
      /No|番号/i.test(header[0] ?? "") ||
      /英単語|english|word/i.test(header[1] ?? "") ||
      /日本語|意味|meaning/i.test(header[2] ?? "") ||
      /Unit|レベル|level|難易度/i.test(header[3] ?? "");
    if (SKIP_HEADER || looksHeader) rows = rows.slice(1);

    // 出題用データ（B:英単語, C:日本語, D:Unit）
    const mapped = rows
      .filter(r => r.length >= 4 && r[1] && r[2]) // 英/日がある行のみ
      .map(r => ({
        no: String(r[0] ?? "").trim(),
        en: String(r[1] ?? "").trim(),   // 英単語（解答）
        jp: String(r[2] ?? "").trim(),   // 日本語（問題）
        level: String(r[3] ?? "").trim() // Unit（難易度）
      }));
    setAllItems(mapped);
  }, []);

  // ✅ 手入力ユニットでプールを切替（レベル列がある場合は厳密一致：表記ゆれは正規化で吸収）
  const pool = useMemo(() => {
    if (!allItems.length) return [];
    if (!difficulty.trim()) return [];
    const same = (a, b) => canonLevelLabel(a) === canonLevelLabel(b);

    const hasLevelCol = allItems.some(it => String(it.level || "").trim().length > 0);
    if (hasLevelCol) {
      return allItems.filter(it => same(it.level, difficulty));
    }

    // 万一レベル列が無いCSVのときは、手入力でも全件（必要なら任意で変えてOK）
    return allItems;
  }, [allItems, difficulty]);

  // 開始可能条件
  const canStart = useMemo(() => {
    return pool.length >= 1 && name.trim().length > 0 && difficulty.trim().length > 0;
  }, [pool.length, name, difficulty]);

  // qIndex 変更時/quiz開始時に入力欄リセット
  useEffect(() => { if (step === "quiz") setValue(""); }, [qIndex, step]);

  // アンマウント時タイマー停止
  useEffect(() => () => { if (totalTimerRef.current) clearInterval(totalTimerRef.current); }, []);

  function startQuiz() {
  // ✅ 再受験時に送信状態だけリセット（名前・ユニットは触らない）
  setSent(false);
  setSending(false);
  setProgress(0);

  const quizSet = sampleUnique(pool, Math.min(QUESTION_COUNT, pool.length));
  setItems(quizSet);
  setAnswers([]);
  setQIndex(0);
  setStep("quiz");

  if (USE_TOTAL_TIMER) {
    setTotalLeft(TOTAL_TIME_SEC_DEFAULT);
    if (totalTimerRef.current) clearInterval(totalTimerRef.current);
    totalTimerRef.current = setInterval(() => {
      setTotalLeft((t) => {
        if (totalPausedRef.current) return t; // ★レビュー中は停止
        if (t <= 1) {
          clearInterval(totalTimerRef.current);
          finishQuiz();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }
}


  const [showReview, setShowReview] = useState({ visible: false, record: null });

  function submitAnswer(userInput) {
    const item = items[qIndex];
    if (!item) return;

    const ok = judgeAnswerJPtoEN(userInput, item);
    const record = { qIndex, q: item.jp, a: userInput, correct: item.en, ok };
    setAnswers((prev) => [...prev, record]);
    setShowReview({ visible: true, record });
    if (USE_TOTAL_TIMER) totalPausedRef.current = true;
  }

  function nextQuestion() {
    if (qIndex + 1 >= items.length) {
      finishQuiz();
      return;
    }
    setQIndex(qIndex + 1);
  }

  function finishQuiz() {
    if (totalTimerRef.current) clearInterval(totalTimerRef.current);
    setStep("result");
  }

  // ---- 結果送信（別シートへ追記）----
  async function sendResult() {
    const url = import.meta.env.VITE_GAS_URL;
    if (!url) throw new Error("VITE_GAS_URL is empty");

    const payload = {
      subject: APP_NAME,
      timestamp: new Date().toISOString(),
      user_name: name,
      mode: MODE_FIXED,
      difficulty, // 手入力ユニット名をそのまま送る
      score: answers.filter((a) => a && a.ok).length,
      duration_sec: USE_TOTAL_TIMER ? (TOTAL_TIME_SEC_DEFAULT - totalLeft) : null,
      question_set_id: `auto-${Date.now()}`,
      questions: items.map((it) => ({ en: it.en, jp: it.jp, level: it.level })),
      answers,
      device_info: navigator.userAgent,
      targetSheet: TARGET_SHEET_NAME,
    };

    const body = new URLSearchParams({ payload: JSON.stringify(payload) });

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      mode: "no-cors",
      keepalive: true,
    });
  }

  // ★ 認証チェック
  function tryAuth() {
    const id = String(studentNumber).trim();
    if (!id) return;
    if (authIds.has(id)) {
      setStep("start"); // 認証成功 → 元のスタート画面へ
    } else {
      alert("利用ライセンスがありません。");
      // そのまま認証画面に留まる
    }
  }

  // ---- 画面描画 ----
  let content = null;

  // ★ 認証画面（最初に表示）
  if (step === "auth") {
    content = (
      <div style={wrapStyle}>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>利用認証</h1>
        <p style={{ opacity: 0.8, marginBottom: 16 }}>生徒番号を入力してください。</p>

        {!authLoaded ? (
          <div style={{ fontSize: 16, opacity: 0.8 }}>読み込み中…</div>
        ) : (
          <>
            <label style={labelStyle}>生徒番号</label>
            <input
              style={inputStyle}
              placeholder="例：20230001"
              value={studentNumber}
              onChange={(e) => setStudentNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") tryAuth(); }}
              autoFocus
            />
            <button style={primaryBtnStyle} onClick={tryAuth}>
              認証する
            </button>
          </>
        )}
      </div>
    );
  } else if (step === "start") {
    content = (
      <div style={wrapStyle}>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>大手前　ユメタン英単語</h1>
        <p style={{ opacity: 0.8, marginBottom: 16 }}>名前とユニットを入力してスタート</p>

        <label style={labelStyle}>あなたの名前</label>
        <input
          style={inputStyle}
          placeholder="例：ネッツ　太郎"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {/* ✅ ユニット名は手入力（候補はUnit1〜Unit8を表示） */}
        <label style={labelStyle}>ユニット名を入力（例: Unit3）</label>
        <input
          list="unit-suggestions"
          style={inputStyle}
          placeholder="Unit3"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
        />
        <datalist id="unit-suggestions">
          {SUGGEST_UNITS.map(opt => <option key={opt} value={opt} />)}
        </datalist>

        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {difficulty.trim()
            ? (pool.length ? `選択中の出題範囲：${pool.length}件` : "該当なし（ユニット名・CSVを確認）")
            : "ユニット名を入力してください"}
        </div>

        <button
          style={{ ...primaryBtnStyle, marginTop: 16 }}
          onClick={startQuiz}
          disabled={!canStart}
        >
          スタート（{QUESTION_COUNT}問）
        </button>
      </div>
    );
  } else if (step === "quiz") {
    const it = items[qIndex];

    if (!it) {
      content = (
        <div style={wrapStyle}>
          <div style={{ fontSize: 16, opacity: 0.8 }}>読み込み中...</div>
        </div>
      );
    } else {
      content = (
        <QuizFrame
          index={qIndex}
          total={items.length}
          display={it.jp}
          totalLeft={USE_TOTAL_TIMER ? totalLeft : null}
          value={value}
          setValue={setValue}
          onSubmit={() => submitAnswer(value)}
          showReview={showReview}
          onCloseReview={() => {
            setShowReview({ visible: false, record: null });
            if (USE_TOTAL_TIMER) totalPausedRef.current = false; // レビュー終了で再開
            nextQuestion();
          }}
        />
      );
    }
  } else if (step === "result") {
    const score = answers.filter((a) => a && a.ok).length;

    async function handleSend() {
      setSending(true);
      setProgress(0);

      const fake = setInterval(() => {
        setProgress((p) => {
          if (p >= 100) {
            clearInterval(fake);
            setSent(true);
            setSending(false);
            return 100;
          }
          return p + 10;
        });
      }, 200);

      try {
        await sendResult();
      } catch (e) {
        console.error(e);
        alert("送信に失敗しました。VITE_GAS_URL と GAS の公開設定を確認してください。");
      }
    }

    const wrongOnly = answers.filter((a) => a && !a.ok);
    const handleRetryWrong = () => {
      const wrongItems = items.filter((_, i) => answers[i] && !answers[i].ok);
      if (wrongItems.length === 0) {
        alert("復習対象の問題がありません。");
        return;
      }
      const next = sampleUnique(wrongItems, Math.min(QUESTION_COUNT, wrongItems.length));
      setItems(next);
      setAnswers([]);
      setQIndex(0);
      setStep("quiz");
    };

    content = (
      <div style={wrapStyle}>
        <h2 style={{ fontSize: 24, marginBottom: 8 }}>結果</h2>
        <div style={{ marginBottom: 8 }}>
          名前：<b>{name}</b> ／ 形式：{MODE_FIXED} ／ 難易度：{difficulty || "-" }
        </div>
        <div style={{ fontSize: 20, marginBottom: 16 }}>
          得点：{score} / {answers.length}
        </div>

        <div
          style={{
            maxHeight: 300,
            overflow: "auto",
            width: "100%",
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 12,
            background: "#fafafa",
            textAlign: "left",
            color: "#111",
            marginInline: "auto",
            boxSizing: "border-box"
          }}
        >
          {answers.map((r, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
                padding: "6px 0",
                borderBottom: "1px solid #f0f0f0",
              }}
            >
              <div>問題：{r?.q ?? "-"}</div>
              <div>あなた：{r?.a || "（無回答）"}</div>
              <div>
                模範解答：<b>{r?.correct ?? "-"}</b> {r?.ok ? "✅" : "❌"}
              </div>
            </div>
          ))}
        </div>

        {!sent && !sending && (
          <button style={primaryBtnStyle} onClick={handleSend}>
            結果を送信（{TARGET_SHEET_NAME}）
          </button>
        )}

        {sending && (
          <div style={{ marginTop: 12, width: "80%" }}>
            <div
              style={{
                height: 10,
                background: "#eee",
                borderRadius: 5,
                overflow: "hidden",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: "100%",
                  background: "#111",
                  transition: "width 0.2s linear",
                }}
              />
            </div>
            <div>{progress}% 送信中...</div>
          </div>
        )}

        {sent && (
          <>
            <div style={{ marginTop: 16, fontWeight: "bold" }}>✅ 送信完了！</div>
            <div
              style={{
                display: "flex",
                gap: 12,
                marginTop: 16,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <button
              style={primaryBtnStyle}
                onClick={() => {
                      // ✅ 送信状態・進行だけリセット（名前・ユニットは保持）
                      setSent(false);
                      setSending(false);
                      setProgress(0);
                      setAnswers([]);
                      setItems([]);
                      setQIndex(0);
                      if (USE_TOTAL_TIMER && totalTimerRef.current) clearInterval(totalTimerRef.current);
                      totalPausedRef.current = false;         
                      // ❌ setName("") や setDifficulty("") は呼ばない（＝保持）
                      setStep("start");
                      }}
                    >
                      ホームへ戻る
                    </button>

              {wrongOnly.length > 0 && (
                <button style={primaryBtnStyle} onClick={handleRetryWrong}>
                  間違えた問題を復習
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return <>{content}</>;
}

// ========= 小さめ部品 =========
function QuizFrame({
  index, total, display, totalLeft,
  value, setValue, onSubmit, showReview, onCloseReview,
}) {
  const [practice, setPractice] = useState("");
  const [practiceMsg, setPracticeMsg] = useState("");

  const disabled = showReview.visible;

  const handlePracticeSubmit = () => {
    const user = normalizeEn(practice);
    const cands = splitAnswerCandidates(showReview.record.correct);
    if (cands.includes(user)) {
      setPracticeMsg("");
      setPractice("");
      onCloseReview();
    } else {
      setPracticeMsg("不正解。もう一度入力してみよう。");
    }
  };

  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", width: "100%", marginBottom: 8 }}>
        <div>Q {index + 1} / {total}</div>
        <div style={{ display: "flex", gap: 12 }}>
          {totalLeft != null && <Timer label="全体" sec={totalLeft} />}
        </div>
      </div>

      <div style={questionBoxStyle}>
        <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 6, color: "#555" }}>問題</div>
        <div style={{ fontSize: 22, color: "#111" }}>{display}</div>
      </div>

      <label style={labelStyle}>英単語を入力</label>
      <input
        style={{ ...inputStyle, width: "92%", margin: "0 auto" }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !showReview.visible) onSubmit(); }}
        placeholder="example: run"
      />
      <button
        style={{ ...primaryBtnStyle, opacity: showReview.visible ? 0.6 : 1, cursor: showReview.visible ? "not-allowed" : "pointer" }}
        onClick={() => { if (!showReview.visible) onSubmit(); }}
        disabled={disabled}
      >
        答え合わせ
      </button>

      {showReview.visible && (
        <div style={reviewStyle}>
          <div style={{ fontWeight: "bold", marginBottom: 8 }}>答え合わせ</div>
          <div>問題：{showReview.record.q}</div>
          <div>あなた：{showReview.record.a || "（無回答）"}</div>
          <div style={{ marginBottom: 8 }}>
            模範解答：<b>{showReview.record.correct}</b>{" "}
            {showReview.record.ok ? "✅ 正解" : "❌ 不正解"}
          </div>

          {showReview.record.ok ? (
            <button style={{ ...primaryBtnStyle, marginTop: 8 }} onClick={onCloseReview}>
              次の問題へ
            </button>
          ) : (
            <>
              <div style={{ textAlign: "left", margin: "8px 0 6px", color: "#333" }}>
                ① 正しい単語を入力（練習用・成績には反映しません）
              </div>
              <input
                style={{
                  ...inputStyle,
                  width: "100%",
                  maxWidth: "500px",
                  margin: "0 auto",
                  display: "block",
                  boxSizing: "border-box"
                }}
                value={practice}
                onChange={(e) => setPractice(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handlePracticeSubmit(); }}
                placeholder="模範解答を見ながら正しく入力"
              />

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                <button style={primaryBtnStyle} onClick={handlePracticeSubmit}>
                  回答する（練習）
                </button>
                <button style={{ ...primaryBtnStyle, background: "#555" }} onClick={onCloseReview}>
                  ② 次の問題に進む
                </button>
              </div>
              {practiceMsg && (
                <div style={{ marginTop: 8, color: "#b00020", fontWeight: "bold" }}>
                  {practiceMsg}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Timer({ label, sec }) {
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return <div style={{ fontFamily: "ui-monospace, monospace" }}>{label}:{mm}:{ss}</div>;
}

// ========= スタイル =========
const wrapStyle = {
  width: "min(680px, 92vw)",
  margin: "0 auto",
  padding: "24px 16px",
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  textAlign: "center",
  gap: 12,
  boxSizing: "border-box",
};
const labelStyle = { alignSelf: "center", fontSize: 14, marginTop: 8, color: "#333" };
const inputStyle = {
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  border: "1px solid #ddd",
  borderRadius: 12,
  background: "#fff",
  color: "#111",
};
const primaryBtnStyle = {
  marginTop: 12,
  padding: "12px 18px",
  borderRadius: 12,
  border: "none",
  background: "#111",
  color: "#fff",
  fontSize: 16,
  cursor: "pointer",
};
const questionBoxStyle = {
  width: "100%",
  background: "#f7f7f7",
  border: "1px solid #ddd",
  borderRadius: 16,
  padding: 14,
  boxShadow: "0 2px 6px rgba(0,0,0,.05)",
  color: "#111",
};
const reviewStyle = {
  width: "100%",
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 16,
  padding: 14,
  boxSizing: "border-box",
  marginTop: 12,
  boxShadow: "0 2px 10px rgba(0,0,0,.04)",
  color: "#111",
};
const chipStyle = {
  padding: "8px 14px",
  borderRadius: 999,
  border: "1px solid #ddd",
  background: "#f3f3f3",
  cursor: "pointer",
  fontSize: 14,
};

// ✅ default export はファイル末尾に1回だけ
export default App;
