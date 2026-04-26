# WW Girls JV Soccer Tools

Three social-media tools for Waukesha West Girls JV Soccer:

- **Card** — build the per-game social card with scorers and final score
- **Schedule** — lay out the season schedule, log results
- **Roster** — manage players, jerseys, captains, coaching staff

All three save to this GitHub repository so your data stays in sync between phone, tablet, and laptop. Edit on one device, the others pick up the change next time you open them.

**Public URL:** https://rlandquist.github.io/WW-Girls-JV-Soccer/

---

## How it works

Each tool is a self-contained HTML page served from GitHub Pages. When you save:

1. The tool writes to `localStorage` first (instant, never fails).
2. Then it commits the JSON file to this repo via the GitHub REST API.
3. GitHub Pages rebuilds the public site within 1–2 minutes.

When you open a tool on a different device, it reads the JSON files via the GitHub API to pull the latest data, then writes that to `localStorage`. From then on, you have local cached copies for offline use.

```
/                              ← repo root, served as GitHub Pages
├── index.html                 ← landing page (you start here)
├── GirlsJVSoccerCard.html     ← card tool
├── GirlsJVSoccerSchedule.html ← schedule tool
├── GirlsJVSoccerRoster.html   ← roster tool
├── common.js                  ← shared GitHub-sync library
├── manifest.json              ← PWA manifest (makes the site installable)
├── sw.js                      ← service worker (caches app shell for offline)
├── teams.json                 ← owned by Card tool (read-write)
├── schedule.json              ← owned by Schedule tool
├── roster.json                ← owned by Roster tool
└── Logos/
    ├── WaukeshaWest.png       ← school paw mark (do not rename)
    └── …                      ← opponent logos
```

---

## First-time setup

The whole setup takes about five minutes. You only do this once.

### 1. Generate a Personal Access Token

The tools commit to this repo on your behalf. They need a token to authenticate.

Go to **https://github.com/settings/tokens?type=beta** and:

1. Click **Generate new token** (top right).
2. **Token name**: `WW-Girls-JV-Soccer card tools` (or anything you'll recognize later).
3. **Expiration**: pick something. **1 year** is reasonable — set a calendar reminder for renewal.
4. **Repository access**: select **Only select repositories**, then choose `rlandquist/WW-Girls-JV-Soccer`.
5. **Repository permissions**: scroll down to **Contents** and set it to **Read and write**. Leave everything else at "No access".
6. Hit **Generate token** at the bottom.
7. Copy the token (`github_pat_…`). **You won't see it again** — if you lose it, generate a new one.

This token is *fine-grained*: it can only touch this one repo, and only modify file contents. It can't delete the repo, change settings, or read any of your other repos.

### 2. Paste the token into the tools

1. Open https://rlandquist.github.io/WW-Girls-JV-Soccer/ in your browser.
2. Tap the **GitHub sync** disclosure near the top of the page (collapsed by default).
3. Paste your token into the **Personal access token** field.
4. Tap **Test connection** to verify — the status pill should turn green and read "Synced".
5. Tap **Save**.

The token lives in your browser's `localStorage` for this site only. It's not sent anywhere except to GitHub when the tools commit changes. It does **not** sync between devices — you'll repeat this step on each phone, tablet, or laptop you want to use the tools from.

You only need to do this on **one** of the four pages. The landing page is easiest, but any of them works. All four share localStorage on the same origin.

### 3. Pin to your home screen (optional but recommended)

The tools are installable as a Progressive Web App, which means they get a real home-screen icon and run in their own window without browser chrome.

**iPhone / iPad (Safari)**
1. Tap the **Share** button (square with arrow pointing up).
2. Scroll down and tap **Add to Home Screen**.
3. Edit the name if you want, then tap **Add**.

You can install from any of the four pages. The icon's name comes from the page you installed from:

| Installed from | Home-screen name |
|---|---|
| Landing page | WW Soccer |
| Card tool | Soccer Card |
| Schedule tool | Schedule |
| Roster tool | Roster |

If you want quick-tap access to the Card tool during a game, install from the Card tool page directly. You can install all four if you want — they're separate icons but share the same data underneath.

**Android (Chrome or Edge)**
1. Open the browser menu (⋮ in the top right).
2. Tap **Install app** (or **Add to Home screen** depending on the browser).
3. Confirm.

On Android, long-pressing the installed app icon also reveals three jump-shortcuts: Card / Schedule / Roster.

---

## Daily use

Open from the home-screen icon (or visit the URL). Edit. Save. The save automatically commits to GitHub with a message like:

```
Update teams.json — 2026-04-26 14:32 (Card tool)
```

You'll see a green toast confirming each save.

### Conflict handling

If two people edit the same file at once and the second person's save would overwrite the first, the tool detects the conflict and asks what to do:

- **Keep mine** — overwrite the remote with your version
- **Load theirs** — discard your unsaved changes, load the remote version
- **Cancel** — leave both alone for now, decide later

Each tool only writes its own JSON file, so most concurrent edits don't actually conflict — two people editing different tools at the same time will never collide. Conflicts only happen when two people edit the same tool simultaneously, which is rare in practice.

### After saving, when does the public site update?

GitHub Pages takes 1–2 minutes to rebuild after each push to `main`. Saves take effect instantly in your tool — you see updated data the moment you save. But if someone loads the *public* page (`https://rlandquist.github.io/...`) within those 1–2 minutes, they may see slightly stale data.

This only affects a fresh page load. If a tool is already open on another device and you save from your device, the other device won't see your change until it's reloaded — but at that point it'll see the latest data via the API regardless of Pages rebuild status.

---

## Opponent logos

Logos live in `/Logos/` (capital `L`). To add a new opponent:

1. Save the opponent's logo as a square PNG with a transparent or solid background — ideally 200×200 or larger.
2. Name it CamelCase with no spaces: `KettleMoraine.png`, `WaukeshaNorth.png`, etc.
3. Commit it to `/Logos/` in this repo (drag-drop on github.com works fine).
4. In the Card tool, add the team and set its **logo file** to exactly that filename.

The filename is **case-sensitive** on GitHub Pages. `KettleMoraine.png` and `kettlemoraine.png` are different files — if you mismatch case, the logo won't load.

The school's own paw mark (`WaukeshaWest.png`) is referenced by code as the canonical school logo. Don't rename or remove it.

---

## Offline behavior

Once you've visited the site at least once, it works offline:

- The four pages load from cache (managed by `sw.js`)
- Your data loads from `localStorage` (managed by `common.js`)
- Opponent logos load from cache (cached on demand the first time you view a card featuring each opponent)

When you save while offline, the save fails with a toast saying GitHub is unreachable, but the change stays in `localStorage` and your tool keeps working with the new data. Next time you save while online, the change commits normally.

So you can use the tools at an away game with no signal — viewing, editing, and downloading PNG cards all keep working. Once you're back on Wi-Fi, your local edits sync to GitHub on the next save.

---

## Troubleshooting

**"Saves don't seem to sync to GitHub"**
- Open the GH config panel. The status pill should be green ("Synced"). If it's orange or absent, tap **Test connection**.
- Verify the token has **Contents: Read and write** for this repo. Tokens with read-only permission save to localStorage but never commit.
- Check the token hasn't expired. PATs expire on the date you set when generating, and GitHub does not warn you before expiration. Set a calendar reminder.

**"I don't see the latest data on this device"**
- Pull-to-refresh, or close and reopen the tab. The tool re-fetches from GitHub on every page load.
- If the data still looks stale, hard-reload (long-press refresh on mobile, or Ctrl+Shift+R on desktop) to bypass the service worker cache.

**"I need to roll back a change"**
1. Go to https://github.com/rlandquist/WW-Girls-JV-Soccer
2. Click the JSON file (e.g. `teams.json`)
3. Click **History** at the top right
4. Find the version you want and view it
5. Use the GitHub web UI's edit button to copy that version's contents back into the current file, then commit

After the next page load, the tools will see the rolled-back data.

**"Service worker isn't activating"**
- Service workers require HTTPS. GitHub Pages always serves HTTPS, so this should never fail in practice. If it does, try a hard reload once.
- First visit always installs the SW. Subsequent visits load the cached shell instantly, even offline.

**"I want to wipe everything on this device and start fresh"**
- Browser settings → Site settings → Find this site → **Clear data**
- That clears localStorage (your token, cached data) AND unregisters the service worker.
- Reload the page; you're back at first-time-setup state.

---

## For developers

### Rolling out an update

Push changes to `main`. GitHub Pages rebuilds in 1–2 minutes. Devices with open tabs continue using the cached shell until they reload.

If your change affects how data is read or written (any `common.js` change, or anything that breaks compatibility with existing localStorage entries), bump `CACHE_VERSION` in `sw.js` so the service worker evicts the old shell on the next page load:

```js
// sw.js, near the top
const CACHE_VERSION = 'v1';   // bump to 'v2', 'v3', etc.
```

### JSON schema notes

**`teams.json`** — owned by Card tool. Schedule tool reads `teams[]` only and ignores everything else.

```jsonc
{
  "version": 2,
  "teams": [
    { "name": "Arrowhead", "file": "Arrowhead.png" },
    { "name": "Badger",    "file": "Badger.png"    }
  ],
  "spineText": "...",          // card-specific
  "scorersByGame": { },        // card-specific
  "footerModeByGame": { },     // card-specific
  "halftimeModeByGame": { }    // card-specific
}
```

**`schedule.json`** — owned by Schedule tool.

```jsonc
{
  "version": 1,
  "games": [
    {
      "id": "g1abc",
      "date": "2026-08-22",
      "opponent": "Arrowhead",
      "location": "H",         // 'H' | 'A' | 'N'
      "status": "scheduled",   // 'scheduled' | 'final' | 'cancelled'
      "scoreUs": null,
      "scoreThem": null,
      "time": "5:00 PM"
    }
  ],
  "layout": "single"           // 'single' | 'double'
}
```

**`roster.json`** — owned by Roster tool.

```jsonc
{
  "version": 1,
  "layout": "double",          // 'single' | 'double'
  "coaches": [
    { "label": "Head Coach",        "name": "Zach Bargas" },
    { "label": "Asst. Coach",       "name": "" },
    { "label": "Goalkeepers Coach", "name": "" }
  ],
  "players": [
    {
      "id": "p1abc",
      "number": 7,
      "name": "Jane Smith",
      "positions": ["MF", "F"],
      "captain": false,
      "year": "10"
    }
  ]
}
```

Each tool's `applyXxxData()` helper is the source of truth for parsing — see `common.js`'s `loadJson()` and the tool-specific `applyTeamsPayload()` / `applyScheduleData()` / `applyRosterData()` for full details.

### Optional polish

The PWA manifest currently points all icon sizes at the single `WaukeshaWest.png`, and the browser scales it. For sharper home-screen rendering on Android Chrome's install prompt, generate true 192×192 and 512×512 PNGs and update `manifest.json`'s icon entries. Not blocking — installs and offline behavior already work fine.

---

## Files in this repo

| File | What it does |
|---|---|
| `index.html` | Landing page with three tool tiles + shared GH config panel |
| `GirlsJVSoccerCard.html` | Per-game card builder. Owns `teams.json`. |
| `GirlsJVSoccerSchedule.html` | Season schedule. Owns `schedule.json`, reads `teams.json`. |
| `GirlsJVSoccerRoster.html` | Roster + coaching staff. Owns `roster.json`. |
| `common.js` | Shared GitHub-sync library used by all four pages |
| `manifest.json` | PWA manifest — makes the site installable |
| `sw.js` | Service worker — caches app shell + opponent logos for offline |
| `teams.json` | Opponent list + card-specific state |
| `schedule.json` | Season schedule |
| `roster.json` | Player roster + coaching staff |
| `Logos/WaukeshaWest.png` | School paw mark — do not rename |
| `Logos/*.png` | Opponent logos, CamelCase filenames |

---

If you hit something this README doesn't cover, the source files are heavily commented — start at `common.js` for the sync layer, and at each tool's `init()` function for the page lifecycle.
