// Rhythm Dojo v0.2
// 追加：Pattern / 判定 / スコア&コンボ / 30秒チャレンジ / Offset保存

let audioCtx = null;
let master = null;

let isRunning = false;
let mode = "practice"; // "practice" | "calib"
let bpm = 100;
let spb = 0.6; // seconds per beat

let startTime = 0;
let nextBeatTime = 0;
let scheduleAhead = 0.12;
let tickIntervalMs = 25;

const SESSION_SECONDS = 30;

const OFFSET_KEY = "offset_bt_ms";
let latencyCompMs = 0;

// Game state
let pattern = "quarter";    // quarter|eighth|sixteenth|triplet|offbeat
let difficulty = "hard";    // normal|hard|insane
let sessionEndTime = 0;

let score = 0;
let combo = 0;
let maxCombo = 0;
let lastTargetIndex = -999999;

let hitErrorsMs = []; // MISS以外の誤差だけ保存（分析用）
let counts = { perfect:0, great:0, good:0, bad:0, miss:0 };

const PAT = {
  quarter:   { label: "4分",     interval: (spb)=>spb,    phase: (spb)=>0 },
  eighth:    { label: "8分",     interval: (spb)=>spb/2,  phase: (spb)=>0 },
  sixteenth: { label: "16分",    interval: (spb)=>spb/4,  phase: (spb)=>0 },
  triplet:   { label: "3連",     interval: (spb)=>spb/3,  phase: (spb)=>0 },
  offbeat:   { label: "裏拍",    interval: (spb)=>spb,    phase: (spb)=>spb/2 }
};

const DIFF = {
  normal: { p:25, g:55, ok:95, bad:135 },
  hard:   { p:20, g:40, ok:80, bad:120 },
  insane: { p:15, g:30, ok:60, bad:90 }
};

const POINTS = { perfect:100, great:70, good:40, bad:10, miss:0 };

// UI
const elBpm = document.getElementById("bpm");
const elStart = document.getElementById("start");
const elStop = document.getElementById("stop");
const elPad = document.getElementById("pad");

const elNow = document.getElementById("now");
const elOffset = document.getElementById("offset");
const elNeedle = document.getElementById("needle");
const elMsg = document.getElementById("msg");
const elJudge = document.getElementById("judge");
const elTimeLeft = document.getElementById("timeLeft");

const elScore = document.getElementById("score");
const elCombo = document.getElementById("combo");
const elMaxCombo = document.getElementById("maxCombo");

const elMean = document.getElementById("mean");
const elStd = document.getElementById("std");
const elAcc = document.getElementById("acc");

const elCPerfect = document.getElementById("cPerfect");
const elCGreat = document.getElementById("cGreat");
const elCGood = document.getElementById("cGood");
const elCBad = document.getElementById("cBad");
const elCMiss = document.getElementById("cMiss");

const elModePractice = document.getElementById("modePractice");
const elModeCalib = document.getElementById("modeCalib");
const elModeHint = document.getElementById("modeHint");

let timerId = null;
let uiTimerId = null;

// PWA: service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  master = audioCtx.createGain();
  master.gain.value = 0.25;
  master.connect(audioCtx.destination);
}

function beep(atTime, accent=false) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = accent ? 1400 : 1000;

  gain.gain.setValueAtTime(0.0001, atTime);
  gain.gain.exponentialRampToValueAtTime(0.35, atTime + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.04);

  osc.connect(gain);
  gain.connect(master);
  osc.start(atTime);
  osc.stop(atTime + 0.06);
}

function scheduler() {
  if (!isRunning) return;

  // セッション終了
  if (mode === "practice" && audioCtx.currentTime >= sessionEndTime) {
    stop(true);
    return;
  }

  // クリック音（4分の頭を強く）
  while (nextBeatTime < audioCtx.currentTime + scheduleAhead) {
    const beatIndex = Math.round((nextBeatTime - startTime) / spb);
    const accent = (beatIndex % 4 === 0);
    beep(nextBeatTime, accent);
    nextBeatTime += spb;
  }
}

function resetGameState() {
  score = 0;
  combo = 0;
  maxCombo = 0;
  lastTargetIndex = -999999;
  hitErrorsMs = [];
  counts = { perfect:0, great:0, good:0, bad:0, miss:0 };
  renderScoreboard();
  renderResult();
  renderNow("--");
  setJudge("READY", "--");
}

function start() {
  bpm = Number(elBpm.value || 100);
  spb = 60 / bpm;

  ensureAudio();
  audioCtx.resume(); // iOS対策：ユーザー操作でresume必須

  resetGameState();

  isRunning = true;
  elStart.disabled = true;
  elStop.disabled = false;
  elPad.disabled = false;

  // カウントイン：0.25秒後に開始
  startTime = audioCtx.currentTime + 0.25;
  nextBeatTime = startTime;

  if (mode === "practice") {
    sessionEndTime = startTime + SESSION_SECONDS;
    elMsg.textContent = `30秒チャレンジ開始：${PAT[pattern].label} / ${difficulty.toUpperCase()}。`;
  } else {
    elMsg.textContent = "Calibration：クリックに合わせて20回タップ。終わったら自動でOffset更新。";
  }

  timerId = setInterval(scheduler, tickIntervalMs);
  uiTimerId = setInterval(renderTimeLeft, 50);
  renderTimeLeft();
}

function stop(fromAuto=false) {
  isRunning = false;
  elStart.disabled = false;
  elStop.disabled = true;
  elPad.disabled = true;

  if (timerId) clearInterval(timerId);
  if (uiTimerId) clearInterval(uiTimerId);
  timerId = null;
  uiTimerId = null;

  renderTimeLeft(true);
  renderResult();
  elMsg.textContent = fromAuto
    ? "終了！スコアと精度を確認。次はPerfect率かStd（安定度）を伸ばす。"
    : "Stop。結果を見て癖（食い/タメ）とブレを潰そう。";
}

function renderTimeLeft(forceEnd=false) {
  if (!audioCtx || mode !== "practice") {
    elTimeLeft.textContent = SESSION_SECONDS.toFixed(1);
    return;
  }
  const left = forceEnd ? 0 : Math.max(0, sessionEndTime - audioCtx.currentTime);
  elTimeLeft.textContent = left.toFixed(1);
}

function getTarget(tapT) {
  const p = PAT[pattern];
  const interval = p.interval(spb);
  const base = startTime + p.phase(spb);

  // 近いターゲットを取る（丸め）
  const n = Math.round((tapT - base) / interval);
  return { n, ideal: base + n * interval, interval, base };
}

function gradeFromAbs(absMs) {
  const th = DIFF[difficulty];
  if (absMs <= th.p) return "perfect";
  if (absMs <= th.g) return "great";
  if (absMs <= th.ok) return "good";
  if (absMs <= th.bad) return "bad";
  return "miss";
}

function setJudge(text, errMs) {
  elJudge.textContent = text;
  elNow.textContent = (errMs === "--") ? "--" : String(Math.round(errMs));
}

function renderNow(errMs) {
  // メーター表示（±150ms）
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const v = (errMs === "--") ? 0 : clamp(errMs, -150, 150);
  const pct = (v + 150) / 300; // 0..1
  elNeedle.style.left = `${pct * 100}%`;
}

function renderScoreboard() {
  elScore.textContent = String(score);
  elCombo.textContent = String(combo);
  elMaxCombo.textContent = String(maxCombo);
}

function renderResult() {
  elCPerfect.textContent = String(counts.perfect);
  elCGreat.textContent = String(counts.great);
  elCGood.textContent = String(counts.good);
  elCBad.textContent = String(counts.bad);
  elCMiss.textContent = String(counts.miss);

  if (hitErrorsMs.length < 2) {
    elMean.textContent = "--";
    elStd.textContent = "--";
  } else {
    const m = mean(hitErrorsMs);
    const s = std(hitErrorsMs, m);
    elMean.textContent = String(Math.round(m));
    elStd.textContent = String(Math.round(s));
  }

  const total = counts.perfect + counts.great + counts.good + counts.bad + counts.miss;
  if (total === 0) elAcc.textContent = "--";
  else {
    const hit = total - counts.miss;
    elAcc.textContent = String(Math.round((hit / total) * 100));
  }
}

function loadOffset() {
  const v = Number(localStorage.getItem(OFFSET_KEY) ?? "0");
  latencyCompMs = Number.isFinite(v) ? v : 0;
  elOffset.textContent = String(Math.round(latencyCompMs));
}

function saveOffset() {
  localStorage.setItem(OFFSET_KEY, String(Math.round(latencyCompMs)));
  elOffset.textContent = String(Math.round(latencyCompMs));
}

function onTap() {
  if (!isRunning || !audioCtx) return;

  const rawTapT = audioCtx.currentTime;
  const tapT = rawTapT + (latencyCompMs / 1000);

  // セッション外なら無視
  if (mode === "practice" && rawTapT >= sessionEndTime) return;

  if (mode === "calib") {
    // Calibrationは4分の拍に合わせる（最短で端末クセを取る）
    const ideal = nearestBeatTime(tapT);
    const errMs = (tapT - ideal) * 1000;
    calibPush(errMs);
    return;
  }

  // Game
  const { n, ideal } = getTarget(tapT);
  // 同じターゲット連打をMISS扱い（ズル防止＆気持ちよさ優先）
  if (n <= lastTargetIndex) {
    counts.miss++;
    combo = 0;
    setJudge("MISS", 0);
    renderNow(0);
    renderScoreboard();
    renderResult();
    return;
  }
  lastTargetIndex = n;

  const errMs = (tapT - ideal) * 1000; // +遅い / -早い
  const absMs = Math.abs(errMs);
  const g = gradeFromAbs(absMs);

  counts[g]++;

  if (g === "miss") {
    combo = 0;
  } else {
    hitErrorsMs.push(errMs);
    combo++;
    if (combo > maxCombo) maxCombo = combo;

    // 点数：ベース + コンボボーナス（最大+50）
    const base = POINTS[g];
    const bonus = Math.min(combo, 50);
    score += (base + bonus);
  }

  setJudge(g.toUpperCase(), errMs);
  renderNow(errMs);
  renderScoreboard();
  renderResult();
}

let calibErrorsMs = [];
function calibPush(errMs) {
  calibErrorsMs.push(errMs);
  setJudge("CALIB", errMs);
  renderNow(errMs);

  if (calibErrorsMs.length >= 20) {
    const med = median(calibErrorsMs);
    latencyCompMs = -med;   // いつも遅い(+ms)なら補正はマイナス
    saveOffset();
    calibErrorsMs = [];
    elMsg.textContent = `Calibration完了。Offsetを ${Math.round(latencyCompMs)} ms に保存した。Gameで試そう。`;
    setJudge("READY", "--");
    renderNow("--");
  }
}

function nearestBeatTime(t) {
  const n = Math.round((t - startTime) / spb);
  return startTime + n * spb;
}

// Mode / Pattern / Difficulty
function setMode(next) {
  mode = next;
  elModePractice.classList.toggle("active", mode === "practice");
  elModeCalib.classList.toggle("active", mode === "calib");
  elModeHint.textContent = (mode === "practice")
    ? "Game：30秒でスコア稼ぎ。判定は厳しめ。"
    : "Calibration：Bluetooth遅延を補正（20回タップで自動設定＆保存）。";
  resetGameState();
}

function setPattern(p) {
  pattern = p;
  document.getElementById("patQuarter").classList.toggle("active", p === "quarter");
  document.getElementById("patEighth").classList.toggle("active", p === "eighth");
  document.getElementById("patSixteenth").classList.toggle("active", p === "sixteenth");
  document.getElementById("patTriplet").classList.toggle("active", p === "triplet");
  document.getElementById("patOffbeat").classList.toggle("active", p === "offbeat");
  resetGameState();
  elMsg.textContent = `Pattern：${PAT[p].label} に切替。Startで30秒勝負。`;
}

function setDifficulty(d) {
  difficulty = d;
  document.getElementById("diffNormal").classList.toggle("active", d === "normal");
  document.getElementById("diffHard").classList.toggle("active", d === "hard");
  document.getElementById("diffInsane").classList.toggle("active", d === "insane");
  resetGameState();
  elMsg.textContent = `Difficulty：${d.toUpperCase()} に切替。`;
}

// stats
function mean(arr) { return arr.reduce((a,b)=>a+b,0) / arr.length; }
function std(arr, m) {
  const v = arr.reduce((a,b)=>a+(b-m)*(b-m),0) / (arr.length - 1);
  return Math.sqrt(v);
}
function median(arr) {
  const a = [...arr].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return (a.length % 2) ? a[mid] : (a[mid-1]+a[mid])/2;
}

// UI wiring
elStart.addEventListener("click", start);
elStop.addEventListener("click", () => stop(false));
elPad.addEventListener("pointerdown", onTap);

elModePractice.addEventListener("click", () => setMode("practice"));
elModeCalib.addEventListener("click", () => setMode("calib"));

document.getElementById("patQuarter").addEventListener("click", () => setPattern("quarter"));
document.getElementById("patEighth").addEventListener("click", () => setPattern("eighth"));
document.getElementById("patSixteenth").addEventListener("click", () => setPattern("sixteenth"));
document.getElementById("patTriplet").addEventListener("click", () => setPattern("triplet"));
document.getElementById("patOffbeat").addEventListener("click", () => setPattern("offbeat"));

document.getElementById("diffNormal").addEventListener("click", () => setDifficulty("normal"));
document.getElementById("diffHard").addEventListener("click", () => setDifficulty("hard"));
document.getElementById("diffInsane").addEventListener("click", () => setDifficulty("insane"));

document.getElementById("resetOffset").addEventListener("click", () => {
  latencyCompMs = 0;
  saveOffset();
  elMsg.textContent = "Offsetを0に戻した。BluetoothでズレるならCalibrationしてね。";
});

// 初期化
loadOffset();
setMode("practice");
setPattern("quarter");
setDifficulty("hard");
