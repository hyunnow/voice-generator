// Runs Kokoro TTS and MP3 encoding off the main thread so the page stays responsive.
import { KokoroTTS, TextSplitterStream } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
import { Mp3Encoder } from "https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000; // Kokoro always outputs 24 kHz mono
const MP3_KBPS = 128;
// Kokoro reads at most ~510 phoneme tokens per pass (the rest is silently cut), so keep chunks well below that.
const MAX_CHUNK_CHARS = 250;

// fp32 is the recommended precision on WebGPU; q8 is the light, fast option on CPU.
const ENGINES = {
  webgpu: { device: "webgpu", dtype: "fp32", sizeMB: 326, label: "GPU(WebGPU)" },
  "wasm-q8": { device: "wasm", dtype: "q8", sizeMB: 92, label: "CPU(q8)" },
  "wasm-fp32": { device: "wasm", dtype: "fp32", sizeMB: 326, label: "CPU(fp32)" },
};

let tts = null;
let current = null;
let gpuFailed = false;
let queue = Promise.resolve();

const post = (message) => self.postMessage(message);

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};

async function handle(message) {
  try {
    if (message.type === "load") await ensureModel(message.engine);
    if (message.type === "generate") await generate(message);
  } catch (err) {
    console.error(err);
    post({ type: "error", job: message.type === "generate" ? message : null, message: err?.message ?? String(err) });
  }
}

async function hasWebGPU() {
  try {
    return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function ensureModel(choice) {
  const key = choice === "auto" ? (!gpuFailed && (await hasWebGPU()) ? "webgpu" : "wasm-q8") : choice;
  if (tts && current === key) return;
  try {
    await loadModel(key);
  } catch (err) {
    if (key === "wasm-q8") throw err;
    console.warn(err);
    if (key === "webgpu") gpuFailed = true;
    post({ type: "notice", message: `${ENGINES[key].label} 로딩에 실패해서 CPU(q8)로 바꿀게요…` });
    await loadModel("wasm-q8");
  }
}

async function loadModel(key) {
  if (tts) {
    await tts.model.dispose();
    tts = null;
    current = null;
  }
  const { device, dtype, sizeMB, label } = ENGINES[key];
  post({ type: "loading", percent: 0, sizeMB });
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    device,
    dtype,
    progress_callback: (p) => {
      // The .onnx weights are ~99% of the download; the tokenizer/config files would only make the bar jump.
      if (p.status === "progress" && p.total && p.file.endsWith(".onnx")) {
        post({ type: "loading", percent: (100 * p.loaded) / p.total, sizeMB });
      }
    },
  });
  current = key;
  post({ type: "ready", engine: label });
}

async function generate(job) {
  await ensureModel(job.engine);
  const started = performance.now();
  let samples;
  try {
    samples = await synthesize(job);
  } catch (err) {
    if (current !== "webgpu") throw err;
    console.warn(err);
    gpuFailed = true;
    post({ type: "notice", message: "GPU에서 오류가 나서 CPU(q8)로 다시 만들게요…" });
    await loadModel("wasm-q8");
    samples = await synthesize(job);
  }
  const blob = encodeMp3(samples);
  post({
    type: "result",
    job,
    blob,
    seconds: samples.length / SAMPLE_RATE,
    elapsed: (performance.now() - started) / 1000,
    engine: ENGINES[current].label,
  });
}

async function synthesize({ text, voice, speed }) {
  const chunks = splitText(text);
  if (chunks.length === 0) throw new Error("읽을 수 있는 영어 문장이 없어요.");
  // Kokoro pads every chunk with ~0.3 s of silence before and ~0.5 s after, so plain concatenation
  // already leaves a natural pause between chunks (and it scales with speed).
  const parts = [];
  for (const [i, chunk] of chunks.entries()) {
    post({ type: "progress", done: i, total: chunks.length });
    parts.push((await tts.generate(chunk, { voice, speed })).audio);
  }
  return concat(parts);
}

// Each line is read on its own. Sentences within a line are packed together (up to MAX_CHUNK_CHARS)
// so the model voices them in one pass and keeps the natural flow between them.
function splitText(text) {
  const chunks = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const splitter = new TextSplitterStream();
    splitter.push(line);
    const pieces = [...splitter].flatMap((sentence) =>
      sentence.length <= MAX_CHUNK_CHARS
        ? [sentence]
        : sentence.split(/(?<=[,;:])\s+/).flatMap((clause) => (clause.length <= MAX_CHUNK_CHARS ? [clause] : clause.split(/\s+/))),
    );
    chunks.push(...pack(pieces));
  }
  return chunks;
}

function pack(pieces) {
  const chunks = [];
  let chunk = "";
  for (const piece of pieces) {
    if (chunk && chunk.length + 1 + piece.length > MAX_CHUNK_CHARS) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk = chunk ? `${chunk} ${piece}` : piece;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function concat(arrays) {
  const out = new Float32Array(arrays.reduce((length, a) => length + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function encodeMp3(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, MP3_KBPS);
  const frames = [];
  for (let i = 0; i < pcm.length; i += 1152) frames.push(encoder.encodeBuffer(pcm.subarray(i, i + 1152)));
  frames.push(encoder.flush());
  return new Blob(frames, { type: "audio/mpeg" });
}
