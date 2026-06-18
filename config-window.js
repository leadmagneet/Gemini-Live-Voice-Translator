const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const WebSocket = require('ws');
const { RtAudio, RtAudioFormat } = require('audify');

const PORT = Number(process.env.CONFIG_UI_PORT || 3000);
const ENV_PATH = path.join(process.cwd(), '.env');

const WASAPI_API = 7;

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

const DEFAULT_MODEL = 'gemini-3.5-live-translate-preview';

// =====================================================
// ENV
// =====================================================
function parseEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};

  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const env = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function writeEnv(config) {
  const oldEnv = parseEnvFile();
  const env = { ...oldEnv, ...config };

  const lines = [];

  lines.push('# =====================================================');
  lines.push('# GEMINI');
  lines.push('# =====================================================');
  lines.push(`GEMINI_API_KEY=${env.GEMINI_API_KEY || ''}`);
  lines.push('');

  lines.push('# =====================================================');
  lines.push('# DEVICES');
  lines.push('# =====================================================');
  lines.push(`REAL_MIC_ID=${env.REAL_MIC_ID || ''}`);
  lines.push(`CABLE_INPUT_ID=${env.CABLE_INPUT_ID || ''}`);
  lines.push(`VOICEMEETER_OUT_ID=${env.VOICEMEETER_OUT_ID || ''}`);
  lines.push(`REAL_PHONES_ID=${env.REAL_PHONES_ID || ''}`);
  lines.push('');

  lines.push('# =====================================================');
  lines.push('# TRANSLATION DIRECTIONS');
  lines.push('# =====================================================');
  lines.push(`OUTGOING_TARGET_LANG=${env.OUTGOING_TARGET_LANG || 'en'}`);
  lines.push(`OUTGOING_PIPELINE_NAME=${env.OUTGOING_PIPELINE_NAME || 'OUTGOING_RU_TO_EN'}`);
  lines.push(`INCOMING_TARGET_LANG=${env.INCOMING_TARGET_LANG || 'ru'}`);
  lines.push(`INCOMING_PIPELINE_NAME=${env.INCOMING_PIPELINE_NAME || 'INCOMING_EN_TO_RU'}`);
  lines.push('');

  lines.push('# =====================================================');
  lines.push('# GEMINI / DEBUG');
  lines.push('# =====================================================');
  lines.push(`MODEL_NAME=${env.MODEL_NAME || DEFAULT_MODEL}`);
  lines.push(`ENABLE_TRANSCRIPTS=${env.ENABLE_TRANSCRIPTS || '1'}`);
  lines.push(`REALTIME_INPUT_CONFIG=${env.REALTIME_INPUT_CONFIG || '0'}`);
  lines.push('');

  lines.push('# =====================================================');
  lines.push('# AUDIO STABILITY');
  lines.push('# =====================================================');
  lines.push(`CAPTURE_FRAMES=${env.CAPTURE_FRAMES || '800'}`);
  lines.push(`PLAYBACK_FRAMES=${env.PLAYBACK_FRAMES || '480'}`);
  lines.push(`GEMINI_CHUNK_MS=${env.GEMINI_CHUNK_MS || '100'}`);
  lines.push(`MAX_CAPTURE_QUEUE_MS=${env.MAX_CAPTURE_QUEUE_MS || '1500'}`);
  lines.push(`MAX_PLAYBACK_QUEUE_MS=${env.MAX_PLAYBACK_QUEUE_MS || '900'}`);
  lines.push(`MAX_WS_BUFFERED_BYTES=${env.MAX_WS_BUFFERED_BYTES || '262144'}`);
  lines.push(`RECONNECT_DELAY_MS=${env.RECONNECT_DELAY_MS || '3000'}`);
  lines.push('');

  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

// =====================================================
// DEVICES
// =====================================================
function getDevices() {
  const audio = new RtAudio(WASAPI_API);
  const devices = audio.getDevices();

  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    inputChannels: d.inputChannels,
    outputChannels: d.outputChannels,
    isDefaultInput: Boolean(d.isDefaultInput),
    isDefaultOutput: Boolean(d.isDefaultOutput),
    type:
      d.inputChannels > 0 && d.outputChannels > 0
        ? 'input+output'
        : d.inputChannels > 0
          ? 'input'
          : d.outputChannels > 0
            ? 'output'
            : 'unknown',
  }));
}

function hasName(d, text) {
  return String(d.name || '').toLowerCase().includes(text.toLowerCase());
}

function detectDevices(devices) {
  const inputs = devices.filter((d) => d.inputChannels > 0);
  const outputs = devices.filter((d) => d.outputChannels > 0);

  const realMic =
    inputs.find((d) => d.isDefaultInput) ||
    inputs.find((d) => hasName(d, 'микроф')) ||
    inputs.find((d) => hasName(d, 'microphone')) ||
    inputs.find((d) => hasName(d, 'realtek')) ||
    null;

  const cableInput =
    outputs.find((d) => hasName(d, 'CABLE Input')) ||
    outputs.find((d) => hasName(d, 'CABLE In') && !hasName(d, '16ch')) ||
    outputs.find((d) => hasName(d, 'CABLE')) ||
    null;

  const cableOutput =
    inputs.find((d) => hasName(d, 'CABLE Output')) ||
    null;

  const voicemeeterInput =
    outputs.find((d) => d.name === 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)') ||
    outputs.find((d) => hasName(d, 'Voicemeeter Input')) ||
    null;

  const voicemeeterOutB1 =
    inputs.find((d) => hasName(d, 'Voicemeeter Out B1')) ||
    null;

  const realPhones =
    outputs.find((d) => d.isDefaultOutput) ||
    outputs.find((d) => hasName(d, 'науш')) ||
    outputs.find((d) => hasName(d, 'headphones')) ||
    outputs.find((d) => hasName(d, 'динамики')) ||
    outputs.find((d) => hasName(d, 'speakers')) ||
    outputs.find((d) => hasName(d, 'realtek')) ||
    null;

  return {
    realMic,
    cableInput,
    cableOutput,
    voicemeeterInput,
    voicemeeterOutB1,
    realPhones,
    ok: {
      realMic: Boolean(realMic),
      cableInput: Boolean(cableInput),
      cableOutput: Boolean(cableOutput),
      voicemeeterInput: Boolean(voicemeeterInput),
      voicemeeterOutB1: Boolean(voicemeeterOutB1),
      realPhones: Boolean(realPhones),
    },
  };
}

// =====================================================
// AUDIO TESTS
// =====================================================
function calcRms(buffer) {
  if (!buffer || buffer.length < 2) return 0;

  let sumSquares = 0;
  const samples = Math.floor(buffer.length / 2);

  for (let i = 0; i < samples * 2; i += 2) {
    const s = buffer.readInt16LE(i);
    sumSquares += s * s;
  }

  return Math.sqrt(sumSquares / samples);
}

function meterInput(deviceId, seconds = 5) {
  return new Promise((resolve) => {
    const stream = new RtAudio(WASAPI_API);

    let maxRms = 0;
    let avgRms = 0;
    let count = 0;
    let opened = false;

    try {
      stream.openStream(
        null,
        { deviceId: Number(deviceId), nChannels: CHANNELS },
        RtAudioFormat.RTAUDIO_SINT16,
        INPUT_RATE,
        800,
        `MeterInput-${deviceId}`,
        (inputBuffer) => {
          const rms = calcRms(inputBuffer);

          maxRms = Math.max(maxRms, rms);
          avgRms = (avgRms * count + rms) / (count + 1);
          count++;
        },
        null
      );

      opened = true;
      stream.start();

      setTimeout(() => {
        try { stream.stop(); } catch (_) {}
        try { stream.closeStream(); } catch (_) {}

        resolve({
          ok: maxRms >= 80,
          maxRms: Math.round(maxRms),
          avgRms: Math.round(avgRms),
          frames: count,
          message:
            maxRms >= 80
              ? 'Сигнал есть. Устройство получает звук.'
              : 'Почти тишина. Скорее всего, выбран не тот input или звук туда не идёт.',
        });
      }, seconds * 1000);
    } catch (err) {
      if (opened) {
        try { stream.stop(); } catch (_) {}
        try { stream.closeStream(); } catch (_) {}
      }

      resolve({
        ok: false,
        error: err.message,
        message: 'Не удалось открыть input device.',
      });
    }
  });
}

class TonePlayer {
  constructor(stream, freq = 440) {
    this.stream = stream;
    this.freq = freq;
    this.phase = 0;
    this.running = false;
    this.framesWritten = 0;
  }

  makeFrame(frameSamples) {
    const buffer = Buffer.alloc(frameSamples * CHANNELS * BYTES_PER_SAMPLE);
    const amp = 0.2 * 32767;

    for (let i = 0; i < frameSamples; i++) {
      const sample = Math.round(Math.sin(this.phase) * amp);

      this.phase += 2 * Math.PI * this.freq / OUTPUT_RATE;
      if (this.phase > Math.PI * 2) {
        this.phase -= Math.PI * 2;
      }

      buffer.writeInt16LE(sample, i * 2);
    }

    return buffer;
  }

  writeNext() {
    if (!this.running) return;

    try {
      this.stream.write(this.makeFrame(480));
      this.framesWritten++;
    } catch (_) {}
  }

  start() {
    this.running = true;

    for (let i = 0; i < 8; i++) {
      this.writeNext();
    }
  }

  stop() {
    this.running = false;
  }
}

function toneOutput(deviceId, seconds = 3) {
  return new Promise((resolve) => {
    const stream = new RtAudio(WASAPI_API);
    let player = null;
    let opened = false;

    try {
      stream.openStream(
        { deviceId: Number(deviceId), nChannels: CHANNELS },
        null,
        RtAudioFormat.RTAUDIO_SINT16,
        OUTPUT_RATE,
        480,
        `ToneOutput-${deviceId}`,
        null,
        () => {
          if (player) player.writeNext();
        }
      );

      try {
        stream.outputVolume = 1.0;
      } catch (_) {}

      opened = true;
      player = new TonePlayer(stream);

      stream.start();
      player.start();

      setTimeout(() => {
        try { if (player) player.stop(); } catch (_) {}
        try { stream.stop(); } catch (_) {}
        try { stream.closeStream(); } catch (_) {}

        resolve({
          ok: true,
          framesWritten: player ? player.framesWritten : 0,
          message: 'Beep отправлен в output device.',
        });
      }, seconds * 1000);
    } catch (err) {
      if (opened) {
        try { if (player) player.stop(); } catch (_) {}
        try { stream.stop(); } catch (_) {}
        try { stream.closeStream(); } catch (_) {}
      }

      resolve({
        ok: false,
        error: err.message,
        message: 'Не удалось открыть output device.',
      });
    }
  });
}

// =====================================================
// GEMINI TEST
// =====================================================
function testGeminiKey(apiKey, modelName = DEFAULT_MODEL) {
  return new Promise((resolve) => {
    if (!apiKey) {
      resolve({
        ok: false,
        message: 'GEMINI_API_KEY пустой.',
      });
      return;
    }

    const url =
      `wss://generativelanguage.googleapis.com/ws/` +
      `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    const ws = new WebSocket(url);

    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;

      clearTimeout(timer);

      try {
        ws.close();
      } catch (_) {}

      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        message: 'Timeout. Gemini не ответил за 10 секунд.',
      });
    }, 10000);

    ws.on('open', () => {
      const setup = {
        setup: {
          model: `models/${modelName}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: 'en',
              echoTargetLanguage: false,
            },
          },
        },
      };

      try {
        ws.send(JSON.stringify(setup));
      } catch (err) {
        finish({
          ok: false,
          message: `Ошибка отправки setup: ${err.message}`,
        });
      }
    });

    ws.on('message', (data) => {
      let msg;

      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        return;
      }

      if (msg.setupComplete !== undefined) {
        finish({
          ok: true,
          message: 'Gemini API key рабочий. Модель доступна. setupComplete получен.',
        });
      }
    });

    ws.on('error', (err) => {
      finish({
        ok: false,
        message: `WebSocket error: ${err.message}`,
      });
    });

    ws.on('close', (code, reason) => {
      if (done) return;

      finish({
        ok: false,
        message: `Gemini закрыл соединение. code=${code} reason=${reason ? reason.toString() : ''}`,
      });
    });
  });
}

// =====================================================
// HTTP HELPERS
// =====================================================
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });

  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
  });

  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk.toString();

      if (data.length > 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });

    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// =====================================================
// HTML
// =====================================================
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Gemini Translator Setup</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #070b16;
      --panel: rgba(17, 24, 39, 0.88);
      --panel2: rgba(15, 23, 42, 0.92);
      --line: rgba(148, 163, 184, 0.22);
      --text: #e5e7eb;
      --muted: #94a3b8;
      --good: #22c55e;
      --bad: #ef4444;
      --warn: #f59e0b;
      --blue: #3b82f6;
      --blue2: #2563eb;
      --purple: #8b5cf6;
      --field: #0f172a;
      --shadow: 0 20px 55px rgba(0, 0, 0, 0.35);
      --radius: 18px;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 10%, rgba(59, 130, 246, 0.22), transparent 30%),
        radial-gradient(circle at 90% 20%, rgba(139, 92, 246, 0.20), transparent 28%),
        radial-gradient(circle at 50% 90%, rgba(34, 197, 94, 0.10), transparent 30%),
        var(--bg);
    }

    header {
      padding: 26px 28px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(2, 6, 23, 0.78);
      backdrop-filter: blur(16px);
      position: sticky;
      top: 0;
      z-index: 5;
    }

    .header-inner {
      max-width: 1250px;
      margin: 0 auto;
      display: flex;
      gap: 18px;
      align-items: center;
      justify-content: space-between;
    }

    .brand {
      display: flex;
      gap: 14px;
      align-items: center;
    }

    .logo {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--blue), var(--purple));
      display: grid;
      place-items: center;
      font-weight: 900;
      box-shadow: 0 12px 35px rgba(59, 130, 246, 0.35);
    }

    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.02em;
    }

    .subtitle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }

    .header-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    main {
      max-width: 1250px;
      margin: 0 auto;
      padding: 24px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }

    .grid-4 {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 18px;
      margin-bottom: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }

    .card h2 {
      margin: 0 0 13px;
      font-size: 17px;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .step {
      width: 24px;
      height: 24px;
      border-radius: 8px;
      background: rgba(59, 130, 246, 0.18);
      color: #bfdbfe;
      display: inline-grid;
      place-items: center;
      font-size: 13px;
      font-weight: 800;
    }

    label {
      display: block;
      margin: 12px 0 7px;
      color: #cbd5e1;
      font-size: 13px;
      font-weight: 650;
    }

    input, select {
      width: 100%;
      padding: 11px 12px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      background: var(--field);
      color: var(--text);
      outline: none;
      transition: border 0.15s, box-shadow 0.15s;
    }

    input:focus, select:focus {
      border-color: rgba(59, 130, 246, 0.8);
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.13);
    }

    button {
      cursor: pointer;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--blue), var(--blue2));
      color: white;
      padding: 11px 14px;
      margin: 5px 6px 5px 0;
      font-weight: 750;
      transition: transform 0.12s, filter 0.12s, opacity 0.12s;
      box-shadow: 0 10px 25px rgba(37, 99, 235, 0.22);
    }

    button:hover {
      transform: translateY(-1px);
      filter: brightness(1.08);
    }

    button:active {
      transform: translateY(0);
    }

    button.secondary {
      background: #475569;
      box-shadow: none;
    }

    button.good {
      background: linear-gradient(135deg, #16a34a, #059669);
      box-shadow: 0 10px 25px rgba(5, 150, 105, 0.22);
    }

    button.warn {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      box-shadow: 0 10px 25px rgba(245, 158, 11, 0.18);
    }

    .status {
      margin-top: 12px;
      padding: 12px;
      border-radius: 14px;
      background: var(--panel2);
      border: 1px solid var(--line);
      white-space: pre-wrap;
      font-family: Consolas, ui-monospace, monospace;
      font-size: 13px;
      min-height: 44px;
      overflow: auto;
      max-height: 280px;
    }

    .ok {
      color: #86efac;
      border-color: rgba(34, 197, 94, 0.35);
    }

    .bad {
      color: #fecaca;
      border-color: rgba(239, 68, 68, 0.35);
    }

    .small {
      color: var(--muted);
      font-size: 12.5px;
      line-height: 1.45;
      margin-top: 7px;
    }

    .hint {
      padding: 11px 12px;
      border-radius: 14px;
      background: rgba(59, 130, 246, 0.10);
      border: 1px solid rgba(59, 130, 246, 0.22);
      color: #bfdbfe;
      font-size: 13px;
      line-height: 1.45;
      margin-top: 10px;
    }

    .pill-wrap {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      border-radius: 999px;
      background: rgba(51, 65, 85, 0.85);
      font-size: 12.5px;
      border: 1px solid rgba(148, 163, 184, 0.18);
    }

    .pill.okpill {
      background: rgba(6, 78, 59, 0.82);
      color: #bbf7d0;
      border-color: rgba(34, 197, 94, 0.28);
    }

    .pill.badpill {
      background: rgba(127, 29, 29, 0.78);
      color: #fecaca;
      border-color: rgba(239, 68, 68, 0.30);
    }

    .route {
      display: grid;
      grid-template-columns: 1fr auto 1fr auto 1fr;
      gap: 10px;
      align-items: center;
      padding: 12px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid var(--line);
      margin-top: 10px;
    }

    .node {
      padding: 10px;
      border-radius: 12px;
      background: rgba(30, 41, 59, 0.82);
      text-align: center;
      font-size: 13px;
      min-height: 42px;
      display: grid;
      place-items: center;
    }

    .arrow {
      color: #93c5fd;
      font-weight: 900;
    }

    .device-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: end;
    }

    .footer-note {
      text-align: center;
      color: var(--muted);
      font-size: 12px;
      padding: 12px;
    }

    @media (max-width: 1050px) {
      .grid, .grid-4 {
        grid-template-columns: 1fr;
      }

      .header-inner {
        flex-direction: column;
        align-items: flex-start;
      }

      .route {
        grid-template-columns: 1fr;
      }

      .arrow {
        text-align: center;
      }

      main {
        padding: 14px;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand">
        <div class="logo">GT</div>
        <div>
          <h1>Gemini Translator Setup</h1>
          <div class="subtitle">Device routing, Gemini key check, language direction, and audio tests</div>
        </div>
      </div>
      <div class="header-actions">
        <button onclick="loadStatus()">Refresh devices</button>
        <button class="good" onclick="autoFill()">Auto-fill detected</button>
        <button class="warn" onclick="saveEnv()">Save .env</button>
      </div>
    </div>
  </header>

  <main>
    <div class="card">
      <h2><span class="step">1</span> System check</h2>
      <div id="detected"></div>
      <div class="hint">
        Conference settings should be: <b>Microphone = CABLE Output</b>, <b>Speakers = Voicemeeter Input</b>.
        In VoiceMeeter: <b>Voicemeeter Input: A = OFF, B = ON</b>.
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2><span class="step">2</span> Gemini API</h2>

        <label>Gemini API key</label>
        <input id="GEMINI_API_KEY" placeholder="Paste your Gemini API key here" />

        <label>Model</label>
        <input id="MODEL_NAME" value="gemini-3.5-live-translate-preview" />

        <button onclick="testGemini()">Test Gemini key</button>
        <div id="geminiResult" class="status">Gemini status will appear here.</div>
      </div>

      <div class="card">
        <h2><span class="step">3</span> Translation direction</h2>

        <label>Your microphone → conference</label>
        <select id="OUTGOING_TARGET_LANG"></select>
        <input id="OUTGOING_CUSTOM_LANG" placeholder="Custom code, optional. Example: uk, nl, id" style="margin-top:8px" />

        <label>Conference audio → your headphones</label>
        <select id="INCOMING_TARGET_LANG"></select>
        <input id="INCOMING_CUSTOM_LANG" placeholder="Custom code, optional. Example: ru, en, es" style="margin-top:8px" />

        <div class="route">
          <div class="node">Your mic</div>
          <div class="arrow">→</div>
          <div class="node">Gemini target: <b id="routeOut">en</b></div>
          <div class="arrow">→</div>
          <div class="node">CABLE Input</div>
        </div>

        <div class="route">
          <div class="node">Voicemeeter Out B1</div>
          <div class="arrow">→</div>
          <div class="node">Gemini target: <b id="routeIn">ru</b></div>
          <div class="arrow">→</div>
          <div class="node">Headphones</div>
        </div>

        <div class="small">
          Common language codes are included in the list. For another supported language, type its code in the custom field.
        </div>
      </div>
    </div>

    <div class="card">
      <h2><span class="step">4</span> Audio devices</h2>

      <div class="grid">
        <div>
          <label>REAL_MIC_ID — physical microphone</label>
          <div class="device-row">
            <select id="REAL_MIC_ID"></select>
            <button onclick="testInput('REAL_MIC_ID')">RMS test</button>
          </div>
          <div class="small">Speak into your mic. RMS must rise.</div>
        </div>

        <div>
          <label>CABLE_INPUT_ID — send translated audio to conference</label>
          <div class="device-row">
            <select id="CABLE_INPUT_ID"></select>
            <button onclick="testOutput('CABLE_INPUT_ID')">Beep</button>
          </div>
          <div class="small">Conference mic meter should move because it receives CABLE Output.</div>
        </div>

        <div>
          <label>VOICEMEETER_OUT_ID — read incoming conference audio</label>
          <div class="device-row">
            <select id="VOICEMEETER_OUT_ID"></select>
            <button onclick="testInput('VOICEMEETER_OUT_ID')">RMS test</button>
          </div>
          <div class="small">Speak from the phone in the meeting. RMS must rise here.</div>
        </div>

        <div>
          <label>REAL_PHONES_ID — play translated incoming audio</label>
          <div class="device-row">
            <select id="REAL_PHONES_ID"></select>
            <button onclick="testOutput('REAL_PHONES_ID')">Beep</button>
          </div>
          <div class="small">You should hear a beep in headphones/speakers.</div>
        </div>
      </div>

      <div id="testResult" class="status">Audio test results will appear here.</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2><span class="step">5</span> Save configuration</h2>
        <button class="good" onclick="saveEnv()">Save .env</button>
        <button class="secondary" onclick="showEnv()">Show current .env</button>
        <div id="saveResult" class="status">Save result will appear here.</div>
      </div>

      <div class="card">
        <h2>Final route reminder</h2>
        <div class="status">Conference:
Microphone = CABLE Output
Speakers   = Voicemeeter Input

VoiceMeeter:
Voicemeeter Input: A = OFF, B = ON

Node:
REAL_MIC_ID        = physical microphone
CABLE_INPUT_ID     = CABLE Input
VOICEMEETER_OUT_ID = Voicemeeter Out B1
REAL_PHONES_ID     = headphones / speakers</div>
      </div>
    </div>

    <div class="footer-note">
      After saving .env, stop this window server and run: node index.js
    </div>
  </main>

<script>
let devices = [];
let env = {};
let detected = {};

const LANGUAGES = [
  ['en', 'English'],
  ['ru', 'Russian'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['pt-BR', 'Portuguese Brazil'],
  ['zh', 'Chinese'],
  ['zh-CN', 'Chinese Simplified'],
  ['zh-TW', 'Chinese Traditional'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['pl', 'Polish'],
  ['nl', 'Dutch'],
  ['sv', 'Swedish'],
  ['no', 'Norwegian'],
  ['da', 'Danish'],
  ['fi', 'Finnish'],
  ['cs', 'Czech'],
  ['sk', 'Slovak'],
  ['ro', 'Romanian'],
  ['bg', 'Bulgarian'],
  ['el', 'Greek'],
  ['he', 'Hebrew'],
  ['fa', 'Persian'],
  ['ur', 'Urdu'],
  ['bn', 'Bengali'],
  ['id', 'Indonesian'],
  ['ms', 'Malay'],
  ['th', 'Thai'],
  ['vi', 'Vietnamese'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['mr', 'Marathi'],
  ['gu', 'Gujarati'],
  ['kn', 'Kannada'],
  ['ml', 'Malayalam'],
  ['pa', 'Punjabi'],
  ['sw', 'Swahili'],
  ['af', 'Afrikaans'],
  ['sq', 'Albanian'],
  ['hy', 'Armenian'],
  ['az', 'Azerbaijani'],
  ['eu', 'Basque'],
  ['be', 'Belarusian'],
  ['bs', 'Bosnian'],
  ['ca', 'Catalan'],
  ['hr', 'Croatian'],
  ['et', 'Estonian'],
  ['gl', 'Galician'],
  ['ka', 'Georgian'],
  ['hu', 'Hungarian'],
  ['is', 'Icelandic'],
  ['ga', 'Irish'],
  ['kk', 'Kazakh'],
  ['lv', 'Latvian'],
  ['lt', 'Lithuanian'],
  ['mk', 'Macedonian'],
  ['mn', 'Mongolian'],
  ['ne', 'Nepali'],
  ['sr', 'Serbian'],
  ['sl', 'Slovenian'],
  ['so', 'Somali'],
  ['uz', 'Uzbek'],
  ['zu', 'Zulu']
];

function deviceLabel(d) {
  const flags = [];
  if (d.isDefaultInput) flags.push('DEFAULT INPUT');
  if (d.isDefaultOutput) flags.push('DEFAULT OUTPUT');

  return 'ID=' + d.id + ' | ' + d.name + ' | in=' + d.inputChannels + ' out=' + d.outputChannels + (flags.length ? ' | ' + flags.join(', ') : '');
}

function setStatus(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'status ' + (ok === true ? 'ok' : ok === false ? 'bad' : '');
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function fillSelect(id, list, selectedId) {
  const select = document.getElementById(id);
  select.innerHTML = '';

  for (const d of list) {
    const option = document.createElement('option');
    option.value = String(d.id);
    option.textContent = deviceLabel(d);

    if (String(d.id) === String(selectedId)) {
      option.selected = true;
    }

    select.appendChild(option);
  }
}

function fillLanguageSelect(id, selectedCode) {
  const select = document.getElementById(id);
  select.innerHTML = '';

  const selectedExists = LANGUAGES.some(function(item) {
    return item[0] === selectedCode;
  });

  if (selectedCode && !selectedExists) {
    const custom = document.createElement('option');
    custom.value = selectedCode;
    custom.textContent = selectedCode + ' — current custom value';
    custom.selected = true;
    select.appendChild(custom);
  }

  for (const item of LANGUAGES) {
    const code = item[0];
    const name = item[1];

    const option = document.createElement('option');
    option.value = code;
    option.textContent = name + ' — ' + code;

    if (String(code) === String(selectedCode)) {
      option.selected = true;
    }

    select.appendChild(option);
  }
}

function getLanguage(selectId, customId) {
  const custom = document.getElementById(customId).value.trim();
  if (custom) return custom;

  return document.getElementById(selectId).value.trim();
}

function updateRouteLabels() {
  document.getElementById('routeOut').textContent = getLanguage('OUTGOING_TARGET_LANG', 'OUTGOING_CUSTOM_LANG') || 'en';
  document.getElementById('routeIn').textContent = getLanguage('INCOMING_TARGET_LANG', 'INCOMING_CUSTOM_LANG') || 'ru';
}

function renderDetected() {
  const checks = [
    ['CABLE Input', detected.ok && detected.ok.cableInput],
    ['CABLE Output', detected.ok && detected.ok.cableOutput],
    ['Voicemeeter Input', detected.ok && detected.ok.voicemeeterInput],
    ['Voicemeeter Out B1', detected.ok && detected.ok.voicemeeterOutB1],
    ['Physical microphone', detected.ok && detected.ok.realMic],
    ['Headphones / speakers', detected.ok && detected.ok.realPhones]
  ];

  let html = '<div class="pill-wrap">';

  for (const row of checks) {
    const name = row[0];
    const ok = row[1];

    html += '<span class="pill ' + (ok ? 'okpill' : 'badpill') + '">' + (ok ? 'OK' : 'FAIL') + ' ' + name + '</span>';
  }

  html += '</div>';

  html += '<div class="status">';
  html += 'CABLE Input: ' + (detected.cableInput ? deviceLabel(detected.cableInput) : 'NOT FOUND') + '\\n';
  html += 'CABLE Output: ' + (detected.cableOutput ? deviceLabel(detected.cableOutput) : 'NOT FOUND') + '\\n';
  html += 'Voicemeeter Input: ' + (detected.voicemeeterInput ? deviceLabel(detected.voicemeeterInput) : 'NOT FOUND') + '\\n';
  html += 'Voicemeeter Out B1: ' + (detected.voicemeeterOutB1 ? deviceLabel(detected.voicemeeterOutB1) : 'NOT FOUND') + '\\n';
  html += '</div>';

  document.getElementById('detected').innerHTML = html;
}

async function loadStatus() {
  const status = await api('/api/status');

  devices = status.devices;
  env = status.env || {};
  detected = status.detected || {};

  const inputs = devices.filter(function(d) { return d.inputChannels > 0; });
  const outputs = devices.filter(function(d) { return d.outputChannels > 0; });

  document.getElementById('GEMINI_API_KEY').value = env.GEMINI_API_KEY || '';
  document.getElementById('MODEL_NAME').value = env.MODEL_NAME || 'gemini-3.5-live-translate-preview';

  fillLanguageSelect('OUTGOING_TARGET_LANG', env.OUTGOING_TARGET_LANG || 'en');
  fillLanguageSelect('INCOMING_TARGET_LANG', env.INCOMING_TARGET_LANG || 'ru');

  document.getElementById('OUTGOING_CUSTOM_LANG').value = '';
  document.getElementById('INCOMING_CUSTOM_LANG').value = '';

  fillSelect('REAL_MIC_ID', inputs, env.REAL_MIC_ID || (detected.realMic && detected.realMic.id));
  fillSelect('CABLE_INPUT_ID', outputs, env.CABLE_INPUT_ID || (detected.cableInput && detected.cableInput.id));
  fillSelect('VOICEMEETER_OUT_ID', inputs, env.VOICEMEETER_OUT_ID || (detected.voicemeeterOutB1 && detected.voicemeeterOutB1.id));
  fillSelect('REAL_PHONES_ID', outputs, env.REAL_PHONES_ID || (detected.realPhones && detected.realPhones.id));

  renderDetected();
  updateRouteLabels();
}

function autoFill() {
  if (detected.realMic) document.getElementById('REAL_MIC_ID').value = detected.realMic.id;
  if (detected.cableInput) document.getElementById('CABLE_INPUT_ID').value = detected.cableInput.id;
  if (detected.voicemeeterOutB1) document.getElementById('VOICEMEETER_OUT_ID').value = detected.voicemeeterOutB1.id;
  if (detected.realPhones) document.getElementById('REAL_PHONES_ID').value = detected.realPhones.id;

  setStatus('saveResult', 'Detected devices applied. Click Save .env.', true);
}

function collectConfig() {
  const outLang = getLanguage('OUTGOING_TARGET_LANG', 'OUTGOING_CUSTOM_LANG') || 'en';
  const inLang = getLanguage('INCOMING_TARGET_LANG', 'INCOMING_CUSTOM_LANG') || 'ru';

  return {
    GEMINI_API_KEY: document.getElementById('GEMINI_API_KEY').value.trim(),
    MODEL_NAME: document.getElementById('MODEL_NAME').value.trim() || 'gemini-3.5-live-translate-preview',

    REAL_MIC_ID: document.getElementById('REAL_MIC_ID').value,
    CABLE_INPUT_ID: document.getElementById('CABLE_INPUT_ID').value,
    VOICEMEETER_OUT_ID: document.getElementById('VOICEMEETER_OUT_ID').value,
    REAL_PHONES_ID: document.getElementById('REAL_PHONES_ID').value,

    OUTGOING_TARGET_LANG: outLang,
    OUTGOING_PIPELINE_NAME: 'OUTGOING_TO_' + outLang.toUpperCase(),

    INCOMING_TARGET_LANG: inLang,
    INCOMING_PIPELINE_NAME: 'INCOMING_TO_' + inLang.toUpperCase(),

    ENABLE_TRANSCRIPTS: '1',
    REALTIME_INPUT_CONFIG: '0',

    CAPTURE_FRAMES: '800',
    PLAYBACK_FRAMES: '480',
    GEMINI_CHUNK_MS: '100',

    MAX_CAPTURE_QUEUE_MS: '1500',
    MAX_PLAYBACK_QUEUE_MS: '900',
    MAX_WS_BUFFERED_BYTES: '262144',
    RECONNECT_DELAY_MS: '3000'
  };
}

async function saveEnv() {
  try {
    const config = collectConfig();
    const result = await api('/api/save', config);

    setStatus('saveResult', result.message + '\\n\\n.env saved.', true);
    await loadStatus();
  } catch (err) {
    setStatus('saveResult', err.message, false);
  }
}

async function showEnv() {
  try {
    const result = await api('/api/status');
    setStatus('saveResult', JSON.stringify(result.env, null, 2), true);
  } catch (err) {
    setStatus('saveResult', err.message, false);
  }
}

async function testGemini() {
  try {
    setStatus('geminiResult', 'Checking Gemini API key...', null);

    const result = await api('/api/test-gemini', {
      apiKey: document.getElementById('GEMINI_API_KEY').value.trim(),
      modelName: document.getElementById('MODEL_NAME').value.trim()
    });

    setStatus('geminiResult', result.message, result.ok);
  } catch (err) {
    setStatus('geminiResult', err.message, false);
  }
}

async function testInput(selectId) {
  try {
    const id = document.getElementById(selectId).value;
    setStatus('testResult', 'Testing input ID=' + id + ' ...\\nWait a few seconds.', null);

    const result = await api('/api/test-input', {
      deviceId: id,
      seconds: 6
    });

    setStatus(
      'testResult',
      'INPUT ' + selectId + ' ID=' + id + '\\n' +
      result.message + '\\n' +
      'maxRms=' + result.maxRms + '\\n' +
      'avgRms=' + result.avgRms + '\\n' +
      'frames=' + result.frames,
      result.ok
    );
  } catch (err) {
    setStatus('testResult', err.message, false);
  }
}

async function testOutput(selectId) {
  try {
    const id = document.getElementById(selectId).value;
    setStatus('testResult', 'Sending beep to output ID=' + id + ' ...', null);

    const result = await api('/api/test-output', {
      deviceId: id,
      seconds: 4
    });

    setStatus(
      'testResult',
      'OUTPUT ' + selectId + ' ID=' + id + '\\n' +
      result.message + '\\n' +
      'framesWritten=' + result.framesWritten,
      result.ok
    );
  } catch (err) {
    setStatus('testResult', err.message, false);
  }
}

document.addEventListener('change', function(event) {
  if (
    event.target.id === 'OUTGOING_TARGET_LANG' ||
    event.target.id === 'INCOMING_TARGET_LANG'
  ) {
    updateRouteLabels();
  }
});

document.addEventListener('input', function(event) {
  if (
    event.target.id === 'OUTGOING_CUSTOM_LANG' ||
    event.target.id === 'INCOMING_CUSTOM_LANG'
  ) {
    updateRouteLabels();
  }
});

loadStatus().catch(function(err) {
  setStatus('saveResult', err.message, false);
});
</script>
</body>
</html>`;

// =====================================================
// SERVER
// =====================================================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const devices = getDevices();
      const env = parseEnvFile();
      const detected = detectDevices(devices);

      sendJson(res, 200, {
        ok: true,
        env,
        devices,
        detected,
      });

      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(req);
      writeEnv(body);

      sendJson(res, 200, {
        ok: true,
        message: '.env сохранён',
        env: parseEnvFile(),
      });

      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/test-gemini') {
      const body = await readBody(req);

      const result = await testGeminiKey(
        body.apiKey,
        body.modelName || DEFAULT_MODEL
      );

      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/test-input') {
      const body = await readBody(req);

      const result = await meterInput(
        Number(body.deviceId),
        Number(body.seconds || 6)
      );

      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/test-output') {
      const body = await readBody(req);

      const result = await toneOutput(
        Number(body.deviceId),
        Number(body.seconds || 4)
      );

      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err.message,
    });
  }
});

function openBrowser() {
  const url = `http://localhost:${PORT}`;

  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

server.listen(PORT, () => {
  console.log('=====================================================');
  console.log('Gemini Translator Config Window');
  console.log('=====================================================');
  console.log(`Open: http://localhost:${PORT}`);
  console.log('');
  console.log('Важно: index.js должен быть остановлен,');
  console.log('иначе аудио-устройства могут быть заняты.');
  console.log('=====================================================');

  openBrowser();
});

server.on('error', (err) => {
  console.error('[SERVER ERROR]', err.message);

  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Закрой старый config-window.js или поменяй CONFIG_UI_PORT.`);
  }

  process.exit(1);
});