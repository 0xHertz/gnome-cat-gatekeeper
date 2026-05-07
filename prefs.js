import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_SCHEMA = 'org.github.cat-gatekeeper';

export default class CatGatekeeperPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings(SETTINGS_SCHEMA);

    const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'cat-gatekeeper-symbolic' });

    const timingGroup = new Adw.PreferencesGroup();

    const usageLimitRow = new Adw.ActionRow({
      title: 'Usage limit (minutes)',
      subtitle: 'How long before taking a break',
    });
    const usageLimitSpin = new Gtk.SpinButton({
      halign: Gtk.Align.END,
      valign: Gtk.Align.CENTER,
      adjustment: new Gtk.Adjustment({ lower: 1, upper: 480, step_increment: 1 }),
    });
    usageLimitSpin.set_value(settings.get_int('usage-limit'));
    settings.bind('usage-limit', usageLimitSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
    usageLimitRow.add_suffix(usageLimitSpin);
    timingGroup.add(usageLimitRow);

    const breakTimeRow = new Adw.ActionRow({
      title: 'Break time (minutes)',
      subtitle: 'How long the cat break lasts',
    });
    const breakTimeSpin = new Gtk.SpinButton({
      halign: Gtk.Align.END,
      valign: Gtk.Align.CENTER,
      adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1 }),
    });
    breakTimeSpin.set_value(settings.get_int('break-time'));
    settings.bind('break-time', breakTimeSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
    breakTimeRow.add_suffix(breakTimeSpin);
    timingGroup.add(breakTimeRow);
    page.add(timingGroup);

    const behaviorPage = new Adw.PreferencesPage({ title: 'Behavior', icon_name: 'system-run-symbolic' });

    const behaviorGroup = new Adw.PreferencesGroup();

    const enableRow = new Adw.SwitchRow({
      title: 'Enable Extension',
      subtitle: 'Track usage time and show cat break',
    });
    settings.bind('enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(enableRow);

    const indicatorRow = new Adw.SwitchRow({
      title: 'Show Status Indicator',
      subtitle: 'Show icon in the top panel',
    });
    settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(indicatorRow);

    behaviorPage.add(behaviorGroup);

    window.add(page);
    window.add(behaviorPage);
  }
}