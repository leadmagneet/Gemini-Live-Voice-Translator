require('dotenv').config();

const WebSocket = require('ws');
const { RtAudio, RtAudioFormat } = require('audify');

// =====================================================
// ENV
// =====================================================
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('[ERROR] GEMINI_API_KEY is missing in your .env file.');
  process.exit(1);
}

// =====================================================
// DEVICE CONFIG
// =====================================================
const WASAPI_API = 7;

// Твой реальный микрофон
const REAL_MIC_ID = Number(process.env.REAL_MIC_ID || 148);

// VB-CABLE Input.
const CABLE_INPUT_ID = Number(process.env.CABLE_INPUT_ID || 132);

// VoiceMeeter Out B1.
const VOICEMEETER_OUT_ID = Number(process.env.VOICEMEETER_OUT_ID || 146);

const REAL_PHONES_ID = Number(process.env.REAL_PHONES_ID || 135);

// =====================================================
// TRANSLATION DIRECTIONS
// =====================================================

const OUTGOING_TARGET_LANG = process.env.OUTGOING_TARGET_LANG || 'en';

const INCOMING_TARGET_LANG = process.env.INCOMING_TARGET_LANG || 'ru';

const OUTGOING_PIPELINE_NAME =
  process.env.OUTGOING_PIPELINE_NAME || `OUTGOING_TO_${OUTGOING_TARGET_LANG.toUpperCase()}`;

const INCOMING_PIPELINE_NAME =
  process.env.INCOMING_PIPELINE_NAME || `INCOMING_TO_${INCOMING_TARGET_LANG.toUpperCase()}`;

// =====================================================
// GEMINI CONFIG
// =====================================================
const MODEL_NAME = process.env.MODEL_NAME || 'gemini-3.5-live-translate-preview';

const URL =
  `wss://generativelanguage.googleapis.com/ws/` +
  `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

let runtimeEnableTranscripts = process.env.ENABLE_TRANSCRIPTS !== '0';

let runtimeEnableRealtimeInputConfig = process.env.REALTIME_INPUT_CONFIG === '1';

// =====================================================
// AUDIO CONFIG
// =====================================================
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

const CAPTURE_FRAMES = Number(process.env.CAPTURE_FRAMES || 800);     // 50 ms at 16 kHz
const PLAYBACK_FRAMES = Number(process.env.PLAYBACK_FRAMES || 480);   // 20 ms at 24 kHz

const GEMINI_CHUNK_MS = Number(process.env.GEMINI_CHUNK_MS || 100);

const CAPTURE_FRAME_BYTES = CAPTURE_FRAMES * CHANNELS * BYTES_PER_SAMPLE;
const PLAYBACK_FRAME_BYTES = PLAYBACK_FRAMES * CHANNELS * BYTES_PER_SAMPLE;

const GEMINI_INPUT_CHUNK_BYTES =
  INPUT_RATE * CHANNELS * BYTES_PER_SAMPLE * GEMINI_CHUNK_MS / 1000;

const MAX_CAPTURE_QUEUE_MS = Number(process.env.MAX_CAPTURE_QUEUE_MS || 1500);
const MAX_PLAYBACK_QUEUE_MS = Number(process.env.MAX_PLAYBACK_QUEUE_MS || 900);

const MAX_CAPTURE_QUEUE_BYTES =
  INPUT_RATE * CHANNELS * BYTES_PER_SAMPLE * MAX_CAPTURE_QUEUE_MS / 1000;

const MAX_PLAYBACK_QUEUE_BYTES =
  OUTPUT_RATE * CHANNELS * BYTES_PER_SAMPLE * MAX_PLAYBACK_QUEUE_MS / 1000;

const MAX_WS_BUFFERED_BYTES = Number(process.env.MAX_WS_BUFFERED_BYTES || 256 * 1024);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 3000);

// =====================================================
// GLOBAL STATE
// =====================================================
let shuttingDown = false;

// =====================================================
// BYTE QUEUE
// =====================================================
class ByteQueue {
  constructor(maxBytes, name) {
    this.maxBytes = maxBytes;
    this.name = name;

    this.chunks = [];
    this.offset = 0;
    this.size = 0;
  }

  push(buffer) {
    if (!buffer || buffer.length === 0) return;

    const copy = Buffer.from(buffer);
    this.chunks.push(copy);
    this.size += copy.length;

    if (this.size > this.maxBytes) {
      const overflow = this.size - this.maxBytes;
      this.dropOldest(overflow);

      console.warn(
        `[${this.name}] Dropped ${overflow} old bytes to keep realtime. queueBytes=${this.size}`
      );
    }
  }

  dropOldest(bytes) {
    let remaining = bytes;

    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      const available = head.length - this.offset;

      if (remaining < available) {
        this.offset += remaining;
        this.size -= remaining;
        return;
      }

      remaining -= available;
      this.size -= available;
      this.chunks.shift();
      this.offset = 0;
    }

    if (this.chunks.length === 0) {
      this.offset = 0;
      this.size = 0;
    }
  }

  readExactPadded(byteCount) {
    const out = Buffer.alloc(byteCount);
    this._readInto(out);
    return out;
  }

  _readInto(outputBuffer) {
    outputBuffer.fill(0);

    let written = 0;

    while (written < outputBuffer.length && this.chunks.length > 0) {
      const head = this.chunks[0];

      const available = head.length - this.offset;
      const need = outputBuffer.length - written;
      const n = Math.min(available, need);

      head.copy(outputBuffer, written, this.offset, this.offset + n);

      written += n;
      this.offset += n;
      this.size -= n;

      if (this.offset >= head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }

    if (this.chunks.length === 0) {
      this.offset = 0;
      this.size = 0;
    }

    return written;
  }

  clear() {
    this.chunks = [];
    this.offset = 0;
    this.size = 0;
  }
}

// =====================================================
// AUDIFY OUTPUT PLAYER
// =====================================================
class RtAudioWritePlayer {
  constructor(stream, queue, name) {
    this.stream = stream;
    this.queue = queue;
    this.name = name;

    this.running = false;
    this.framesWritten = 0;
    this.writeErrorCount = 0;
    this.lastLogAt = Date.now();
  }

  start() {
    if (this.running) return;

    this.running = true;

    for (let i = 0; i < 4; i++) {
      this.writeNextFrame();
    }

    console.log(`[${this.name}] RtAudio write player started.`);
  }

  stop() {
    this.running = false;
  }

  onFrameDone() {
    if (!this.running) return;
    this.writeNextFrame();
  }

  writeNextFrame() {
    if (!this.running) return;

    const frame = this.queue.readExactPadded(PLAYBACK_FRAME_BYTES);

    try {
      this.stream.write(frame);
      this.framesWritten++;

      const now = Date.now();

      if (now - this.lastLogAt > 3000) {
        this.lastLogAt = now;

        const queueMs =
          Math.round(
            this.queue.size /
            (OUTPUT_RATE * CHANNELS * BYTES_PER_SAMPLE) *
            1000
          );

        console.log(
          `[${this.name}] audio write alive. framesWritten=${this.framesWritten}, queueBytes=${this.queue.size}, queueMs=${queueMs}`
        );
      }
    } catch (err) {
      this.writeErrorCount++;

      if (this.writeErrorCount < 10 || this.writeErrorCount % 100 === 0) {
        console.error(`[${this.name}] stream.write failed:`, err.message);
      }
    }
  }
}

// =====================================================
// GEMINI SETUP
// =====================================================
function buildSetupMessage(targetLanguageCode) {
  const setup = {
    model: `models/${MODEL_NAME}`,

    generationConfig: {
      responseModalities: ['AUDIO'],

      translationConfig: {
        targetLanguageCode,
        echoTargetLanguage: false,
      },
    },
  };

  if (runtimeEnableRealtimeInputConfig) {
    setup.realtimeInputConfig = {
      automaticActivityDetection: {
        disabled: false,
        prefixPaddingMs: Number(process.env.SERVER_PREFIX_PADDING_MS || 80),
        silenceDurationMs: Number(process.env.SERVER_SILENCE_DURATION_MS || 300),
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    };
  }

  if (runtimeEnableTranscripts) {
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
  }

  return { setup };
}

function maybeAdjustSetupAfterClose(code, reasonText) {
  if (code !== 1007) return false;

  let changed = false;

  if (
    runtimeEnableTranscripts &&
    /inputAudioTranscription|outputAudioTranscription/i.test(reasonText)
  ) {
    runtimeEnableTranscripts = false;
    changed = true;

    console.warn('[SYSTEM] Server rejected transcription fields. Disabling transcripts.');
  }

  if (
    runtimeEnableRealtimeInputConfig &&
    /realtimeInputConfig|automaticActivityDetection|activityHandling/i.test(reasonText)
  ) {
    runtimeEnableRealtimeInputConfig = false;
    changed = true;

    console.warn('[SYSTEM] Server rejected realtimeInputConfig. Disabling realtimeInputConfig.');
  }

  return changed;
}

// =====================================================
// TRANSLATION PIPELINE
// =====================================================
class TranslationPipeline {
  constructor(options) {
    this.name = options.name;
    this.targetLanguageCode = options.targetLanguageCode;

    this.inputDeviceId = options.inputDeviceId;
    this.outputDeviceId = options.outputDeviceId;

    this.inputStreamName = options.inputStreamName;
    this.outputStreamName = options.outputStreamName;

    this.inputAudio = new RtAudio(WASAPI_API);
    this.outputAudio = new RtAudio(WASAPI_API);

    this.captureQueue = new ByteQueue(
      MAX_CAPTURE_QUEUE_BYTES,
      `${this.name} CAPTURE`
    );

    this.playbackQueue = new ByteQueue(
      MAX_PLAYBACK_QUEUE_BYTES,
      `${this.name} PLAYBACK`
    );

    this.ws = null;
    this.ready = false;

    this.capturePumpTimer = null;
    this.hardwareStarted = false;

    this.player = null;
  }

  connectWs() {
    if (shuttingDown) return;

    this.ready = false;

    const ws = new WebSocket(URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log(`[WS ${this.name}] Connected. target=${this.targetLanguageCode}`);

      try {
        ws.send(JSON.stringify(buildSetupMessage(this.targetLanguageCode)));
      } catch (err) {
        console.error(`[WS ${this.name}] setup send failed:`, err.message);
      }
    });

    ws.on('message', (data) => {
      const result = this.handleServerMessage(data);

      if (result === 'setupComplete') {
        this.ready = true;
      }
    });

    ws.on('error', (err) => {
      console.error(`[WS ${this.name} ERROR]`, err.message);
    });

    ws.on('close', (code, reason) => {
      const reasonText = reason ? reason.toString() : '';

      console.warn(`[WS ${this.name}] Closed. code=${code} reason=${reasonText}`);

      if (this.ws === ws) {
        this.ws = null;
        this.ready = false;
      }

      this.captureQueue.clear();
      this.playbackQueue.clear();

      maybeAdjustSetupAfterClose(code, reasonText);

      if (!shuttingDown) {
        setTimeout(() => this.connectWs(), RECONNECT_DELAY_MS);
      }
    });
  }

  handleServerMessage(data) {
    let response;

    try {
      response = JSON.parse(data.toString());
    } catch (err) {
      console.error(`[${this.name}] Bad JSON from server:`, err.message);
      return null;
    }

    if (response.setupComplete !== undefined) {
      console.log(`[SYSTEM] ${this.name} setup complete.`);
      return 'setupComplete';
    }

    const content = response.serverContent;

    if (!content) {
      return null;
    }

    if (content.interrupted) {
      console.warn(`[${this.name}] Server interrupted generation. Clearing own playback queue.`);
      this.playbackQueue.clear();
    }

    if (content.inputTranscription?.text) {
      console.log(`[${this.name} INPUT] ${content.inputTranscription.text}`);
    }

    if (content.outputTranscription?.text) {
      console.log(`[${this.name} OUTPUT] ${content.outputTranscription.text}`);
    }

    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const inlineData = part.inlineData;

        if (
          inlineData?.data &&
          inlineData?.mimeType &&
          inlineData.mimeType.startsWith('audio/pcm')
        ) {
          const audio = Buffer.from(inlineData.data, 'base64');
          this.playbackQueue.push(audio);
        }
      }
    }

    return null;
  }

  sendAudioToGemini(chunk) {
    const ws = this.ws;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      console.warn(
        `[${this.name}] WebSocket backpressure. Dropping input chunk. bufferedAmount=${ws.bufferedAmount}`
      );

      return false;
    }

    const message = {
      realtimeInput: {
        audio: {
          data: chunk.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    };

    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error(`[${this.name}] ws.send failed:`, err.message);
      return false;
    }
  }

  startCapturePump() {
    if (this.capturePumpTimer) return;

    this.capturePumpTimer = setInterval(() => {
      this.pumpCapture();
    }, 10);

    console.log(`[${this.name}] capture pump started.`);
  }

  stopCapturePump() {
    if (this.capturePumpTimer) {
      clearInterval(this.capturePumpTimer);
      this.capturePumpTimer = null;
    }

    this.captureQueue.clear();
  }

  pumpCapture() {
    if (!this.ready) {
      this.captureQueue.clear();
      return;
    }

    let guard = 0;

    while (this.captureQueue.size >= GEMINI_INPUT_CHUNK_BYTES && guard < 20) {
      guard++;

      const chunk = this.captureQueue.readExactPadded(GEMINI_INPUT_CHUNK_BYTES);
      this.sendAudioToGemini(chunk);
    }
  }

  startHardware() {
    if (this.hardwareStarted) return;

    this.hardwareStarted = true;

    try {
      // -----------------------------
      // INPUT STREAM
      // -----------------------------
      this.inputAudio.openStream(
        null,
        { deviceId: this.inputDeviceId, nChannels: CHANNELS },
        RtAudioFormat.RTAUDIO_SINT16,
        INPUT_RATE,
        CAPTURE_FRAMES,
        this.inputStreamName,
        (inputBuffer) => {
          this.captureQueue.push(inputBuffer);
        },
        null
      );

      this.inputAudio.start();

      // -----------------------------
      // OUTPUT STREAM
      // -----------------------------
      this.outputAudio.openStream(
        { deviceId: this.outputDeviceId, nChannels: CHANNELS },
        null,
        RtAudioFormat.RTAUDIO_SINT16,
        OUTPUT_RATE,
        PLAYBACK_FRAMES,
        this.outputStreamName,
        null,
        () => {
          if (this.player) {
            this.player.onFrameDone();
          }
        }
      );

      try {
        this.outputAudio.outputVolume = 1.0;
      } catch (_) {}

      this.player = new RtAudioWritePlayer(
        this.outputAudio,
        this.playbackQueue,
        this.outputStreamName
      );

      this.outputAudio.start();
      this.player.start();

      this.startCapturePump();

      console.log(`[HARDWARE ${this.name}] started.`);
      console.log(`[HARDWARE ${this.name}] inputDeviceId=${this.inputDeviceId}`);
      console.log(`[HARDWARE ${this.name}] outputDeviceId=${this.outputDeviceId}`);
    } catch (err) {
      console.error(`[CRITICAL HARDWARE ERROR ${this.name}]`, err.message);
      process.exit(1);
    }
  }

  stop() {
    console.log(`[SYSTEM] Stopping ${this.name}...`);

    this.stopCapturePump();

    try {
      if (this.player) {
        this.player.stop();
      }
    } catch (_) {}

    try {
      this.captureQueue.clear();
      this.playbackQueue.clear();
    } catch (_) {}

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    } catch (_) {}

    try {
      this.inputAudio.stop();
    } catch (_) {}

    try {
      this.inputAudio.closeStream();
    } catch (_) {}

    try {
      this.outputAudio.stop();
    } catch (_) {}

    try {
      this.outputAudio.closeStream();
    } catch (_) {}

    console.log(`[SYSTEM] ${this.name} stopped.`);
  }
}

// =====================================================
// PIPELINES
// =====================================================

const outgoingPipeline = new TranslationPipeline({
  name: OUTGOING_PIPELINE_NAME,
  targetLanguageCode: OUTGOING_TARGET_LANG,

  inputDeviceId: REAL_MIC_ID,
  outputDeviceId: CABLE_INPUT_ID,

  inputStreamName: 'RealMic-Input',
  outputStreamName: 'CableOut-ToConference',
});

// PIPELINE 2:
const incomingPipeline = new TranslationPipeline({
  name: INCOMING_PIPELINE_NAME,
  targetLanguageCode: INCOMING_TARGET_LANG,

  inputDeviceId: VOICEMEETER_OUT_ID,
  outputDeviceId: REAL_PHONES_ID,

  inputStreamName: 'VoiceMeeter-Conference',
  outputStreamName: 'Headphones-Translated',
});

const pipelines = [
  outgoingPipeline,
  incomingPipeline,
];

// =====================================================
// SHUTDOWN
// =====================================================
function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log('\n[SYSTEM] Shutting down...');

  for (const pipeline of pipelines) {
    try {
      pipeline.stop();
    } catch (err) {
      console.error(`[SYSTEM] Failed to stop ${pipeline.name}:`, err.message);
    }
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// =====================================================
// START
// =====================================================
console.log('=====================================================');
console.log('=== RUNNING ENV-CONFIGURABLE DUAL TRANSLATOR ========');
console.log('=====================================================');

console.log('[SYSTEM] Routing expected:');
console.log('[SYSTEM] Conference microphone = CABLE Output');
console.log('[SYSTEM] Conference speakers   = VoiceMeeter Input');
console.log('[SYSTEM] Node writes outgoing translated audio to = CABLE Input');
console.log('[SYSTEM] Node reads conference audio from         = VoiceMeeter Out B1');
console.log('[SYSTEM] Node plays incoming translated audio to  = REAL_PHONES_ID');
console.log('-----------------------------------------------------');

console.log(`[SYSTEM] MODEL_NAME=${MODEL_NAME}`);
console.log(`[SYSTEM] ENABLE_TRANSCRIPTS=${runtimeEnableTranscripts}`);
console.log(`[SYSTEM] REALTIME_INPUT_CONFIG=${runtimeEnableRealtimeInputConfig}`);

console.log(`[SYSTEM] OUTGOING_PIPELINE_NAME=${OUTGOING_PIPELINE_NAME}`);
console.log(`[SYSTEM] OUTGOING_TARGET_LANG=${OUTGOING_TARGET_LANG}`);
console.log(`[SYSTEM] INCOMING_PIPELINE_NAME=${INCOMING_PIPELINE_NAME}`);
console.log(`[SYSTEM] INCOMING_TARGET_LANG=${INCOMING_TARGET_LANG}`);

console.log(`[SYSTEM] CAPTURE_FRAMES=${CAPTURE_FRAMES}`);
console.log(`[SYSTEM] PLAYBACK_FRAMES=${PLAYBACK_FRAMES}`);
console.log(`[SYSTEM] GEMINI_CHUNK_MS=${GEMINI_CHUNK_MS}`);
console.log(`[SYSTEM] MAX_CAPTURE_QUEUE_MS=${MAX_CAPTURE_QUEUE_MS}`);
console.log(`[SYSTEM] MAX_PLAYBACK_QUEUE_MS=${MAX_PLAYBACK_QUEUE_MS}`);

console.log(`[SYSTEM] REAL_MIC_ID=${REAL_MIC_ID}`);
console.log(`[SYSTEM] CABLE_INPUT_ID=${CABLE_INPUT_ID}`);
console.log(`[SYSTEM] VOICEMEETER_OUT_ID=${VOICEMEETER_OUT_ID}`);
console.log(`[SYSTEM] REAL_PHONES_ID=${REAL_PHONES_ID}`);

console.log(`[SYSTEM] CAPTURE_FRAME_BYTES=${CAPTURE_FRAME_BYTES}`);
console.log(`[SYSTEM] PLAYBACK_FRAME_BYTES=${PLAYBACK_FRAME_BYTES}`);
console.log('-----------------------------------------------------');

for (const pipeline of pipelines) {
  pipeline.connectWs();
}

setTimeout(() => {
  for (const pipeline of pipelines) {
    pipeline.startHardware();
  }
}, 700);
