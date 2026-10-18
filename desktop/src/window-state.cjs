'use strict';
/**
 * Window size / position / maximized memory.
 *
 * Stored as plain JSON under `app.getPath('userData')`. Reads are defensive: a
 * hand-edited or half-written file must never stop the window from opening, so
 * every value is range-checked and the restored bounds are dropped unless some
 * display still covers them (monitors get unplugged).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BOUNDS = Object.freeze({ width: 1280, height: 860 });
const MINIMUM = Object.freeze({ width: 940, height: 600 });
const OFFSCREEN_TOLERANCE = 24;

function positiveInt(value, fallback, max = 16384) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function finiteInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

class WindowStateStore {
  /**
   * @param {string} userDataDir app.getPath('userData')
   * @param {{width:number,height:number,minWidth:number,minHeight:number}} defaults
   */
  constructor(userDataDir, { width, height, minWidth, minHeight }) {
    this.file = path.join(userDataDir, 'window-state.json');
    this.defaults = { width, height };
    this.minimum = { width: minWidth, height: minHeight };
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      const bounds = {
        width: positiveInt(raw.width, 0, 16384),
        height: positiveInt(raw.height, 0, 16384),
      };
      // A coordinate must stay absent rather than be stored as null: `x: null`
      // reaches BrowserWindow as 0 and silently pins the window to a corner.
      const x = finiteInt(raw.x);
      const y = finiteInt(raw.y);
      if (x !== null) bounds.x = x;
      if (y !== null) bounds.y = y;
      if (bounds.width < this.minimum.width || bounds.height < this.minimum.height) return null;
      return {
        bounds,
        maximized: raw.maximized === true,
        fullscreen: raw.fullscreen === true,
      };
    } catch {
      return null;
    }
  }

  /** @returns {{width:number,height:number,x?:number,y?:number}} a bounds object safe to hand to BrowserWindow */
  resolveBounds() {
    const saved = this.read();
    if (!saved) return { ...this.defaults };
    if (!this.isVisibleOnSomeDisplay(saved.bounds)) return { ...this.defaults };
    return { ...saved.bounds };
  }

  isMaximized() {
    const saved = this.read();
    return Boolean(saved && saved.maximized);
  }

  isVisibleOnSomeDisplay(bounds) {
    // `screen` is only usable after app is ready, so it is required lazily here.
    const { screen } = require('electron');
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    // No saved coordinate at all: the OS picks a spot, which is always visible.
    if (bounds.x === undefined || bounds.y === undefined) return true;
    return workAreas.some((area) => {
      const overlapsHorizontally =
        bounds.x + OFFSCREEN_TOLERANCE > area.x &&
        bounds.x + bounds.width - OFFSCREEN_TOLERANCE < area.x + area.width;
      const overlapsVertically =
        bounds.y + OFFSCREEN_TOLERANCE > area.y &&
        bounds.y + bounds.height - OFFSCREEN_TOLERANCE < area.y + area.height;
      return overlapsHorizontally && overlapsVertically;
    });
  }

  write({ bounds, maximized, fullscreen }) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const x = finiteInt(bounds.x);
      const y = finiteInt(bounds.y);
      const payload = {
        width: positiveInt(bounds.width, this.defaults.width),
        height: positiveInt(bounds.height, this.defaults.height),
        ...(x !== null ? { x } : {}),
        ...(y !== null ? { y } : {}),
        maximized: Boolean(maximized),
        fullscreen: Boolean(fullscreen),
        updatedAt: new Date().toISOString(),
      };
      // Write-then-rename so a crash mid-write cannot leave truncated JSON.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { DEFAULT_BOUNDS, MINIMUM, WindowStateStore };
