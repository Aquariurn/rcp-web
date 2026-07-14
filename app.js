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

let model = null;
let webcam = null;
let cameraRunning = false;
let playing = false;
let latestPrediction = null;
let score = { player:0, computer:0, rounds:0 };

function normalizeClass(className) { return aliases[className.trim().toLowerCase()] || aliases[className.trim()] || null; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function loadModel() {
  if (!window.tmImage) throw new Error("로컬 AI 라이브러리를 불러오지 못했습니다.");
  ui.modelStatus.classList.remove("error");
  ui.modelStatus.textContent = "모델을 불러오는 중…";
  model = await tmImage.load("model/model.json", "model/metadata.json");
  ui.modelStatus.textContent = `연결 완료 · 클래스 ${model.getTotalClasses()}개`;
  ui.prediction.textContent = "모델 준비 완료";
  return model;
}

async function startCamera() {
  if (!model) {
    ui.settingsDialog.showModal();
    ui.modelStatus.classList.add("error");
    ui.modelStatus.textContent = "model 폴더에 내보낸 모델 파일을 넣어주세요.";
    return;
  }
  ui.startButton.disabled = true;
  try {
    webcam = new tmImage.Webcam(480, 360, true);
    await webcam.setup();
    await webcam.play();
    ui.webcamContainer.replaceChildren(webcam.canvas);
    ui.cameraPlaceholder.hidden = true;
    ui.cameraFrame.classList.add("active");
    cameraRunning = true;
    ui.startButtonText.textContent = "승부하기";
    ui.resultText.textContent = "준비됐다면 승부하기 버튼을 눌러주세요.";
    requestAnimationFrame(predictLoop);
  } catch (error) {
    ui.resultText.textContent = "카메라를 열 수 없어요. 브라우저의 카메라 권한을 확인해주세요.";
  } finally { ui.startButton.disabled = false; }
}

async function predictLoop() {
  if (!cameraRunning || !webcam) return;
  webcam.update();
  const predictions = await model.predict(webcam.canvas);
  const best = predictions.reduce((a,b) => a.probability > b.probability ? a : b);
  const choice = normalizeClass(best.className);
  latestPrediction = choice ? { choice, confidence:best.probability } : null;
  ui.prediction.textContent = choice ? choices[choice].label : best.className;
  ui.confidence.textContent = `${Math.round(best.probability * 100)}%`;
  requestAnimationFrame(predictLoop);
}

async function playRound() {
  if (playing) return;
  playing = true;
  ui.startButton.disabled = true;
  ui.resultPanel.className = "result-panel";
  ui.resultText.textContent = "가위, 바위, 보! 손 모양을 유지하세요.";
  for (const value of [3,2,1]) {
    ui.countdown.textContent = value;
    ui.countdown.classList.add("show");
    await delay(650);
    ui.countdown.classList.remove("show");
    await delay(120);
  }
  if (!latestPrediction || latestPrediction.confidence < 0.55) {
    ui.resultText.textContent = "손 모양이 잘 보이지 않아요. 다시 한번 보여주세요!";
    ui.startButton.disabled = false;
    playing = false;
    return;
  }
  const player = latestPrediction.choice;
  const computer = Object.keys(choices)[Math.floor(Math.random() * 3)];
  const result = player === computer ? "draw" : choices[player].beats === computer ? "win" : "lose";
  score.rounds += 1;
  if (result === "win") score.player += 1;
  if (result === "lose") score.computer += 1;
  ui.playerScore.textContent = score.player;
  ui.computerScore.textContent = score.computer;
  ui.roundCount.textContent = score.rounds;
  ui.computerChoice.innerHTML = `<span class="choice-emoji">${choices[computer].emoji}</span><p>${choices[computer].label}</p>`;
  ui.computerChoice.classList.remove("reveal");
  void ui.computerChoice.offsetWidth;
  ui.computerChoice.classList.add("reveal");
  const messages = { win:"당신의 승리! 멋진 한 수였어요.", lose:"컴퓨터의 승리! 다시 도전해보세요.", draw:"무승부! 마음이 통했네요." };
  ui.resultPanel.className = `result-panel ${result}`;
  ui.resultText.textContent = `${choices[player].label} vs ${choices[computer].label} — ${messages[result]}`;
  ui.startButton.disabled = false;
  ui.startButtonText.textContent = "한 판 더";
  playing = false;
}

ui.settingsButton.addEventListener("click", () => ui.settingsDialog.showModal());
ui.saveModelButton.addEventListener("click", async () => {
  ui.saveModelButton.disabled = true;
  try { await loadModel(); await delay(350); ui.settingsDialog.close(); }
  catch (error) { ui.modelStatus.classList.add("error"); ui.modelStatus.textContent = "모델을 불러오지 못했습니다. model 폴더의 세 파일을 확인해주세요."; }
  finally { ui.saveModelButton.disabled = false; }
});
ui.startButton.addEventListener("click", () => cameraRunning ? playRound() : startCamera());
ui.resetButton.addEventListener("click", () => {
  score = { player:0, computer:0, rounds:0 };
  ui.playerScore.textContent = ui.computerScore.textContent = ui.roundCount.textContent = "0";
  ui.computerChoice.innerHTML = '<span class="choice-emoji">?</span><p>아직 고민 중…</p>';
  ui.resultPanel.className = "result-panel";
  ui.resultText.textContent = cameraRunning ? "점수를 초기화했어요. 새로운 승부를 시작해요!" : "카메라를 켜면 게임을 시작할 수 있어요.";
});

loadModel().catch(() => {
  ui.prediction.textContent = "모델 파일 필요";
  ui.modelStatus.classList.add("error");
  ui.modelStatus.textContent = "model 폴더에 model.json, metadata.json, weights.bin을 넣어주세요.";
});
