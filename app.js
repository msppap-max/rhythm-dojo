// Rhythm Dojo v0.1
// 目的：クリック音 / タップ判定 / 結果 / 遅延補正（Calibration）

let audioCtx = null;
let master = null;

let isRunning = false;
let mode = "practice"; // "practice" | "calib"
let bpm = 100;

let spb = 0.6;                 // seconds per beat
let startTime = 0;             // first beat time (audio clock)
let nextBeatTime = 0;          // scheduler cursor
let scheduleAhead = 0.12;      // seconds
let tickIntervalMs = 25;

let tapErrorsMs = [];
let latencyCompMs = 0;         // calibration result (ms), tapTime + comp

// UI
const elBpm = document.getElementById("bpm");
const elStart = document.getElementById("start");
const elStop = document.getElementById("stop");
const elPad = document.getElementById("pad");
const elNow = document.getElementById("now");
const elOffset = document.getElementById("offset");
const elCount = document.getElementById("count");
const elMean = document.getElementById("mean");
const elStd = document.getElementById("std");
const elMsg = document.getElementById("msg");
const elNeedle = document.getElementById("needle");

const elModePractice = document.getElementById("modePractice");
const elModeCalib = document.getElementById("modeCalib");

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

function setMode(next) {
  mode = next;
  elModePractice.classList.toggle("active", mode === "practice");
  elModeCalib.classList.toggle("active", mode === "calib");
  tapErrorsMs = [];
  renderStats();
  elMsg.textContent = mode === "calib"
    ? "Calibration：クリックに合わせて20回くらいタップ。終わったら自動でOffset更新。"
    : "Practice：クリックに合わせてタップ。ズレ（ms）を“見える化”する。";
}

function beep(atTime, accent=false) {
  // クリック音：オシレーターで短く鳴らす
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

function computeNearestBeatTime(t) {
  // t は audioCtx.currentTime 基準
  const n = Math.round((t - startTime) / spb);
  return startTime + n * spb;
}

function onTap() {
  if (!isRunning || !audioCtx) return;

  const rawTapT = audioCtx.currentTime;
  const tapT = rawTapT + (latencyCompMs / 1000);

  const ideal = computeNearestBeatTime(tapT);
  const errMs = (tapT - ideal) * 1000; // +なら遅い、-なら早い

  tapErrorsMs.push(errMs);
  renderNow(errMs);
  renderStats();

  // Calibrationは一定回数で確定（中央値で補正）
  if (mode === "calib" && tapErrorsMs.length >= 20) {
    const med = median(tapErrorsMs);
    latencyCompMs = -med; // いつも遅い(+ms)なら、補正はマイナス
    elOffset.textContent = Math.round(latencyCompMs).toString();
    elMsg.textContent = `Calibration完了。Offsetを ${Math.round(latencyCompMs)} ms に設定した。Practiceで試そう。`;
    // 次の練習に向けてリセット
    tapErrorsMs = [];
    renderStats();
  }
}

function renderNow(errMs) {
  elNow.textContent = Math.round(errMs).toString();
  elCount.textContent = tapErrorsMs.length.toString();

  // メーター表示（±150msを端とする）
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const v = clamp(errMs, -150, 150);
  const pct = (v + 150) / 300; // 0..1
  elNeedle.style.left = `${pct * 100}%`;
}

function renderStats() {
  elOffset.textContent = Math.round(latencyCompMs).toString();
  elCount.textContent = tapErrorsMs.length.toString();

  if (tapErrorsMs.length < 2) {
    elMean.textContent = "--";
    elStd.textContent = "--";
    return;
  }
  const m = mean(tapErrorsMs);
  const s = std(tapErrorsMs, m);
  elMean.textContent = `${Math.round(m)}`;
  elStd.textContent = `${Math.round(s)}`;
}

function scheduler() {
  if (!isRunning) return;

  while (nextBeatTime < audioCtx.currentTime + scheduleAhead) {
    // 4拍目を強く（道場の太鼓）
    const beatIndex = Math.round((nextBeatTime - startTime) / spb);
    const accent = (beatIndex % 4 === 0);
    beep(nextBeatTime, accent);
    nextBeatTime += spb;
  }
}

let timerId = null;

function start() {
  bpm = Number(elBpm.value || 100);
  spb = 60 / bpm;

  ensureAudio();
  // iOS対策：ユーザー操作でresume
  audioCtx.resume();

  tapErrorsMs = [];
  renderStats();
  elNow.textContent = "--";
  elNeedle.style.left = "50%";

  isRunning = true;
  elStart.disabled = true;
  elStop.disabled = false;
  elPad.disabled = false;

  // カウントイン：0.2秒後に開始
  startTime = audioCtx.currentTime + 0.2;
  nextBeatTime = startTime;

  elMsg.textContent = mode === "calib"
    ? "Calibration開始：クリックに合わせてタップ×20。"
    : "Practice開始：クリックに合わせてタップ。ズレを見て調整。";

  timerId = setInterval(scheduler, tickIntervalMs);
}

function stop() {
  isRunning = false;
  elStart.disabled = false;
  elStop.disabled = true;
  elPad.disabled = true;
  if (timerId) clearInterval(timerId);
  timerId = null;
  elMsg.textContent = "Stop。結果を見て、癖（食い気味/タメ気味）を掴もう。";
}

function mean(arr) {
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}
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
elStop.addEventListener("click", stop);

elModePractice.addEventListener("click", () => setMode("practice"));
elModeCalib.addEventListener("click", () => setMode("calib"));

elPad.addEventListener("pointerdown", onTap);

// 初期表示
setMode("practice");
