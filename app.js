// Rhythm Dojo v0.21
// 追加：自動スタート（Tapで開始）＋3,2,1カウントイン＋流れるガイド＋判定演出

let audioCtx = null;
let master = null;

let isRunning = false;
let bpm = 100;
let spb = 0.6;

const SESSION_SECONDS = 30;
const COUNT_IN_BEATS = 3; // 3,2,1

const OFFSET_KEY = "offset_bt_ms";
let latencyCompMs = 0;

let mode = "practice"; // practice | calib
let pattern = "quarter"; // quarter|eighth|sixteenth|triplet|offbeat
let difficulty = "normal"; // normal|hard|insane

let startTime = 0;        // 実プレイ開始（カウントイン後）
let countInStart = 0;     // カウントイン開始
let sessionEndTime = 0;
let nextBeatTime = 0;
let scheduleAhead = 0.12;
let tickIntervalMs = 25;

let score = 0, combo = 0, maxCombo = 0;
let lastTargetIndex = -999999;
let hitErrorsMs = [];
let counts = { perfect:0, great:0, good:0, bad:0, miss:0 };

const PAT = {
  quarter:   { label: "4分",  interval: (spb)=>spb,   phase: (spb)=>0 },
  eighth:    { label: "8分",  interval: (spb)=>spb/2, phase: (spb)=>0 },
  sixteenth: { label: "16分", interval: (spb)=>spb/4, phase: (spb)=>0 },
  triplet:   { label: "3連",  interval: (spb)=>spb/3, phase: (spb)=>0 },
  offbeat:   { label: "裏拍", interval: (spb)=>spb,   phase: (spb)=>spb/2 }
};

const DIFF = {
  normal: { p:25, g:55, ok:95, bad:135 },
  hard:   { p:20, g:40, ok:80, bad:120 },
  insane: { p:15, g:30, ok:60, bad:90 }
};

const POINTS = { perfect:100, great:70, good:40, bad:10, miss:0 };

// UI
const elBpm = document.getElementById("bpm");
const elPad = document.getElementById("pad");
const elEndBtn = document.getElementById("endBtn");

const elNow = document.getElementById("now");
const elNeedle = document.getElementById("needle");
const elMsg = document.getElementById("msg");
const elJudge = document.getElementById("judge");

const elScore = document.getElementById("score");
const elCombo = document.getElementById("combo");
const elMaxCombo = document.getElementById("maxCombo");
const elTimeLeft = document.getElementById("timeLeft");

const elOffset = document.getElementById("offset");
const elCountIn = document.getElementById("countIn");

const elModePractice = document.getElementById("modePractice");
const elModeCalib = document.getElementById("modeCalib");
const elModeHint = document.getElementById("modeHint");

const elMean = document.getElementById("mean");
const elStd = document.getElementById("std");
const elAcc = document.getElementById("acc");

const elCPerfect = document.getElementById("cPerfect");
const elCGreat = document.getElementById("cGreat");
const elCGood = document.getElementById("cGood");
const elCBad = document.getElementById("cBad");
const elCMiss = document.getElementById("cMiss");

// Guide canvas
const elMeter = document.getElementById("meter");
const canvas = document.getElementById("guideCanvas");
const ctx2d = canvas.getContext("2d");
let dpr = 1;

let timerId = null;
let uiTimerId = null;
let rafId = null;

let calibErrorsMs = [];

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

  // 終了（practiceのみ）
  if (mode === "practice" && audioCtx.currentTime >= sessionEndTime) {
    stop(true);
    return;
  }

  // クリック音（4分の頭を強く）
  while (nextBeatTime < audioCtx.currentTime + scheduleAhead) {
    const beatIndex = Math.round((nextBeatTime - countInStart) / spb);
    const accent = (beatIndex % 4 === 0);
    beep(nextBeatTime, accent);
    nextBeatTime += spb;
  }
}

function resetGameState() {
  score = 0; combo = 0; maxCombo = 0;
  lastTargetIndex = -999999;
  hitErrorsMs = [];
  counts = { perfect:0, great:0, good:0, bad:0, miss:0 };
  calibErrorsMs = [];

  setJudge("READY", "--", null);
  renderNow("--");
  renderScoreboard();
  renderResult();
  renderTimeLeft(true);
}

function armStart() {
  bpm = Number(elBpm.value || 100);
  spb = 60 / bpm;

  ensureAudio();
  audioCtx.resume();

  resetGameState();

  isRunning = true;
  elEndBtn.disabled = false;

  // カウントイン開始（0.25秒後）
  countInStart = audioCtx.currentTime + 0.25;
  startTime = countInStart + COUNT_IN_BEATS * spb;   // ここが本番開始
  nextBeatTime = countInStart;

  if (mode === "practice") {
    sessionEndTime = startTime + SESSION_SECONDS;
    elMsg.textContent = `Tapで開始：3,2,1… → ${PAT[pattern].label} / ${difficulty.toUpperCase()}（30秒）`;
  } else {
    // calibrationは開始時刻だけ作ってクリックを鳴らす（20回タップで完了）
    sessionEndTime = startTime + 9999;
    elMsg.textContent = "Calibration：クリックに合わせて20回タップ。完了するとOffsetを保存。";
  }

  timerId = setInterval(scheduler, tickIntervalMs);
  uiTimerId = setInterval(renderTimeLeft, 50);

  startGuideLoop();
}

function stop(fromAuto=false) {
  isRunning = false;
  elEndBtn.disabled = true;

  if (timerId) clearInterval(timerId);
  if (uiTimerId) clearInterval(uiTimerId);
  timerId = null;
  uiTimerId = null;

  stopGuideLoop();

  hideCountIn();

  if (mode === "practice") {
    elMsg.textContent = fromAuto
      ? "終了！スコア/精度を確認。次はPerfect率かStd（安定度）を伸ばす。"
      : "End。結果を見て癖（食い/タメ）とブレを潰そう。";
  } else {
    elMsg.textContent = "Calibration停止。必要ならもう一度Tapで開始。";
  }

  renderResult();
  renderTimeLeft(true);
}

function renderTimeLeft(forceIdle=false) {
  if (!audioCtx || mode !== "practice" || forceIdle || !isRunning) {
    elTimeLeft.textContent = SESSION_SECONDS.toFixed(1);
    return;
  }
  // カウントイン中は残り固定（本番開始から減る）
  if (audioCtx.currentTime < startTime) {
    elTimeLeft.textContent = SESSION_SECONDS.toFixed(1);
    return;
  }
  const left = Math.max(0, sessionEndTime - audioCtx.currentTime);
  elTimeLeft.textContent = left.toFixed(1);
}

function getTarget(tapT) {
  const p = PAT[pattern];
  const interval = p.interval(spb);
  const base = startTime + p.phase(spb);
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

function setJudge(text, errMs, grade) {
  elJudge.textContent = text;
  elNow.textContent = (errMs === "--") ? "--" : String(Math.round(errMs));

  // 色＋ポップ演出
  elJudge.classList.remove("perfect","great","good","bad","miss","pop");
  if (grade) elJudge.classList.add(grade);
  // 再付与でアニメが効くように1フレーム空ける
  requestAnimationFrame(() => elJudge.classList.add("pop"));
}

function renderNow(errMs) {
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  const v = (errMs === "--") ? 0 : clamp(errMs, -150, 150);
  const pct = (v + 150) / 300;
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

function showCountIn(n) {
  elCountIn.textContent = String(n);
  elCountIn.classList.remove("hidden");
}
function hideCountIn() {
  elCountIn.classList.add("hidden");
}

function applyPadFx(grade) {
  const map = {
    perfect:"fx-perfect",
    great:"fx-great",
    good:"fx-good",
    bad:"fx-bad",
    miss:"fx-miss"
  };
  const cls = map[grade];
  if (!cls) return;

  elPad.classList.remove("fx-perfect","fx-great","fx-good","fx-bad","fx-miss");
  elPad.classList.add(cls);

  // combo数字の軽いポップ
  if (grade !== "miss") {
    elCombo.classList.remove("pop");
    requestAnimationFrame(()=>elCombo.classList.add("pop"));
  }

  setTimeout(()=>{
    elPad.classList.remove(cls);
  }, 140);
}

function onTap() {
  // まだ走ってないならTapで自動開始
  if (!isRunning) {
    armStart();
    return;
  }

  if (!audioCtx) return;

  const rawTapT = audioCtx.currentTime;

  // カウントイン中は判定しない（混乱防止）
  if (rawTapT < startTime) {
    const beatsLeft = Math.ceil((startTime - rawTapT) / spb);
    // 3,2,1の表示
    const n = Math.max(1, Math.min(COUNT_IN_BEATS, beatsLeft));
    showCountIn(n);
    setJudge(String(n), "--", null);
    renderNow("--");
    return;
  } else {
    hideCountIn();
  }

  const tapT = rawTapT + (latencyCompMs / 1000);

  // Calibration
  if (mode === "calib") {
    const ideal = nearestBeatTime(tapT);
    const errMs = (tapT - ideal) * 1000;
    calibPush(errMs);
    return;
  }

  // Practice/Game
  const { n, ideal } = getTarget(tapT);

  // 同一ターゲット連打をMISS扱い
  if (n <= lastTargetIndex) {
    counts.miss++;
    combo = 0;
    setJudge("MISS", 0, "miss");
    applyPadFx("miss");
    renderNow(0);
    renderScoreboard();
    renderResult();
    return;
  }
  lastTargetIndex = n;

  const errMs = (tapT - ideal) * 1000;
  const absMs = Math.abs(errMs);
  const g = gradeFromAbs(absMs);

  counts[g]++;

  if (g === "miss") {
    combo = 0;
  } else {
    hitErrorsMs.push(errMs);
    combo++;
    if (combo > maxCombo) maxCombo = combo;

    const base = POINTS[g];
    const bonus = Math.min(combo, 50);
    score += (base + bonus);
  }

  setJudge(g.toUpperCase(), errMs, g);
  applyPadFx(g);
  renderNow(errMs);
  renderScoreboard();
  renderResult();
}

function calibPush(errMs) {
  calibErrorsMs.push(errMs);
  setJudge("CALIB", errMs, null);
  renderNow(errMs);

  if (calibErrorsMs.length >= 20) {
    const med = median(calibErrorsMs);
    latencyCompMs = -med;
    saveOffset();
    calibErrorsMs = [];
    elMsg.textContent = `Calibration完了。Offsetを ${Math.round(latencyCompMs)} ms に保存した。Gameで試そう。`;
    setJudge("READY", "--", null);
    renderNow("--");
    hideCountIn();
  }
}

function nearestBeatTime(t) {
  const n = Math.round((t - countInStart) / spb);
  return countInStart + n * spb;
}

// Guide（流れる点）
function resizeCanvas() {
  const rect = elMeter.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx2d.setTransform(dpr,0,0,dpr,0,0);
}

function drawGuide() {
  if (!isRunning || !audioCtx) return;

  const w = elMeter.clientWidth;
  const h = elMeter.clientHeight;
  ctx2d.clearRect(0, 0, w, h);

  const now = audioCtx.currentTime;
  const base = startTime + PAT[pattern].phase(spb);
  const interval = PAT[pattern].interval(spb);

  // 表示窓（中心に向かって流れる）
  const ahead = 1.25;   // 未来をどれくらい見せるか（秒）
  const behind = 0.35;  // 過去側（少しだけ）

  // カウントイン中は「点」を出さない（混乱防止）
  if (now < startTime) {
    rafId = requestAnimationFrame(drawGuide);
    return;
  }

  const nNow = Math.round((now - base) / interval);
  const startN = nNow - 2;
  const endN = nNow + Math.ceil(ahead / interval) + 2;

  // 点の描画
  for (let n = startN; n <= endN; n++) {
    const t = base + n * interval;
    const dt = t - now; // +未来 / -過去
    if (dt < -behind || dt > ahead) continue;

    const x = (w * 0.5) + (dt / ahead) * (w * 0.5); // 未来は右、中心へ
    const y = h * 0.5;

    // ちょい“未来ほど薄い”
    const alpha = 0.15 + 0.65 * (1 - Math.min(1, Math.abs(dt) / ahead));
    ctx2d.beginPath();
    ctx2d.arc(x, y, 5, 0, Math.PI * 2);
    ctx2d.fillStyle = `rgba(234,234,234,${alpha.toFixed(3)})`;
    ctx2d.fill();
  }

  rafId = requestAnimationFrame(drawGuide);
}

function startGuideLoop() {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(drawGuide);
}

function stopGuideLoop() {
  window.removeEventListener("resize", resizeCanvas);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  // クリア
  const w = elMeter.clientWidth;
  const h = elMeter.clientHeight;
  ctx2d.clearRect(0, 0, w, h);
}

// Mode/Pattern/Difficulty
function setMode(next) {
  mode = next;
  elModePractice.classList.toggle("active", mode === "practice");
  elModeCalib.classList.toggle("active", mode === "calib");
  elModeHint.textContent = (mode === "practice")
    ? "Game：Tapで自動開始（3,2,1…）。点が中心線に来たらTap。"
    : "Calibration：Tapで開始。クリックに合わせて20回タップでOffset保存。";
  if (isRunning) stop(false);
  resetGameState();
}

function setPattern(p) {
  pattern = p;
  document.getElementById("patQuarter").classList.toggle("active", p === "quarter");
  document.getElementById("patEighth").classList.toggle("active", p === "eighth");
  document.getElementById("patSixteenth").classList.toggle("active", p === "sixteenth");
  document.getElementById("patTriplet").classList.toggle("active", p === "triplet");
  document.getElementById("patOffbeat").classList.toggle("active", p === "offbeat");
  if (isRunning) stop(false);
  resetGameState();
  elMsg.textContent = `Pattern：${PAT[p].label}。点が中心線に来たらTap。`;
}

function setDifficulty(d) {
  difficulty = d;
  document.getElementById("diffNormal").classList.toggle("active", d === "normal");
  document.getElementById("diffHard").classList.toggle("active", d === "hard");
  document.getElementById("diffInsane").classList.toggle("active", d === "insane");
  if (isRunning) stop(false);
  resetGameState();
  elMsg.textContent = `Difficulty：${d.toUpperCase()}。`;
}

// stats
function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function std(arr,m){
  const v = arr.reduce((a,b)=>a+(b-m)*(b-m),0)/(arr.length-1);
  return Math.sqrt(v);
}
function median(arr){
  const a=[...arr].sort((x,y)=>x-y);
  const mid=Math.floor(a.length/2);
  return (a.length%2)?a[mid]:(a[mid-1]+a[mid])/2;
}

// Wiring
elPad.addEventListener("pointerdown", onTap);
elEndBtn.addEventListener("click", () => stop(false));

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

// init
loadOffset();
setMode("practice");
setPattern("quarter");
setDifficulty("normal");
resetGameState();
