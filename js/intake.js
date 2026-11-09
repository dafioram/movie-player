// Getting files in: file picker, folder picker, drag and drop, "Open with" from the OS, and zips.
// Everything is turned into "items": {name, path, size, lastModified, kind, getBlob(), problem}.
// File System Access handles are kept so the last movie can be reopened later.

import { classify, extension } from './names.js';
import { openZip, ZipError } from './zip.js';

const MAX_FILES = 3000;
const MAX_DEPTH = 4;

export const canUseHandles = typeof window !== 'undefined' && 'showOpenFilePicker' in window;

function fileItem(file, path, handle, source = 'file') {
  return {
    name: file.name,
    path: path || file.name,
    size: file.size,
    lastModified: file.lastModified,
    kind: classify(file.name),
    source,
    handle,
    getBlob: async () => file,
    problem: null,
  };
}

async function zipItems(file, zipPath, notes) {
  let entries;
  try {
    entries = await openZip(file);
  } catch (e) {
    notes.push({ name: file.name, reason: e instanceof ZipError ? e.message : 'Could not read this zip: ' + e.message, blocking: true });
    return [];
  }
  const items = [];
  for (const entry of entries) {
    const kind = classify(entry.name);
    const item = {
      name: entry.name,
      path: zipPath + '/' + entry.path,
      size: entry.size,
      lastModified: file.lastModified,
      kind,
      source: 'zip',
      zipName: file.name,
      zipEntry: entry,
      handle: null,
      getBlob: () => entry.blob(),
      problem: null,
    };
    if (entry.encrypted) item.problem = 'encrypted inside the zip';
    else if ((kind === 'video' || kind === 'audio') && !entry.stored) {
      item.problem = kind === 'video'
        ? "This zip compresses the video, so it can't be played directly. Re-create the zip with no compression (store only)."
        : 'compressed inside the zip (only uncompressed audio can be played from a zip)';
    } else if (!entry.usable()) item.problem = `uses ${entry.methodName} compression, which is not supported`;
    items.push(item);
  }
  return items;
}

async function expandFile(file, path, handle, out, notes, source) {
  const kind = classify(file.name);
  if (kind === 'zip') {
    const z = await zipItems(file, path, notes);
    out.zips.push({ name: file.name, entries: z.length, problems: z.filter((i) => i.problem).length });
    out.items.push(...z);
  } else if (kind === 'archive') {
    notes.push({ name: file.name, reason: `${extension(file.name).toUpperCase()} archives are not supported. Use a zip with no compression instead.`, blocking: true });
  } else {
    out.items.push(fileItem(file, path, handle, source));
  }
}

async function walkDirectory(dir, prefix, out, notes, depth) {
  for await (const entry of dir.values()) {
    if (out.items.length >= MAX_FILES) return;
    const path = prefix + '/' + entry.name;
    if (entry.kind === 'file') {
      const kind = classify(entry.name);
      if (kind === 'other') { out.items.push({ name: entry.name, path, kind, size: 0, getBlob: null, problem: null }); continue; }
      const file = await entry.getFile();
      await expandFile(file, path, entry, out, notes, 'folder');
    } else if (entry.kind === 'directory' && depth < MAX_DEPTH && !entry.name.startsWith('.')) {
      await walkDirectory(entry, path, out, notes, depth + 1);
    }
  }
}

/**
 * Expands a list of FileSystemHandles (files and folders) and/or plain Files into items.
 * Returns {items, notes, roots, zips}; roots are the handles to remember for reopening.
 */
export async function expand(sources) {
  const out = { items: [], zips: [], roots: [] };
  const notes = [];
  for (const src of sources) {
    if (!src) continue;
    if (typeof FileSystemHandle !== 'undefined' && src instanceof FileSystemHandle) {
      out.roots.push(src);
      if (src.kind === 'directory') await walkDirectory(src, src.name, out, notes, 1);
      else await expandFile(await src.getFile(), src.name, src, out, notes, 'file');
    } else if (src instanceof File) {
      await expandFile(src, src.webkitRelativePath || src.name, null, out, notes, 'file');
    }
  }
  return { ...out, notes };
}

export async function pickFiles() {
  if (canUseHandles) {
    try {
      return await window.showOpenFilePicker({ multiple: true, id: 'movies' });
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }
  return pickWithInput(false);
}

export async function pickFolder() {
  if ('showDirectoryPicker' in window) {
    try {
      return [await window.showDirectoryPicker({ id: 'movies', mode: 'read' })];
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }
  return pickWithInput(true);
}

function pickWithInput(folder) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => resolve([...input.files]));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Must be called synchronously inside the drop event. */
export function dropSources(dataTransfer) {
  const promises = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue;
    if (item.getAsFileSystemHandle) {
      const file = item.getAsFile();
      promises.push(item.getAsFileSystemHandle().then((h) => h || file).catch(() => file));
    } else {
      promises.push(Promise.resolve(item.getAsFile()));
    }
  }
  return Promise.all(promises);
}

/** Requests read access to remembered handles (needs a user gesture). Returns false if refused. */
export async function requestAccess(handles) {
  for (const h of handles) {
    if (!h.queryPermission) continue;
    let state = await h.queryPermission({ mode: 'read' });
    if (state !== 'granted') state = await h.requestPermission({ mode: 'read' });
    if (state !== 'granted') return false;
  }
  return true;
}

export async function hasAccess(handles) {
  for (const h of handles) {
    if (!h.queryPermission) return false;
    if ((await h.queryPermission({ mode: 'read' })) !== 'granted') return false;
  }
  return true;
}

/** Picks the companions for a chosen video: all of them if it's the only video, else name matches. */
export function companionsFor(video, items) {
  const videos = items.filter((i) => i.kind === 'video' && !i.problem);
  const base = video.name.replace(/\.[^.]+$/, '').toLowerCase();
  const others = videos.filter((v) => v !== video).map((v) => v.name.replace(/\.[^.]+$/, '').toLowerCase());
  return items.filter((i) => {
    if (i === video || i.kind === 'video' || i.kind === 'zip' || i.kind === 'archive') return false;
    if (i.kind === 'other') return false;
    if (videos.length <= 1) return true;
    const n = i.name.toLowerCase();
    if (n.startsWith(base)) return true;
    // belongs to no other video either: keep it (e.g. fonts in a Fonts folder)
    return !others.some((o) => n.startsWith(o)) && (i.kind === 'font' || i.path.toLowerCase().includes(base));
  });
}
