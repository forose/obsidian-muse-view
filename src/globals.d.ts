// Ambient declarations for globals used by the recovered MuseView source
// that are not covered by the standard DOM/ES libs in tsconfig.json.

interface Window {
  // Obsidian exposes moment on the window object at runtime.
  moment?: any;
}
