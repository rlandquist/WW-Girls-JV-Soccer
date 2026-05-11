/* ═══════════════════════════════════════════════════════════════════
 * WW Girls JV Soccer — Service Worker
 *
 * Caches the static "app shell" so the five pages (index + four tools)
 * load even when the device is offline. Data still flows through
 * common.js's existing localStorage fallback, so editing/viewing roster,
 * schedule, team, and goal data continues to work offline; only the
 * GitHub sync is suspended until connectivity returns.
 *
 * Caching strategy:
 *   - Same-origin shell (HTML, JS, JSON, paw mark, manifest):
 *       cache-first with stale-while-revalidate background refresh
 *   - Same-origin /Logos/ images (opponent logos):
 *       cache-first; on miss, fetch and cache for next visit
 *   - Cross-origin (api.github.com, fonts.googleapis.com,
 *     cdnjs.cloudflare.com): pass through, never intercepted
 *   - Non-GET requests (POST/PUT/DELETE — i.e. GitHub saves):
 *       always pass through
 *
 * Versioning: bump CACHE_VERSION whenever you ship breaking shell
 * changes (new HTML structure, common.js API changes, etc.). The
 * activate handler deletes any cache that doesn't match the current
 * version, so old shells get evicted on the next page load.
 *
 * v9 (May 2026): Tier 3 #1 — pruned Card.html's mobile @media
 * (max-width: 900px) block. After diffing rule-by-rule against
 * shared.css, every rule in Card's @media was a duplicate of
 * shared's: identical values, identical selectors, identical
 * comments-stripped semantics. The only differences were inert
 * (.editor-toggle: #0d1f42 hard-coded vs var(--ink), which resolve
 * to the same colour; .card-container missing justify-content:
 * flex-start, which doesn't apply because Card's .card-container
 * isn't a flex container). Tier 1 kept the block intact for safety;
 * the concern at the time was Card's desktop `position: sticky` on
 * .card-container needing a mobile reset, but shared's @media
 * already handles that with `position: static !important`. The
 * 130-line block collapsed to a 14-line comment explaining where
 * mobile lives. Card.html dropped ~3.6 KB. Bumped so v8-cached
 * devices evict and pick up the trimmed Card.html on next visit.
 *
 * v8 (May 2026): Tier 2 cleanup pass. Card tool's download() and
 * copyToClipboard() now delegate to WWCommon.downloadElementAsPng
 * and copyElementAsPngToClipboard — the html2canvas + blob plumbing
 * is unified across all three card tools. The shared helpers gained
 * three new opts (filename, before, after) so each tool can supply
 * its own filename and pre-export hooks (Card uses `before` to hide
 * the drag-tip overlay). The .copy-btn.success class on Card was
 * renamed to .done for symmetry with Schedule and Roster (matches
 * the class WWCommon adds during the 'Copied!' flash). Orphan
 * decorated comments left over from the Tier 1 shared.css extraction
 * were also swept across Card/Schedule/Roster/Goals so the section
 * labels accurately describe what each block is, instead of
 * advertising header chrome that no longer lives there. Bumped so
 * v7-cached devices evict and pick up the trimmed Card.html and the
 * extended common.js on next visit.
 *
 * v7 (May 2026): Card tool's pattern rendering moved from canvas
 * drawing to CSS-background overlays via WWCommon.applyPatternToElement,
 * matching how Schedule and Roster already render their patterns. The
 * three mode-specific PATTERNS arrays in Card.html collapsed to three
 * single-line calls to the extended makeSoccerPatterns helper, which
 * now accepts accentRgb + light:true for the light-bg flip used by
 * Preview mode. Dot overlays, the Score corner mask, and the angled
 * right-edge fades on Preview / Halftime are gone — the cards now
 * render uniformly with the same approach as Schedule / Roster.
 * Bumped so v6-cached devices evict and pick up both the trimmed
 * Card.html and the extended common.js on next visit.
 *
 * v6 (May 2026): Added shared.css — a new top-level stylesheet that owns
 * the chrome shared by every page (app-header, mobile media query,
 * photo-credit pill, toast, CSS variables, etc.). Each tool's inline
 * <style> block shrank to its tool-specific rules only, and per-tool
 * accent colours are now CSS custom properties so re-skinning is a
 * one-line change. Common.js also gained makeSoccerPatterns,
 * buildPatternPicker, applyPatternToElement, downloadElementAsPng,
 * copyElementAsPngToClipboard, setupMobileEditorToggle, and
 * registerServiceWorker — the JS that was being copy-pasted across
 * tools moved into one place. Bumped so v5-cached devices evict and
 * pull both shared.css and the trimmed HTMLs on next visit; without
 * the bump, the cached HTMLs would <link> a shared.css that wasn't
 * in cache yet, leaving the page un-styled until the second reload
 * caught up via stale-while-revalidate.
 *
 * v5 (May 2026): Card tool's scorer-display preference (totals vs
 * times) is now per-card-mode — Final and Halftime carry independent
 * prefs. New localStorage keys are read on first load with a one-time
 * migration from the legacy single key. Bumped so v4-cached devices
 * evict and pick up the restructured Card.html on next visit; without
 * it, the new toggles wouldn't render and the migration wouldn't run
 * until stale-while-revalidate caught up on the second reload.
 *
 * v4 (May 2026): Added Classic8.png (conference badge) and
 * RobertLandquistPhotography.png (photo credit) to the pre-cached
 * shell. Both were already cached on demand via the /Logos/ path
 * matcher, but cache-on-demand only catches them after the user
 * visits a page that renders them. Pre-caching guarantees offline
 * availability from install — important because the photo credit
 * appears on every page and the Classic 8 badge appears on Card
 * and Schedule whenever a Classic 8 opponent is rendered.
 *
 * v3 (May 2026): Mobile + UX polish pass — photo-credit pill un-fixes
 * on phones and shrinks on index/Goals; Schedule and Roster allow
 * double-column layout on mobile (with horizontal scroll); Goals
 * dims its sections until a game is picked and recomputes the
 * half-toggle from goals data per game; Tools back-link enlarged on
 * all four tool pages; per-tool accent line under each header;
 * Goals tile icon swapped from target to goal-net; trailing
 * "Waukesha West • All Tools" footer removed from Goals. App-shell
 * URL list unchanged — the bump just forces v2-cached devices to
 * re-fetch the updated HTML/CSS/SVG instead of waiting on stale-
 * while-revalidate.
 *
 * v2 (May 2026): Added GirlsJVSoccerGoals.html to the shell. Bumped
 * version so devices with a v1 cache evict and re-prime the shell on
 * next load (otherwise they wouldn't see the new page until a hard
 * reload).
 * ═══════════════════════════════════════════════════════════════════ */

const CACHE_VERSION    = 'v9';
const APP_SHELL_CACHE  = `ww-soccer-shell-${CACHE_VERSION}`;
const LOGO_CACHE       = `ww-soccer-logos-${CACHE_VERSION}`;

/* Files that should be available offline from the moment the SW
   installs. We deliberately do NOT pre-cache opponent logos here —
   there are 14+ of them, and they're cached on demand as the user
   actually views games featuring each opponent. That keeps the
   install footprint small. */
const APP_SHELL_URLS = [
  './',
  './index.html',
  './GirlsJVSoccerCard.html',
  './GirlsJVSoccerSchedule.html',
  './GirlsJVSoccerRoster.html',
  './GirlsJVSoccerGoals.html',
  './common.js',
  './shared.css',
  './manifest.json',
  './Logos/WaukeshaWest.png',
  './Logos/Classic8.png',
  './Logos/RobertLandquistPhotography.png'
];

/* ─── Install: pre-cache the app shell ─────────────────────────── */
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(function(cache) {
        /* addAll is atomic — if any URL fails to fetch, the whole
           install fails. That's the right behavior here: a partial
           shell would mean inconsistent offline UX. */
        return cache.addAll(APP_SHELL_URLS);
      })
      .then(function() {
        /* Skip the "waiting" phase so the new SW takes over as soon
           as the old one's tabs close. Combined with clients.claim()
           below, this means a single page reload picks up the new
           shell after a deploy. */
        return self.skipWaiting();
      })
  );
});

/* ─── Activate: evict old caches ───────────────────────────────── */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys
            .filter(function(key) {
              /* Keep only caches that end with the current version
                 suffix. Anything else is a previous deploy's leftovers. */
              return !key.endsWith('-' + CACHE_VERSION);
            })
            .map(function(key) { return caches.delete(key); })
        );
      })
      .then(function() {
        /* Take control of all open clients (tabs) immediately rather
           than waiting for them to navigate. */
        return self.clients.claim();
      })
  );
});

/* ─── Fetch: route requests through cache strategies ───────────── */
self.addEventListener('fetch', function(event) {
  const req = event.request;

  /* Only ever intercept GET. POST/PUT/DELETE go to the network
     untouched — those are GitHub saves and must not be cached. */
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Cross-origin requests pass through. We don't cache GitHub API
     responses (they carry auth + are mutating), Google Fonts
     (the browser HTTP cache handles them well enough), or cdnjs
     (html2canvas / Sortable are bundled in browser cache after
     first load). Letting them through also avoids any CORS /
     opaque-response storage issues. */
  if (url.origin !== self.location.origin) return;

  /* Opponent logos: dedicated cache, cache-first with network
     fallback. Once an opponent logo is fetched (e.g. user clicked
     into a game card featuring Arrowhead), it stays in this cache
     for offline use forever — until CACHE_VERSION bumps. */
  if (/\/Logos\/.+\.(png|jpg|jpeg|svg|webp|gif)$/i.test(url.pathname)) {
    event.respondWith(cacheFirstThenNetwork(req, LOGO_CACHE));
    return;
  }

  /* Everything else same-origin (HTML, JS, JSON, manifest):
     cache-first with stale-while-revalidate. Serves instantly
     from cache when present, refreshes in the background. */
  event.respondWith(cacheFirstThenNetwork(req, APP_SHELL_CACHE));
});

/* ─── Strategy: cache-first with background refresh ─────────────
   1. Look in the named cache.
   2. If hit: return the cached response immediately, AND kick off
      a background fetch to refresh the cache (stale-while-revalidate).
   3. If miss: fetch from network. On success, cache and return.
   4. If miss AND offline: for navigation requests (i.e. the user
      typed a URL or clicked a link), fall back to the cached index
      so they at least see something. For asset requests, surface
      the network error to the page. */
async function cacheFirstThenNetwork(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    /* Background refresh — don't await it. If the network is up
       and returns a fresh copy, swap it into cache for next time.
       If the network is down or the response is bad, just leave
       the cached copy alone. */
    fetch(request)
      .then(function(resp) {
        if (resp && resp.ok) {
          cache.put(request, resp.clone()).catch(function() {});
        }
      })
      .catch(function() { /* offline — keep the cached copy */ });
    return cached;
  }

  /* Cache miss — go to network. */
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      /* Clone before caching — Response bodies are streams and can
         only be consumed once. */
      cache.put(request, resp.clone()).catch(function() {});
    }
    return resp;
  } catch (err) {
    /* Offline AND not in cache. Last-ditch fallback: if the user
       was navigating to a page (not requesting a sub-resource),
       hand back the cached index so they get *something* useful. */
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html')
                    || await cache.match('./');
      if (fallback) return fallback;
    }
    /* Sub-resource and offline — surface the error so the page can
       handle it (e.g. show a broken-image icon). */
    throw err;
  }
}

/* ─── Update channel ───────────────────────────────────────────────
   Pages can postMessage({type: 'SKIP_WAITING'}) to this SW to force
   an immediate activation when a new version is detected. Useful for
   "Update available — tap to reload" UI down the road. Not wired up
   in the current shell, but cheap to leave here for future use. */
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
