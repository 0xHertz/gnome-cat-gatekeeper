# Cat Gatekeeper for GNOME Shell

A GNOME Shell extension that shows a cat break screen after you spend too long on selected applications and websites.

## Features

- Track time spent on applications and websites
- Show cat break screen when usage limit is reached
- Configurable usage limit and break time
- System tray indicator
- Preferences UI for configuration

## Installation

### From Source

1. Clone or download this extension
2. Compile the GSettings schema:
   ```bash
   glib-compile-schemas schemas/
   ```
3. Copy the extension to your local extensions directory:
   ```bash
   cp -r cat-gatekeeper@cat-gatekeeper.github.com ~/.local/share/gnome-shell/extensions/
   ```
4. Restart GNOME Shell (press Alt+F2, type `r`, press Enter)
5. Enable the extension:
   - Via GNOME Extensions app
   - Or via command line:
     ```bash
     gnome-extensions enable cat-gatekeeper@cat-gatekeeper.github.com
     ```

### From releases

Download the latest release from the releases page and extract to your extensions directory.

## Configuration

### Usage Limit

Set the time in minutes before the cat break screen appears (1-480 minutes).

### Break Time

Set the duration of the cat break screen in minutes (1-60 minutes).

### Tracked Applications

Add applications to track. The extension tracks the focused application by name.
For web tracking, you may need additional setup depending on your browser.

## Development

### File Structure

```
cat-gatekeeper/
├── metadata.json          # Extension metadata
├── extension.js           # Main extension code
├── prefs.js               # Preferences UI
├── schemas/               # GSettings schema
│   └── org.github.cat-gatekeeper.gschema.xml
├── locale/                # Internationalization
│   ├── en/LC_MESSAGES/
│   └── ja/LC_MESSAGES/
└── assets/                # Icons and media
```

### Debugging

Use GNOME's Looking Glass to debug:
1. Press Alt+F2
2. Type `lg` and press Enter
3. Find "Cat Gatekeeper" in the inspector

View logs:
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Original Browser Extension

This is a GNOME Shell port of the [Cat Gatekeeper](https://github.com/zokuzoku/cat-gatekeeper) browser extension.

## License

MIT License - See LICENSE file for details.

## Credits

- Original extension: [Cat Gatekeeper](https://github.com/zokuzoku/cat-gatekeeper)
- Cat assets are not covered by MIT License - See ASSETS_LICENSE.md