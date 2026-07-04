// @ts-check
/**
 * Stem-set intake: whole-window drag-drop plus a file picker.
 *
 * Dropped files become ONE stem set. Roles are auto-detected from filename
 * conventions (_vocals/_drums/_bass/_lead and common synonyms); a small
 * role-assign dialog lets the user confirm/override roles and enter the
 * set's title, source BPM, and source key before anything persists.
 * (.zip stem sets are deliberately not supported yet — needs a vendored
 * unzip, which requires approval per the working agreement.)
 */

import { putTrack } from './store.js';
import { showToast } from '../ui/toasts.js';

const ACCEPT_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'];
const ACCEPT_ATTR = '.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,audio/*';
const MAX_SIZE = 150 * 1024 * 1024;

export const KEY_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Filename-convention role detection (most specific first). */
const ROLE_PATTERNS = /** @type {[import('./store.js').StemRole, RegExp][]} */ ([
  ['vocals', /\b(vocals?|vox|voice|acapella|aca)\b|_vocals?|_vox/i],
  ['drums', /\b(drums?|beat|kick|percs?|percussion)\b|_drums?|_beat/i],
  ['bass', /\b(bass|sub|808)\b|_bass|_sub/i],
  ['lead', /\b(lead|melody|synths?|inst|instrumental|guitar|keys|chords?|music)\b|_lead|_melody|_inst/i],
]);

/** @param {string} name */
function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** @param {File} file */
function isSupported(file) {
  return file.type.startsWith('audio/') || ACCEPT_EXTENSIONS.includes(extension(file.name));
}

/** @param {string} name */
function baseName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** @param {string} name @returns {import('./store.js').StemRole | null} */
export function detectRole(name) {
  const base = baseName(name);
  for (const [role, re] of ROLE_PATTERNS) {
    if (re.test(base)) return role;
  }
  return null;
}

/** Derive a set title: strip role tokens, prefer the files' common prefix. @param {File[]} files */
function titleFor(files) {
  const cleaned = files.map((f) =>
    baseName(f.name)
      .replace(/[_\-. ]*(vocals?|vox|voice|acapella|drums?|beat|kick|percs?|percussion|bass|sub|808|lead|melody|synths?|inst|instrumental|guitar|keys|chords?|music|stem)s?[_\-. ]*/gi, ' ')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  const candidates = cleaned.filter(Boolean);
  if (candidates.length === 0) return baseName(files[0].name).replace(/[_]+/g, ' ').trim();
  // Common prefix across all names, else the first cleaned name.
  let prefix = candidates[0];
  for (const c of candidates.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < c.length && prefix[i].toLowerCase() === c[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s\-_]+$/, '').trim();
  return prefix.length >= 3 ? prefix : candidates[0];
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
 *   onTrackAdded: (record: import('./store.js').TrackRecord) => void,
 *   analyze?: (file: File) => Promise<{ bpm?: number, key?: string }>,
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
  overlay.innerHTML = '<div class="drop-overlay__box">Drop stems to build a set</div>';
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

  /** @param {File[]} candidates */
  async function processFiles(candidates) {
    if (candidates.some((f) => extension(f.name) === 'zip')) {
      showToast('.zip stem sets aren’t supported yet — drop the audio files directly.', {
        type: 'error',
      });
    }
    const files = candidates.filter((f) => {
      if (!isSupported(f)) {
        if (extension(f.name) !== 'zip') {
          showToast(`“${f.name}” isn't a supported audio format (MP3, WAV, OGG, M4A).`, {
            type: 'error',
          });
        }
        return false;
      }
      if (f.size > MAX_SIZE) {
        showToast(`“${f.name}” is too large (max 150 MB).`, { type: 'error' });
        return false;
      }
      return true;
    });
    if (files.length === 0) return;
    if (files.length > 4) {
      showToast('A stem set is at most 4 files (vocals, drums, bass, lead) — using the first 4.', {
        type: 'error',
        duration: 6000,
      });
      files.length = 4;
    }

    // Optional auto-detect (Phase 6 hook) pre-fills bpm/key from the first file.
    /** @type {{ bpm?: number, key?: string }} */
    let detected = {};
    if (opts.analyze) {
      try {
        detected = await opts.analyze(files[0]);
      } catch {
        // detection is best-effort
      }
    }

    const plan = await openAssignDialog(files, detected);
    if (!plan) return; // user cancelled

    try {
      showToast(`Adding “${plan.title}”…`, { duration: 2500 });
      const ctx = await opts.getAudioContext();

      /** @type {import('./store.js').TrackRecord['stems']} */
      const stems = {};
      for (const { file, role } of plan.assignments) {
        if (!role) continue;
        // Decode to validate (the buffer detaches, so decode a copy; keep the Blob).
        const bytes = await file.arrayBuffer();
        await ctx.decodeAudioData(bytes.slice(0));
        stems[role] = { blob: file };
      }
      if (Object.keys(stems).length === 0) {
        showToast('Every file was set to “skip” — nothing was added.', { type: 'error' });
        return;
      }

      /** @type {import('./store.js').TrackRecord} */
      const record = {
        id: crypto.randomUUID(),
        title: plan.title,
        artist: 'Your library',
        sourceBpm: plan.sourceBpm,
        sourceKey: plan.sourceKey,
        bars: plan.bars,
        stems,
        color: '',
        demo: false,
        addedAt: Date.now(),
      };
      record.color = colorFor(record.id);
      await putTrack(record);
      opts.onTrackAdded(record);
      const roleList = Object.keys(stems).join(', ');
      showToast(`“${plan.title}” added (${roleList}).`, { type: 'success' });
    } catch (err) {
      console.error('intake failed', err);
      const msg =
        err instanceof Error && err.message.includes('Storage is full')
          ? err.message
          : 'A stem couldn’t be read — the file may be corrupted or DRM-protected.';
      showToast(msg, { type: 'error', duration: 6000 });
    }
  }

  return {
    openPicker() {
      input.click();
    },
  };
}

/**
 * Role-assign dialog: per-file role dropdowns plus title/bpm/key/bars fields.
 * Resolves null on cancel.
 * @param {File[]} files
 * @param {{ bpm?: number, key?: string }} detected
 * @returns {Promise<{
 *   title: string, sourceBpm: number, sourceKey: string, bars: number,
 *   assignments: { file: File, role: import('./store.js').StemRole | null }[],
 * } | null>}
 */
function openAssignDialog(files, detected) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'help-overlay';

    const dialog = document.createElement('form');
    dialog.className = 'help-dialog panel assign-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Assign stem roles');

    const detectedKey = detected.key ?? 'C major';
    const [detRoot, detMode] = detectedKey.split(' ');

    dialog.innerHTML = `
      <h2 class="help-dialog__title">Build a stem set</h2>
      <p class="help-dialog__intro">Pick which instrument each file plays. Files whose names
      mention a role are pre-assigned — double-check them.</p>
      <div class="assign-dialog__files"></div>
      <div class="assign-dialog__meta">
        <label class="assign-field assign-field--wide">
          <span>Title</span>
          <input name="title" type="text" required maxlength="60" />
        </label>
        <label class="assign-field">
          <span>Source BPM</span>
          <input name="bpm" type="number" min="40" max="220" step="0.1" required />
        </label>
        <label class="assign-field">
          <span>Key</span>
          <span class="assign-field__pair">
            <select name="root">${KEY_ROOTS.map((r) => `<option${r === detRoot ? ' selected' : ''}>${r}</option>`).join('')}</select>
            <select name="mode">
              <option${detMode !== 'minor' ? ' selected' : ''}>major</option>
              <option${detMode === 'minor' ? ' selected' : ''}>minor</option>
            </select>
          </span>
        </label>
        <label class="assign-field">
          <span>Loop bars</span>
          <select name="bars">
            ${[4, 8, 16, 32].map((b) => `<option${b === 16 ? ' selected' : ''}>${b}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="help-dialog__actions">
        <button type="button" class="help-dialog__danger" data-cancel>Cancel</button>
        <button type="submit" class="help-dialog__close">Add to library</button>
      </div>
    `;

    const list = /** @type {HTMLElement} */ (dialog.querySelector('.assign-dialog__files'));
    const usedRoles = new Set();
    files.forEach((file, i) => {
      let auto = detectRole(file.name);
      if (auto && usedRoles.has(auto)) auto = null;
      if (auto) usedRoles.add(auto);
      const row = document.createElement('label');
      row.className = 'assign-file';
      row.innerHTML = `
        <span class="assign-file__name" title="${file.name}">${file.name}</span>
        <select data-file="${i}">
          ${['vocals', 'drums', 'bass', 'lead']
            .map((r) => `<option value="${r}"${r === auto ? ' selected' : ''}>${r}</option>`)
            .join('')}
          <option value=""${auto ? '' : ' selected'}>skip</option>
        </select>`;
      list.append(row);
    });
    // Single unmatched file defaults to lead (a whole track is a "lead" stem).
    if (files.length === 1 && !detectRole(files[0].name)) {
      /** @type {HTMLSelectElement} */ (list.querySelector('select')).value = 'lead';
    }

    const titleInput = /** @type {HTMLInputElement} */ (dialog.querySelector('[name=title]'));
    titleInput.value = titleFor(files);
    /** @type {HTMLInputElement} */ (dialog.querySelector('[name=bpm]')).value = String(
      detected.bpm ?? 120
    );

    const close = (/** @type {any} */ result) => {
      overlay.remove();
      resolve(result);
    };

    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(dialog);
      /** @type {{ file: File, role: import('./store.js').StemRole | null }[]} */
      const assignments = files.map((file, i) => {
        const sel = /** @type {HTMLSelectElement} */ (dialog.querySelector(`select[data-file="${i}"]`));
        return { file, role: /** @type {any} */ (sel.value || null) };
      });
      // Duplicate roles: last one wins, earlier duplicates are skipped.
      const seen = new Set();
      for (let i = assignments.length - 1; i >= 0; i--) {
        const a = assignments[i];
        if (!a.role) continue;
        if (seen.has(a.role)) a.role = null;
        else seen.add(a.role);
      }
      close({
        title: String(data.get('title') || 'Untitled set').trim(),
        sourceBpm: Math.min(220, Math.max(40, Number(data.get('bpm')) || 120)),
        sourceKey: `${data.get('root')} ${data.get('mode')}`,
        bars: Number(data.get('bars')) || 16,
        assignments,
      });
    });
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null);
    });

    overlay.append(dialog);
    document.body.append(overlay);
    titleInput.focus();
  });
}
