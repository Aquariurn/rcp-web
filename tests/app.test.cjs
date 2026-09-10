const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeFile(name, contents, { type = "application/octet-stream", size } = {}) {
  const initialText = typeof contents === "string" ? contents : JSON.stringify(contents);
  return {
    name, type, size: size ?? Buffer.byteLength(initialText ?? ""),
    async text() {
      const value = contents?.promise ? await contents.promise : contents;
      if (value instanceof Error) throw value;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

function uploadedFiles({ metadata, modelDefinition, weightFiles } = {}) {
  const definition = modelDefinition ?? {
    modelTopology: { class_name: "Model" },
    weightsManifest: [{ paths: ["weights.bin"], weights: [] }],
  };
  const expectedWeights = definition.weightsManifest?.flatMap((group) => group.paths || []) ?? [];
  return {
    modelFile: fakeFile("model.json", definition, { type: "application/json" }),
    weightFiles: weightFiles ?? expectedWeights.map((filePath) => fakeFile(path.basename(filePath), "weights")),
    metadataFile: fakeFile("metadata.json", metadata ?? {
      labels: ["가위", "바위", "보"], imageSize: 224, modelName: "사용자 모델",
    }, { type: "application/json" }),
  };
}

function element() {
  const listeners = new Map();
  const classes = new Set();
  let text = "";
  return {
    disabled: false, hidden: false, innerHTML: "", children: [], offsetWidth: 0, files: [], value: "",
    get textContent() { return text; },
    set textContent(value) { text = String(value); },
    get className() { return [...classes].join(" "); },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes?.[name] ?? null; },
    dispatch(name, event = {}) { return listeners.get(name)?.map((listener) => listener(event)); },
    replaceChildren(...children) { this.children = children; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function makeModel(name, { labels = ["가위", "바위", "보"], count = labels.length,
  inputShape = [null, 224, 224, 3], outputShape = [null, count], events = [] } = {}) {
  const control = { error: null, pending: null, predictions: [{ className: "바위", probability: 0.96 }] };
  return {
    name, control, disposed: 0,
    getClassLabels: () => labels,
    getTotalClasses: () => count,
    async predict() {
      events.push(`${name}:predict:start`);
      if (control.error) throw control.error;
      const predictions = control.pending ? await control.pending.promise : control.predictions;
      events.push(`${name}:predict:end`);
      return predictions;
    },
    model: {
      inputs: [{ shape: inputShape }],
      outputs: [{ shape: outputShape }],
      getWeights: () => [],
      dispose() { events.push(`${name}:dispose`); this.owner.disposed += 1; },
    },
  };
}

function fixture({ initial, events = [] } = {}) {
  const defaultModel = makeModel("initial", { events });
  defaultModel.model.owner = defaultModel;
  const loads = [initial ?? defaultModel];
  const localLoads = [];
  const browserFileLoads = [];
  const elements = new Map();
  const frames = new Map();
  const timers = new Map();
  const cameras = [];
  const page = element();
  const control = { loadCalls: 0, timerCalls: 0, timerErrorAt: 0, setup: null, play: null, updateError: null };
  let nextId = 1;
  let preparedLoad;
  const tf = {
    dispose(weights) { weights.forEach((weight) => weight.dispose()); },
    io: {
      browserFiles(files) {
        events.push("browser-files");
        browserFileLoads.push(files);
        return { type: "browser-files", files };
      },
    },
    async loadLayersModel(source) {
      control.loadCalls += 1;
      const result = source?.type === "browser-files" ? localLoads.shift() : preparedLoad;
      if (!result) throw new Error("unexpected model load");
      if (result instanceof Error) throw result;
      const loaded = result?.promise ? await result.promise : result;
      return loaded.model;
    },
  };
  const tmImage = {
    CustomMobileNet: class {
      constructor(layers, metadata) {
        if (control.constructorError) throw control.constructorError;
        const wrapped = layers.owner;
        wrapped.getClassLabels = () => metadata.labels;
        return wrapped;
      }
    },
    Webcam: class {
      constructor() { this.canvas = {}; this.tracks = [{ stops: 0, stop() { this.stops += 1; } }]; cameras.push(this); }
      async setup() {
        if (control.setup) await control.setup.promise;
        this.webcam = { srcObject: { getTracks: () => this.tracks }, pause() {} };
        events.push("camera:setup");
        if (control.setupError) throw control.setupError;
      }
      async play() {
        events.push("camera:play");
        if (control.play) await control.play.promise;
        if (control.playError) throw control.playError;
      }
      update() { if (control.updateError) throw control.updateError; }
      stop() {
        if (!this.webcam?.srcObject) return;
        this.webcam.srcObject.getTracks().forEach((track) => track.stop());
        this.webcam.srcObject = null;
        events.push("camera:stop");
      }
      pause() {}
    },
  };
  const context = vm.createContext({
    window: { tmImage, tf, addEventListener: page.addEventListener.bind(page) }, tmImage, tf,
    async fetch() {
      assert.ok(loads.length, "unexpected concurrent or duplicate metadata load");
      const job = loads.shift();
      if (control.metadataPending) await control.metadataPending.promise;
      if (control.metadataError) throw control.metadataError;
      preparedLoad = job;
      return {
        ok: !control.metadataHttpError,
        async json() {
          if (control.metadataJsonError) throw control.metadataJsonError;
          return { labels: job.getClassLabels ? job.getClassLabels() : defaultModel.getClassLabels(), imageSize: 224 };
        },
      };
    },
    document: { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); } },
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) {
      control.timerCalls += 1;
      if (control.timerCalls === control.timerErrorAt) throw new Error("injected timer failure");
      const id = nextId++; timers.set(id, callback); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { error() {}, warn() {}, log() {} },
  });
  vm.runInContext(source, context, { filename: "app.js" });
  const run = (code) => vm.runInContext(code, context);
  const ui = (id) => elements.get(`#${id}`);
  function beginFrame() {
    assert.equal(frames.size, 1, "only one prediction frame should be queued");
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    return callback();
  }
  async function frame() { await beginFrame(); await flush(); }
  async function tick() {
    assert.equal(timers.size, 1, "one countdown wait should be pending");
    const [id, callback] = timers.entries().next().value;
    timers.delete(id); callback(); await flush();
  }
  async function finish(operation, onWait = () => {}) {
    let settled = false, rejected;
    Promise.resolve(operation).then(() => { settled = true; }, (error) => { settled = true; rejected = error; });
    await flush();
    for (let i = 0; !settled && i < 12; i++) { onWait(); await tick(); }
    assert.equal(settled, true, "operation should finish without stranded promises");
    if (rejected) throw rejected;
  }
  function candidate(name, options = {}) {
    const model = makeModel(name, { ...options, events });
    model.model.owner = model;
    return model;
  }
  return { control, defaultModel, candidate, loads, localLoads, browserFileLoads, ui, run, frames, timers, cameras, events, beginFrame, frame, tick, finish,
    hide: () => page.dispatch("pagehide", { persisted: false }),
    show: () => page.dispatch("pageshow", { persisted: true }),
  };
}

async function runningFixture() {
  const f = fixture();
  await flush();
  await f.run("startCamera()");
  await f.frame();
  return f;
}

function selectUploadedFiles(f, { modelFile = [], weightFiles = [], metadataFile = [] } = {}) {
  f.ui("modelFileInput").files = Array.isArray(modelFile) ? modelFile : [modelFile];
  f.ui("weightsFileInput").files = weightFiles;
  f.ui("metadataFileInput").files = Array.isArray(metadataFile) ? metadataFile : [metadataFile];
  for (const id of ["modelFileInput", "weightsFileInput", "metadataFileInput"]) {
    f.ui(id).dispatch("change");
  }
}

async function clickAndWait(f, id) {
  await Promise.all(f.ui(id).dispatch("click") ?? []);
  await flush();
}

function scores(f) { return ["playerScore", "computerScore", "roundCount"].map((id) => Number(f.ui(id).textContent)); }

function assertRoundFinished(f, { failed = false } = {}) {
  assert.equal(f.ui("resetButton").disabled, false);
  assert.equal(f.ui("startButton").disabled, failed);
  assert.equal(f.ui("countdown").classList.contains("show"), false);
  assert.equal(f.ui("countdown").textContent, "");
}

function protectReset(f) {
  assert.equal(f.ui("startButton").disabled, true);
  assert.equal(f.ui("resetButton").disabled, true);
  const before = [scores(f), f.ui("resultText").textContent, f.ui("countdown").textContent];
  f.ui("resetButton").dispatch("click");
  assert.deepEqual([scores(f), f.ui("resultText").textContent, f.ui("countdown").textContent], before);
}

test("initial model load disables play and prevents duplicate loads", async () => {
  const initial = deferred();
  const f = fixture({ initial });
  assert.equal(f.ui("startButton").disabled, true);
  assert.equal(f.ui("saveModelButton").disabled, true);
  assert.match(f.ui("modelStatus").textContent, /불러오는|로딩/);
  const duplicate = f.run("loadModel()");
  await flush();
  assert.equal(f.control.loadCalls, 1);
  initial.resolve(f.defaultModel);
  await duplicate;
  await flush();
  assert.equal(f.ui("startButton").disabled, false);
  assert.equal(f.ui("saveModelButton").disabled, false);
  assert.match(f.ui("modelStatus").textContent, /완료/);
});

test("failed initial load displays failure and keeps play unavailable", async () => {
  const f = fixture({ initial: new Error("missing model") });
  await flush();
  assert.equal(f.ui("startButton").disabled, true);
  assert.equal(f.ui("saveModelButton").disabled, false);
  assert.equal(f.ui("modelSource").textContent, "연결 안 됨");
  assert.equal(f.ui("modelStatus").classList.contains("error"), true);
  assert.match(f.ui("modelStatus").textContent, /실패|불러오지 못|확인/);
});

for (const [name, labels] of [
  ["Korean labels", ["가위", "바위", "보"]],
  ["case and whitespace aliases", [" SCISSOR ", "주먹", "Palm"]],
]) {
  test(`model validation accepts ${name}`, async () => {
    const f = fixture(); await flush();
    const candidate = f.candidate("replacement", { labels });
    f.loads.push(candidate);
    await f.run("loadModel()");
    assert.equal(candidate.disposed, 0);
    assert.equal(f.defaultModel.disposed, 1);
    assert.equal(f.ui("modelStatus").classList.contains("error"), false);
  });
}

for (const [name, options] of [
  ["missing class", { labels: ["가위", "바위"] }],
  ["duplicate alias", { labels: ["가위", "바위", "rock"] }],
  ["unsupported class", { labels: ["가위", "바위", "background"] }],
  ["inherited property name", { labels: ["가위", "바위", "__proto__"] }],
  ["class count mismatch", { labels: ["가위", "바위", "보"], count: 4 }],
  ["non-string label", { labels: ["가위", "바위", null] }],
]) {
  test(`invalid model (${name}) is rejected while the working model survives`, async () => {
    const f = await runningFixture();
    const candidate = f.candidate("invalid", options);
    f.loads.push(candidate);
    await Promise.resolve(f.run("loadModel()")).catch(() => {});
    await flush();
    const loadedLayers = name === "class count mismatch";
    assert.equal(candidate.disposed, loadedLayers ? 1 : 0);
    assert.equal(f.control.loadCalls, loadedLayers ? 2 : 1, "invalid metadata must be rejected before allocating a model");
    assert.equal(f.defaultModel.disposed, 0);
    assert.equal(f.ui("modelStatus").classList.contains("error"), true);
    await f.frame();
    assert.equal(f.ui("prediction").textContent, "바위");
    assert.equal(f.ui("startButton").disabled, false);
  });
}

test("network failure during reload preserves the previous working model", async () => {
  const f = await runningFixture();
  f.loads.push(new Error("injected load failure"));
  await Promise.resolve(f.run("loadModel()")).catch(() => {});
  await flush();
  assert.equal(f.defaultModel.disposed, 0);
  assert.equal(f.ui("modelStatus").classList.contains("error"), true);
  await f.frame();
  assert.equal(f.ui("prediction").textContent, "바위");
});

test("model replacement waits for the old model's in-flight prediction before disposal", async () => {
  const f = await runningFixture();
  const pending = deferred();
  f.defaultModel.control.pending = pending;
  const prediction = f.beginFrame();
  await flush();
  const candidate = f.candidate("replacement");
  candidate.control.predictions = [{ className: "보", probability: 0.99 }];
  f.loads.push(candidate);
  const replacement = f.run("loadModel()");
  await flush();
  assert.equal(f.defaultModel.disposed, 0);
  pending.resolve([{ className: "바위", probability: 0.96 }]);
  await prediction;
  await replacement;
  assert.equal(f.defaultModel.disposed, 1);
  assert.ok(f.events.lastIndexOf("initial:predict:end") < f.events.indexOf("initial:dispose"));
  await f.frame();
  assert.equal(f.ui("prediction").textContent, "보");
});

test("upload controls require one model, at least one weight, and one metadata file", async () => {
  const f = fixture(); await flush();
  const files = uploadedFiles();
  const modelInput = f.ui("modelFileInput");
  const weightsInput = f.ui("weightsFileInput");
  const metadataInput = f.ui("metadataFileInput");

  assert.equal(f.ui("uploadModelButton").disabled, true);
  modelInput.files = [files.modelFile]; modelInput.dispatch("change");
  assert.equal(f.ui("uploadModelButton").disabled, true);
  weightsInput.files = files.weightFiles; weightsInput.dispatch("change");
  assert.equal(f.ui("uploadModelButton").disabled, true);
  metadataInput.files = [files.metadataFile]; metadataInput.dispatch("change");
  assert.equal(f.ui("uploadModelButton").disabled, false);
  assert.match(f.ui("modelStatus").textContent, /3개.*준비/);
  assert.equal(modelInput.getAttribute("aria-invalid"), "false");

  weightsInput.files = []; weightsInput.dispatch("change");
  assert.equal(f.ui("uploadModelButton").disabled, true);
  assert.match(f.ui("modelStatus").textContent, /함께|모든 가중치/);
});

test("valid uploaded files replace the model in manifest order and keep the dialog open", async () => {
  const f = await runningFixture();
  const firstWeight = fakeFile("first.bin", "first");
  const secondWeight = fakeFile("second.bin", "second");
  const files = uploadedFiles({
    modelDefinition: {
      modelTopology: { class_name: "Model" },
      weightsManifest: [
        { paths: ["weights/first.bin"], weights: [] },
        { paths: ["second.bin"], weights: [] },
      ],
    },
    weightFiles: [secondWeight, firstWeight],
  });
  const candidate = f.candidate("uploaded");
  candidate.control.predictions = [{ className: "보", probability: 0.99 }];
  f.localLoads.push(candidate);
  selectUploadedFiles(f, files);
  f.ui("settingsDialog").showModal();

  await clickAndWait(f, "uploadModelButton");

  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(candidate.disposed, 0);
  assert.equal(f.ui("settingsDialog").open, true);
  assert.equal(f.ui("modelSource").textContent, "업로드 · 사용자 모델");
  assert.equal(f.ui("modelStatus").classList.contains("error"), false);
  assert.equal(f.browserFileLoads.length, 1);
  assert.equal(f.browserFileLoads[0][0], files.modelFile);
  assert.deepEqual(Array.from(f.browserFileLoads[0], (file) => file.name), ["model.json", "first.bin", "second.bin"]);
  await f.frame();
  assert.equal(f.ui("prediction").textContent, "보");
});

test("missing upload files are rejected before model allocation", async () => {
  const f = fixture(); await flush();
  const files = uploadedFiles();
  const selections = [
    { weightFiles: files.weightFiles, metadataFile: files.metadataFile },
    { modelFile: files.modelFile, metadataFile: files.metadataFile },
    { modelFile: files.modelFile, weightFiles: files.weightFiles },
  ];

  for (const selection of selections) {
    selectUploadedFiles(f, selection);
    assert.equal(await f.run("loadUploadedModel()"), false);
    assert.equal(f.ui("uploadModelButton").disabled, true);
    assert.equal(f.ui("modelFileInput").getAttribute("aria-invalid"), "true");
    assert.match(f.ui("modelStatus").textContent, /함께 선택/);
  }
  assert.equal(f.control.loadCalls, 1);
  assert.equal(f.browserFileLoads.length, 0);
  assert.equal(f.defaultModel.disposed, 0);
});

test("malformed metadata and model JSON preserve the working model", async () => {
  for (const invalidPart of ["metadata", "model"]) {
    const f = await runningFixture();
    const files = uploadedFiles();
    if (invalidPart === "metadata") files.metadataFile = fakeFile("metadata.json", "{ broken", { type: "application/json" });
    else files.modelFile = fakeFile("model.json", "{ broken", { type: "application/json" });
    selectUploadedFiles(f, files);

    await clickAndWait(f, "uploadModelButton");

    assert.equal(f.browserFileLoads.length, 0);
    assert.equal(f.defaultModel.disposed, 0);
    assert.equal(f.ui("modelSource").textContent, "기본 모델");
    assert.equal(f.ui("modelStatus").classList.contains("error"), true);
    assert.match(f.ui("modelStatus").textContent, new RegExp(`${invalidPart === "metadata" ? "metadata" : "model"}\\.json`));
    await f.frame();
    assert.equal(f.ui("prediction").textContent, "바위");
  }
});

test("oversized uploaded files are rejected before TensorFlow loading", async () => {
  const cases = [
    (files) => { files.metadataFile = fakeFile("metadata.json", {}, { size: 256 * 1024 + 1 }); },
    (files) => { files.modelFile = fakeFile("model.json", {}, { size: 5 * 1024 * 1024 + 1 }); },
    (files) => { files.weightFiles = [fakeFile("weights.bin", "weights", { size: 64 * 1024 * 1024 + 1 })]; },
  ];

  for (const makeOversized of cases) {
    const f = await runningFixture();
    const files = uploadedFiles();
    makeOversized(files);
    selectUploadedFiles(f, files);

    await clickAndWait(f, "uploadModelButton");

    assert.equal(f.browserFileLoads.length, 0);
    assert.equal(f.defaultModel.disposed, 0);
    assert.match(f.ui("modelStatus").textContent, /너무 커요|64MB/);
    await f.frame();
    assert.equal(f.ui("prediction").textContent, "바위");
  }
});

test("a weights manifest mismatch is rejected before TensorFlow loading", async () => {
  const f = await runningFixture();
  const files = uploadedFiles({
    modelDefinition: {
      modelTopology: { class_name: "Model" },
      weightsManifest: [{ paths: ["expected.bin"], weights: [] }],
    },
    weightFiles: [fakeFile("different.bin", "weights")],
  });
  selectUploadedFiles(f, files);

  await clickAndWait(f, "uploadModelButton");

  assert.equal(f.browserFileLoads.length, 0);
  assert.equal(f.control.loadCalls, 1);
  assert.equal(f.defaultModel.disposed, 0);
  assert.match(f.ui("modelStatus").textContent, /가중치.*맞지/);
  await f.frame();
});

test("invalid uploaded labels are rejected before reading model weights", async () => {
  const f = await runningFixture();
  const files = uploadedFiles({ metadata: { labels: ["가위", "바위", "배경"], imageSize: 224 } });
  selectUploadedFiles(f, files);

  await clickAndWait(f, "uploadModelButton");

  assert.equal(f.browserFileLoads.length, 0);
  assert.equal(f.control.loadCalls, 1);
  assert.equal(f.defaultModel.disposed, 0);
  assert.match(f.ui("modelStatus").textContent, /가위, 바위, 보/);
  await f.frame();
});

test("an uploaded model with an incompatible input or output shape is disposed while the working model survives", async () => {
  for (const options of [
    { inputShape: [null, 192, 192, 3] },
    { outputShape: [null, 1, 3] },
  ]) {
    const f = await runningFixture();
    const files = uploadedFiles();
    const candidate = f.candidate("wrong-shape", options);
    f.localLoads.push(candidate);
    selectUploadedFiles(f, files);

    await clickAndWait(f, "uploadModelButton");

    assert.equal(f.browserFileLoads.length, 1);
    assert.equal(candidate.disposed, 1);
    assert.equal(f.defaultModel.disposed, 0);
    assert.equal(f.ui("modelSource").textContent, "기본 모델");
    assert.match(f.ui("modelStatus").textContent, /입력·출력 규격/);
    await f.frame();
    assert.equal(f.ui("prediction").textContent, "바위");
  }
});

test("a local TensorFlow load failure preserves the working model", async () => {
  const f = await runningFixture();
  const files = uploadedFiles();
  f.localLoads.push(new Error("injected local load failure"));
  selectUploadedFiles(f, files);

  await clickAndWait(f, "uploadModelButton");

  assert.equal(f.browserFileLoads.length, 1);
  assert.equal(f.defaultModel.disposed, 0);
  assert.equal(f.ui("modelSource").textContent, "기본 모델");
  assert.equal(f.ui("modelStatus").classList.contains("error"), true);
  await f.frame();
  assert.equal(f.ui("prediction").textContent, "바위");
});

test("duplicate upload clicks start only one local model load", async () => {
  const f = fixture(); await flush();
  const files = uploadedFiles();
  const pending = deferred();
  const candidate = f.candidate("uploaded");
  f.localLoads.push(pending);
  selectUploadedFiles(f, files);

  const firstClick = f.ui("uploadModelButton").dispatch("click") ?? [];
  const secondClick = f.ui("uploadModelButton").dispatch("click") ?? [];
  await flush();

  assert.equal(f.browserFileLoads.length, 1);
  assert.equal(f.control.loadCalls, 2);
  assert.equal(f.ui("uploadModelButton").disabled, true);
  assert.equal(f.ui("modelFileInput").disabled, true);
  pending.resolve(candidate);
  await Promise.all([...firstClick, ...secondClick]);
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(candidate.disposed, 0);
});

test("upload waits for an in-flight prediction before replacing its model", async () => {
  const f = await runningFixture();
  const predictionPending = deferred();
  f.defaultModel.control.pending = predictionPending;
  const prediction = f.beginFrame();
  await flush();
  const candidate = f.candidate("uploaded");
  candidate.control.predictions = [{ className: "가위", probability: 0.98 }];
  f.localLoads.push(candidate);
  selectUploadedFiles(f, uploadedFiles());

  const uploadJobs = f.ui("uploadModelButton").dispatch("click") ?? [];
  await flush();
  assert.equal(f.browserFileLoads.length, 0);
  assert.equal(f.defaultModel.disposed, 0);

  predictionPending.resolve([{ className: "바위", probability: 0.96 }]);
  await prediction;
  await Promise.all(uploadJobs);
  assert.ok(f.events.lastIndexOf("initial:predict:end") < f.events.indexOf("initial:dispose"));
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(f.frames.size, 1);
  await f.frame();
  assert.equal(f.ui("prediction").textContent, "가위");
});

test("pagehide during a pending upload disposes both old and late models without updating the page", async () => {
  const f = fixture(); await flush();
  const files = uploadedFiles();
  const pending = deferred();
  const candidate = f.candidate("late-upload");
  f.localLoads.push(pending);
  selectUploadedFiles(f, files);
  f.ui("settingsDialog").showModal();
  const uploadJobs = f.ui("uploadModelButton").dispatch("click") ?? [];
  await flush();
  assert.equal(f.browserFileLoads.length, 1);

  f.hide();
  const statusAfterHide = f.ui("modelStatus").textContent;
  pending.resolve(candidate);
  await Promise.all(uploadJobs);
  await flush();

  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(candidate.disposed, 1);
  assert.equal(f.ui("modelStatus").textContent, statusAfterHide);
  assert.equal(f.ui("settingsDialog").open, true);
  assert.equal(f.ui("startButton").disabled, true);
  assert.equal(f.frames.size, 0);
});

test("pageshow restores the uploaded file source instead of the bundled model", async () => {
  const f = fixture(); await flush();
  const files = uploadedFiles();
  const uploaded = f.candidate("uploaded");
  f.localLoads.push(uploaded);
  selectUploadedFiles(f, files);
  await clickAndWait(f, "uploadModelButton");
  assert.equal(f.loads.length, 0);

  f.hide();
  const restored = f.candidate("restored-upload");
  f.localLoads.push(restored);
  f.show();
  await flush();

  assert.equal(uploaded.disposed, 1);
  assert.equal(restored.disposed, 0);
  assert.equal(f.control.loadCalls, 3);
  assert.equal(f.browserFileLoads.length, 2);
  assert.deepEqual(Array.from(f.browserFileLoads[1]), Array.from(f.browserFileLoads[0]));
  assert.equal(f.loads.length, 0, "restoration must not fetch the bundled source");
  assert.equal(f.ui("modelSource").textContent, "업로드 · 사용자 모델");
  assert.equal(f.ui("startButton").disabled, false);
});

test("the default model button replaces an uploaded model and updates its source", async () => {
  const f = fixture(); await flush();
  const uploaded = f.candidate("uploaded");
  f.localLoads.push(uploaded);
  selectUploadedFiles(f, uploadedFiles());
  await clickAndWait(f, "uploadModelButton");

  const restoredDefault = f.candidate("restored-default");
  f.loads.push(restoredDefault);
  await clickAndWait(f, "saveModelButton");

  assert.equal(uploaded.disposed, 1);
  assert.equal(restoredDefault.disposed, 0);
  assert.equal(f.browserFileLoads.length, 1);
  assert.equal(f.ui("modelSource").textContent, "기본 모델");
  assert.match(f.ui("modelStatus").textContent, /연결 완료.*기본 모델/);
  assert.equal(f.ui("startButton").disabled, false);
});

for (const stage of ["setup", "play"]) {
  test(`camera ${stage} failure stops acquired tracks and allows retry`, async () => {
    const f = fixture(); await flush();
    f.control[`${stage}Error`] = new Error(`injected ${stage} failure`);
    await f.run("startCamera()");
    assert.ok(f.cameras[0].tracks.every((track) => track.stops === 1));
    assert.equal(f.frames.size, 0);
    assert.equal(f.ui("startButton").disabled, false);
    assert.match(f.ui("resultText").textContent, /카메라/);
    f.control[`${stage}Error`] = null;
    await f.run("startCamera()");
    assert.equal(f.cameras.length, 2);
    assert.equal(f.frames.size, 1);
  });
}

test("pagehide stops the camera, cancels prediction frames, and disposes the model once", async () => {
  const f = await runningFixture();
  f.hide(); f.hide();
  await flush();
  assert.equal(f.frames.size, 0);
  assert.equal(f.defaultModel.disposed, 1);
  assert.ok(f.cameras[0].tracks.every((track) => track.stops === 1));
});

test("pagehide during loading disposes the late candidate without enabling the game", async () => {
  const initial = deferred();
  const f = fixture({ initial });
  await flush();
  f.hide();
  initial.resolve(f.defaultModel);
  await flush();
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(f.ui("startButton").disabled, true);
  assert.equal(f.frames.size, 0);
});

for (const stage of ["setup", "play"]) {
  test(`pagehide during camera ${stage} cleans up late streams without scheduling predictions`, async () => {
    const f = fixture(); await flush();
    const pending = deferred();
    f.control[stage] = pending;
    const operation = f.run("startCamera()");
    await flush();
    f.hide();
    pending.resolve();
    await operation;
    await flush();
    assert.ok(f.cameras[0].tracks.every((track) => track.stops === 1));
    assert.equal(f.frames.size, 0);
    assert.equal(f.ui("cameraFrame").classList.contains("active"), false);
    assert.equal(f.ui("startButton").disabled, true);
  });
}

test("pagehide waits for an in-flight prediction and ignores its late result", async () => {
  const f = await runningFixture();
  const pending = deferred();
  f.defaultModel.control.pending = pending;
  const operation = f.beginFrame();
  await flush();
  f.hide();
  const textAfterHide = f.ui("prediction").textContent;
  assert.equal(f.defaultModel.disposed, 0);
  pending.resolve([{ className: "보", probability: 0.99 }]);
  await operation; await flush();
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(f.ui("prediction").textContent, textAfterHide);
  assert.equal(f.frames.size, 0);
});

for (const cause of ["predict", "webcam", "empty predictions"]) {
  test(`${cause} failure clears stale predictions, blocks play, and keeps retrying`, async () => {
    const f = await runningFixture();
    if (cause === "predict") f.defaultModel.control.error = new Error("injected prediction failure");
    if (cause === "webcam") f.control.updateError = new Error("injected update failure");
    if (cause === "empty predictions") f.defaultModel.control.predictions = [];
    await f.frame();
    assert.equal(f.ui("startButton").disabled, true);
    assert.match(f.ui("prediction").textContent, /오류/);
    assert.notEqual(f.ui("confidence").textContent, "96%");
    const before = scores(f);
    await f.run("playRound()");
    assert.equal(f.timers.size, 0);
    assert.deepEqual(scores(f), before);
    await f.frame();
    assert.equal(f.frames.size, 1);
    f.ui("resetButton").dispatch("click");
    assert.match(f.ui("resultText").textContent, /오류/);
  });
}

for (const [outcome, random, expected] of [["win", 0, [1, 0, 1]], ["lose", 0.99, [0, 1, 1]], ["draw", 0.5, [0, 0, 1]]]) {
  test(`${outcome} scoring preserves reset protection and restores controls`, async () => {
    const f = await runningFixture();
    f.run(`Math.random = () => ${random}`);
    await f.finish(f.run("playRound()"), () => protectReset(f));
    assert.deepEqual(scores(f), expected);
    assertRoundFinished(f);
    f.ui("resetButton").dispatch("click");
    assert.deepEqual(scores(f), [0, 0, 0]);
  });
}

for (const predictions of [[{ className: "바위", probability: 0.3 }], [{ className: "unknown", probability: 0.99 }]]) {
  test(`unusable prediction (${predictions[0].className}, ${predictions[0].probability}) does not score`, async () => {
    const f = await runningFixture();
    f.defaultModel.control.predictions = predictions;
    await f.frame();
    await f.finish(f.run("playRound()"), () => protectReset(f));
    assert.deepEqual(scores(f), [0, 0, 0]);
    assertRoundFinished(f);
  });
}

for (const recover of [false, true]) {
  test(`inference failure ${recover ? "recovers" : "persists"} during countdown without button or score races`, async () => {
    const f = await runningFixture();
    const round = f.run("playRound()");
    f.defaultModel.control.error = new Error("injected prediction failure");
    await f.frame();
    protectReset(f);
    if (recover) {
      f.defaultModel.control.error = null;
      await f.frame();
      protectReset(f);
    }
    await f.finish(round, () => protectReset(f));
    assert.equal(scores(f)[2], recover ? 1 : 0);
    assertRoundFinished(f, { failed: !recover });
    if (!recover) {
      f.defaultModel.control.error = null;
      await f.frame();
      assertRoundFinished(f);
      await f.finish(f.run("playRound()"));
      assert.equal(scores(f)[2], 1);
    }
  });
}

for (let wait = 1; wait <= 6; wait++) {
  test(`countdown wait ${wait} rejection restores controls and clears the countdown`, async () => {
    const f = await runningFixture();
    f.control.timerErrorAt = wait;
    await f.finish(f.run("playRound()"), () => protectReset(f));
    assert.deepEqual(scores(f), [0, 0, 0]);
    assertRoundFinished(f);
    assert.match(f.ui("resultText").textContent, /오류|실패|진행하지 못/);
  });
}

test("simultaneous countdown and inference errors restore reset while keeping play unavailable", async () => {
  const f = await runningFixture();
  f.control.timerErrorAt = 2;
  const round = f.run("playRound()");
  f.defaultModel.control.error = new Error("injected prediction failure");
  await f.frame();
  await f.finish(round);
  assert.deepEqual(scores(f), [0, 0, 0]);
  assertRoundFinished(f, { failed: true });
  assert.match(f.ui("resultText").textContent, /오류/);
});

for (const reason of ["metadataError", "metadataHttpError", "metadataJsonError"]) {
  test(`${reason} prevents model allocation and preserves the active model`, async () => {
    const f = await runningFixture();
    f.control[reason] = new Error("injected metadata error");
    f.loads.push(f.candidate("unused"));
    await f.run("loadModel()");
    assert.equal(f.control.loadCalls, 1);
    assert.equal(f.defaultModel.disposed, 0);
    assert.equal(f.ui("modelStatus").classList.contains("error"), true);
    await f.frame();
    assert.equal(f.ui("prediction").textContent, "바위");
  });
}

test("wrapper construction failure disposes the candidate layers only", async () => {
  const f = await runningFixture();
  const candidate = f.candidate("candidate");
  f.loads.push(candidate);
  f.control.constructorError = new Error("injected wrapper error");
  await f.run("loadModel()");
  assert.equal(candidate.disposed, 1);
  assert.equal(f.defaultModel.disposed, 0);
  await f.frame();
});

test("reload and camera start are blocked while another camera setup is pending", async () => {
  const f = fixture(); await flush();
  f.control.setup = deferred();
  const camera = f.run("startCamera()");
  await f.run("loadModel()");
  await f.run("startCamera()");
  assert.equal(f.control.loadCalls, 1);
  assert.equal(f.cameras.length, 1);
  assert.equal(f.ui("saveModelButton").disabled, true);
  f.control.setup.resolve(); await camera;
  assert.equal(f.ui("saveModelButton").disabled, false);
});

test("page restoration reloads the model and prevents an old round from scoring", async () => {
  const f = await runningFixture();
  const round = f.run("playRound()");
  await f.run("loadModel()");
  assert.equal(f.control.loadCalls, 1, "a playing round must block model reload");
  f.hide();
  const replacement = f.candidate("restored");
  f.loads.push(replacement);
  f.show(); await flush();
  await f.finish(round);
  assert.deepEqual(scores(f), [0, 0, 0]);
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(f.ui("startButton").disabled, false);
  assert.equal(f.ui("startButtonText").textContent, "카메라 켜기");
  assert.equal(f.frames.size, 0);
  await f.run("startCamera()"); await f.frame();
  await f.finish(f.run("playRound()"));
  assert.equal(scores(f)[2], 1);
});

test("a late model from a hidden page cannot overwrite a restored page's model or controls", async () => {
  const initial = deferred();
  const f = fixture({ initial }); await flush();
  f.hide();
  const pendingReplacement = deferred();
  const replacement = f.candidate("restored");
  f.loads.push(pendingReplacement);
  f.show(); await flush();
  initial.resolve(f.defaultModel); await flush();
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(f.ui("startButton").disabled, true, "old finally must not end new loading state");
  pendingReplacement.resolve(replacement); await flush();
  assert.equal(replacement.disposed, 0);
  assert.equal(f.ui("startButton").disabled, false);
  await f.run("startCamera()"); await f.frame();
  assert.ok(f.events.includes("restored:predict:start"));
});

test("pagehide during metadata fetch never starts allocating model weights", async () => {
  const f = fixture(); await flush();
  f.control.metadataPending = deferred();
  f.loads.push(f.candidate("unused"));
  const loading = f.run("loadModel()");
  f.hide();
  f.control.metadataPending.resolve(); await loading;
  assert.equal(f.control.loadCalls, 1);
  assert.equal(f.defaultModel.disposed, 1);
  assert.equal(f.ui("startButton").disabled, true);
});

test("bundled TensorFlow and Teachable Machine load and release the real project model", async () => {
  const tf = require("../vendor/tf.min.js");
  const vendorContext = vm.createContext({ tf, console });
  vm.runInContext(readFileSync(path.join(__dirname, "..", "vendor", "teachablemachine-image.min.js"), "utf8"), vendorContext);
  const metadata = JSON.parse(readFileSync(path.join(__dirname, "..", "model", "metadata.json"), "utf8"));
  const modelJson = JSON.parse(readFileSync(path.join(__dirname, "..", "model", "model.json"), "utf8"));
  const weights = readFileSync(path.join(__dirname, "..", "model", "weights.bin"));
  const before = tf.memory().numTensors;
  const f = fixture(); await flush();
  const releaseModel = f.run("disposeModel");
  const layers = await tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest.flatMap((group) => group.weights),
    weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
  }));
  const model = new vendorContext.tmImage.CustomMobileNet(layers, metadata);
  const input = tf.zeros([1, metadata.imageSize, metadata.imageSize, 3]);
  let output;
  try {
    assert.equal(model.getTotalClasses(), 3);
    assert.deepEqual(model.getClassLabels(), ["가위", "바위", "보"]);
    output = model.model.predict(input);
    assert.equal((await output.data()).length, 3);
  } finally {
    output?.dispose(); input.dispose(); releaseModel(model.model);
  }
  assert.equal(tf.memory().numTensors, before, "model tensors must be released");
});
