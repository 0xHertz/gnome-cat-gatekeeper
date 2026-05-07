import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";

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
let extensionRef = null;

let usageData = {};
let currentSeconds = 0;

let catIsActive = false;

let trackerInterval = 0;
let saveInterval = 0;

let animationTimer = 0;
let countdownTimer = 0;
let switchTimer = 0;

let statusIndicator = null;
let indicatorIcon = null;

let catOverlay = null;
let catActor = null;

let currentFrames = [];
let currentFrameIndex = 0;

let preloadedNeko1 = [];
let preloadedNeko2 = [];

let dismissOverlay = null;

function removeTimer(id) {
  if (!id) return 0;

  try {
    GLib.source_remove(id);
  } catch (_) {}

  return 0;
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
    frames.push(GLib.build_filenamev([dirPath, name]));
  }
}

function setFrame(path) {
  if (!catActor) return;

  const file = Gio.File.new_for_path(path);

  const uri = file.get_uri();

  catActor.set_style(`
    background-image: url("${uri}");
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
  `);
}

function startAnimation() {
  stopAnimation();

  animationTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    if (!catActor) return false;

    if (!currentFrames.length) return true;

    setFrame(currentFrames[currentFrameIndex]);

    currentFrameIndex = (currentFrameIndex + 1) % currentFrames.length;

    return true;
  });
}

function stopAnimation() {
  animationTimer = removeTimer(animationTimer);
}

function cleanupOverlay() {
  stopAnimation();

  countdownTimer = removeTimer(countdownTimer);

  switchTimer = removeTimer(switchTimer);

  dismissOverlay = null;

  if (catOverlay) {
    try {
      Main.layoutManager.removeChrome(catOverlay);
    } catch (_) {}

    try {
      catOverlay.destroy();
    } catch (_) {}
  }

  catOverlay = null;
  catActor = null;

  currentFrames = [];
  currentFrameIndex = 0;

  catIsActive = false;
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

    GLib.file_set_contents(dataFile, JSON.stringify(usageData));
  } catch (e) {
    log(`[Cat Gatekeeper] persist error: ${e}`);
  }
}

function loadUsageData() {
  try {
    const dataFile = GLib.build_filenamev([getUserDataDir(), "usage.json"]);

    if (!GLib.file_test(dataFile, GLib.FileTest.EXISTS)) return;

    const [ok, contents] = GLib.file_get_contents(dataFile);

    if (ok && contents) {
      usageData = JSON.parse(new TextDecoder().decode(contents));
    }
  } catch (_) {
    usageData = {};
  }
}

function getStoredSeconds() {
  const stored = usageData[USAGE_STORAGE_KEY];

  const now = Date.now();

  if (!stored || typeof stored !== "object") return 0;

  if (now - (stored.updatedAt || 0) > USAGE_STALE_AFTER_MS) {
    return 0;
  }

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

  saveInterval = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    USAGE_SAVE_INTERVAL * 1000,
    () => {
      saveUsageSeconds(currentSeconds);
      return true;
    },
  );

  trackerInterval = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
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
  trackerInterval = removeTimer(trackerInterval);

  saveInterval = removeTimer(saveInterval);

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

  catOverlay = new St.Widget({
    x: monitor.x,
    y: monitor.y,
    width: monitor.width,
    height: monitor.height,
    reactive: true,
    can_focus: true,
  });

  catActor = new St.Widget({
    x: 0,
    y: 0,
    width: monitor.width,
    height: monitor.height,
  });

  catOverlay.add_child(catActor);

  const countdownLabel = new St.Label({
    text: formatTime(breakMinutes * 60),
    style_class: "cat-countdown",
  });

  countdownLabel.set_position(Math.floor((monitor.width - 200) / 2), 24);

  catOverlay.add_child(countdownLabel);

  Main.layoutManager.addChrome(catOverlay, {
    affectsInputRegion: true,
  });

  currentFrames = preloadedNeko1;
  currentFrameIndex = 0;

  setFrame(currentFrames[0]);

  startAnimation();

  switchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 11000, () => {
    if (!catActor) return false;

    currentFrames = preloadedNeko2;
    currentFrameIndex = 0;

    return false;
  });

  let seconds = breakMinutes * 60;

  countdownTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    if (!catOverlay) return false;

    seconds--;

    countdownLabel.set_text(formatTime(seconds));

    if (seconds <= 0) {
      cleanupOverlay();

      onBreakEnd();

      return false;
    }

    return true;
  });

  dismissOverlay = () => {
    cleanupOverlay();

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
      `[Cat Gatekeeper] frames loaded: neko1=${preloadedNeko1.length}, neko2=${preloadedNeko2.length}`,
    );

    createIndicator();

    if (settings.get_boolean("enabled")) {
      startTracking();
    }

    settings.connect("changed::enabled", () => {
      settings.get_boolean("enabled") ? startTracking() : stopTracking();
    });

    settings.connect("changed::usage-limit", () => {
      if (settings.get_boolean("enabled")) {
        startTracking();
      }
    });
  }

  disable() {
    stopTracking();

    cleanupOverlay();

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
  }
}
