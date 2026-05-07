import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GdkPixbuf from "gi://GdkPixbuf";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import {
  PopupMenu,
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
let trackerInterval = null;
let saveInterval = null;
let animationSwitchId = null; // 【修复】追踪切换动画的延时任务
let countdownId = null; // 【修复】追踪倒计时任务
let statusIndicator = null;
let indicatorIcon = null;
let catOverlay = null;
let catActor = null;
let extensionRef = null;
let preloadedNeko1 = [];
let preloadedNeko2 = [];

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
    } catch (e) {
      /* skip */
    }
  }
}

function playFrameAnimation(frames, monitor) {
  stopFrameAnimation();
  if (frames.length === 0) {
    catActor = new Clutter.Actor({ width: 1, height: 1 });
    return;
  }
  const first = frames[0];
  const hasAlpha = first.get_has_alpha();
  const image = new Clutter.Image();
  image.set_data(
    first.get_pixels(),
    hasAlpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
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
  const tId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    // 【修复】增加更严格的存活检查
    if (!catActor || catActor._animId !== tId || !catIsActive) {
      return GLib.SOURCE_REMOVE;
    }
    const pix = frames[idx];
    image.set_data(
      pix.get_pixels(),
      hasAlpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
      pix.get_width(),
      pix.get_height(),
      pix.get_rowstride(),
    );
    idx = (idx + 1) % frames.length;
    return GLib.SOURCE_CONTINUE;
  });

  catActor._animId = tId;
}

function stopFrameAnimation() {
  if (catActor && catActor._animId) {
    GLib.source_remove(catActor._animId);
    catActor._animId = 0;
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
    if (ok && contents) {
      usageData = JSON.parse(new TextDecoder().decode(contents));
    }
  } catch (e) {
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

  saveInterval = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    USAGE_SAVE_INTERVAL * 1000,
    () => {
      saveUsageSeconds(currentSeconds);
      return GLib.SOURCE_CONTINUE;
    },
  );

  trackerInterval = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    if (catIsActive) return GLib.SOURCE_CONTINUE;

    currentSeconds++;
    const limitSec = settings.get_int("usage-limit") * 60;

    if (currentSeconds >= limitSec) {
      saveUsageSeconds(0);
      currentSeconds = 0;
      showCat(settings.get_int("break-time"), () => startTracking());
    }
    return GLib.SOURCE_CONTINUE;
  });
}

function stopTracking() {
  if (trackerInterval) {
    GLib.source_remove(trackerInterval);
    trackerInterval = null;
  }
  if (saveInterval) {
    GLib.source_remove(saveInterval);
    saveInterval = null;
  }
  if (currentSeconds > 0) saveUsageSeconds(currentSeconds);
}

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
    if (catOverlay && catOverlay.dismiss) catOverlay.dismiss();
  });
  menu.addMenuItem(dismissItem);

  menu.addMenuItem(new PopupSeparatorMenuItem());

  const prefsItem = new PopupMenuItem("Preferences");
  prefsItem.connect("activate", () => extensionRef.openPreferences());
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
  catOverlay.add_child(catActor);

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

  // 【修复】记录此定时器 ID，并在清理时移除
  animationSwitchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 11000, () => {
    animationSwitchId = null;
    if (!catIsActive || !catOverlay) return GLib.SOURCE_REMOVE;

    const oldActor = catActor;
    playFrameAnimation(preloadedNeko2, monitor);

    // 使用 idle_add 时也要小心环境
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (!catOverlay || !catIsActive) return GLib.SOURCE_REMOVE;
      catOverlay.add_child(catActor);
      if (oldActor) catOverlay.remove_child(oldActor);
      return GLib.SOURCE_REMOVE;
    });
    return GLib.SOURCE_REMOVE;
  });

  let seconds = breakMinutes * 60;

  // 【修复】明确记录 countdownId
  countdownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    if (!catIsActive) {
      countdownId = null;
      return GLib.SOURCE_REMOVE;
    }

    seconds--;
    countdownLabel.set_text(formatTime(seconds));

    if (seconds <= 0) {
      countdownId = null;
      if (catOverlay && catOverlay.dismiss) catOverlay.dismiss();
      onBreakEnd();
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  });

  catOverlay.dismiss = () => {
    // 【修复】集中清理所有与此 Break 相关的定时器
    if (countdownId) {
      GLib.source_remove(countdownId);
      countdownId = null;
    }
    if (animationSwitchId) {
      GLib.source_remove(animationSwitchId);
      animationSwitchId = null;
    }

    catIsActive = false;
    if (catOverlay) {
      Main.layoutManager.removeChrome(catOverlay);
      catOverlay = null;
    }
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

    createIndicator();

    if (settings.get_boolean("enabled")) startTracking();

    // 记录信号连接 ID 也是个好习惯，但 Extension 类会自动处理 settings 的信号
    this._settingsChangedId = settings.connect("changed::enabled", () => {
      settings.get_boolean("enabled") ? startTracking() : stopTracking();
    });
    this._limitChangedId = settings.connect("changed::usage-limit", () => {
      if (settings.get_boolean("enabled")) startTracking();
    });
  }

  disable() {
    // 【修复】按顺序强制清理所有资源
    stopTracking();

    // 如果猫还在屏幕上，强制调用其内部清理逻辑
    if (catOverlay && catOverlay.dismiss) {
      catOverlay.dismiss();
    } else {
      // 保险起见，即使没有 overlay 也要清空这些 ID
      if (countdownId) GLib.source_remove(countdownId);
      if (animationSwitchId) GLib.source_remove(animationSwitchId);
    }

    stopFrameAnimation();

    if (statusIndicator) {
      statusIndicator.destroy();
      statusIndicator = null;
      indicatorIcon = null;
    }

    preloadedNeko1 = [];
    preloadedNeko2 = [];
    settings = null;
    extensionRef = null;
    countdownId = null;
    animationSwitchId = null;
  }
}
