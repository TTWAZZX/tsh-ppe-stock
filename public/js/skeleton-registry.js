/**
 * Skeleton Registry — HTML templates for each loading state
 *
 * แทนที่ inline skeleton ใน index.html ด้วย centralized factory
 * เพิ่ม skeleton ใหม่ได้โดยไม่ต้องแก้ไขหลายจุด
 */

const SkeletonRegistry = (() => {

  // ─── Skeleton Templates ──────────────────────────────────────────────────

  const TEMPLATES = {
    /**
     * Dashboard page skeleton
     * แทนที่ #dashboardSkeleton ใน index.html
     */
    dashboard: `
      <div class="animate-pulse space-y-4 p-4">
        <!-- Stats row -->
        <div class="grid grid-cols-2 gap-3">
          <div class="h-24 bg-gray-200 rounded-xl"></div>
          <div class="h-24 bg-gray-200 rounded-xl"></div>
          <div class="h-24 bg-gray-200 rounded-xl"></div>
          <div class="h-24 bg-gray-200 rounded-xl"></div>
        </div>
        <!-- Chart area -->
        <div class="h-48 bg-gray-200 rounded-xl"></div>
        <!-- List rows -->
        <div class="space-y-2">
          <div class="h-12 bg-gray-200 rounded-lg"></div>
          <div class="h-12 bg-gray-200 rounded-lg w-4/5"></div>
          <div class="h-12 bg-gray-200 rounded-lg w-3/5"></div>
        </div>
      </div>`,

    /**
     * Feedback list skeleton
     * แทนที่ spinner ใน #feedbackList
     */
    feedback: `
      <div class="animate-pulse space-y-3 p-4">
        ${Array(4).fill(`
          <div class="bg-white rounded-xl p-4 space-y-2">
            <div class="flex items-center gap-3">
              <div class="h-8 w-8 bg-gray-200 rounded-full"></div>
              <div class="h-4 bg-gray-200 rounded w-32"></div>
            </div>
            <div class="h-3 bg-gray-200 rounded w-full"></div>
            <div class="h-3 bg-gray-200 rounded w-4/5"></div>
          </div>`).join('')}
      </div>`,

    /**
     * Matrix grid skeleton
     */
    matrix: `
      <div class="animate-pulse p-4">
        <div class="h-8 bg-gray-200 rounded w-48 mb-4"></div>
        <div class="space-y-2">
          ${Array(6).fill(`
            <div class="h-10 bg-gray-200 rounded-lg"></div>`).join('')}
        </div>
      </div>`,

    /**
     * Item list skeleton (PPE items page)
     */
    itemList: `
      <div class="animate-pulse space-y-3 p-4">
        ${Array(5).fill(`
          <div class="bg-white rounded-xl p-4 flex items-center gap-4">
            <div class="h-12 w-12 bg-gray-200 rounded-lg flex-shrink-0"></div>
            <div class="flex-1 space-y-2">
              <div class="h-4 bg-gray-200 rounded w-3/4"></div>
              <div class="h-3 bg-gray-200 rounded w-1/2"></div>
            </div>
            <div class="h-8 w-16 bg-gray-200 rounded-lg"></div>
          </div>`).join('')}
      </div>`,

    /**
     * Voucher list skeleton
     */
    voucherList: `
      <div class="animate-pulse space-y-3 p-4">
        ${Array(4).fill(`
          <div class="bg-white rounded-xl p-4 space-y-3">
            <div class="flex justify-between">
              <div class="h-4 bg-gray-200 rounded w-24"></div>
              <div class="h-6 bg-gray-200 rounded-full w-16"></div>
            </div>
            <div class="h-3 bg-gray-200 rounded w-full"></div>
            <div class="h-3 bg-gray-200 rounded w-3/5"></div>
          </div>`).join('')}
      </div>`,
  };

  // ─── Mount / Unmount Helpers ─────────────────────────────────────────────

  /**
   * Mount a skeleton into a container element.
   * Hides existing content, injects skeleton HTML.
   *
   * @param {string} templateName - Key in TEMPLATES
   * @param {string} containerId  - DOM element ID to inject into
   * @param {string} [contentId]  - Optional: ID of content to hide
   */
  function mount(templateName, containerId, contentId = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Hide real content
    if (contentId) {
      const content = document.getElementById(contentId);
      if (content) content.classList.add('hidden');
    }

    // Inject skeleton
    const skeletonEl = document.createElement('div');
    skeletonEl.id            = `skeleton_${containerId}`;
    skeletonEl.dataset.skeleton = templateName;
    skeletonEl.innerHTML     = TEMPLATES[templateName] ?? '';

    // Remove existing skeleton if any
    unmount(containerId);
    container.prepend(skeletonEl);
  }

  /**
   * Remove skeleton and restore content visibility.
   *
   * @param {string} containerId
   * @param {string} [contentId]
   */
  function unmount(containerId, contentId = null) {
    const existing = document.getElementById(`skeleton_${containerId}`);
    if (existing) existing.remove();

    if (contentId) {
      const content = document.getElementById(contentId);
      if (content) content.classList.remove('hidden');
    }
  }

  /**
   * Get HTML string for a template (for pre-rendering).
   * @param {string} templateName
   */
  function getTemplate(templateName) {
    return TEMPLATES[templateName] ?? '';
  }

  return { mount, unmount, getTemplate, TEMPLATES };
})();

window.SkeletonRegistry = SkeletonRegistry;
