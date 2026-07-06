// @ts-check
/**
 * Optional BPM + key auto-detect for intake. Decoding happens here (Web Audio
 * can't run in a worker portably); the number crunching runs off the main
 * thread in analyzeWorker.js so intake stays responsive. Best-effort: returns
 * whatever it could detect within the timeout, and the user can override.
 */

const TIMEOUT_MS = 12000;
const MAX_SECONDS = 45; // analyzing the first ~45s is plenty for loops

/** @type {Worker | null} */
let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./analyzeWorker.js', import.meta.url), { type: 'module' });
  }
  return worker;
}

/**
 * @param {File} file
 * @returns {Promise<{ bpm?: number, key?: string }>}
 */
export async function analyzeFile(file) {
  const bytes = await file.arrayBuffer();
  // A throwaway OfflineAudioContext decodes without needing a user gesture.
  const OAC = window.OfflineAudioContext || /** @type {any} */ (window).webkitOfflineAudioContext;
  const decoder = new OAC(1, 1, 44100);
  const buffer = await decoder.decodeAudioData(bytes);

  // Mono downmix, truncated — transferred to the worker (zero-copy).
  const frames = Math.min(buffer.length, Math.floor(MAX_SECONDS * buffer.sampleRate));
  const mono = new Float32Array(frames);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }

  return new Promise((resolve) => {
    const w = getWorker();
    const timer = setTimeout(() => {
      w.removeEventListener('message', onMessage);
      resolve({});
    }, TIMEOUT_MS);
    /** @param {MessageEvent} e */
    const onMessage = (e) => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      resolve(e.data ?? {});
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
  });
}
