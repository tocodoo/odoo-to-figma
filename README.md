# Odoo To Figma

Paste a web page URL: the plugin rebuilds it in Figma, pixel for pixel, as fully editable layers (frames, text, images, SVG, borders, shadows, gradients).

## Installation

Everything goes through **`install.sh`**, in a single command, once:

```bash
curl -fsSL https://raw.githubusercontent.com/tocodoo/odoo-to-figma/main/install.sh | bash
```

You need a Mac, [Figma Desktop](https://www.figma.com/downloads/) (the plugin does not run in Figma in the browser), [Google Chrome](https://www.google.com/chrome) and [Node.js](https://nodejs.org) 18 or later (take the "LTS" version). No GitHub account is needed.

### Git is required

The app is always installed **as a git clone**: this is how the plugin updates itself (see below). `install.sh` takes care of it:

- **Git missing?** The script opens the macOS window that installs it (Apple's Command Line Tools). Click **Install**, wait for it to finish, then run the command again.
- **Not in a git clone?** If you run the script through `curl`, or from a ZIP downloaded from GitHub, it clones the repository into `~/odootofigma` (change it with `ODOO_TO_FIGMA_DIR`) and continues from there. A ZIP copy is never installed as is.
- **Already cloned?** `./install.sh` from your clone works too.

Avoid `~/Documents`, `~/Desktop` and `~/Downloads` for the clone: macOS keeps background services out of these folders, which blocks automatic updates.

### What the script installs

1. The dependencies (`npm install`).
2. A small **launcher** that starts with your macOS session. A Figma plugin cannot run commands by itself: the launcher starts the render server when you click **Start server** in the plugin, and applies updates. The server is copied to `~/Library/Application Support/Odoo To Figma`.
3. The **odoo-to-figma** MCP server in Claude Code (optional, see [Driving exports with Claude](#driving-exports-with-claude-mcp)).

Last step, in Figma Desktop: **Plugins → Development → Import plugin from manifest…**, then pick `figma-plugin/manifest.json` in the clone. The script prints the full path.

A step-by-step guide for colleagues is in [INSTALL.md](INSTALL.md).

### Updates

Each time the plugin opens, it checks GitHub (`git fetch`) for a newer version. If there is one, the plugin stays locked on **Update required** until you click **Update now**: the launcher runs `git pull` and `npm install`, refreshes the server, then the plugin closes. Reopen it and you are on the latest version.

If the update fails (local changes in the clone, for example), run `git pull` then `./install.sh` in the clone. If GitHub cannot be reached (offline), the plugin opens as usual.

## Usage

1. In Figma: **Plugins → Development → Odoo To Figma**.
2. While the server is not running, the plugin is locked: click **Start server**. It unlocks as soon as the server answers, and locks again if the server stops.
3. Paste the URL, pick the screens (Desktop 1440, Tablet 768, Mobile 390) and the theme, then click **Import to Figma**.

Each screen becomes a frame placed to the right of what is already on the page. The **Stop** button (in **Server settings**) stops the server and Chrome.

**Auto layout** (toggle): containers become Figma auto layout frames. The direction (vertical, horizontal or wrap), paddings, gaps, alignments and hug, fill or fixed sizes are inferred from the exact positions of the elements. Nothing moves compared to the page: a container that no auto layout reproduces exactly keeps free positioning. Positioned elements (`position: absolute`, backgrounds, highlights) become absolutely positioned inside the auto layout. Invisible spacers ("Spacer") fill uneven gaps. When possible, the real CSS padding is kept with an alignment ("padding 8 · centered" rather than "13/4/8/4"), so the layers stay right when resized in Figma. Overlapping borders (kanban cards stuck together with `margin: -1px`) become a negative gap.

| Command                      | Purpose                                                           |
|------------------------------|-------------------------------------------------------------------|
| `./install.sh`               | Installs or updates everything (dependencies, launcher, Claude MCP) |
| `npm run install-launcher`   | Reinstalls only the launcher and the Claude MCP, e.g. after changing the code |
| `npm run uninstall-launcher` | Removes the launcher, the MCP and the server copy                 |
| `npm start`                  | Starts the server by hand (without the launcher), in a terminal   |

Launcher log: `~/Library/Logs/Odoo To Figma/launcher.log`.

## Driving exports with Claude (MCP)

The install also registers the **odoo-to-figma** MCP server in Claude Code, for all your projects. Restart Claude Code, keep the plugin open in Figma (the **✦ Claude** badge lights up), then ask for example:

- "Open https://demo.odoo.com/odoo/sales, click New, then export the screen to Figma."
- "On this page, click the 'Send by email' button and export only the modal."
- "Export every view of this app: each menu, each tab, in desktop and mobile."
- "Import these 10 URLs in desktop and mobile, with auto layout."

Claude drives a "session" Chrome: it reads the page (links, buttons, tabs, menus and open dialogs, with a screenshot), clicks, types text, then exports. Three export scopes:

| Scope            | Content                                                                   |
|------------------|---------------------------------------------------------------------------|
| full page        | the whole page (default)                                                  |
| visible screen   | what is on screen, e.g. the screen with its modal and the backdrop behind |
| one element      | only the modal, a menu, a card, a chart or a table (reference read by Claude, or a CSS selector such as `.o_notebook`) |

Each export becomes a named frame in Figma, and Claude gets the result back. If the plugin is closed, exports wait and are imported as soon as it opens.

**Pages behind a login**: ask Claude to open the page in a visible window, log in in that window, then Claude continues. Cookies are kept in `~/Library/Application Support/Odoo To Figma/profile`.

**Claude Desktop**: the install script prints the line to add to `claude_desktop_config.json`.

Available tools: `open_page`, `get_page`, `click`, `hover` (keeps the mouse over an element, e.g. to export a tooltip), `type_text`, `press_key`, `go_back`, `scroll`, `export_to_figma`, `import_url_to_figma`, `import_html_to_figma` (HTML written by Claude → Figma), `figma_status`, `close_browser`.

## What is reproduced

- **Layout**: exact position and size of each element, layer hierarchy mirroring the DOM (`header`, `section`, `div.container`…), stacking order (z-index), clipped content (`overflow: hidden`).
- **Text**: real fonts, weights, sizes, line height, letter spacing, case, underline, clickable links. A paragraph stays a single layer, even with bold or links inside. Line breaks are the browser's.
- **Backgrounds**: colors (including `oklch`, `lab`, `display-p3`), background images (`cover`, `contain`, position, repeat, sprites), linear, radial and conic gradients, gradient text.
- **Borders and corners**: width per side, dashed and dotted, radius per corner.
- **Effects**: drop and inner shadows, `text-shadow`, blur (`filter` and `backdrop-filter`), blend modes, opacity.
- **Rotations**: a rotated element (Odoo's "Paid" or "Lost" ribbon, a slanted badge) keeps its real size and editable content; it is simply rotated in Figma, around the same center as in the browser.
- **`clip-path` cut-outs**: `polygon()`, `inset()`, `circle()`, `ellipse()` and `path()` become a vector mask (the arrows of Odoo's status bar, for example); the content stays editable underneath. Simple shapes (circle, rounded rectangle) become rounded corners.
- **Separator lines**: single-side inner shadows (`box-shadow: inset 0 -1px 0 …`, used by Odoo and Bootstrap as separators) become real Figma strokes.
- **Images, never redrawn**: each image (profile picture, visual, logo) is imported as is, original file included, in an image layer with locked proportions. Cropping (`object-fit`, `object-position`, rounded corners, circular `clip-path`) is applied without touching the image. In auto layout, images keep their exact size. Figma accepts neither WebP nor AVIF: they are converted losslessly to PNG. Images larger than 4096 px, Figma's limit, are scaled down.
- **Inline SVG** (icons drawn in the HTML) imported as vectors.
- **Icons as vectors, whatever the font**: Font Awesome 4 (full `font-awesome` 4.7 package), Font Awesome 5/6, Material Symbols, `odoo_ui_icons`, Bootstrap Icons, custom fonts. The exact outline is read from the font file loaded by the page (WOFF2, WOFF, TTF, OTF), with ligatures (`search` → icon), OpenType variants (`ss01`) and variable axes (fill, weight). Each icon is named (`fa-check`, `search`, `oi_studio`…), keeps its color and stays recolorable in Figma. If the font file cannot be reached, the icon is rendered as a high-definition image.
- **Tables and lists**: each table is rebuilt column by column, the way you would by hand: `Columns` (horizontal) → `Column — Description` (vertical) → `Header — Description`, `Row 1 — Description`… Each column keeps its width, cells fill the column and keep their CSS padding. Row borders and backgrounds (which a cell background would hide in Figma) are carried over to the cells, so separators run edge to edge. Empty filler rows are removed. A row with a cell spanning several columns (section, note, "Add a line") stays a full-width row between two blocks of columns. A header moved by `position: sticky` (the optional columns toggle) gets back to its column.
- **Charts**: Chart.js charts (bar, line, area, pie, doughnut, polar) are exported as editable vectors: bars, curves, points, grids, axis labels and legend. Other canvases are captured as images.
- **Emojis**: text keeps its font and Figma shows emojis with its system font (a forced emoji font would show up empty in Figma).
- **Forms** (fields, placeholders, selects); videos, iframes and native controls are captured as images.
- **Odoo specifics**: scroll animations (`o_animate`), lazy images and sticky headers are handled before capture. Back-office screens (lists, forms, `demo.odoo.com` with its redirects) can be imported too.

If a font is not installed on your computer, it is replaced and the plugin says so at the end of the import. Install it and import again for an identical result.

## Structure

```
install.sh           One-command install and update (git clone, dependencies, launcher, MCP)
figma-plugin/        The Figma plugin (manifest, main code, UI)
server/              Render server (headless Chrome → layer description)
  index.js           HTTP render server (port 3999)
  launcher.js        Launcher: starts/stops the server and applies updates for the plugin (port 3998)
  mcp.js             MCP server (stdio): the tools used by Claude
  session.js         Session Chrome driven by Claude (clicks, typing, cookies)
  jobs.js            Queue of exports to the Figma plugin (Server-Sent Events)
  capture.js         Page loading, scrolling, images, screenshots
  snapshot-to-ir.js  Turns Chrome's layout into a layer tree
  autolayout.js      Infers auto layout from exact positions
  css.js             CSS colors, gradients, shadows, sizes
  fa4.js             Font Awesome 4.7 icons as vectors (font-awesome package)
  iconfonts.js       Icons from any font as vectors (the page's font files, fontkit)
  page-scripts.js    Scripts run inside the page (preparation, SVG, icons)
scripts/             Launcher install, test tools (capture, visual comparison)
test/                Fake Figma environment to test the plugin without Figma
```

## Development tools

```bash
npm run capture -- https://www.odoo.com desktop out.json   # command-line capture
npm run test:plugin -- out.json [--auto-layout]            # runs the plugin in a strict fake Figma
node test/check-autolayout.js out.json                     # checks that auto layout moves no layer
npm run test:mcp                                           # full Claude scenario: click → modal → export (fake plugin)
node scripts/preview.js out.json out --original            # control render (rotations included) + screenshot of the original page
node scripts/inspect.js https://demo.odoo.com/odoo fn.js   # runs the function body in fn.js inside the page and prints the result
python3 scripts/compare.py out 0 900                       # side-by-side comparison
echo "odoo https://www.odoo.com desktop" | ./scripts/batch-test.sh   # run everything on a list of sites
```

The fake Figma (`test/mock-figma.js`) also checks vector masks (`createNodeFromSvg`, `isMask`, `insertChild`) and constraints. `check-autolayout.js` simulates main-axis alignment (start, center, end) and negative gaps.

`test/fixtures/kitchen-sink.html` gathers the edge cases: gradient text, ellipsis, line-clamp, justified text, RTL, superscripts, multicolor borders, rotation, z-index, forms, `object-fit` images…

## Configuration

| Variable            | Default            | Purpose                                  |
|---------------------|--------------------|------------------------------------------|
| `PORT`              | `3999`             | Server port                              |
| `LAUNCHER_PORT`     | `3998`             | Launcher port                            |
| `HOST`              | `127.0.0.1`        | Listening interface                      |
| `CHROME_PATH`       | auto               | Chrome path if not detected              |
| `ODOO_TO_FIGMA_DIR` | `~/odootofigma`    | Where `install.sh` clones the repository |
| `ODOO_TO_FIGMA_REPO`| the GitHub repo    | Repository `install.sh` clones           |

To use a hosted server instead of a local one, enter its address in **Server settings** (at the bottom of the plugin), and add its domain to `networkAccess.allowedDomains` in `manifest.json`.
