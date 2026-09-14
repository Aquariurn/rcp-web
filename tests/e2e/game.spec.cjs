const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const file = name => path.join(root, 'model', name);

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.runtimeErrors = errors;
  await page.goto('/');
  await expect(page.getByRole('button', { name: '카메라 켜기' })).toBeEnabled();
});

test.afterEach(async ({ page }) => {
  expect(page.runtimeErrors).toEqual([]);
});

async function startCamera(page) {
  await page.getByRole('button', { name: '카메라 켜기' }).click();
  await expect(page.locator('#webcamContainer canvas')).toBeVisible();
  // The bundled model and real browser canvas must predict before any test injection.
  await expect(page.locator('#prediction')).toHaveText(/^(가위|바위|보)$/);
  await expect(page.locator('#confidence')).toHaveText(/^\d+%$/);
}

async function selectModel(page, metadata = file('metadata.json')) {
  await page.getByLabel('모델 구조', { exact: true }).setInputFiles(file('model.json'));
  await page.getByLabel('모델 가중치', { exact: true }).setInputFiles(file('weights.bin'));
  await page.getByLabel('모델 정보', { exact: true }).setInputFiles(metadata);
  await page.getByRole('button', { name: '선택한 모델 적용', exact: true }).click();
}

test('camera, round, reset and responsive layout', async ({ page }) => {
  await startCamera(page);
  // Fake video is not a hand. Stabilize only model output for deterministic game rules.
  await page.evaluate(() => {
    model.predict = async () => [{ className: '바위', probability: 0.99 }];
    Math.random = () => 0;
  });
  await expect(page.locator('#prediction')).toHaveText('바위');
  await page.getByRole('button', { name: '승부하기' }).click();
  await expect(page.getByRole('button', { name: '점수 초기화' })).toBeDisabled();
  await expect(page.locator('#roundCount')).toHaveText('1');
  await expect(page.locator('#playerScore')).toHaveText('1');
  await expect(page.locator('#resultText')).toContainText('당신의 승리');
  await page.getByRole('button', { name: '점수 초기화' }).click();
  await expect(page.locator('#roundCount')).toHaveText('0');
  await expect(page.locator('#playerScore')).toHaveText('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('native model file selection, invalid model preservation and default restore', async ({ page }) => {
  await startCamera(page);
  await page.getByRole('button', { name: '모델 설정 열기' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await selectModel(page);
  await expect(page.locator('#modelStatus')).toContainText('연결 완료 · 업로드');
  await expect(page.locator('#prediction')).toHaveText(/^(가위|바위|보)$/);
  const activeSource = await page.locator('#modelSource').textContent();
  await selectModel(page, {
    name: 'metadata.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ labels: ['Class 1'], imageSize: 224 })),
  });
  await expect(page.locator('#modelStatus')).toContainText('기존 모델을 계속 사용합니다');
  await expect(page.locator('#modelSource')).toHaveText(activeSource);
  await expect(page.locator('#prediction')).toHaveText(/^(가위|바위|보)$/);
  await page.getByRole('button', { name: '기본 모델 사용', exact: true }).click();
  await expect(page.locator('#modelStatus')).toContainText('연결 완료 · 기본 모델');
  await expect(page.locator('#modelSource')).toHaveText('기본 모델');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('camera access rejection is recoverable', async ({ page }) => {
  // Simulate denial; no OS permission dialog or physical camera is needed in CI.
  await page.evaluate(() => {
    window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Test permission denial', 'NotAllowedError');
    };
  });
  await page.getByRole('button', { name: '카메라 켜기' }).click();
  await expect(page.locator('#resultText')).toContainText('카메라를 열 수 없어요');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.realGetUserMedia; });
  await startCamera(page);
});

test('camera disconnect cancels a round and permits reconnect', async ({ page }) => {
  await startCamera(page);
  await page.getByRole('button', { name: '승부하기' }).click();
  await expect(page.locator('#countdown')).toHaveClass(/show/);
  await page.evaluate(() => {
    const track = webcam.webcam.srcObject.getTracks()[0];
    // stop() alone does not emit ended. Simulate the device disconnect notification.
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });
  await expect(page.locator('#resultText')).toContainText('연결이 끊겼');
  await expect(page.locator('#roundCount')).toHaveText('0');
  await expect(page.getByRole('button', { name: '점수 초기화' })).toBeEnabled();
  await startCamera(page);
  await page.evaluate(() => { model.predict = async () => [{ className: '바위', probability: 0.99 }]; });
  await expect(page.locator('#prediction')).toHaveText('바위');
  await page.getByRole('button', { name: '승부하기' }).click();
  await expect(page.locator('#roundCount')).toHaveText('1');
});
