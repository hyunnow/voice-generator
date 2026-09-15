// Voices graded C or better in the Kokoro v1.0 voice card; lower grades sound noticeably synthetic.
const VOICES = [
  ["미국 여성", [["af_heart", "Heart", "가장 자연스러움 · 추천"], ["af_bella", "Bella", "A-"], ["af_nicole", "Nicole", "부드러운 톤 · B-"], ["af_aoede", "Aoede", "C+"], ["af_kore", "Kore", "C+"], ["af_sarah", "Sarah", "C+"]]],
  ["미국 남성", [["am_michael", "Michael", "C+"], ["am_fenrir", "Fenrir", "C+"], ["am_puck", "Puck", "C+"]]],
  ["영국 여성", [["bf_emma", "Emma", "B-"], ["bf_isabella", "Isabella", "C"]]],
  ["영국 남성", [["bm_george", "George", "C"], ["bm_fable", "Fable", "C"]]],
];
const VOICE_NAMES = Object.fromEntries(VOICES.flatMap(([, voices]) => voices.map(([id, name]) => [id, name])));
const PREFS_KEY = "tts-prefs";

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"),
  voice: $("voice"),
  speed: $("speed"),
  speedValue: $("speedValue"),
  engine: $("engine"),
  button: $("generate"),
  status: $("status"),
  bar: $("bar"),
  results: $("results"),
};

for (const [group, voices] of VOICES) {
  const optgroup = document.createElement("optgroup");
  optgroup.label = group;
  for (const [id, name, note] of voices) optgroup.append(new Option(`${name} (${note})`, id));
  els.voice.append(optgroup);
}

const prefs = readPrefs();
if ([...els.voice.options].some((o) => o.value === prefs.voice)) els.voice.value = prefs.voice;
if ([...els.engine.options].some((o) => o.value === prefs.engine)) els.engine.value = prefs.engine;
if (prefs.speed) els.speed.value = prefs.speed;
showSpeed();

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let busy = false;

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case "loading":
      setStatus(`음성 모델 불러오는 중… ${Math.floor(data.percent)}% (처음 한 번만 약 ${data.sizeMB}MB를 내려받아요)`, data.percent);
      break;
    case "ready":
      if (!busy) setStatus(`준비 완료 · ${data.engine}에서 실행`);
      break;
    case "notice":
      setStatus(data.message);
      break;
    case "progress":
      if (data.total > 1) setStatus(`음성 만드는 중… (${data.done + 1}/${data.total})`, (100 * data.done) / data.total);
      else setStatus("음성 만드는 중…");
      break;
    case "result":
      addResult(data);
      finish(`완료 · ${data.seconds.toFixed(1)}초 분량 · ${data.elapsed.toFixed(1)}초 걸림 · ${data.engine}`);
      break;
    case "error":
      if (data.job) finish(`오류: ${data.message}`, true);
      else setStatus(`오류: ${data.message}`, null, true);
      break;
  }
};

worker.onerror = (event) => {
  finish(`오류: 음성 엔진을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요. ${event.message ?? ""}`, true);
};

els.speed.addEventListener("input", showSpeed);
els.voice.addEventListener("change", savePrefs);
els.speed.addEventListener("change", savePrefs);
els.engine.addEventListener("change", () => {
  savePrefs();
  worker.postMessage({ type: "load", engine: els.engine.value });
});
els.button.addEventListener("click", generate);
els.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    generate();
  }
});

// Start downloading the model right away so it is ready by the time the text is typed.
worker.postMessage({ type: "load", engine: els.engine.value });

function generate() {
  if (busy) return;
  // English voices can't read Hangul, so drop it instead of producing garbled audio.
  const hadKorean = /\p{Script=Hangul}/u.test(els.text.value);
  const text = els.text.value
    .replace(/\p{Script=Hangul}+/gu, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .split("\n")
    // Tidy punctuation orphaned by the removal: "apples. 사과." -> "apples. ." -> "apples.", "apple (사과), pear" -> "apple, pear"
    .map((line) =>
      line
        .replace(/\s+/g, " ")
        .replace(/([.,!?;:])(\s+[.,!?;:])+/g, "$1")
        .replace(/\s+(?=[.,!?;:])/g, "")
        .replace(/^[\s.,!?;:]+/, "")
        .trim(),
    )
    .filter((line) => /[A-Za-z0-9]/.test(line))
    .join("\n");

  if (!text) {
    setStatus(hadKorean ? "한글은 읽을 수 없어요. 영어 문장을 입력해 주세요." : "영어 문장을 입력해 주세요.", null, true);
    return;
  }

  busy = true;
  els.button.disabled = true;
  setStatus(hadKorean ? "한글은 빼고 영어만 읽을게요…" : "음성 만드는 중…");
  worker.postMessage({ type: "generate", text, voice: els.voice.value, speed: Number(els.speed.value), engine: els.engine.value });
}

function addResult({ job, blob, seconds }) {
  const url = URL.createObjectURL(blob);
  const item = document.createElement("li");

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${VOICE_NAMES[job.voice] ?? job.voice} · ${job.speed.toFixed(2)}× · ${seconds.toFixed(1)}초 · ${Math.ceil(blob.size / 1024)}KB`;

  const text = document.createElement("p");
  text.className = "text";
  text.textContent = job.text;

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = url;

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(job.text);
  link.textContent = `⬇ MP3 다운로드 (${link.download})`;

  item.append(meta, text, audio, link);
  els.results.prepend(item);
  audio.play().catch(() => {});
}

function fileName(text) {
  let name = "";
  for (const word of text.replace(/['’]/g, "").match(/[A-Za-z0-9]+/g) ?? []) {
    const next = name ? `${name}_${word}` : word;
    if (next.length > 50) break;
    name = next;
  }
  return `${name || "speech"}.mp3`;
}

function finish(message, isError = false) {
  busy = false;
  els.button.disabled = false;
  setStatus(message, null, isError);
}

function setStatus(message, percent = null, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
  els.bar.hidden = percent === null;
  if (percent !== null) els.bar.value = percent;
}

function showSpeed() {
  els.speedValue.textContent = `${Number(els.speed.value).toFixed(2)}×`;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ voice: els.voice.value, speed: els.speed.value, engine: els.engine.value }));
  } catch {
    // Storage can be unavailable (private mode); preferences are just not remembered then.
  }
}
