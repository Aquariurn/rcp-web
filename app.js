const $ = (selector) => document.querySelector(selector);

const ui = {
  settingsButton: $("#settingsButton"), settingsDialog: $("#settingsDialog"),
  saveModelButton: $("#saveModelButton"), modelStatus: $("#modelStatus"), startButton: $("#startButton"),
  startButtonText: $("#startButtonText"), resetButton: $("#resetButton"), cameraFrame: $("#cameraFrame"),
  cameraPlaceholder: $("#cameraPlaceholder"), webcamContainer: $("#webcamContainer"), prediction: $("#prediction"),
  confidence: $("#confidence"), countdown: $("#countdown"), computerChoice: $("#computerChoice"),
  resultPanel: $("#resultPanel"), resultText: $("#resultText"), playerScore: $("#playerScore"),
  computerScore: $("#computerScore"), roundCount: $("#roundCount"), modelSource: $("#modelSource"),
  modelFileInput: $("#modelFileInput"), weightsFileInput: $("#weightsFileInput"),
  metadataFileInput: $("#metadataFileInput"), uploadModelButton: $("#uploadModelButton"),
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
const DEFAULT_MODEL_SOURCE = Object.freeze({ type:"bundled" });
const MAX_MODEL_JSON_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_WEIGHT_BYTES = 64 * 1024 * 1024;
const MAX_WEIGHT_FILES = 32;
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
let modelLoadingSource = null;
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
let activeModelSource = DEFAULT_MODEL_SOURCE;

function normalizeClass(className) {
  const label = typeof className === "string" ? className.trim().toLowerCase() : "";
  return Object.hasOwn(aliases, label) ? aliases[label] : null;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function selectedFiles(input) { return Array.from(input.files || []); }

function hasSelectedModelFiles() {
  return selectedFiles(ui.modelFileInput).length === 1
    && selectedFiles(ui.weightsFileInput).length > 0
    && selectedFiles(ui.metadataFileInput).length === 1;
}

function getSelectedModelSource() {
  if (!hasSelectedModelFiles()) {
    throw new Error("model.json, metadata.json, weights.bin을 함께 선택해주세요.");
  }
  return {
    type:"files",
    modelFile:selectedFiles(ui.modelFileInput)[0],
    weightFiles:selectedFiles(ui.weightsFileInput),
    metadataFile:selectedFiles(ui.metadataFileInput)[0],
  };
}

function setFileInputsInvalid(invalid) {
  const value = invalid ? "true" : "false";
  ui.modelFileInput.setAttribute("aria-invalid", value);
  ui.weightsFileInput.setAttribute("aria-invalid", value);
  ui.metadataFileInput.setAttribute("aria-invalid", value);
}

function fileBasename(path) {
  return typeof path === "string" ? path.replaceAll("\\", "/").split("/").pop() : "";
}

async function readJsonFile(file, label, maxBytes) {
  if (!file || file.size === 0) throw new Error(`${label} 파일이 비어 있어요.`);
  if (Number.isFinite(file.size) && file.size > maxBytes) throw new Error(`${label} 파일이 너무 커요.`);
  try { return JSON.parse(await file.text()); }
  catch (error) { throw new Error(`${label} 파일을 읽을 수 없어요. Teachable Machine에서 다시 내려받아주세요.`); }
}

function matchWeightFiles(modelDefinition, weightFiles) {
  if (!modelDefinition?.modelTopology || typeof modelDefinition.modelTopology !== "object"
    || !Array.isArray(modelDefinition.weightsManifest) || modelDefinition.weightsManifest.length === 0) {
    throw new Error("model.json이 Teachable Machine 모델 형식이 아니에요.");
  }
  const expectedNames = modelDefinition.weightsManifest.flatMap((group) => Array.isArray(group.paths) ? group.paths.map(fileBasename) : []);
  if (expectedNames.length === 0 || expectedNames.some((name) => !name) || new Set(expectedNames).size !== expectedNames.length) {
    throw new Error("model.json의 가중치 목록을 확인할 수 없어요.");
  }
  const filesByName = new Map();
  if (weightFiles.length > MAX_WEIGHT_FILES) throw new Error(`가중치 파일은 최대 ${MAX_WEIGHT_FILES}개까지 선택할 수 있어요.`);
  const totalBytes = weightFiles.reduce((total, file) => total + (Number.isFinite(file?.size) ? file.size : 0), 0);
  if (totalBytes > MAX_WEIGHT_BYTES) throw new Error("가중치 파일의 전체 크기는 64MB 이하여야 해요.");
  for (const file of weightFiles) {
    if (!file || file.size === 0) throw new Error("가중치 파일이 비어 있어요.");
    if (filesByName.has(file.name)) throw new Error(`가중치 파일 ${file.name}이 중복으로 선택됐어요.`);
    filesByName.set(file.name, file);
  }
  const missing = expectedNames.filter((name) => !filesByName.has(name));
  const extra = [...filesByName.keys()].filter((name) => !expectedNames.includes(name));
  if (missing.length || extra.length) {
    throw new Error("model.json과 가중치 파일이 서로 맞지 않아요. 같은 다운로드 묶음의 파일을 선택해주세요.");
  }
  return expectedNames.map((name) => filesByName.get(name));
}

function updateControls() {
  const busy = !pageActive || modelLoading || cameraStarting || playing;
  ui.startButton.disabled = busy || !model || predictionFailed;
  ui.saveModelButton.disabled = busy;
  ui.uploadModelButton.disabled = busy || !hasSelectedModelFiles();
  ui.modelFileInput.disabled = busy;
  ui.weightsFileInput.disabled = busy;
  ui.metadataFileInput.disabled = busy;
  ui.resetButton.disabled = !pageActive || playing;
  ui.uploadModelButton.textContent = modelLoadingSource === "files" ? "모델 확인 중…" : "선택한 모델 적용";
  ui.saveModelButton.textContent = modelLoadingSource === "bundled" ? "기본 모델 불러오는 중…" : "기본 모델 사용";
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

function validateMetadata(metadata) {
  validateClasses(metadata?.labels);
  const imageSize = metadata?.imageSize ?? window.tmImage.IMAGE_SIZE ?? 224;
  if (!Number.isInteger(imageSize) || imageSize <= 0 || imageSize > 4096) {
    throw new Error("metadata.json의 이미지 크기 정보가 올바르지 않아요.");
  }
  if (metadata?.grayscale !== undefined && typeof metadata.grayscale !== "boolean") {
    throw new Error("metadata.json의 색상 채널 정보가 올바르지 않아요.");
  }
}

function validateModelInput(layersModel, metadata) {
  const imageSize = metadata?.imageSize ?? window.tmImage.IMAGE_SIZE ?? 224;
  const channels = metadata?.grayscale === true ? 1 : 3;
  const shape = layersModel?.inputs?.[0]?.shape;
  const outputShape = layersModel?.outputs?.[0]?.shape;
  if ((metadata?.grayscale !== undefined && typeof metadata.grayscale !== "boolean")
    || !Number.isInteger(imageSize) || imageSize <= 0
    || layersModel?.inputs?.length !== 1 || !Array.isArray(shape) || shape.length !== 4
    || (shape[0] !== null && shape[0] !== 1) || shape[1] !== imageSize || shape[2] !== imageSize || shape[3] !== channels
    || layersModel?.outputs?.length !== 1 || !Array.isArray(outputShape) || outputShape.length !== 2
    || (outputShape[0] !== null && outputShape[0] !== 1) || outputShape[1] !== choiceNames.length) {
    throw new Error("모델의 입력·출력 규격과 metadata.json 정보가 서로 맞지 않아요.");
  }
}

function modelSourceName(source, metadata) {
  if (source.type === "bundled") return "기본 모델";
  const name = typeof metadata?.modelName === "string" ? metadata.modelName.trim() : "";
  return name ? `업로드 · ${name.slice(0, 60)}` : "업로드 모델";
}

async function loadModelAssets(source, isCurrent) {
  let metadata;
  let layersModel;
  if (source.type === "files") {
    metadata = await readJsonFile(source.metadataFile, "metadata.json", MAX_METADATA_BYTES);
    if (!isCurrent()) return null;
    validateMetadata(metadata);
    const modelDefinition = await readJsonFile(source.modelFile, "model.json", MAX_MODEL_JSON_BYTES);
    if (!isCurrent()) return null;
    const orderedWeights = matchWeightFiles(modelDefinition, source.weightFiles);
    try { layersModel = await tf.loadLayersModel(tf.io.browserFiles([source.modelFile, ...orderedWeights])); }
    catch (error) {
      console.error("업로드한 모델 파일을 불러오지 못했습니다.", error);
      throw new Error("model.json과 가중치 파일이 서로 맞지 않아요. 같은 다운로드 묶음의 파일을 선택해주세요.");
    }
  } else {
    const response = await fetch(METADATA_URL);
    if (!isCurrent()) return null;
    if (!response.ok) throw new Error("model/metadata.json 파일을 확인해주세요.");
    metadata = await response.json();
    if (!isCurrent()) return null;
    validateMetadata(metadata);
    layersModel = await tf.loadLayersModel(MODEL_URL);
  }
  return { layersModel, metadata };
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

async function loadModel(source = DEFAULT_MODEL_SOURCE) {
  if (!pageActive || modelLoading || cameraStarting || playing) return false;
  const version = lifecycleVersion;
  let layersModel = null;
  const isCurrent = () => pageActive && version === lifecycleVersion;
  modelLoading = true;
  modelLoadingSource = source.type;
  if (!model) ui.modelSource.textContent = "확인 중";
  cancelPredictionFrame();
  clearPrediction("모델 준비 중");
  updateControls();
  setModelStatus("모델을 불러오는 중…");
  setResult(modelLoadingMessage);
  try {
    if (!window.tmImage || !window.tf || !window.tf.io) throw new Error("로컬 AI 라이브러리를 불러오지 못했습니다.");
    if (predictionTask) await predictionTask;
    if (!isCurrent()) return false;
    // 파일과 메타데이터를 먼저 검사해 실패한 로딩에 TensorFlow 모델이 남지 않게 합니다.
    const loaded = await loadModelAssets(source, isCurrent);
    if (!loaded) return false;
    ({ layersModel } = loaded);
    const { metadata } = loaded;
    if (!isCurrent()) return false;
    validateModelInput(layersModel, metadata);
    const candidate = new tmImage.CustomMobileNet(layersModel, metadata);
    validateClasses(candidate.getClassLabels(), candidate.getTotalClasses());
    const previousModel = model;
    model = candidate;
    layersModel = null;
    disposeModel(previousModel?.model);
    activeModelSource = source;
    predictionFailed = false;
    const sourceName = modelSourceName(source, metadata);
    ui.modelSource.textContent = sourceName;
    setFileInputsInvalid(false);
    setModelStatus(`연결 완료 · ${sourceName} · 클래스 ${model.getTotalClasses()}개`);
    clearPrediction("모델 준비 완료");
    setResult(cameraRunning ? readyPrompt : cameraPrompt);
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    if (source.type === "files") setFileInputsInvalid(true);
    if (!model) ui.modelSource.textContent = "연결 안 됨";
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
      modelLoadingSource = null;
      updateControls();
      schedulePrediction();
    }
  }
}

async function loadUploadedModel() {
  try { return await loadModel(getSelectedModelSource()); }
  catch (error) {
    setFileInputsInvalid(true);
    setModelStatus(error.message, true);
    return false;
  }
}

async function startCamera() {
  if (!pageActive || modelLoading || cameraStarting || cameraRunning) return;
  if (!model) {
    ui.settingsDialog.showModal();
    setModelStatus("설정에서 기본 모델을 다시 불러오거나 내 모델 파일을 선택해주세요.", true);
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
  modelLoadingSource = null;
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
  loadModel(activeModelSource);
});

ui.settingsButton.addEventListener("click", () => ui.settingsDialog.showModal());
for (const input of [ui.modelFileInput, ui.weightsFileInput, ui.metadataFileInput]) {
  input.addEventListener("change", () => {
    setFileInputsInvalid(false);
    updateControls();
    const selectedCount = selectedFiles(ui.modelFileInput).length
      + selectedFiles(ui.weightsFileInput).length
      + selectedFiles(ui.metadataFileInput).length;
    if (hasSelectedModelFiles()) setModelStatus(`${selectedCount}개 파일을 선택했습니다. 적용할 준비가 됐어요.`);
    else if (selectedCount > 0) setModelStatus("model.json, metadata.json, 모든 가중치 파일을 선택해주세요.");
  });
}
ui.uploadModelButton.addEventListener("click", async () => {
  await loadUploadedModel();
});
ui.saveModelButton.addEventListener("click", async () => {
  await loadModel(DEFAULT_MODEL_SOURCE);
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
