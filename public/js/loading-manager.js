/**
 * Enterprise Loading Manager
 * Central controller for all loading states in the app.
 *
 * Solves:
 * - Race conditions from single _apiCallInProgress lock
 * - Skeleton flicker (minimum display time)
 * - Duplicate/concurrent loading states
 * - Memory leaks from abandoned requests
 * - Uncoordinated show/hide calls
 */

const LoadingManager = (() => {
  // ─── Constants ───────────────────────────────────────────────────────────
  const MIN_DISPLAY_MS = 300; // Prevent flicker for fast responses

  // ─── Internal State ───────────────────────────────────────────────────────
  /** @type {Map<string, { count: number, startTime: number }>} */
  const _states = new Map();

  /** @type {Map<string, Promise>} - Deduplicate identical in-flight requests */
  const _inflight = new Map();

  /** @type {Map<string, AbortController>} - Per-key abort controllers */
  const _controllers = new Map();

  /** @type {Map<string, Set<Function>>} - Subscribers for each key */
  const _subscribers = new Map();

  // ─── Skeleton DOM Registry ────────────────────────────────────────────────
  /**
   * Maps loading keys to DOM behaviour.
   *
   * Types:
   *   'skeleton' – show a pre-existing #skeletonId, hide content element(s)
   *   'widget'   – dynamically inject a SkeletonRegistry template into a container
   *   'splash'   – control the splash screen element
   *   (none)     – action keys → use global overlay
   *
   * Key format: "scope.action"
   *   - "page.dashboard"   → page-level skeleton
   *   - "widget.feedback"  → component-level injected skeleton
   *   - "action.voucher"   → overlay (mutating operations)
   */
  const SKELETON_REGISTRY = {
    // Fix #1: contentIds is an ARRAY to handle multiple panels
    // noRestoreContent: true → hide panels on show, but DON'T restore on hide
    //   (updateUI() manages panel visibility based on isAdmin — if we restore here, non-admin
    //    would see adminDashboardPanel flash visible before updateUI() hides it again)
    'page.dashboard': {
      type:             'skeleton',
      skeletonId:       'dashboardSkeleton',
      contentIds:       ['adminDashboardPanel', 'userDashboardPanel'],
      noRestoreContent: true,
    },
    'page.splash': {
      type:       'splash',
      skeletonId: 'splashScreen',
    },
    // Fix #2/#3: widget type uses SkeletonRegistry.mount() — no pre-existing element needed
    'widget.feedback': {
      type:         'widget',
      templateName: 'feedback',
      containerId:  'feedbackList',
    },
    'widget.matrix': {
      type:         'widget',
      templateName: 'matrix',
      containerId:  'matrixContentGrid',
    },
    // 'action.*' keys → use global overlay (no entry needed here)
  };

  // ─── Private Helpers ─────────────────────────────────────────────────────

  function _getOrCreate(key) {
    if (!_states.has(key)) {
      _states.set(key, { count: 0, startTime: 0 });
    }
    return _states.get(key);
  }

  function _notify(key, isLoading) {
    const subs = _subscribers.get(key);
    if (subs) subs.forEach(fn => fn(isLoading));

    // Wildcard subscribers receive all events
    const wildcardSubs = _subscribers.get('*');
    if (wildcardSubs) wildcardSubs.forEach(fn => fn(key, isLoading));
  }

  function _showDOM(key, message) {
    const reg = SKELETON_REGISTRY[key];

    if (!reg) {
      // All 'action.*' keys → global overlay
      if (key.startsWith('action.')) _showOverlay(message);
      return;
    }

    if (reg.type === 'splash') {
      const el = document.getElementById(reg.skeletonId);
      if (el) el.classList.remove('hidden');

    } else if (reg.type === 'skeleton') {
      // Fix #8: hide ALL content panels (contentIds array)
      (reg.contentIds || []).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      // Also handle legacy single contentId
      if (reg.contentId) {
        const el = document.getElementById(reg.contentId);
        if (el) el.classList.add('hidden');
      }
      const skeleton = document.getElementById(reg.skeletonId);
      if (skeleton) skeleton.classList.remove('hidden');

    } else if (reg.type === 'widget') {
      // Fix #2/#3: inject skeleton dynamically — no pre-existing element needed
      if (window.SkeletonRegistry) {
        SkeletonRegistry.mount(reg.templateName, reg.containerId);
      }
    }
  }

  function _hideDOM(key) {
    const reg = SKELETON_REGISTRY[key];

    if (!reg) {
      if (key.startsWith('action.')) _hideOverlay();
      return;
    }

    if (reg.type === 'splash') {
      const el = document.getElementById(reg.skeletonId);
      if (el) el.classList.add('hidden');

    } else if (reg.type === 'skeleton') {
      const skeleton = document.getElementById(reg.skeletonId);
      if (skeleton) skeleton.classList.add('hidden');
      // Only restore content panels when noRestoreContent is NOT set.
      // Some panels (e.g. dashboard) are managed by updateUI() — restoring here
      // would cause a flash where the wrong role panel becomes briefly visible.
      if (!reg.noRestoreContent) {
        (reg.contentIds || []).forEach(id => {
          const el = document.getElementById(id);
          if (el) el.classList.remove('hidden');
        });
        if (reg.contentId) {
          const el = document.getElementById(reg.contentId);
          if (el) el.classList.remove('hidden');
        }
      }

    } else if (reg.type === 'widget') {
      // Fix #2/#3: remove injected skeleton
      if (window.SkeletonRegistry) {
        SkeletonRegistry.unmount(reg.containerId);
      }
    }
  }

  // Fix #4/#5: update overlay message properly
  function _showOverlay(message = 'กำลังดำเนินการ...') {
    const overlay  = document.getElementById('loadingOverlay');
    const titleEl  = overlay ? overlay.querySelector('#overlayTitle')  : null;
    const subtextEl= overlay ? overlay.querySelector('#overlaySubtext'): null;

    if (!overlay) return;
    overlay.classList.remove('hidden');

    // Update message text if element exists (added in HTML fix)
    if (titleEl)   titleEl.textContent   = message;
    if (subtextEl) subtextEl.textContent = 'กรุณารอสักครู่…';
  }

  function _hideOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Start loading for a key.
   * Supports concurrent starts — only triggers DOM on first call.
   * @param {string} key
   * @param {object} [options]
   * @param {string} [options.message] - Overlay message text
   * @returns {AbortController}
   */
  function start(key, options = {}) {
    const state = _getOrCreate(key);
    state.count++;

    if (state.count === 1) {
      state.startTime = performance.now();
      _showDOM(key, options.message);
      _notify(key, true);
    }

    if (!_controllers.has(key)) {
      _controllers.set(key, new AbortController());
    }

    return _controllers.get(key);
  }

  /**
   * Stop loading for a key.
   * Respects MIN_DISPLAY_MS to prevent flicker.
   * @param {string} key
   */
  function stop(key) {
    const state = _states.get(key);
    if (!state || state.count === 0) return;

    state.count--;

    if (state.count === 0) {
      const elapsed   = performance.now() - state.startTime;
      const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);

      setTimeout(() => {
        // Re-check: another start() may have happened during the timeout
        if ((_states.get(key)?.count ?? 0) === 0) {
          _hideDOM(key);
          _notify(key, false);
          _controllers.delete(key);
        }
      }, remaining);
    }
  }

  /**
   * Cancel and stop a loading key immediately (no MIN_DISPLAY_MS delay).
   * Aborts the in-flight fetch request.
   * @param {string} key
   */
  function cancel(key) {
    const controller = _controllers.get(key);
    if (controller) {
      controller.abort();
      _controllers.delete(key);
    }

    const state = _states.get(key);
    if (state) {
      state.count = 0;
      _hideDOM(key);
      _notify(key, false);
    }

    _inflight.delete(key);
  }

  /**
   * Cancel all active loading keys (use on page unload / hard navigation).
   */
  function cancelAll() {
    for (const key of [..._states.keys()]) {
      cancel(key);
    }
  }

  /**
   * Subscribe to loading state changes for a key.
   * @param {string} key - Use '*' for all events
   * @param {Function} callback
   * @returns {Function} unsubscribe
   */
  function subscribe(key, callback) {
    if (!_subscribers.has(key)) _subscribers.set(key, new Set());
    _subscribers.get(key).add(callback);
    return () => _subscribers.get(key)?.delete(callback);
  }

  /**
   * Check if a key is currently loading.
   * @param {string} key
   */
  function isLoading(key) {
    return (_states.get(key)?.count ?? 0) > 0;
  }

  /**
   * Deduplicate: if same key is already in-flight, return existing Promise.
   * @param {string} key
   * @param {Function} asyncFn
   * @returns {Promise}
   */
  function deduplicateRequest(key, asyncFn) {
    if (_inflight.has(key)) {
      return _inflight.get(key);
    }

    const promise = asyncFn().finally(() => {
      _inflight.delete(key);
    });

    _inflight.set(key, promise);
    return promise;
  }

  /**
   * Wrap an async function with automatic loading state management.
   *
   * @param {string} key
   * @param {Function} asyncFn - async (signal) => result
   * @param {object} [options]
   * @param {boolean} [options.deduplicate]
   * @param {string}  [options.message]
   * @returns {Promise}
   *
   * @example
   * const data = await LoadingManager.wrap('page.dashboard', (signal) =>
   *   fetch('/api/ppe', { signal })
   * );
   */
  async function wrap(key, asyncFn, options = {}) {
    // Deduplicate: piggyback on existing in-flight request
    if (options.deduplicate && _inflight.has(key)) {
      return _inflight.get(key);
    }

    const controller = start(key, options);

    const run = async () => {
      try {
        return await asyncFn(controller.signal);
      } finally {
        stop(key);
      }
    };

    if (options.deduplicate) {
      return deduplicateRequest(key, run);
    }
    return run();
  }

  /**
   * Update splash screen status text and progress bar.
   * @param {string} text
   * @param {number} progress - 0 to 100
   */
  function updateSplash(text, progress) {
    const statusEl   = document.getElementById('splashStatus');
    const progressEl = document.getElementById('splashProgress');
    if (statusEl)   statusEl.textContent    = text;
    if (progressEl) progressEl.style.width  = `${progress}%`;
  }

  return {
    start,
    stop,
    cancel,
    cancelAll,
    subscribe,
    isLoading,
    wrap,
    updateSplash,
    deduplicateRequest,
  };
})();

window.LoadingManager = LoadingManager;
