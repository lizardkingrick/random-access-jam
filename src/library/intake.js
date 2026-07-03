// @ts-check
/**
 * Track intake: whole-window drag-drop plus a file picker. Files are
 * validated, decoded (to verify + measure), persisted to IndexedDB, and
 * reported back so the library/wheel can refresh.
 */

import { putTrack } from './store.js';
import { showToast } from '../ui/toasts.js';

const ACCEPT_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'];
const ACCEPT_ATTR = '.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,audio/*';
const MAX_SIZE = 150 * 1024 * 1024;

/** @param {string} name */
function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** @param {File} file */
function isSupported(file) {
  return file.type.startsWith('audio/') || ACCEPT_EXTENSIONS.includes(extension(file.name));
}

/** Derive a display title from a filename. @param {string} name */
function titleFrom(name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

/** Stable pseudo-random hue per id, so wheel chips vary. @param {string} id */
export function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 85%, 62%)`;
}

/**
 * @param {{
 *   getAudioContext: () => Promise<AudioContext>,
 *   onTrackAdded: (record: import('./store.js').TrackRecord, buffer: AudioBuffer) => void,
 * }} opts
 */
export function initIntake(opts) {
  // Hidden file input for the "+ Add tracks" button.
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = ACCEPT_ATTR;
  input.hidden = true;
  document.body.append(input);
  input.addEventListener('change', () => {
    if (input.files?.length) processFiles([...input.files]);
    input.value = '';
  });

  // Whole-window drop target with a glowing overlay.
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = '<div class="drop-overlay__box">Drop audio files to add them</div>';
  document.body.append(overlay);

  let dragDepth = 0;
  /** @param {DragEvent} e */
  const hasFiles = (e) => Boolean(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.add('is-visible');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.remove('is-visible');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('is-visible');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) processFiles(files);
  });

  /** @param {File[]} files */
  async function processFiles(files) {
    const total = files.length;
    let added = 0;
    for (let i = 0; i < total; i++) {
      const file = files[i];
      const label = total > 1 ? ` (${i + 1}/${total})` : '';
      if (!isSupported(file)) {
        showToast(`“${file.name}” isn't a supported audio format (MP3, WAV, OGG, M4A).`, {
          type: 'error',
        });
        continue;
      }
      if (file.size > MAX_SIZE) {
        showToast(`“${file.name}” is too large (max 150 MB).`, { type: 'error' });
        continue;
      }
      try {
        showToast(`Adding “${titleFrom(file.name)}”${label}…`, { duration: 2000 });
        const ctx = await opts.getAudioContext();
        const bytes = await file.arrayBuffer();
        // decodeAudioData detaches the buffer — decode a copy, keep the Blob.
        const buffer = await ctx.decodeAudioData(bytes.slice(0));

        /** @type {import('./store.js').TrackRecord} */
        const record = {
          id: crypto.randomUUID(),
          title: titleFrom(file.name),
          artist: 'Your library',
          type: file.type || `audio/${extension(file.name)}`,
          size: file.size,
          duration: buffer.duration,
          color: '',
          demo: false,
          loop: false,
          addedAt: Date.now(),
          blob: file,
        };
        record.color = colorFor(record.id);
        await putTrack(record);
        added++;
        opts.onTrackAdded(record, buffer);
      } catch (err) {
        console.error('intake failed', file.name, err);
        const msg =
          err instanceof Error && err.message.includes('Storage is full')
            ? err.message
            : `Couldn't read “${file.name}” — the file may be corrupted or DRM-protected.`;
        showToast(msg, { type: 'error', duration: 6000 });
      }
    }
    if (total > 1) {
      showToast(`Added ${added} of ${total} tracks to the library.`, {
        type: added ? 'success' : 'error',
      });
    } else if (added === 1) {
      showToast('Track added — it lives on the wheel now.', { type: 'success' });
    }
  }

  return {
    openPicker() {
      input.click();
    },
  };
}
