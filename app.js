const $ = (selector) => document.querySelector(selector);

const ui = {
  settingsButton: $("#settingsButton"), settingsDialog: $("#settingsDialog"),
  saveModelButton: $("#saveModelButton"), modelStatus: $("#modelStatus"), startButton: $("#startButton"),
  startButtonText: $("#startButtonText"), resetButton: $("#resetButton"), cameraFrame: $("#cameraFrame"),
  cameraPlaceholder: $("#cameraPlaceholder"), webcamContainer: $("#webcamContainer"), prediction: $("#prediction"),
  confidence: $("#confidence"), countdown: $("#countdown"), computerChoice: $("#computerChoice"),
  resultPanel: $("#resultPanel"), resultText: $("#resultText"), playerScore: $("#playerScore"),
  computerScore: $("#computerScore"), roundCount: $("#roundCount"),
};

const choices = {
  scissors: { label: "가위", emoji: "✌️", beats: "paper" },
  rock: { label: "바위", emoji: "✊", beats: "scissors" },
  paper: { label: "보", emoji: "✋", beats: "rock" },
};
const aliases = { "가위":"scissors", scissors:"scissors", scissor:"scissors", "바위":"rock", rock:"rock", "주먹":"rock", "보":"paper", paper:"paper", palm:"paper" };
const choiceNames = Object.keys(choices);
const roundMessages = { win:"당신의 승리! 멋진 한 수였어요.", lose:"컴퓨터의 승리! 다시 도전해보세요.", draw:"무승부! 마음이 통했네요." };
const MODEL_URL = "model/model.json";
const METADATA_URL = "model/metadata.json";
const WEBCAM_WIDTH = 480;
const WEBCAM_HEIGHT = 360;
const MIN_PREDICTION_CONFIDENCE = 0.55;
const COUNTDOWN_VALUES = [3, 2, 1];
const COUNTDOWN_VISIBLE_MS = 650;
const COUNTDOWN_GAP_MS = 120;
const roundPrompt = "가위, 바위, 보! 손 모양을 유지하세요.";
const cameraPrompt = "카메라를 켜면 게임을 시작할 수 있어요.";
const readyPrompt = "준비됐다면 승부하기 버튼을 눌러주세요.";
const modelLoadingMessage = "AI 모델을 불러오고 있어요. 잠시 기다려주세요.";
const predictionErrorMessage = "손 모양을 인식하는 중 오류가 발생했어요. 다시 인식을 시도하고 있어요.";

let model = null;
let modelLoading = false;
let webcam = null;
let startingWebcam = null;
let cameraRunning = false;
let cameraStarting = false;
let playing = false;
let latestPrediction = null;
let predictionFailed = false;
let score = { player:0, computer:0, rounds:0 };
let pageActive = true;
let lifecycleVersion = 0;
let predictionFrame = null;
let predictionTask = null;

function normalizeClass(className) {
  const label = typeof className === "string" ? className.trim().toLowerCase() : "";
  return Object.hasOwn(aliases, label) ? aliases[label] : null;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function updateControls() {
  const busy = !pageActive || modelLoading || cameraStarting || playing;
  ui.startButton.disabled = busy || !model || predictionFailed;
  ui.saveModelButton.disabled = busy;
  ui.resetButton.disabled = !pageActive || playing;
}

function setResult(message, result = "") {
  ui.resultPanel.className = result ? `result-panel ${result}` : "result-panel";
  ui.resultText.textContent = message;
}

function setModelStatus(message, isError = false) {
  ui.modelStatus.classList.toggle("error", isError);
  ui.modelStatus.textContent = message;
}

function clearPrediction(label) {
  latestPrediction = null;
  ui.prediction.textContent = label;
  ui.confidence.textContent = "—";
}

function renderScores() {
  ui.playerScore.textContent = score.player;
  ui.computerScore.textContent = score.computer;
  ui.roundCount.textContent = score.rounds;
}

function renderComputerChoice(choice = null) {
  ui.computerChoice.classList.remove("reveal");
  if (!choice) {
    ui.computerChoice.innerHTML = '<span class="choice-emoji">?</span><p>아직 고민 중…</p>';
    return;
  }
  ui.computerChoice.innerHTML = `<span class="choice-emoji">${choices[choice].emoji}</span><p>${choices[choice].label}</p>`;
  void ui.computerChoice.offsetWidth;
  ui.computerChoice.classList.add("reveal");
}

function clearCountdown() {
  ui.countdown.classList.remove("show");
  ui.countdown.textContent = "";
}

function renderCamera() {
  ui.webcamContainer.replaceChildren(...(webcam ? [webcam.canvas] : []));
  ui.cameraPlaceholder.hidden = cameraRunning;
  ui.cameraFrame.classList.toggle("active", cameraRunning);
}

function validateClasses(labels, classCount = labels?.length) {
  const normalized = Array.isArray(labels) ? labels.map(normalizeClass) : [];
  if (classCount !== choiceNames.length || normalized.length !== choiceNames.length || normalized.includes(null) || new Set(normalized).size !== choiceNames.length) {
    throw new Error("모델 클래스는 가위, 바위, 보를 각각 하나씩 포함해야 합니다.");
  }
}

function disposeModel(layersModel) {
  if (!layersModel) return;
  // 이 번들의 CustomMobileNet.dispose() 대신 실제 TensorFlow 모델을 해제합니다.
  try {
    const weights = layersModel.getWeights();
    try { layersModel.dispose(); }
    // 내보낸 중첩 모델에 남는 참조도 정리합니다. 각 로딩의 가중치는 독립적입니다.
    finally { tf.dispose(weights); }
  }
  catch (error) { console.error("모델 자원을 정리하지 못했습니다.", error); }
}

function stopWebcam(camera) {
  const video = camera?.webcam;
  if (!video?.srcObject) return;
  video.srcObject.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
}

function cancelPredictionFrame() {
  if (predictionFrame !== null) cancelAnimationFrame(predictionFrame);
  predictionFrame = null;
}

function schedulePrediction() {
  if (pageActive && cameraRunning && webcam && model && !modelLoading && !predictionTask && predictionFrame === null) {
    predictionFrame = requestAnimationFrame(predictLoop);
  }
}

async function loadModel() {
  if (!pageActive || modelLoading || cameraStarting || playing) return false;
  const version = lifecycleVersion;
  let layersModel = null;
  modelLoading = true;
  cancelPredictionFrame();
  clearPrediction("모델 준비 중");
  updateControls();
  setModelStatus("모델을 불러오는 중…");
  setResult(modelLoadingMessage);
  try {
    if (!window.tmImage || !window.tf) throw new Error("로컬 AI 라이브러리를 불러오지 못했습니다.");
    if (predictionTask) await predictionTask;
    if (!pageActive || version !== lifecycleVersion) return false;
    // 메타데이터부터 검사해 실패한 로딩에 TensorFlow 모델이 남지 않게 합니다.
    const response = await fetch(METADATA_URL);
    if (!pageActive || version !== lifecycleVersion) return false;
    if (!response.ok) throw new Error("model/metadata.json 파일을 확인해주세요.");
    const metadata = await response.json();
    if (!pageActive || version !== lifecycleVersion) return false;
    validateClasses(metadata?.labels);
    layersModel = await tf.loadLayersModel(MODEL_URL);
    if (!pageActive || version !== lifecycleVersion) return false;
    const candidate = new tmImage.CustomMobileNet(layersModel, metadata);
    validateClasses(candidate.getClassLabels(), candidate.getTotalClasses());
    const previousModel = model;
    model = candidate;
    layersModel = null;
    disposeModel(previousModel?.model);
    predictionFailed = false;
    setModelStatus(`연결 완료 · 클래스 ${model.getTotalClasses()}개`);
    clearPrediction("모델 준비 완료");
    setResult(cameraRunning ? readyPrompt : cameraPrompt);
    return true;
  } catch (error) {
    if (!pageActive || version !== lifecycleVersion) return false;
    setModelStatus(`모델 연결 실패 · ${error.message || "model 폴더의 세 파일을 확인해주세요."}${model ? " 기존 모델을 계속 사용합니다." : ""}`, true);
    clearPrediction(model ? (predictionFailed ? "인식 오류" : "모델 준비 완료") : "모델 연결 실패");
    setResult(predictionFailed ? predictionErrorMessage
      : model ? "모델을 다시 불러오지 못했어요. 기존 모델로 계속 진행할 수 있어요."
      : "모델을 연결하지 못했어요. 설정에서 모델을 확인하고 다시 불러와주세요.");
    return false;
  } finally {
    disposeModel(layersModel);
    if (version === lifecycleVersion) {
      modelLoading = false;
      updateControls();
      schedulePrediction();
    }
  }
}

async function startCamera() {
  if (!pageActive || modelLoading || cameraStarting || cameraRunning) return;
  if (!model) {
    ui.settingsDialog.showModal();
    setModelStatus("model 폴더에 내보낸 모델 파일을 넣어주세요.", true);
    return;
  }
  const version = lifecycleVersion;
  let candidate = null;
  cameraStarting = true;
  updateControls();
  try {
    candidate = new tmImage.Webcam(WEBCAM_WIDTH, WEBCAM_HEIGHT, true);
    startingWebcam = candidate;
    await candidate.setup();
    if (!pageActive || version !== lifecycleVersion) return;
    await candidate.play();
    if (!pageActive || version !== lifecycleVersion) return;
    webcam = candidate;
    cameraRunning = true;
    renderCamera();
    ui.startButtonText.textContent = "승부하기";
    setResult(readyPrompt);
    schedulePrediction();
  } catch (error) {
    if (!pageActive || version !== lifecycleVersion) return;
    cameraRunning = false;
    webcam = null;
    renderCamera();
    setResult("카메라를 열 수 없어요. 브라우저의 카메라 권한을 확인해주세요.");
  } finally {
    if (webcam !== candidate) stopWebcam(candidate);
    if (version === lifecycleVersion) {
      cameraStarting = false;
      startingWebcam = null;
      updateControls();
    }
  }
}

function predictLoop() {
  predictionFrame = null;
  if (!pageActive || !cameraRunning || !webcam || !model || modelLoading || predictionTask) return;
  predictionTask = predictFrame().finally(() => {
    predictionTask = null;
    schedulePrediction();
  });
  return predictionTask;
}

async function predictFrame() {
  const activeModel = model;
  const activeWebcam = webcam;
  const version = lifecycleVersion;
  try {
    activeWebcam.update();
    const predictions = await activeModel.predict(activeWebcam.canvas);
    if (!pageActive || version !== lifecycleVersion || modelLoading) return;
    const best = predictions.reduce((a,b) => a.probability > b.probability ? a : b);
    const choice = normalizeClass(best.className);
    latestPrediction = choice ? { choice, confidence:best.probability } : null;
    ui.prediction.textContent = choice ? choices[choice].label : best.className;
    ui.confidence.textContent = `${Math.round(best.probability * 100)}%`;
    if (predictionFailed) {
      predictionFailed = false;
      updateControls();
      setResult(playing ? roundPrompt : "다시 손 모양을 인식하고 있어요. 준비됐다면 승부하기 버튼을 눌러주세요.");
    }
  } catch (error) {
    if (!pageActive || version !== lifecycleVersion || modelLoading) return;
    if (!predictionFailed) console.error("손 모양 추론에 실패했습니다.", error);
    predictionFailed = true;
    clearPrediction("인식 오류");
    updateControls();
    setResult(predictionErrorMessage);
  }
}

async function playRound() {
  if (!pageActive || !cameraRunning || playing || predictionFailed || modelLoading || !model) return;
  const version = lifecycleVersion;
  playing = true;
  try {
    updateControls();
    setResult(roundPrompt);
    for (const value of COUNTDOWN_VALUES) {
      ui.countdown.textContent = value;
      ui.countdown.classList.add("show");
      await delay(COUNTDOWN_VISIBLE_MS);
      if (!pageActive || version !== lifecycleVersion) return;
      ui.countdown.classList.remove("show");
      await delay(COUNTDOWN_GAP_MS);
      if (!pageActive || version !== lifecycleVersion) return;
    }
    if (predictionFailed || !latestPrediction || latestPrediction.confidence < MIN_PREDICTION_CONFIDENCE) {
      setResult(predictionFailed
        ? predictionErrorMessage
        : "손 모양이 잘 보이지 않아요. 다시 한번 보여주세요!");
      return;
    }
    const player = latestPrediction.choice;
    const computer = choiceNames[Math.floor(Math.random() * choiceNames.length)];
    const result = player === computer ? "draw" : choices[player].beats === computer ? "win" : "lose";
    score.rounds += 1;
    if (result === "win") score.player += 1;
    if (result === "lose") score.computer += 1;
    renderScores();
    renderComputerChoice(computer);
    setResult(`${choices[player].label} vs ${choices[computer].label} — ${roundMessages[result]}`, result);
    ui.startButtonText.textContent = "한 판 더";
  } catch (error) {
    if (!pageActive || version !== lifecycleVersion) return;
    console.error("승부 처리에 실패했습니다.", error);
    setResult(predictionFailed
      ? predictionErrorMessage
      : "승부를 진행하지 못했어요. 다시 시도해주세요.");
  } finally {
    if (version === lifecycleVersion) {
      playing = false;
      updateControls();
      clearCountdown();
    }
  }
}

window.addEventListener("pagehide", () => {
  pageActive = false;
  lifecycleVersion += 1;
  cancelPredictionFrame();
  stopWebcam(webcam);
  stopWebcam(startingWebcam);
  webcam = startingWebcam = null;
  cameraRunning = cameraStarting = modelLoading = playing = false;
  clearPrediction("모델 준비 중");
  predictionFailed = false;
  const previousModel = model;
  model = null;
  if (predictionTask) predictionTask.then(() => disposeModel(previousModel?.model));
  else disposeModel(previousModel?.model);
  renderCamera();
  clearCountdown();
  ui.startButtonText.textContent = "카메라 켜기";
  updateControls();
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  pageActive = true;
  loadModel();
});

ui.settingsButton.addEventListener("click", () => ui.settingsDialog.showModal());
ui.saveModelButton.addEventListener("click", async () => {
  if (await loadModel()) ui.settingsDialog.close();
});
ui.startButton.addEventListener("click", () => cameraRunning ? playRound() : startCamera());
ui.resetButton.addEventListener("click", () => {
  if (!pageActive || playing) return;
  score = { player:0, computer:0, rounds:0 };
  renderScores();
  renderComputerChoice();
  setResult(modelLoading ? modelLoadingMessage : predictionFailed
    ? predictionErrorMessage
    : cameraRunning ? "점수를 초기화했어요. 새로운 승부를 시작해요!" : cameraPrompt);
});

loadModel();
