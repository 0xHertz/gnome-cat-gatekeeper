import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GdkPixbuf from "gi://GdkPixbuf";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import {
  PopupSeparatorMenuItem,
  PopupSwitchMenuItem,
  PopupMenuItem,
} from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const SETTINGS_SCHEMA = "org.github.cat-gatekeeper";
const USAGE_STORAGE_KEY = "cat-gatekeeper-usage";
const USAGE_STALE_AFTER_MS = 30 * 60 * 1000;
const USAGE_SAVE_INTERVAL = 5;

let settings = null;
let usageData = {};
let currentSeconds = 0;

let catIsActive = false;

let trackerInterval = 0;
let saveInterval = 0;

let statusIndicator = null;
let indicatorIcon = null;

let catOverlay = null;
let catActor = null;

let extensionRef = null;

let preloadedNeko1 = [];
let preloadedNeko2 = [];

let dismissOverlay = null;

let sourceIds = new Set();

function addTimeout(interval, callback) {
  let id = 0;

  id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
    if (!sourceIds.has(id)) return false;

    try {
      const keep = callback();

      if (!keep) sourceIds.delete(id);

      return keep;
    } catch (e) {
      logError(e);

      sourceIds.delete(id);

      return false;
    }
  });

  sourceIds.add(id);

  return id;
}

function addIdle(callback) {
  let id = 0;

  id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    if (!sourceIds.has(id)) return false;

    sourceIds.delete(id);

    try {
      return callback();
    } catch (e) {
      logError(e);
      return false;
    }
  });

  sourceIds.add(id);

  return id;
}

function removeSource(id) {
  if (!id) return;

  if (!sourceIds.has(id)) return;

  try {
    GLib.source_remove(id);
  } catch (_) {}

  sourceIds.delete(id);
}

function clearSources() {
  for (const id of sourceIds) {
    try {
      GLib.source_remove(id);
    } catch (_) {}
  }

  sourceIds.clear();
}

function actorAlive(actor) {
  if (!actor) return false;

  try {
    return actor.get_stage() !== null;
  } catch (_) {
    return false;
  }
}

function loadFrames(dirName, frames) {
  const dirPath = GLib.build_filenamev([extensionRef.path, "assets", dirName]);

  if (!GLib.file_test(dirPath, GLib.FileTest.IS_DIR)) return;

  const dir = Gio.File.new_for_path(dirPath);

  const iter = dir.enumerate_children(
    "standard::name",
    Gio.FileQueryInfoFlags.NONE,
    null,
  );

  const names = [];

  let info;

  while ((info = iter.next_file(null)) !== null) names.push(info.get_name());

  names.sort();

  for (const name of names) {
    const path = GLib.build_filenamev([dirPath, name]);

    try {
      frames.push(GdkPixbuf.Pixbuf.new_from_file(path));
    } catch (_) {}
  }
}

function playFrameAnimation(frames, monitor) {
  stopFrameAnimation();

  if (frames.length === 0) {
    catActor = new Clutter.Actor({
      width: 1,
      height: 1,
    });

    return;
  }

  const first = frames[0];

  const image = new Clutter.Image();

  image.set_data(
    first.get_pixels(),
    first.get_has_alpha()
      ? Cogl.PixelFormat.RGBA_8888
      : Cogl.PixelFormat.RGB_888,
    first.get_width(),
    first.get_height(),
    first.get_rowstride(),
  );

  catActor = new Clutter.Actor({
    width: monitor.width,
    height: monitor.height,
    content: image,
    content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
  });

  let idx = 1;

  catActor._animId = addTimeout(100, () => {
    if (!catActor) return false;

    if (!actorAlive(catActor)) return false;

    const pix = frames[idx];

    image.set_data(
      pix.get_pixels(),
      pix.get_has_alpha()
        ? Cogl.PixelFormat.RGBA_8888
        : Cogl.PixelFormat.RGB_888,
      pix.get_width(),
      pix.get_height(),
      pix.get_rowstride(),
    );

    idx = (idx + 1) % frames.length;

    return true;
  });
}

function stopFrameAnimation() {
  if (catActor?._animId) {
    removeSource(catActor._animId);
    catActor._animId = 0;
  }

  if (catActor) {
    try {
      catActor.destroy();
    } catch (_) {}
  }

  catActor = null;
}

function getUserDataDir() {
  return GLib.build_filenamev([GLib.get_user_data_dir(), "cat-gatekeeper"]);
}

function persistUsageData() {
  try {
    const dataDir = getUserDataDir();

    const dataFile = GLib.build_filenamev([dataDir, "usage.json"]);

    if (!GLib.file_test(dataDir, GLib.FileTest.EXISTS))
      GLib.mkdir_with_parents(dataDir, 0o755);

    const json = JSON.stringify(usageData);

    GLib.file_set_contents(dataFile, json);
  } catch (e) {
    log(`[Cat Gatekeeper] persist error: ${e}`);
  }
}

function loadUsageData() {
  try {
    const dataFile = GLib.build_filenamev([getUserDataDir(), "usage.json"]);

    if (!GLib.file_test(dataFile, GLib.FileTest.EXISTS)) return;

    const [ok, contents] = GLib.file_get_contents(dataFile);

    if (ok && contents)
      usageData = JSON.parse(new TextDecoder().decode(contents));
  } catch (_) {
    usageData = {};
  }
}

function getStoredSeconds() {
  const stored = usageData[USAGE_STORAGE_KEY];

  const now = Date.now();

  if (!stored || typeof stored !== "object") return 0;

  if (now - (stored.updatedAt || 0) > USAGE_STALE_AFTER_MS) return 0;

  return Math.max(0, parseInt(stored.seconds, 10) || 0);
}

function saveUsageSeconds(seconds) {
  usageData[USAGE_STORAGE_KEY] = {
    seconds: Math.max(0, seconds),
    updatedAt: Date.now(),
  };

  persistUsageData();
}

function startTracking() {
  stopTracking();

  if (!settings.get_boolean("enabled")) return;

  currentSeconds = getStoredSeconds();

  saveInterval = addTimeout(USAGE_SAVE_INTERVAL * 1000, () => {
    saveUsageSeconds(currentSeconds);
    return true;
  });

  trackerInterval = addTimeout(1000, () => {
    if (catIsActive) return true;

    currentSeconds++;

    const limitSec = settings.get_int("usage-limit") * 60;

    if (currentSeconds >= limitSec) {
      saveUsageSeconds(0);

      currentSeconds = 0;

      showCat(settings.get_int("break-time"), () => startTracking());
    }

    return true;
  });

  updateIndicator(true);
}

function stopTracking() {
  removeSource(trackerInterval);
  removeSource(saveInterval);

  trackerInterval = 0;
  saveInterval = 0;

  if (currentSeconds > 0) saveUsageSeconds(currentSeconds);

  updateIndicator(false);
}

function updateIndicator(_tracking) {}

function createIndicator() {
  statusIndicator = new PanelMenu.Button(0.0, "Cat Gatekeeper", false);

  const catIconPath = GLib.build_filenamev([
    extensionRef.path,
    "assets",
    "icon48.png",
  ]);

  const catGicon = Gio.icon_new_for_string(catIconPath);

  indicatorIcon = new St.Icon({
    gicon: catGicon,
    style_class: "system-status-icon",
  });

  statusIndicator.add_child(indicatorIcon);

  const menu = statusIndicator.menu;

  menu.addMenuItem(new PopupSeparatorMenuItem());

  const enabledItem = new PopupSwitchMenuItem(
    "Enabled",
    settings.get_boolean("enabled"),
  );

  enabledItem.connect("toggled", (item) => {
    settings.set_boolean("enabled", item.state);

    item.state ? startTracking() : stopTracking();
  });

  menu.addMenuItem(enabledItem);

  const indicatorItem = new PopupSwitchMenuItem(
    "Show Indicator",
    settings.get_boolean("show-indicator"),
  );

  indicatorItem.connect("toggled", (item) => {
    settings.set_boolean("show-indicator", item.state);

    statusIndicator.visible = item.state;
  });

  menu.addMenuItem(indicatorItem);

  menu.addMenuItem(new PopupSeparatorMenuItem());

  const dismissItem = new PopupMenuItem("Dismiss Break");

  dismissItem.connect("activate", () => {
    if (dismissOverlay) dismissOverlay();
  });

  menu.addMenuItem(dismissItem);

  menu.addMenuItem(new PopupSeparatorMenuItem());

  const prefsItem = new PopupMenuItem("Preferences");

  prefsItem.connect("activate", () => {
    extensionRef.openPreferences();
  });

  menu.addMenuItem(prefsItem);

  Main.panel.addToStatusArea("cat-gatekeeper", statusIndicator);

  statusIndicator.visible = settings.get_boolean("show-indicator");
}

function showCat(breakMinutes, onBreakEnd) {
  if (catIsActive) return;

  catIsActive = true;

  const monitor = Main.layoutManager.primaryMonitor;

  catOverlay = new Clutter.Actor({
    width: monitor.width,
    height: monitor.height,
  });

  playFrameAnimation(preloadedNeko1, monitor);

  if (catActor) catOverlay.add_child(catActor);

  const countdownLabel = new St.Label({
    text: formatTime(breakMinutes * 60),
    style_class: "cat-countdown",
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
  });

  countdownLabel.set_position(Math.floor((monitor.width - 200) / 2), 24);

  countdownLabel.set_size(200, 56);

  catOverlay.add_child(countdownLabel);

  Main.layoutManager.addChrome(catOverlay, {
    affectsInputRegion: true,
  });

  addTimeout(11000, () => {
    if (!catIsActive) return false;

    if (!actorAlive(catOverlay)) return false;

    const oldActor = catActor;

    playFrameAnimation(preloadedNeko2, monitor);

    addIdle(() => {
      if (!actorAlive(catOverlay)) return false;

      if (catActor) catOverlay.add_child(catActor);

      if (oldActor && actorAlive(oldActor)) catOverlay.remove_child(oldActor);

      return false;
    });

    return false;
  });

  let seconds = breakMinutes * 60;

  let countdownCancelled = false;

  let countdownId = 0;

  addIdle(() => {
    countdownId = addTimeout(1000, () => {
      if (countdownCancelled) return false;

      if (!actorAlive(catOverlay)) return false;

      seconds--;

      countdownLabel.set_text(formatTime(seconds));

      if (seconds <= 0) {
        catIsActive = false;

        try {
          Main.layoutManager.removeChrome(catOverlay);
        } catch (_) {}

        try {
          catOverlay.destroy();
        } catch (_) {}

        catOverlay = null;

        stopFrameAnimation();

        onBreakEnd();

        return false;
      }

      return true;
    });

    return false;
  });

  dismissOverlay = () => {
    countdownCancelled = true;

    removeSource(countdownId);

    catIsActive = false;

    if (catOverlay) {
      try {
        Main.layoutManager.removeChrome(catOverlay);
      } catch (_) {}

      try {
        catOverlay.destroy();
      } catch (_) {}
    }

    catOverlay = null;

    stopFrameAnimation();

    saveUsageSeconds(0);

    startTracking();
  };
}

function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60);

  const s = totalSec % 60;

  return `${m}:${String(s).padStart(2, "0")}`;
}

export default class CatGatekeeperExtension extends Extension {
  enable() {
    extensionRef = this;

    settings = this.getSettings(SETTINGS_SCHEMA);

    loadUsageData();

    loadFrames("f_neko1", preloadedNeko1);

    loadFrames("f_neko2", preloadedNeko2);

    log(
      `[Cat Gatekeeper] frames: neko1=${preloadedNeko1.length}, neko2=${preloadedNeko2.length}`,
    );

    createIndicator();

    if (settings.get_boolean("enabled")) startTracking();

    settings.connect("changed::enabled", () => {
      settings.get_boolean("enabled") ? startTracking() : stopTracking();
    });

    settings.connect("changed::usage-limit", () => {
      if (settings.get_boolean("enabled")) startTracking();
    });
  }

  disable() {
    clearSources();

    stopTracking();

    dismissOverlay = null;

    stopFrameAnimation();

    preloadedNeko1 = [];
    preloadedNeko2 = [];

    extensionRef = null;

    if (statusIndicator) {
      try {
        statusIndicator.destroy();
      } catch (_) {}

      statusIndicator = null;
      indicatorIcon = null;
    }

    if (catOverlay) {
      try {
        Main.layoutManager.removeChrome(catOverlay);
      } catch (_) {}

      try {
        catOverlay.destroy();
      } catch (_) {}

      catOverlay = null;
    }
  }
}
