/* ═══════════════════════════════════════════════════════════════════════════
   common.js — Shared GitHub sync layer + utilities for the WW Soccer tools
   ───────────────────────────────────────────────────────────────────────────
   Loaded by: index.html, GirlsJVSoccerCard.html, GirlsJVSoccerGoals.html,
              GirlsJVSoccerSchedule.html, GirlsJVSoccerRoster.html

   Provides:
     • GitHub config + Personal Access Token storage (one config, all tools)
     • Low-level GitHub Contents API client (GET/PUT JSON)
     • High-level loadJson / saveJson with localStorage cache + SHA tracking
     • Conflict detection (SHA mismatch) + refresh-and-retry dialog
     • Shared toast, escapeHtml, base64 utilities
     • Config panel UI (collapsible, status pill, mountable into any sidebar)

   Public API surface lives on `window.WWCommon` (see bottom of file).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ─── Constants ──────────────────────────────────────────────────────── */
  var GH_CONFIG_KEY     = 'gh-config-v1';        // { owner, repo, branch, pat }
  var GH_SHA_CACHE_KEY  = 'gh-sha-cache-v1';     // { "teams.json": "sha", ... }
  var GH_SYNC_TIMES_KEY = 'gh-sync-times-v1';    // { "teams.json": 1234567890, ... }
  var GH_TOKEN_AGE_KEY  = 'gh-token-saved-at-v1';// timestamp ms when current token was saved
  var TOKEN_WARN_DAYS   = 340;                   // warn when token is this old (default PAT expiry is 365d)
  var TOKEN_WARN_SESSION_KEY = 'gh-token-warn-shown-v1'; // sessionStorage flag — warn once per tab
  var BROADCAST_CHANNEL_NAME = 'ww-soccer-sync'; // cross-tab notifications
  var DEFAULT_OWNER  = 'rlandquist';
  var DEFAULT_REPO   = 'WW-Girls-JV-Soccer';
  var DEFAULT_BRANCH = 'main';
  var GH_API_BASE = 'https://api.github.com';

  /* In-memory queue: per-filename Promise chain so concurrent saves
     for the same file serialize. Prevents self-induced SHA conflicts
     when a tool calls saveJson() twice in rapid succession. */
  var saveQueues = {};

  /* Per-page-load tab id — used so a tab doesn't react to its own broadcast
     pings. Random + millis means even the same browser running multiple
     instances of the same tool stays disambiguated. */
  var TAB_ID = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* Cross-tab notification channel. Some old Safaris don't ship
     BroadcastChannel — degrade silently in that case (no cross-tab live
     update, but everything else still works). */
  var bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(BROADCAST_CHANNEL_NAME) : null;
  var fileSavedListeners = [];
  if (bc) {
    bc.onmessage = function (event) {
      var data = event && event.data;
      if (!data || data.type !== 'file-saved') return;
      if (data.source === TAB_ID) return; // don't react to our own ping
      fileSavedListeners.forEach(function (cb) {
        try { cb(data.filename, data); } catch (e) { /* swallow */ }
      });
    };
  }

  function broadcastFileSaved(filename) {
    if (!bc) return;
    try {
      bc.postMessage({
        type: 'file-saved',
        filename: filename,
        source: TAB_ID,
        at: Date.now()
      });
    } catch (e) { /* swallow */ }
  }

  /* Public registration helper — tools call WWCommon.onFileSaved(cb) to be
     notified when ANY other tab saves a file. The callback receives
     (filename, payload). Tools typically dispatch on filename to call the
     right refreshXxxFromGitHub() function. Returns an unsubscribe fn. */
  function onFileSaved(cb) {
    if (typeof cb !== 'function') return function () {};
    fileSavedListeners.push(cb);
    return function () {
      var i = fileSavedListeners.indexOf(cb);
      if (i >= 0) fileSavedListeners.splice(i, 1);
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CONFIG
     ═══════════════════════════════════════════════════════════════════════ */
  function loadGitHubConfig() {
    try {
      var raw = localStorage.getItem(GH_CONFIG_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        owner:  typeof parsed.owner  === 'string' ? parsed.owner  : DEFAULT_OWNER,
        repo:   typeof parsed.repo   === 'string' ? parsed.repo   : DEFAULT_REPO,
        branch: typeof parsed.branch === 'string' ? parsed.branch : DEFAULT_BRANCH,
        pat:    typeof parsed.pat    === 'string' ? parsed.pat    : ''
      };
    } catch (e) { return null; }
  }

  function saveGitHubConfig(config) {
    try {
      var prev = null;
      try { prev = JSON.parse(localStorage.getItem(GH_CONFIG_KEY) || 'null'); } catch (e) {}
      var newPat = (config && config.pat) || '';
      localStorage.setItem(GH_CONFIG_KEY, JSON.stringify({
        owner:  (config && config.owner)  || DEFAULT_OWNER,
        repo:   (config && config.repo)   || DEFAULT_REPO,
        branch: (config && config.branch) || DEFAULT_BRANCH,
        pat:    newPat
      }));
      /* Track when the current token was first saved on this device, so
         we can warn the user as it approaches its likely expiration. We
         only refresh the timestamp when the token VALUE changes — saving
         the same token (e.g. updating owner/repo) preserves the original
         age. Clearing the token clears the timestamp.
         GitHub's fine-grained PAT API doesn't return an expiration date,
         so age is the cleanest signal we have. Default expiry is 365
         days; we warn at 340. */
      if (!newPat) {
        localStorage.removeItem(GH_TOKEN_AGE_KEY);
      } else if (!prev || prev.pat !== newPat) {
        localStorage.setItem(GH_TOKEN_AGE_KEY, String(Date.now()));
        /* Reset the once-per-session warning flag so a freshly-pasted
           token doesn't immediately re-show a stale-warning toast from
           a previous token. */
        try { sessionStorage.removeItem(TOKEN_WARN_SESSION_KEY); } catch (e) {}
      }
    } catch (e) { /* quota / private mode — silent */ }
  }

  function clearGitHubConfig() {
    try {
      localStorage.removeItem(GH_CONFIG_KEY);
      localStorage.removeItem(GH_SHA_CACHE_KEY);
      localStorage.removeItem(GH_SYNC_TIMES_KEY);
      localStorage.removeItem(GH_TOKEN_AGE_KEY);
    } catch (e) {}
  }

  /* Token age in days, or null if no token saved or no timestamp on
     record (e.g. token was set before the age-tracking shipped). */
  function getTokenAgeDays() {
    try {
      var raw = localStorage.getItem(GH_TOKEN_AGE_KEY);
      if (!raw) return null;
      var ts = parseInt(raw, 10);
      if (isNaN(ts) || ts <= 0) return null;
      var ms = Date.now() - ts;
      return Math.floor(ms / 86400000);
    } catch (e) { return null; }
  }

  /* Show a one-per-session toast if the saved token is approaching
     its likely expiration. Called once on init. Silent if no token,
     no timestamp, or already-shown this session. Idempotent. */
  function maybeShowTokenAgeWarning() {
    if (!isGitHubConfigured()) return;
    var days = getTokenAgeDays();
    if (days == null || days < TOKEN_WARN_DAYS) return;
    try {
      if (sessionStorage.getItem(TOKEN_WARN_SESSION_KEY)) return;
      sessionStorage.setItem(TOKEN_WARN_SESSION_KEY, '1');
    } catch (e) { /* private mode — proceed without dedup */ }
    /* Defer the toast a beat so it doesn't race the page's own startup
       toasts (e.g. roster-loaded confirmations). */
    setTimeout(function () {
      toast('GitHub token is ' + days + ' days old — consider renewing soon. PATs expire silently.', 'warn');
    }, 1500);
  }

  function isGitHubConfigured() {
    var c = loadGitHubConfig();
    return !!(c && c.owner && c.repo && c.pat);
  }

  /* Test the configured PAT + repo. Returns:
       { ok: true,  user: 'rlandquist' }
       { ok: false, stage: 'auth' | 'repo' | 'network', message: '...' }
     stage tells the caller which step failed so the UI can be specific. */
  function testGitHubConnection(config) {
    config = config || loadGitHubConfig();
    if (!config || !config.pat) {
      return Promise.resolve({ ok: false, stage: 'auth', message: 'No token configured' });
    }
    var headers = ghHeaders(config.pat);
    return fetch(GH_API_BASE + '/user', { headers: headers })
      .then(function (r) {
        if (r.status === 401) return { ok: false, stage: 'auth', message: 'Token rejected (401). Check that the token is correct and not expired.' };
        if (!r.ok) return { ok: false, stage: 'auth', message: 'Auth check failed (' + r.status + ')' };
        return r.json().then(function (u) { return { user: u.login }; });
      })
      .then(function (authResult) {
        if (authResult.ok === false) return authResult;
        return fetch(GH_API_BASE + '/repos/' + config.owner + '/' + config.repo, { headers: headers })
          .then(function (r) {
            if (r.status === 404) return { ok: false, stage: 'repo', message: 'Repo "' + config.owner + '/' + config.repo + '" not found, or token lacks access to it.' };
            if (r.status === 403) return { ok: false, stage: 'repo', message: 'Token does not have permission for this repo. For fine-grained tokens, make sure Contents is set to Read and write.' };
            if (!r.ok) return { ok: false, stage: 'repo', message: 'Repo check failed (' + r.status + ')' };
            return { ok: true, user: authResult.user };
          });
      })
      .catch(function (e) {
        return { ok: false, stage: 'network', message: 'Network error: ' + (e && e.message || e) };
      });
  }

  function ghHeaders(pat) {
    return {
      'Authorization': 'Bearer ' + pat,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SHA CACHE + SYNC TIMES
     ═══════════════════════════════════════════════════════════════════════ */
  function readJsonLS(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function writeJsonLS(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  function getCachedSha(filename) {
    var c = readJsonLS(GH_SHA_CACHE_KEY);
    return (c && typeof c[filename] === 'string') ? c[filename] : null;
  }
  function setCachedSha(filename, sha) {
    var c = readJsonLS(GH_SHA_CACHE_KEY);
    if (sha) c[filename] = sha;
    else delete c[filename];
    writeJsonLS(GH_SHA_CACHE_KEY, c);
  }
  function getSyncTime(filename) {
    var t = readJsonLS(GH_SYNC_TIMES_KEY);
    return (t && typeof t[filename] === 'number') ? t[filename] : null;
  }
  function setSyncTime(filename) {
    var t = readJsonLS(GH_SYNC_TIMES_KEY);
    t[filename] = Date.now();
    writeJsonLS(GH_SYNC_TIMES_KEY, t);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     LOW-LEVEL GITHUB CLIENT
     ═══════════════════════════════════════════════════════════════════════ */

  /* GET a JSON file from the configured repo.
     Returns Promise<{ data, sha, raw }> on success.
     Rejects with Error.code:
       'no-config'  → not configured
       'not-found'  → 404
       'auth'       → 401/403
       'parse'      → file content wasn't valid JSON
       'network'    → fetch failed
       'http'       → other HTTP error (Error.status set) */
  function ghGetJson(filename) {
    var cfg = loadGitHubConfig();
    if (!cfg || !cfg.pat) return Promise.reject(makeErr('Not configured', 'no-config'));
    var url = GH_API_BASE + '/repos/' + cfg.owner + '/' + cfg.repo +
              '/contents/' + encodeURIComponent(filename) +
              '?ref=' + encodeURIComponent(cfg.branch);
    return fetch(url, { headers: ghHeaders(cfg.pat) })
      .then(function (r) {
        if (r.status === 404) throw makeErr('File not found on remote', 'not-found');
        if (r.status === 401 || r.status === 403) throw makeErr('Token rejected (' + r.status + ')', 'auth');
        if (!r.ok) {
          var e = makeErr('GitHub returned ' + r.status, 'http');
          e.status = r.status;
          throw e;
        }
        return r.json();
      })
      .then(function (body) {
        var raw = decodeBase64Utf8((body.content || '').replace(/\n/g, ''));
        var data;
        try { data = JSON.parse(raw); }
        catch (e) { throw makeErr('Remote file is not valid JSON', 'parse'); }
        return { data: data, sha: body.sha, raw: raw };
      })
      .catch(function (e) {
        if (e && e.code) throw e;       // already tagged
        throw makeErr((e && e.message) || 'Network error', 'network');
      });
  }

  /* PUT a JSON file. Pass expectedSha=null for a new file (file doesn't exist yet).
     Returns Promise<{ sha }> on success.
     Rejects with Error.code:
       'no-config'  → not configured
       'conflict'   → 409 OR 422 (sha mismatch)
       'auth'       → 401/403
       'network'    → fetch failed
       'http'       → other */
  function ghPutJson(filename, contentObj, expectedSha, message) {
    var cfg = loadGitHubConfig();
    if (!cfg || !cfg.pat) return Promise.reject(makeErr('Not configured', 'no-config'));
    var jsonText = JSON.stringify(contentObj, null, 2);
    var body = {
      message: message || ('Update ' + filename),
      content: encodeBase64Utf8(jsonText),
      branch:  cfg.branch
    };
    if (expectedSha) body.sha = expectedSha;
    var url = GH_API_BASE + '/repos/' + cfg.owner + '/' + cfg.repo +
              '/contents/' + encodeURIComponent(filename);
    return fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(cfg.pat)),
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (r.status === 409) throw makeErr('SHA conflict', 'conflict');
        if (r.status === 422) {
          // 422 usually means SHA mismatch or "sha required" — treat as conflict
          // so the caller can refresh + retry.
          return r.json().then(function (j) {
            throw makeErr((j && j.message) || 'Validation error', 'conflict');
          }, function () {
            throw makeErr('Validation error', 'conflict');
          });
        }
        if (r.status === 401 || r.status === 403) throw makeErr('Token rejected (' + r.status + ')', 'auth');
        if (!r.ok) {
          var e = makeErr('GitHub returned ' + r.status, 'http');
          e.status = r.status;
          throw e;
        }
        return r.json();
      })
      .then(function (body) {
        return { sha: body && body.content && body.content.sha };
      })
      .catch(function (e) {
        if (e && e.code) throw e;
        throw makeErr((e && e.message) || 'Network error', 'network');
      });
  }

  function makeErr(msg, code) {
    var e = new Error(msg);
    e.code = code;
    return e;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     HIGH-LEVEL LOAD / SAVE
     ═══════════════════════════════════════════════════════════════════════ */

  /* Load JSON for a tool, with graceful fallback chain.
     Resolves to: { data, source, sha? }
       source ∈ 'github' | 'localStorage' | 'static' | 'empty'
     Never rejects — always resolves with whatever was reachable. */
  function loadJson(filename, lsKey) {
    var cfg = loadGitHubConfig();

    function fromLocalStorage() {
      try {
        var raw = lsKey ? localStorage.getItem(lsKey) : null;
        if (raw) return { data: JSON.parse(raw), source: 'localStorage' };
      } catch (e) {}
      return null;
    }

    function fromStatic() {
      // Try to fetch the file relatively from the deployed site.
      // Works on GitHub Pages (./teams.json) and locally if served, fails
      // gracefully if the page is loaded as a file:// (some browsers block).
      return fetch('./' + filename, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('static ' + r.status); return r.json(); })
        .then(function (data) { return { data: data, source: 'static' }; })
        .catch(function () { return null; });
    }

    if (cfg && cfg.pat) {
      return ghGetJson(filename)
        .then(function (result) {
          // Mirror to localStorage cache + SHA
          if (lsKey) {
            try { localStorage.setItem(lsKey, JSON.stringify(result.data)); } catch (e) {}
          }
          setCachedSha(filename, result.sha);
          setSyncTime(filename);
          return { data: result.data, source: 'github', sha: result.sha };
        })
        .catch(function (e) {
          // GitHub failed for any reason — fall back through the chain.
          // Keep the cached SHA if we have one (we'll retry next save).
          if (e && e.code === 'auth') {
            toast('GitHub token rejected — check Settings', 'warn');
          } else if (e && e.code === 'not-found') {
            // File doesn't exist on remote; first save will create it.
            setCachedSha(filename, null);
          }
          var ls = fromLocalStorage();
          if (ls) return ls;
          return fromStatic().then(function (st) { return st || { data: null, source: 'empty' }; });
        });
    }

    // No GitHub config — localStorage first, then static, then empty.
    var ls = fromLocalStorage();
    if (ls) return Promise.resolve(ls);
    return fromStatic().then(function (st) { return st || { data: null, source: 'empty' }; });
  }

  /* Save JSON for a tool. Always writes localStorage immediately (offline-safe).
     If GitHub is configured, attempts to PUT with the cached SHA.
     On conflict, opens the conflict dialog and lets the user choose.

     Args:
       filename  — repo file path, e.g. 'teams.json'
       lsKey     — localStorage key to mirror into
       content   — the data object to save (will be JSON.stringified)
       toolName  — string for the auto-generated commit message,
                   e.g. 'Card tool', 'Schedule tool', 'Roster tool'

     Resolves to:
       { action: 'saved-local-only' }   // GH not configured
       { action: 'saved' }              // saved to GH successfully
       { action: 'conflict-forced' }    // user chose to overwrite remote
       { action: 'conflict-reloaded', data }  // user chose to discard local; tool should re-render with `data`
       { action: 'cancelled' }          // user dismissed conflict dialog
       { action: 'failed', reason, error }   // network/auth/etc.
  */
  function saveJson(filename, lsKey, content, toolName) {
    // Mirror to localStorage first, synchronously, before any await.
    if (lsKey) {
      try { localStorage.setItem(lsKey, JSON.stringify(content)); } catch (e) {}
    }
    if (!isGitHubConfigured()) {
      return Promise.resolve({ action: 'saved-local-only' });
    }
    // Serialize per-filename so concurrent saveJson calls don't collide on SHA.
    var prev = saveQueues[filename] || Promise.resolve();
    var next = prev.then(
      function () { return doSaveJson(filename, content, toolName); },
      function () { return doSaveJson(filename, content, toolName); }
    );
    saveQueues[filename] = next.catch(function () {});  // keep chain alive
    return next;
  }

  function doSaveJson(filename, content, toolName) {
    var msg = autoCommitMessage(filename, toolName);
    var sha = getCachedSha(filename);
    return ghPutJson(filename, content, sha, msg)
      .then(function (result) {
        setCachedSha(filename, result.sha);
        setSyncTime(filename);
        notifyConfigPanelChanged();
        broadcastFileSaved(filename);
        return { action: 'saved' };
      })
      .catch(function (e) {
        if (!e || !e.code) {
          return { action: 'failed', reason: 'unknown', error: (e && e.message) || String(e) };
        }
        if (e.code === 'conflict') {
          return handleConflict(filename, content, toolName);
        }
        if (e.code === 'auth') {
          toast('GitHub token rejected — check Settings', 'error');
          notifyConfigPanelChanged();
          return { action: 'failed', reason: 'auth', error: e.message };
        }
        if (e.code === 'network') {
          toast('Saved locally — GitHub unreachable', 'warn');
          return { action: 'failed', reason: 'network', error: e.message };
        }
        if (e.code === 'no-config') {
          return { action: 'saved-local-only' };
        }
        return { action: 'failed', reason: e.code, error: e.message };
      });
  }

  function autoCommitMessage(filename, toolName) {
    // Format: "Update teams.json — 4/26/2026 3:42 PM (Card tool)"
    var d = new Date();
    var date = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    var hr = d.getHours();
    var ampm = hr >= 12 ? 'PM' : 'AM';
    var hr12 = hr % 12; if (hr12 === 0) hr12 = 12;
    var min = d.getMinutes(); if (min < 10) min = '0' + min;
    var time = hr12 + ':' + min + ' ' + ampm;
    var tool = toolName ? ' (' + toolName + ')' : '';
    return 'Update ' + filename + ' — ' + date + ' ' + time + tool;
  }

  /* Conflict resolution flow. Re-fetches the remote so the user sees what they're
     up against, then prompts. Returns the saveJson resolution. */
  function handleConflict(filename, localContent, toolName) {
    // Re-fetch remote first so the dialog can show what changed (and so the
    // SHA cache is fresh either way).
    return ghGetJson(filename).then(
      function (remote) {
        setCachedSha(filename, remote.sha);
        return showConflictDialog({ filename: filename, remoteData: remote.data })
          .then(function (choice) {
            if (choice === 'force') {
              // Retry with the fresh SHA — push our local content over remote.
              return ghPutJson(filename, localContent, remote.sha, autoCommitMessage(filename, toolName))
                .then(function (result) {
                  setCachedSha(filename, result.sha);
                  setSyncTime(filename);
                  notifyConfigPanelChanged();
                  broadcastFileSaved(filename);
                  return { action: 'conflict-forced' };
                })
                .catch(function (e) {
                  return { action: 'failed', reason: (e && e.code) || 'unknown', error: e && e.message };
                });
            }
            if (choice === 'reload') {
              // Tool will re-render from this data; don't touch GH.
              setSyncTime(filename);
              notifyConfigPanelChanged();
              return { action: 'conflict-reloaded', data: remote.data };
            }
            return { action: 'cancelled' };
          });
      },
      function (e) {
        // Couldn't even re-fetch; surface as a network failure.
        return { action: 'failed', reason: (e && e.code) || 'network', error: e && e.message };
      }
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CONFLICT DIALOG
     ═══════════════════════════════════════════════════════════════════════ */
  function showConflictDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'gh-modal-overlay';
      overlay.innerHTML =
        '<div class="gh-modal" role="dialog" aria-modal="true" aria-labelledby="gh-conflict-title">' +
          '<h2 id="gh-conflict-title">Sync conflict</h2>' +
          '<p><strong>' + escapeHtml(opts.filename) + '</strong> was changed on GitHub by another device since this app last synced.</p>' +
          '<p class="gh-modal-sub">Choose how to resolve it. Your local edits are still safe in this browser either way.</p>' +
          '<div class="gh-modal-actions">' +
            '<button type="button" class="gh-btn gh-btn-primary" data-choice="force">Save my version (overwrite remote)</button>' +
            '<button type="button" class="gh-btn" data-choice="reload">Discard mine, load remote</button>' +
            '<button type="button" class="gh-btn gh-btn-ghost" data-choice="cancel">Cancel</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      function close(choice) {
        document.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(choice);
      }
      function onKey(e) { if (e.key === 'Escape') close('cancel'); }
      overlay.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-choice]');
        if (btn) { close(btn.getAttribute('data-choice')); return; }
        if (e.target === overlay) close('cancel');
      });
      document.addEventListener('keydown', onKey);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CONFIG PANEL UI
     Mounted via WWCommon.renderGitHubConfigPanel(container).
     Renders a collapsible disclosure with status pill always visible.
     ═══════════════════════════════════════════════════════════════════════ */
  var mountedPanels = [];   // refs so we can update status pills on state changes

  function renderGitHubConfigPanel(container) {
    if (!container) return;
    var cfg = loadGitHubConfig() || { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, pat: '' };
    container.innerHTML =
      '<details class="gh-config-panel">' +
        '<summary class="gh-config-summary">' +
          '<span class="gh-pill" data-pill>Loading…</span>' +
          '<span class="gh-config-summary-text" data-summary-text>GitHub Sync</span>' +
          '<span class="gh-config-summary-chevron">▾</span>' +
        '</summary>' +
        '<div class="gh-config-body">' +
          '<label class="gh-field">' +
            '<span class="gh-field-label">Owner</span>' +
            '<input type="text" data-field="owner" value="' + escapeAttr(cfg.owner) + '" placeholder="rlandquist">' +
          '</label>' +
          '<label class="gh-field">' +
            '<span class="gh-field-label">Repo</span>' +
            '<input type="text" data-field="repo" value="' + escapeAttr(cfg.repo) + '" placeholder="WW-Girls-JV-Soccer">' +
          '</label>' +
          '<label class="gh-field gh-field-advanced" hidden>' +
            '<span class="gh-field-label">Branch</span>' +
            '<input type="text" data-field="branch" value="' + escapeAttr(cfg.branch) + '" placeholder="main">' +
          '</label>' +
          '<label class="gh-field">' +
            '<span class="gh-field-label">Personal Access Token</span>' +
            '<span class="gh-field-pat-wrap">' +
              '<input type="password" data-field="pat" value="' + escapeAttr(cfg.pat) + '" placeholder="github_pat_…" autocomplete="off">' +
              '<button type="button" class="gh-pat-eye" data-toggle-pat title="Show / hide">👁</button>' +
            '</span>' +
            '<span class="gh-hint">Fine-grained token, this repo only, Contents: read &amp; write. ' +
              '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create one →</a>' +
            '</span>' +
          '</label>' +
          '<div class="gh-config-actions">' +
            '<button type="button" class="gh-btn gh-btn-primary" data-action="save">Save &amp; Test</button>' +
            '<button type="button" class="gh-btn" data-action="test">Test Connection</button>' +
            '<button type="button" class="gh-btn gh-btn-ghost" data-action="advanced">Advanced…</button>' +
            '<button type="button" class="gh-btn gh-btn-danger" data-action="clear">Clear</button>' +
          '</div>' +
          '<div class="gh-config-status" data-status></div>' +
        '</div>' +
      '</details>';

    // Wire up the panel
    var details = container.querySelector('details.gh-config-panel');
    details.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-action');
      var togglePat = e.target.getAttribute && e.target.getAttribute('data-toggle-pat');
      if (togglePat !== null) {
        e.preventDefault();
        var input = details.querySelector('[data-field="pat"]');
        input.type = input.type === 'password' ? 'text' : 'password';
        return;
      }
      if (act === 'save')     { e.preventDefault(); savePanel(details); }
      if (act === 'test')     { e.preventDefault(); testPanel(details); }
      if (act === 'clear')    { e.preventDefault(); clearPanel(details); }
      if (act === 'advanced') {
        e.preventDefault();
        var adv = details.querySelector('.gh-field-advanced');
        if (adv) adv.hidden = !adv.hidden;
      }
    });

    mountedPanels.push(details);
    refreshPanel(details);
    /* First-mount-on-page hooks: start the relative-time tick, and
       check whether the saved token is approaching its likely
       expiration. Both are idempotent / once-per-session-guarded. */
    startPanelTick();
    maybeShowTokenAgeWarning();
  }

  function readPanelInputs(details) {
    function v(sel) { var el = details.querySelector(sel); return el ? el.value.trim() : ''; }
    return {
      owner:  v('[data-field="owner"]')  || DEFAULT_OWNER,
      repo:   v('[data-field="repo"]')   || DEFAULT_REPO,
      branch: v('[data-field="branch"]') || DEFAULT_BRANCH,
      pat:    v('[data-field="pat"]')
    };
  }

  function setPanelStatus(details, kind, message) {
    // kind ∈ 'ok' | 'warn' | 'error' | 'info' | ''
    var el = details.querySelector('[data-status]');
    if (!el) return;
    el.className = 'gh-config-status' + (kind ? ' gh-status-' + kind : '');
    el.textContent = message || '';
  }

  function savePanel(details) {
    var inputs = readPanelInputs(details);
    if (!inputs.pat) {
      setPanelStatus(details, 'warn', 'A token is required.');
      return;
    }
    saveGitHubConfig(inputs);
    setPanelStatus(details, 'info', 'Testing connection…');
    refreshPanel(details);
    testGitHubConnection(inputs).then(function (res) {
      if (res.ok) {
        setPanelStatus(details, 'ok', 'Connected as ' + (res.user || '?') + ' ✓');
      } else {
        setPanelStatus(details, 'error', res.message || 'Connection failed');
      }
      refreshPanel(details);
    });
  }

  function testPanel(details) {
    var inputs = readPanelInputs(details);
    setPanelStatus(details, 'info', 'Testing…');
    testGitHubConnection(inputs).then(function (res) {
      if (res.ok) setPanelStatus(details, 'ok', 'Connected as ' + (res.user || '?') + ' ✓');
      else setPanelStatus(details, 'error', res.message || 'Connection failed');
    });
  }

  function clearPanel(details) {
    if (!confirm('Clear GitHub config from this device?\nYour data in localStorage is unaffected.')) return;
    clearGitHubConfig();
    var fields = ['owner', 'repo', 'branch', 'pat'];
    var defaults = { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, pat: '' };
    fields.forEach(function (f) {
      var el = details.querySelector('[data-field="' + f + '"]');
      if (el) el.value = defaults[f];
    });
    setPanelStatus(details, '', '');
    refreshPanel(details);
  }

  function refreshPanel(details) {
    var pill    = details.querySelector('[data-pill]');
    var summary = details.querySelector('[data-summary-text]');
    var cfg     = loadGitHubConfig();
    if (pill) {
      if (cfg && cfg.pat) {
        pill.className = 'gh-pill gh-pill-ok';
        pill.textContent = '● ' + cfg.owner + '/' + cfg.repo;
      } else {
        pill.className = 'gh-pill gh-pill-off';
        pill.textContent = '● Not connected';
      }
    }
    /* Secondary line: "GitHub Sync · synced 2m ago" / "· not yet synced".
       Falls back to plain "GitHub Sync" if the panel doesn't expose a
       data-summary-text element (older mount markup). */
    if (summary) {
      var label = 'GitHub Sync';
      if (cfg && cfg.pat) {
        var ts = getMostRecentSyncTime();
        label += ' · ' + (ts ? 'synced ' + formatRelativeTime(ts) : 'not yet synced');
      }
      summary.textContent = label;
    }
  }

  /* External code can call this after a sync event so all mounted panels
     refresh their pills + relative-time displays. Also wired to a slow
     interval below so the "Nm ago" text stays roughly current without
     burning cycles. */
  function notifyConfigPanelChanged() {
    mountedPanels.forEach(function (p) { try { refreshPanel(p); } catch (e) {} });
  }

  /* Tick every 60s to roll the "Nm ago" forward without requiring a
     save event. Cheap — no network, just a localStorage read + DOM
     textContent assignment per mounted panel. Started lazily on first
     mount so pages without the panel pay nothing. */
  var panelTickStarted = false;
  function startPanelTick() {
    if (panelTickStarted) return;
    panelTickStarted = true;
    setInterval(function () {
      if (mountedPanels.length === 0) return;
      try { notifyConfigPanelChanged(); } catch (e) {}
    }, 60000);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SHARED UTILITIES
     ═══════════════════════════════════════════════════════════════════════ */

  /* Canonical game-key shape used by Card and Goals to address
     per-game data without coordinating directly. Both tools normalize
     date + opponent identically — trim whitespace, lowercase the
     opponent — so "Arrowhead" typed in one tool and "arrowhead "
     typed in another resolve to the same key. Returns null when
     either field is empty after trimming.
       buildGameKey('2026-08-22', 'Arrowhead')   -> '2026-08-22|arrowhead'
       buildGameKey('2026-08-22', '  ')          -> null
       buildGameKey('', 'Arrowhead')             -> null */
  function buildGameKey(date, opp) {
    var d = (date == null) ? '' : String(date).trim();
    var o = (opp  == null) ? '' : String(opp).trim().toLowerCase();
    if (!d || !o) return null;
    return d + '|' + o;
  }

  /* Short human-readable relative time. Intentionally low-resolution —
     "just now" / "Nm ago" / "Nh ago" / "Nd ago". Anything older than
     30 days falls back to a calendar date. */
  function formatRelativeTime(ms) {
    if (!ms || typeof ms !== 'number') return '';
    var diff = Date.now() - ms;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 30) return 'just now';
    if (s < 90) return '1m ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 30) return d + 'd ago';
    var dt = new Date(ms);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[dt.getMonth()] + ' ' + dt.getDate();
  }

  /* Find the most-recent sync timestamp across all tracked files —
     surfaces "the freshest thing we've talked to GitHub about" rather
     than guessing which file the current tool cares about. */
  function getMostRecentSyncTime() {
    try {
      var raw = localStorage.getItem(GH_SYNC_TIMES_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      var max = 0;
      Object.keys(parsed).forEach(function (k) {
        var v = parsed[k];
        if (typeof v === 'number' && v > max) max = v;
      });
      return max || null;
    } catch (e) { return null; }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function encodeBase64Utf8(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function decodeBase64Utf8(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* Toast notification — bottom-right, auto-dismisses.
     type ∈ 'info' | 'ok' | 'warn' | 'error' (default 'info') */
  var toastContainer = null;
  function toast(msg, type) {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'gh-toast-container';
      document.body.appendChild(toastContainer);
    }
    var t = document.createElement('div');
    t.className = 'gh-toast gh-toast-' + (type || 'info');
    t.textContent = msg;
    toastContainer.appendChild(t);
    // Animate in next frame
    requestAnimationFrame(function () { t.classList.add('gh-toast-shown'); });
    setTimeout(function () {
      t.classList.remove('gh-toast-shown');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, type === 'error' ? 4500 : 2800);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CARD-BUILDER HELPERS
     ─────────────────────────────────────────────────────────────────────────
     Shared by the Schedule, Roster, and Card tools — all three now render
     pattern overlays as CSS backgrounds on the card element via
     applyPatternToElement(). Card's three card modes (Score / Halftime /
     Preview) call makeSoccerPatterns() with different opts to pick the
     right accent colour family per card-body background.
     ═══════════════════════════════════════════════════════════════════════ */

  /* Build the 9-pattern array used by Schedule, Roster, and Card. The
     'streaks' and 'pulse' patterns are tinted with the tool's own colour
     family via stripeRgb / pulseRgb; the other 6 neutral patterns
     (carbon, grid, halftone, slash, diamonds, noise) use the accent
     colour at varying opacities. Returns a fresh array so callers can
     mutate without affecting other tools.

     All RGB args are comma-separated rgb strings (no rgba(), no
     parentheses) — they're interpolated into rgba(...) gradient stops at
     pattern-specific opacities. Defaults match Schedule / Roster / Card-
     Score / Card-Halftime: navy tints with white neutrals on a dark base.

     opts.light=true scales the 6 neutral-pattern opacities by 3× so they
     stay readable on a light base (used by Card's Preview mode, which
     also passes accentRgb:'42,90,200' so the neutrals flip from white to
     navy). The coloured streaks/pulse opacities are NOT touched by the
     boost — they read fine on either base at the same alpha.

       makeSoccerPatterns()                                              -> navy tints + white neutrals (dark bg)
       makeSoccerPatterns({stripeRgb:'100,140,240', pulseRgb:'120,160,255'}) -> royal-blue tints + white neutrals (dark bg)
       makeSoccerPatterns({accentRgb:'42,90,200', light:true})            -> navy tints + boosted-navy neutrals (light bg)
  */
  function makeSoccerPatterns(opts) {
    opts = opts || {};
    var stripe = opts.stripeRgb || '42,90,200';
    var pulse  = opts.pulseRgb  || '50,100,210';
    var accent = opts.accentRgb || '255,255,255';
    var boost  = opts.light ? 3.0 : 1.0;
    /* Format an opacity-boosted rgba() for the 6 neutral patterns.
       Clamps at 1.0 so a high starting alpha + light:true can't overflow. */
    function n(a) {
      var v = Math.min(1, a * boost);
      return 'rgba(' + accent + ',' + (Math.round(v * 10000) / 10000) + ')';
    }
    return [
      { id: 'streaks', label: 'Streaks',
        bg: 'linear-gradient(145deg,transparent 44%,rgba(' + stripe + ',0.28) 44%,rgba(' + stripe + ',0.28) 53%,transparent 53%),linear-gradient(145deg,transparent 58%,rgba(' + stripe + ',0.16) 58%,rgba(' + stripe + ',0.16) 64%,transparent 64%)',
        bgSize: 'auto' },
      { id: 'carbon', label: 'Carbon',
        bg: 'repeating-linear-gradient(45deg,transparent,transparent 5px,' + n(0.06) + ' 5px,' + n(0.06) + ' 6px),repeating-linear-gradient(-45deg,transparent,transparent 5px,' + n(0.06) + ' 5px,' + n(0.06) + ' 6px)',
        bgSize: 'auto' },
      { id: 'grid', label: 'Grid',
        bg: 'repeating-linear-gradient(0deg,transparent,transparent 24px,' + n(0.09) + ' 24px,' + n(0.09) + ' 25px),repeating-linear-gradient(90deg,transparent,transparent 24px,' + n(0.09) + ' 24px,' + n(0.09) + ' 25px)',
        bgSize: 'auto' },
      { id: 'halftone', label: 'Halftone',
        bg: 'radial-gradient(circle,' + n(0.18) + ' 1.5px,transparent 1.5px)',
        bgSize: '11px 11px' },
      { id: 'pulse', label: 'Pulse',
        bg: 'repeating-radial-gradient(ellipse at 110% 110%,transparent,transparent 14px,rgba(' + pulse + ',0.24) 14px,rgba(' + pulse + ',0.24) 16px)',
        bgSize: 'auto' },
      { id: 'slash', label: 'Slash',
        bg: 'repeating-linear-gradient(-60deg,transparent,transparent 10px,' + n(0.07) + ' 10px,' + n(0.07) + ' 12px)',
        bgSize: 'auto' },
      { id: 'diamonds', label: 'Diamonds',
        bg: 'repeating-linear-gradient(45deg,' + n(0.05) + ' 0,' + n(0.05) + ' 1px,transparent 0,transparent 50%),repeating-linear-gradient(135deg,' + n(0.05) + ' 0,' + n(0.05) + ' 1px,transparent 0,transparent 50%)',
        bgSize: '16px 16px' },
      { id: 'noise', label: 'Scatter',
        bg: 'radial-gradient(circle,' + n(0.12) + ' 1px,transparent 1px),radial-gradient(circle,' + n(0.07) + ' 1px,transparent 1px)',
        bgSize: '18px 18px, 9px 9px' },
      { id: 'clean', label: 'Clean', bg: 'none', bgSize: 'auto' }
    ];
  }

  /* Build a pattern picker grid. Renders a swatch button for each
     pattern with a preview + label, and wires the click handler to
     toggle .active and invoke opts.onPick(id).

     grid     — the DOM element to populate (typically #pattern-grid)
     patterns — the patterns array (from makeSoccerPatterns or a custom set)
     opts.currentId — which pattern is active at first render
     opts.onPick    — callback(patternId) when a swatch is clicked
  */
  function buildPatternPicker(grid, patterns, opts) {
    if (!grid) return;
    opts = opts || {};
    var currentId = opts.currentId;
    var onPick = opts.onPick;
    grid.innerHTML = '';
    patterns.forEach(function (p) {
      var btn = document.createElement('div');
      btn.className = 'pat-btn' + (p.id === currentId ? ' active' : '');
      btn.onclick = function () {
        grid.querySelectorAll('.pat-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        if (typeof onPick === 'function') onPick(p.id);
      };
      var prev = document.createElement('div');
      prev.className = 'pat-preview';
      prev.style.backgroundImage = (p.bg === 'none') ? 'none' : p.bg;
      prev.style.backgroundSize = p.bgSize;
      btn.appendChild(prev);
      var nm = document.createElement('div');
      nm.className = 'pat-name';
      nm.textContent = p.label;
      btn.appendChild(nm);
      grid.appendChild(btn);
    });
  }

  /* Apply a pattern to a card element by setting its CSS backgrounds.
     Used by Schedule and Roster (Card uses canvas drawing instead).
     baseColor is optional — when set, it's applied as backgroundColor
     so the pattern's translucent overlays read against the right base. */
  function applyPatternToElement(el, patterns, patternId, baseColor) {
    if (!el || !patterns) return;
    var p = null;
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].id === patternId) { p = patterns[i]; break; }
    }
    if (!p) return;
    el.style.backgroundImage = (p.bg === 'none') ? 'none' : p.bg;
    el.style.backgroundSize = p.bgSize;
    if (baseColor) el.style.backgroundColor = baseColor;
  }

  /* Render a DOM node to a PNG via html2canvas and trigger a download.
     Assumes html2canvas is loaded globally (caller's responsibility —
     the tools that need this include the CDN <script>).

     node       — the element to capture (typically card-wrapper)
     opts.filenamePrefix — e.g. 'ww_card', 'ww_schedule', 'ww_roster'
     opts.slug          — extra slug appended after the prefix (e.g. season year);
                          gets sanitised to [a-z0-9_] and lowercased.
     opts.button        — optional button element to disable + relabel during capture
     opts.busyLabel     — text shown on the button during capture (default 'Rendering...')
     opts.idleLabel     — text restored on the button after capture (default = its current text)
     opts.toastFn       — callback for showing toasts (defaults to WWCommon.toast)
     Returns a Promise that resolves with the filename or rejects with the error. */
  function downloadElementAsPng(node, opts) {
    opts = opts || {};
    if (typeof html2canvas !== 'function') {
      return Promise.reject(new Error('html2canvas not loaded'));
    }
    var prefix = opts.filenamePrefix || 'ww';
    var slug = (opts.slug || '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    var btn = opts.button || null;
    var idleLabel = opts.idleLabel || (btn ? btn.textContent : null);
    var busyLabel = opts.busyLabel || 'Rendering...';
    var toastFn = opts.toastFn || toast;

    if (btn) {
      btn.disabled = true;
      btn.textContent = busyLabel;
    }
    document.body.classList.add('exporting');

    return new Promise(function (resolve, reject) {
      html2canvas(node, { scale: 3, backgroundColor: null, useCORS: true, logging: false })
        .then(function (canvas) {
          document.body.classList.remove('exporting');
          var fname = prefix + (slug ? '_' + slug : '') + '_' + Date.now() + '.png';
          canvas.toBlob(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = fname;
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 100);
            if (btn && idleLabel != null) {
              btn.disabled = false;
              btn.textContent = idleLabel;
            }
            if (toastFn) toastFn('Saved ' + fname);
            resolve(fname);
          });
        })
        .catch(function (err) {
          document.body.classList.remove('exporting');
          if (btn && idleLabel != null) {
            btn.disabled = false;
            btn.textContent = idleLabel;
          }
          if (toastFn) toastFn('Download failed: ' + (err && err.message || err), 'error');
          reject(err);
        });
    });
  }

  /* Same as downloadElementAsPng but writes the PNG to the system clipboard
     instead of downloading. Falls back to a warn toast if the browser doesn't
     expose ClipboardItem (Safari < 13.4, older Firefox). Returns a Promise. */
  function copyElementAsPngToClipboard(node, opts) {
    opts = opts || {};
    if (typeof html2canvas !== 'function') {
      return Promise.reject(new Error('html2canvas not loaded'));
    }
    var btn = opts.button || null;
    var idleLabel = opts.idleLabel || (btn ? btn.textContent : null);
    var busyLabel = opts.busyLabel || 'Rendering...';
    var doneLabel = opts.doneLabel || '✓ Copied!';
    var toastFn = opts.toastFn || toast;

    if (btn) {
      btn.disabled = true;
      btn.textContent = busyLabel;
    }
    document.body.classList.add('exporting');

    return new Promise(function (resolve, reject) {
      html2canvas(node, { scale: 3, backgroundColor: null, useCORS: true, logging: false })
        .then(function (canvas) {
          document.body.classList.remove('exporting');
          canvas.toBlob(function (blob) {
            if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
              if (btn && idleLabel != null) {
                btn.disabled = false;
                btn.textContent = idleLabel;
              }
              if (toastFn) toastFn('Clipboard API not supported', 'warn');
              reject(new Error('clipboard-unsupported'));
              return;
            }
            var item = new ClipboardItem({ 'image/png': blob });
            navigator.clipboard.write([item])
              .then(function () {
                if (btn) {
                  btn.classList.add('done');
                  btn.textContent = doneLabel;
                  setTimeout(function () {
                    btn.classList.remove('done');
                    if (idleLabel != null) btn.textContent = idleLabel;
                    btn.disabled = false;
                  }, 1800);
                }
                resolve();
              })
              .catch(function (err) {
                if (btn && idleLabel != null) {
                  btn.disabled = false;
                  btn.textContent = idleLabel;
                }
                if (toastFn) toastFn('Copy failed: ' + (err && err.message || err), 'error');
                reject(err);
              });
          });
        })
        .catch(function (err) {
          document.body.classList.remove('exporting');
          if (btn && idleLabel != null) {
            btn.disabled = false;
            btn.textContent = idleLabel;
          }
          if (toastFn) toastFn('Render failed: ' + (err && err.message || err), 'error');
          reject(err);
        });
    });
  }

  /* Wire the mobile editor-collapse toggle. Each tool's HTML has a
     <button class="editor-toggle"> that hides/shows the editor panel
     via the .collapsed class on the panel. Centralised here so all
     three card-builder tools share one implementation.

     btnSelector / panelSelector — CSS selectors or DOM elements.
     The button is expected to contain a .chev arrow and an
     .editor-toggle-text label, which this helper updates. */
  function setupMobileEditorToggle(btnSelector, panelSelector) {
    var btn   = (typeof btnSelector   === 'string') ? document.querySelector(btnSelector)   : btnSelector;
    var panel = (typeof panelSelector === 'string') ? document.querySelector(panelSelector) : panelSelector;
    if (!btn || !panel) return;
    btn.addEventListener('click', function () {
      var collapsed = panel.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      var txt = btn.querySelector('.editor-toggle-text');
      if (txt) txt.textContent = collapsed ? 'Show editor' : 'Hide editor';
      var chev = btn.querySelector('.chev');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    });
  }

  /* Register the app's service worker. Called from each tool's init.
     Failures are intentionally silent — offline support just doesn't
     activate, but the page still works. */
  function registerServiceWorker(path) {
    if (!('serviceWorker' in navigator)) return;
    var p = path || './sw.js';
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(p).catch(function () { /* silent */ });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     STYLES (injected once on first script load)
     ═══════════════════════════════════════════════════════════════════════ */
  function injectStyles() {
    if (document.getElementById('gh-common-styles')) return;
    var s = document.createElement('style');
    s.id = 'gh-common-styles';
    s.textContent = [
      // Config panel
      '.gh-config-panel { background:#fff; border:1px solid #e0e4ec; border-radius:8px; margin:8px 0 12px; overflow:hidden; font-family:Arial, sans-serif; }',
      '.gh-config-summary { list-style:none; cursor:pointer; padding:10px 14px; display:flex; align-items:center; gap:10px; user-select:none; }',
      '.gh-config-summary::-webkit-details-marker { display:none; }',
      '.gh-config-summary-text { font-size:13px; font-weight:700; color:#1a1a1a; flex:1; }',
      '.gh-config-summary-chevron { color:#888; transition:transform .15s; }',
      '.gh-config-panel[open] .gh-config-summary-chevron { transform:rotate(180deg); }',
      '.gh-pill { font-size:11px; font-weight:700; padding:3px 9px; border-radius:11px; letter-spacing:.02em; white-space:nowrap; max-width:60%; overflow:hidden; text-overflow:ellipsis; }',
      '.gh-pill-ok  { background:#e7f5e7; color:#2d6a2d; }',
      '.gh-pill-off { background:#fdf2e2; color:#8a5a1a; }',
      '.gh-config-body { padding:6px 14px 14px; border-top:1px solid #f0f2f5; display:flex; flex-direction:column; gap:10px; }',
      '.gh-field { display:flex; flex-direction:column; gap:3px; }',
      '.gh-field-label { font-size:11px; font-weight:700; color:#5a6480; text-transform:uppercase; letter-spacing:.05em; }',
      '.gh-field input[type="text"], .gh-field input[type="password"] { width:100%; padding:7px 9px; border:1px solid #d6dbe6; border-radius:5px; font-size:13px; font-family:inherit; background:#fff; box-sizing:border-box; }',
      '.gh-field input:focus { outline:none; border-color:#1a3a8f; box-shadow:0 0 0 2px rgba(26,58,143,0.15); }',
      '.gh-field-pat-wrap { position:relative; display:block; }',
      '.gh-field-pat-wrap input { padding-right:34px; }',
      '.gh-pat-eye { position:absolute; right:4px; top:50%; transform:translateY(-50%); background:none; border:none; cursor:pointer; padding:4px 7px; font-size:14px; opacity:.55; }',
      '.gh-pat-eye:hover { opacity:1; }',
      '.gh-hint { font-size:11px; color:#6b7a99; line-height:1.4; }',
      '.gh-hint a { color:#1a3a8f; text-decoration:none; }',
      '.gh-hint a:hover { text-decoration:underline; }',
      '.gh-config-actions { display:flex; flex-wrap:wrap; gap:6px; }',
      '.gh-config-status { font-size:12px; padding:6px 8px; border-radius:5px; min-height:14px; }',
      '.gh-config-status.gh-status-ok    { background:#e7f5e7; color:#2d6a2d; }',
      '.gh-config-status.gh-status-warn  { background:#fdf2e2; color:#8a5a1a; }',
      '.gh-config-status.gh-status-error { background:#fbeaea; color:#8a2929; }',
      '.gh-config-status.gh-status-info  { background:#eaf2fb; color:#1a3a8f; }',
      // Buttons (panel + modal share)
      '.gh-btn { font-family:inherit; font-size:12px; font-weight:700; padding:7px 12px; border-radius:5px; border:1px solid #d6dbe6; background:#fff; color:#1a1a1a; cursor:pointer; }',
      '.gh-btn:hover { background:#f5f7fa; }',
      '.gh-btn-primary { background:#1a3a8f; color:#fff; border-color:#1a3a8f; }',
      '.gh-btn-primary:hover { background:#142e74; }',
      '.gh-btn-danger { color:#8a2929; border-color:#e0c4c4; }',
      '.gh-btn-danger:hover { background:#fbeaea; }',
      '.gh-btn-ghost { background:transparent; border-color:transparent; color:#666; }',
      '.gh-btn-ghost:hover { background:#f0f2f5; color:#1a1a1a; }',
      // Modal
      '.gh-modal-overlay { position:fixed; inset:0; background:rgba(13,31,66,0.55); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px; font-family:Arial, sans-serif; }',
      '.gh-modal { background:#fff; border-radius:10px; max-width:440px; width:100%; padding:22px 24px; box-shadow:0 12px 40px rgba(0,0,0,0.3); }',
      '.gh-modal h2 { font-size:17px; font-weight:900; margin:0 0 10px; color:#1a1a1a; }',
      '.gh-modal p { font-size:13px; line-height:1.5; color:#1a1a1a; margin:0 0 8px; }',
      '.gh-modal-sub { color:#666 !important; font-size:12px !important; }',
      '.gh-modal-actions { display:flex; flex-direction:column; gap:7px; margin-top:14px; }',
      '.gh-modal-actions .gh-btn { width:100%; padding:10px; font-size:13px; }',
      // Toast
      '.gh-toast-container { position:fixed; bottom:20px; right:20px; display:flex; flex-direction:column; gap:8px; z-index:10000; pointer-events:none; }',
      '.gh-toast { background:#1a1a1a; color:#fff; font-family:Arial, sans-serif; font-size:13px; padding:10px 14px; border-radius:6px; box-shadow:0 4px 14px rgba(0,0,0,0.25); transform:translateY(8px); opacity:0; transition:opacity .2s, transform .2s; max-width:340px; }',
      '.gh-toast-shown { opacity:1; transform:translateY(0); }',
      '.gh-toast-ok    { background:#2d6a2d; }',
      '.gh-toast-warn  { background:#8a5a1a; }',
      '.gh-toast-error { background:#8a2929; }',
      // Mobile tweaks
      '@media (max-width: 600px) {',
      '  .gh-config-summary { padding:9px 12px; }',
      '  .gh-config-summary-text { font-size:12px; }',
      '  .gh-pill { font-size:10px; }',
      '  .gh-config-body { padding:6px 12px 12px; }',
      '  .gh-modal { padding:18px 18px; }',
      '  .gh-toast-container { bottom:12px; right:12px; left:12px; }',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════════════════════ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectStyles);
  } else {
    injectStyles();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════════════ */
  global.WWCommon = {
    // Config
    loadGitHubConfig:        loadGitHubConfig,
    saveGitHubConfig:        saveGitHubConfig,
    clearGitHubConfig:       clearGitHubConfig,
    isGitHubConfigured:      isGitHubConfigured,
    testGitHubConnection:    testGitHubConnection,
    getTokenAgeDays:         getTokenAgeDays,
    // Low-level GH client
    ghGetJson:               ghGetJson,
    ghPutJson:               ghPutJson,
    // High-level load / save
    loadJson:                loadJson,
    saveJson:                saveJson,
    // SHA cache + sync times
    getCachedSha:            getCachedSha,
    setCachedSha:            setCachedSha,
    getSyncTime:             getSyncTime,
    getMostRecentSyncTime:   getMostRecentSyncTime,
    formatRelativeTime:      formatRelativeTime,
    // Cross-tab sync
    onFileSaved:             onFileSaved,
    // Game key (shared with Card / Goals)
    buildGameKey:            buildGameKey,
    // UI
    renderGitHubConfigPanel: renderGitHubConfigPanel,
    showConflictDialog:      showConflictDialog,
    // Utilities
    toast:                   toast,
    escapeHtml:              escapeHtml,
    escapeAttr:              escapeAttr,
    encodeBase64Utf8:        encodeBase64Utf8,
    decodeBase64Utf8:        decodeBase64Utf8,
    // Card-builder helpers (Schedule + Roster patterns; all three for download)
    makeSoccerPatterns:          makeSoccerPatterns,
    buildPatternPicker:          buildPatternPicker,
    applyPatternToElement:       applyPatternToElement,
    downloadElementAsPng:        downloadElementAsPng,
    copyElementAsPngToClipboard: copyElementAsPngToClipboard,
    setupMobileEditorToggle:     setupMobileEditorToggle,
    registerServiceWorker:       registerServiceWorker,
    // Constants (for tools that want to display them)
    DEFAULT_OWNER:           DEFAULT_OWNER,
    DEFAULT_REPO:            DEFAULT_REPO,
    DEFAULT_BRANCH:          DEFAULT_BRANCH
  };
})(window);
