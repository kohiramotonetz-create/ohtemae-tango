import React, { useEffect, useMemo, useRef, useState } from "react";
import wordsCsv from "./words.csv?raw"; // CSV: A=No. / B=問題 / C=解答（複数は "/" 区切り推奨）/ D=レベル(例: Unit1/Unit2)

// ========= 設定 =========
const QUESTION_COUNT = 20;
const TOTAL_TIME_SEC_DEFAULT = 300; // 全体5分
const USE_TOTAL_TIMER = true;
const SKIP_HEADER = false;                 // CSV 先頭にヘッダーがあるなら true
const TARGET_SHEET_NAME = "英単語ログ";     // ← 送信先シート名（任意に変更OK）
const MODE_FIXED = "日本語→英単語";
const APP_NAME = import.meta.env.VITE_APP_NAME;

const DIFF_OPTIONS = ["Unit1", "Unit2"]; // ✅ 難易度（ユニット）

// ========= ユーティリティ =========
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
function normalizeEn(s) {
  // 必要ならハイフン/アポストロフィ無視も可: .replace(/[-’']/g, "")
  return trimSpaces(s).toLowerCase();
}

// 複数解答候補の分割（半角/全角スラッシュ、カンマ、日本語読点、セミコロン、縦棒も許容）
function splitAnswerCandidates(s) {
  if (!s) return [];
  const DELIMS = /[\/／,、;|]/g;
  return s
    .split(DELIMS)
    .map(part => normalizeEn(part))
    .filter(part => part.length > 0);
}

// 日本語→英単語（候補のどれかに一致で正解）
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
export default function App() {
  // 送信UI
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sent, setSent] = useState(false);

  // グローバル state
  const [name, setName] = useState("");
  const [difficulty, setDifficulty] = useState(DIFF_OPTIONS[0]); // ✅ 追加: 難易度（ユニット）
  const [allItems, setAllItems] = useState([]);
  const [items, setItems] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [step, setStep] = useState("start"); // start | quiz | result
  const [qIndex, setQIndex] = useState(0);

  // 入力欄
  const [value, setValue] = useState("");

  // timers
  const [totalLeft, setTotalLeft] = useState(TOTAL_TIME_SEC_DEFAULT);
  const totalTimerRef = useRef(null);
  const totalPausedRef = useRef(false); // ★全体タイマー一時停止フラグ

  // CSV読み込み（No./問題/解答/レベル）
  useEffect(() => {
    let rows = parseCsvRaw(wordsCsv);
    if (rows.length) {
      const [h0,h1,h2,h3] = rows[0].map(String);
      const looksHeader =
        /No|番号/i.test(h0) ||
        /問題|question|問/i.test(h1) ||
        /解答|解答例|answer|解答欄/i.test(h2) ||
        /難易度|レベル|level|unit/i.test(h3);
      if (SKIP_HEADER || looksHeader) rows = rows.slice(1);
    }
    const mapped = rows
      .filter(r => r.length >= 3 && r[1] && r[2])
      .map(r => ({
        no: String(r[0] ?? "").trim(),
        jp: String(r[1] ?? "").trim(),  // 表示（日本語の設問）
        en: String(r[2] ?? "").trim(),  // 正解（英単語・複数候補OK）
        level: String(r[3] ?? "").trim(), // Unit1 / Unit2 を推奨
      }));
    setAllItems(mapped);
  }, []);

  // ✅ 難易度でプールを切替
  const pool = useMemo(() => {
    if (!allItems.length) return [];
    // A) CSV 4列目に Unit1/Unit2 が入っていればそれで厳密にフィルタ
    const hasUnits = allItems.some(it => /unit\s*1/i.test(it.level) || /unit\s*2/i.test(it.level));
    if (hasUnits) {
      return allItems.filter(it => new RegExp(`^${difficulty}$`, "i").test(it.level));
    }
    // B) フォールバック：CSVにレベルが無い場合は前半=Unit1、後半=Unit2
    const mid = Math.ceil(allItems.length / 2);
    return difficulty === "Unit1" ? allItems.slice(0, mid) : allItems.slice(mid);
  }, [allItems, difficulty]);

  // 開始可能条件
  const canStart = useMemo(
    () => pool.length >= 1 && name.trim().length > 0 && DIFF_OPTIONS.includes(difficulty),
    [pool.length, name, difficulty]
  );

  // qIndex 変更時/quiz開始時に入力欄リセット
  useEffect(() => { if (step === "quiz") setValue(""); }, [qIndex, step]);

  // アンマウント時タイマー停止
  useEffect(() => () => { if (totalTimerRef.current) clearInterval(totalTimerRef.current); }, []);

  function startQuiz() {
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
          // ★一時停止中はカウントを進めない
          if (totalPausedRef.current) return t;

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

  function submitAnswer(userInput) {
    const item = items[qIndex];
    if (!item) return;

    const ok = judgeAnswerJPtoEN(userInput, item);
    const record = {
      qIndex,
      q: item.jp,
      a: userInput,
      correct: item.en, // 複数候補原文（UI表示用）
      ok,
    };
    setAnswers((prev) => [...prev, record]);
    setShowReview({ visible: true, record });
    if (USE_TOTAL_TIMER) totalPausedRef.current = true; // ★レビュー表示中は停止
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

  const [showReview, setShowReview] = useState({ visible: false, record: null });

  // ---- 結果送信（別シートへ追記）----
  async function sendResult() {
    const url = import.meta.env.VITE_GAS_URL;
    if (!url) throw new Error("VITE_GAS_URL is empty");

    const payload = {
      subject: APP_NAME, // ★追加：GAS側のタブ名に使う（= VITE_APP_NAME）
      timestamp: new Date().toISOString(),
      user_name: name,
      mode: MODE_FIXED,          // 固定
      difficulty,                // ✅ 選択した難易度（Unit1/Unit2）
      score: answers.filter((a) => a && a.ok).length,
      duration_sec: USE_TOTAL_TIMER ? (TOTAL_TIME_SEC_DEFAULT - totalLeft) : null,
      question_set_id: `auto-${Date.now()}`,
      questions: items.map((it) => ({ en: it.en, jp: it.jp, level: it.level })),
      answers,
      device_info: navigator.userAgent,
      targetSheet: TARGET_SHEET_NAME, // ← 書き込み先シート
    };

    const body = new URLSearchParams({ payload: JSON.stringify(payload) });

    // no-cors で投げる（応答本文は読まない）
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      mode: "no-cors",
      keepalive: true,
    });
  }

  // ---- 画面描画 ----
  let content = null;

  if (step === "start") {
    content = (
      <div style={wrapStyle}>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>中３英単語 不規則系単語</h1>
        <p style={{ opacity: 0.8, marginBottom: 16 }}>名前とユニットを選んでスタート</p>

        <label style={labelStyle}>あなたの名前</label>
        <input
          style={inputStyle}
          placeholder="例：ネッツ　太郎"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {/* ✅ 難易度（ユニット）選択 */}
        <label style={labelStyle}>ユニットを選択</label>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {DIFF_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setDifficulty(opt)}
              style={{
                ...chipStyle,
                background: difficulty === opt ? "#111" : "#f3f3f3",
                color: difficulty === opt ? "#fff" : "#111",
                borderColor: difficulty === opt ? "#111" : "#ddd",
              }}
            >
              {opt}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {pool.length ? `選択中の出題範囲：${pool.length}件` : "読込中または該当なし"}
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
          名前：<b>{name}</b> ／ 形式：{MODE_FIXED} ／ 難易度：{difficulty}
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
              <button style={primaryBtnStyle} onClick={() => setStep("start")}>
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
  // 練習用フォームのローカル状態（不正解のときだけ使う）
  const [practice, setPractice] = useState("");
  const [practiceMsg, setPracticeMsg] = useState("");

  // 本番の解答ボタン（答え合わせ）は、レビュー表示中や未入力なら無効化
  const disabled = showReview.visible; // ← 入力の空欄では無効化しない
  // 練習判定（①）：成績には反映しない。正しく打てたら次の問題へ、間違いなら再入力を促す
  const handlePracticeSubmit = () => {
    const user = normalizeEn(practice);
    const cands = splitAnswerCandidates(showReview.record.correct); // "color/colour" → ["color","colour"]
    if (cands.includes(user)) {
      setPracticeMsg("");
      setPractice("");
      onCloseReview(); // 正しく書けたら次の問題へ
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

      {/* 本番の解答入力（通常どおり） */}
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

      {/* 答え合わせ（レビュー） */}
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
            // ✅ 正解時：従来どおり「次の問題へ」だけ表示
            <button style={{ ...primaryBtnStyle, marginTop: 8 }} onClick={onCloseReview}>
              次の問題へ
            </button>
          ) : (
            // ❌ 不正解時：①練習用フォーム＋「回答する」／②次の問題に進む
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
                <button
                  style={primaryBtnStyle}
                  onClick={handlePracticeSubmit}
                >
                  回答する（練習）
                </button>
                <button
                  style={{ ...primaryBtnStyle, background: "#555" }}
                  onClick={onCloseReview}
                >
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
