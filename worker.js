// Runs Kokoro TTS and MP3 encoding off the main thread so the page stays responsive.
import { KokoroTTS, TextSplitterStream, env } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
import { Mp3Encoder } from "https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000; // Kokoro always outputs 24 kHz mono
const MP3_KBPS = 128;
// Kokoro reads at most ~510 phoneme tokens per pass (the rest is silently cut), so keep chunks well below that.
const MAX_CHUNK_CHARS = 250;

// fp32 is the recommended precision on WebGPU; q8 is the light, fast option on CPU.
const ENGINES = {
  webgpu: { device: "webgpu", dtype: "fp32", sizeMB: 326 },
  "wasm-q8": { device: "wasm", dtype: "q8", sizeMB: 92 },
  "wasm-fp32": { device: "wasm", dtype: "fp32", sizeMB: 326 },
};

// Safari, and every iOS browser since they all run on WebKit, spins forever inside onnxruntime's default
// JSEP WebAssembly build (microsoft/onnxruntime#26827). The plain build of the same onnxruntime version that
// kokoro-js bundles works there, but it has no WebGPU support, so WebKit browsers always run on the CPU.
const IS_WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);
if (IS_WEBKIT) {
  const ort = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";
  env.wasmPaths = { mjs: `${ort}ort-wasm-simd-threaded.mjs`, wasm: `${ort}ort-wasm-simd-threaded.wasm` };
}

let tts = null;
let engine = null; // engine of the loaded model, or of the one being loaded
let queue = Promise.resolve();

// Every message names the engine involved so the page can fall back to the CPU when the GPU fails.
const post = (message) => self.postMessage({ ...message, engine });

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};

// Some onnxruntime failures only surface as unhandled rejections and leave the awaited call pending forever.
self.addEventListener("unhandledrejection", (event) => {
  post({ type: "error", message: describe(event.reason) });
});

async function handle(message) {
  try {
    if (message.type === "load") await ensureModel(message.engine);
    if (message.type === "generate") await generate(message);
  } catch (err) {
    console.error(err);
    post({ type: "error", message: describe(err) });
  }
}

function describe(err) {
  return err?.message ?? String(err);
}

async function resolveEngine(choice) {
  if (IS_WEBKIT) return choice === "wasm-fp32" ? "wasm-fp32" : "wasm-q8";
  if (choice !== "auto") return choice;
  try {
    return (await navigator.gpu?.requestAdapter()) ? "webgpu" : "wasm-q8";
  } catch {
    return "wasm-q8";
  }
}

async function ensureModel(choice) {
  const key = await resolveEngine(choice);
  if (tts && engine === key) return;
  if (tts) {
    await tts.model.dispose();
    tts = null;
  }
  engine = key;
  const { device, dtype, sizeMB } = ENGINES[key];
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
  post({ type: "ready" });
}

async function generate(job) {
  await ensureModel(job.engine);
  const started = performance.now();
  const samples = await synthesize(job);
  post({
    type: "result",
    job,
    blob: encodeMp3(samples),
    seconds: samples.length / SAMPLE_RATE,
    elapsed: (performance.now() - started) / 1000,
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
