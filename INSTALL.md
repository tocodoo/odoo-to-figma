# Installing Odoo To Figma

Odoo To Figma rebuilds any web page (Odoo website, back office, any other site) in Figma as editable layers: text, original images, vector icons, optional auto layout.

Allow 5 minutes, once.

## What you need

- a Mac;
- [Figma Desktop](https://www.figma.com/downloads/): the plugin does not work in Figma in the browser;
- [Google Chrome](https://www.google.com/chrome);
- [Node.js](https://nodejs.org) version 18 or later (take the "LTS" version);
- Git: if it is missing, the install opens the macOS window that installs it. No GitHub account is needed.

## Installation

1. Open the **Terminal** app and paste:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/tocodoo/odoo-to-figma/main/install.sh | bash
   ```
   The script downloads the app with git into `~/odootofigma`, installs the dependencies and a small launcher that starts with your session. macOS may show a "background item added" notification: this is expected.

   If a window asks to install the **Command Line Tools**, click **Install**, wait for it to finish, then paste the command again.
2. In Figma Desktop, go to **Plugins → Development → Import plugin from manifest…** and pick `~/odootofigma/figma-plugin/manifest.json`.

## Usage

1. In Figma, open **Plugins → Development → Odoo To Figma**.
2. Click **Start server**. This is only needed once per session.
3. Paste a URL, pick the screens (Desktop, Tablet, Mobile), turn on **Auto layout** if needed, then click **Import to Figma**.

### With Claude (optional)

If you use Claude Code, the install also adds the **odoo-to-figma** MCP. Restart Claude Code, keep the plugin open in Figma, then ask for example:

> Open https://demo.odoo.com/odoo/discuss and export each tab to Figma with auto layout.

Claude can click buttons, open modals and export a modal on its own. For an instance that requires a login, it opens a Chrome window where you log in yourself.

## Updating

Each time it opens, the plugin checks GitHub for a new version. If there is one, it stays locked on **Update required**: click **Update now**, then reopen the plugin when it closes.

To update by hand (or if the automatic update fails):

```bash
cd ~/odootofigma
git pull
./install.sh
```

Then close and reopen the plugin in Figma.

## Troubleshooting

| Problem | Solution |
|---|---|
| The plugin stays on "Server stopped" | Run `./install.sh` again in `~/odootofigma`, then click **Start server**. |
| The update fails | Run the manual update above. |
| A font is replaced | The plugin names it at the end of the import: install it on your Mac and import again. |
| A page requires a login | Use Claude with a visible window (see above). |
| Something else | Check the log: `~/Library/Logs/Odoo To Figma/launcher.log` |

To uninstall everything: `npm run uninstall-launcher` in `~/odootofigma`, then delete the folder and remove the plugin in Figma.
