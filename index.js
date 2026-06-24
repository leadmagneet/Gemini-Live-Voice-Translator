require('dotenv').config();

const WebSocket = require('ws');
const { RtAudio, RtAudioFormat } = require('audify');
const fs = require('fs');
const path = require('path');

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
// Node пишет сюда переведённый звук, конференция читает CABLE Output.
const CABLE_INPUT_ID = Number(process.env.CABLE_INPUT_ID || 132);

// VoiceMeeter Out B1.
// Node читает отсюда звук конференции.
const VOICEMEETER_OUT_ID = Number(process.env.VOICEMEETER_OUT_ID || 146);

// Куда отправлять перевод тебе.
// Если наушники отдельным устройством — сюда ID наушников.
// Если jack-наушники через Realtek — часто это "Динамики Realtek".
const REAL_PHONES_ID = Number(process.env.REAL_PHONES_ID || 135);

// =====================================================
// TRANSLATION DIRECTIONS
// =====================================================

// Твоя речь -> перевод -> в конференцию
// Для схемы RU -> EN ставь en
const OUTGOING_TARGET_LANG = process.env.OUTGOING_TARGET_LANG || 'en';

// Звук конференции -> перевод -> тебе в наушники
// Для схемы EN -> RU ставь ru
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

// Транскрипты нужны только для логов.
// Это не текстовый ввод.
let runtimeEnableTranscripts = process.env.ENABLE_TRANSCRIPTS !== '0';

// По умолчанию выключено, потому что у тебя стабильнее без этого.
let runtimeEnableRealtimeInputConfig = process.env.REALTIME_INPUT_CONFIG === '1';

// =====================================================
// AUDIO CONFIG
// =====================================================
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

// Стабильные значения.
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
// SESSION RECORDING (optional, RECORD_SESSION=1)
// =====================================================
const RECORD_SESSION = process.env.RECORD_SESSION === '1';

let sessionDir = null;
let transcriptStream = null;
const allRecorders = [];

// Two combined call recordings (both directions mixed into one file each).
let originalTrack = null;    // your mic + the other person's real voice (16 kHz)
let translatedTrack = null;  // your translated EN + incoming translated RU (24 kHz)

function initSessionLogging() {
  if (!RECORD_SESSION) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  sessionDir = path.join(__dirname, 'logs', stamp);

  fs.mkdirSync(sessionDir, { recursive: true });

  transcriptStream = fs.createWriteStream(
    path.join(sessionDir, 'transcript.log'),
    { flags: 'a' }
  );

  originalTrack = new MixTrack(path.join(sessionDir, 'original.wav'), INPUT_RATE);
  translatedTrack = new MixTrack(path.join(sessionDir, 'translated.wav'), OUTPUT_RATE);

  console.log(`[SYSTEM] RECORD_SESSION=1 -> writing original.wav + translated.wav + transcript to ${sessionDir}`);
}

function logTranscript(line) {
  if (!transcriptStream) return;
  transcriptStream.write(`[${new Date().toISOString()}] ${line}\n`);
}

function finalizeRecordings(done) {
  const open = allRecorders.filter((r) => !r.closed);

  let pending = open.length;
  let finished = false;

  const finishAll = () => {
    if (finished) return;
    finished = true;

    if (transcriptStream) {
      try { transcriptStream.end(); } catch (_) {}
    }

    done();
  };

  if (pending === 0) {
    finishAll();
    return;
  }

  for (const r of open) {
    r.close(() => {
      pending--;
      if (pending <= 0) finishAll();
    });
  }

  // Safety net so we never hang on exit.
  setTimeout(finishAll, 2000);
}

// Streams 16-bit PCM into a .wav file. Header is written as a placeholder
// and patched with the real sizes on graceful shutdown (Ctrl+C).
class WavRecorder {
  constructor(filePath, sampleRate) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = CHANNELS;
    this.dataBytes = 0;
    this.closed = false;

    this.stream = fs.createWriteStream(filePath);
    this.stream.write(this._header(0));

    // Periodically rewrite the header so the file stays playable even if the
    // process is killed without a graceful shutdown (crash / force-kill).
    this.flushTimer = setInterval(() => this._patchHeader(), 3000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  _patchHeader() {
    if (this.closed) return;

    try {
      const fd = fs.openSync(this.filePath, 'r+');
      fs.writeSync(fd, this._header(this.dataBytes), 0, 44, 0);
      fs.closeSync(fd);
    } catch (_) {
      // File may be briefly locked; the next tick will retry.
    }
  }

  _header(dataLen) {
    const buf = Buffer.alloc(44);
    const byteRate = this.sampleRate * this.channels * BYTES_PER_SAMPLE;
    const blockAlign = this.channels * BYTES_PER_SAMPLE;

    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(this.channels, 22);
    buf.writeUInt32LE(this.sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);

    return buf;
  }

  write(buffer) {
    if (this.closed || !buffer || buffer.length === 0) return;

    this.dataBytes += buffer.length;
    this.stream.write(Buffer.from(buffer));
  }

  close(done) {
    if (this.closed) {
      if (done) done();
      return;
    }

    this.closed = true;
    clearInterval(this.flushTimer);

    this.stream.end(() => {
      try {
        const fd = fs.openSync(this.filePath, 'r+');
        fs.writeSync(fd, this._header(this.dataBytes), 0, 44, 0);
        fs.closeSync(fd);
      } catch (err) {
        console.error(`[REC] Failed to finalize ${this.filePath}:`, err.message);
      }

      if (done) done();
    });
  }
}

// Mixes several PCM sources into ONE mono .wav on a shared wall-clock timeline.
// Each source's chunk is placed at the moment it arrives, overlapping audio is
// summed (clamped to int16). Used to produce two combined call recordings:
//   - original.wav   = your mic + the other person's real voice
//   - translated.wav = your translated EN + the incoming translated RU
class MixTrack {
  constructor(filePath, sampleRate) {
    this.rate = sampleRate;
    this.startTime = Date.now();
    this.baseSample = 0;          // samples already flushed to the file
    this.acc = new Int32Array(sampleRate); // pending (un-flushed) samples
    this.accLen = 0;
    this.closed = false;

    this.recorder = new WavRecorder(filePath, sampleRate);

    // Flush completed samples to disk regularly.
    this.flushTimer = setInterval(() => this.flush(), 200);
    if (this.flushTimer.unref) this.flushTimer.unref();

    allRecorders.push(this);
  }

  _ensure(len) {
    if (len <= this.acc.length) return;
    let size = this.acc.length;
    while (size < len) size *= 2;
    const next = new Int32Array(size);
    next.set(this.acc.subarray(0, this.accLen));
    this.acc = next;
  }

  add(int16buf) {
    if (this.closed || !int16buf || int16buf.length < 2) return;

    const n = int16buf.length >> 1;
    let idx = Math.round((Date.now() - this.startTime) / 1000 * this.rate) - this.baseSample;
    if (idx < 0) idx = 0;

    const end = idx + n;
    this._ensure(end);
    if (end > this.accLen) this.accLen = end;

    for (let i = 0; i < n; i++) {
      this.acc[idx + i] += int16buf.readInt16LE(i << 1);
    }
  }

  _drain(count) {
    const out = Buffer.allocUnsafe(count * 2);
    for (let i = 0; i < count; i++) {
      let s = this.acc[i];
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out.writeInt16LE(s, i << 1);
    }
    this.recorder.write(out);

    // Shift remaining samples to the front and zero the vacated tail.
    this.acc.copyWithin(0, count, this.accLen);
    this.accLen -= count;
    this.acc.fill(0, this.accLen);
    this.baseSample += count;
  }

  flush() {
    if (this.closed || this.accLen === 0) return;

    // Keep the last 400 ms in memory so late-arriving overlaps still mix.
    const margin = Math.round(this.rate * 0.4);
    const nowIdx = Math.round((Date.now() - this.startTime) / 1000 * this.rate) - this.baseSample;

    const count = Math.min(this.accLen, nowIdx - margin);
    if (count > 0) this._drain(count);
  }

  close(done) {
    if (this.closed) {
      if (done) done();
      return;
    }

    this.closed = true;
    clearInterval(this.flushTimer);

    if (this.accLen > 0) this._drain(this.accLen);

    this.recorder.close(done);
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

    // 4 * 20 ms = около 80 ms стартового буфера.
    // Это стабильнее, чем 1 frame, но почти не даёт задержки.
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

      // ВАЖНО:
      // Каждый пайплайн чистит только свои очереди.
      // Второй пайплайн не трогаем.
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
      logTranscript(`[${this.name} INPUT] ${content.inputTranscription.text}`);
    }

    if (content.outputTranscription?.text) {
      console.log(`[${this.name} OUTPUT] ${content.outputTranscription.text}`);
      logTranscript(`[${this.name} OUTPUT] ${content.outputTranscription.text}`);
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
          if (translatedTrack) translatedTrack.add(audio);
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
      // Не отправляем старый звук после reconnect.
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
          if (originalTrack) originalTrack.add(inputBuffer);
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

// Must run before pipelines are constructed (recorders use sessionDir).
initSessionLogging();

// PIPELINE 1:
// Твоя речь -> перевод -> в конференцию через VB-CABLE
const outgoingPipeline = new TranslationPipeline({
  name: OUTGOING_PIPELINE_NAME,
  targetLanguageCode: OUTGOING_TARGET_LANG,

  inputDeviceId: REAL_MIC_ID,
  outputDeviceId: CABLE_INPUT_ID,

  inputStreamName: 'RealMic-Input',
  outputStreamName: 'CableOut-ToConference',
});

// PIPELINE 2:
// Звук конференции -> перевод -> тебе в наушники
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

  finalizeRecordings(() => {
    if (sessionDir) {
      console.log(`[SYSTEM] Recordings saved to ${sessionDir}`);
    }
    process.exit(0);
  });
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