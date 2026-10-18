'use strict';

let lastDialogTrigger = null;
let accessibilityIdCounter = 0;
const accessibleDialogState = new WeakMap();
const activeDialogStack = [];

function rememberDialogTrigger() {
        lastDialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }

    function restoreDialogTrigger() {
        const target = lastDialogTrigger;
        lastDialogTrigger = null;
        if (target?.isConnected) setTimeout(() => target.focus(), 0);
    }

    function nextAccessibilityId(prefix = 'a11y') {
        accessibilityIdCounter += 1;
        return `${prefix}-${accessibilityIdCounter}`;
    }

    function isVisibleInteractiveElement(element) {
        if (!(element instanceof HTMLElement) || element.hidden || element.closest('[hidden], .hidden')) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    function getDialogFocusableElements(modal) {
        return [...modal.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true' && isVisibleInteractiveElement(element));
    }

    function configureAccessibleDialog(modal) {
        if (!(modal instanceof HTMLElement)) return;
        modal.classList.add('ui-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        const title = modal.querySelector('h1, h2, h3, h4, [data-dialog-title]');
        if (title) {
            if (!title.id) title.id = nextAccessibilityId('dialog-title');
            modal.setAttribute('aria-labelledby', title.id);
            modal.removeAttribute('aria-label');
        } else if (!modal.hasAttribute('aria-label')) {
            modal.setAttribute('aria-label', 'หน้าต่างโต้ตอบ');
        }
        const description = modal.querySelector('[data-dialog-description], #confirmationMessage, p[id]');
        if (description) {
            if (!description.id) description.id = nextAccessibilityId('dialog-description');
            modal.setAttribute('aria-describedby', description.id);
        }
        const panel = getSharedModalPanel(modal);
        if (panel) {
            panel.classList.add('ui-modal-panel');
            if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        }
        syncAccessibleDialogState(modal);
    }

    function syncAccessibleDialogState(modal) {
        if (!(modal instanceof HTMLElement)) return;
        const isOpen = !modal.classList.contains('hidden');
        const state = accessibleDialogState.get(modal) || { isOpen: false, trigger: null };
        modal.setAttribute('aria-hidden', String(!isOpen));
        if (isOpen && !state.isOpen) {
            state.trigger = lastDialogTrigger || (document.activeElement instanceof HTMLElement && !modal.contains(document.activeElement)
                ? document.activeElement
                : null);
            activeDialogStack.push(modal);
            requestAnimationFrame(() => {
                if (modal.classList.contains('hidden') || modal.contains(document.activeElement)) return;
                const preferred = modal.querySelector('[autofocus], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]');
                (preferred || getSharedModalPanel(modal))?.focus({ preventScroll: true });
            });
        } else if (!isOpen && state.isOpen) {
            const stackIndex = activeDialogStack.lastIndexOf(modal);
            if (stackIndex >= 0) activeDialogStack.splice(stackIndex, 1);
            const trigger = state.trigger;
            state.trigger = null;
            if (!activeDialogStack.length && trigger?.isConnected) setTimeout(() => trigger.focus({ preventScroll: true }), 0);
        }
        state.isOpen = isOpen;
        accessibleDialogState.set(modal, state);
    }

    function closeAccessibleDialog(modal) {
        if (!modal || modal.querySelector('[aria-busy="true"]')) return false;
        const handlers = {
            loginModal: () => hideLoginModal(),
            voucherModal: () => hideVoucherModal(),
            approvalModal: () => hideApprovalModal(),
            confirmationModal: () => modal._cancelAction?.(),
            categoryManagementModal: () => hideCategoryModal(),
            itemSelectorModal: () => closeItemSelector(),
            timelineDetailModal: () => { modal.classList.add('hidden'); modal.classList.remove('flex'); },
            slipModal: () => closeSlip(),
            imagePreviewModal: () => closeImagePreview(),
            feedbackModal: () => closeFeedbackModal(),
            rateItemSelectorModal: () => closeRateSelector(),
            matrixRuleModal: () => closeMatrixModal(),
            matrixDetailModal: () => closeMatrixDetail(),
            uploadDocModal: () => closeUploadModal(),
            pdfViewerModal: () => closePdfViewer(),
        };
        if (modal.id === 'pdpaModal' || !handlers[modal.id]) return false;
        handlers[modal.id]();
        return true;
    }

    function getFieldValidationMessage(field) {
        const label = field.labels?.[0]?.textContent?.replace('*', '').replace(':', '').trim();
        const fieldName = label || field.getAttribute('aria-label') || field.placeholder || 'ข้อมูลนี้';
        if (field.validity.valueMissing) return `กรุณากรอกหรือเลือก ${fieldName}`;
        if (field.validity.typeMismatch) return `รูปแบบ ${fieldName} ไม่ถูกต้อง`;
        if (field.validity.patternMismatch) return `รูปแบบ ${fieldName} ไม่ตรงตามที่กำหนด`;
        if (field.validity.rangeUnderflow) return `${fieldName} ต้องไม่น้อยกว่า ${field.min}`;
        if (field.validity.rangeOverflow) return `${fieldName} ต้องไม่เกิน ${field.max}`;
        if (field.validity.stepMismatch) return `กรุณาระบุ ${fieldName} ตามช่วงที่กำหนด`;
        if (field.validity.tooShort) return `${fieldName} ต้องมีอย่างน้อย ${field.minLength} ตัวอักษร`;
        if (field.validity.tooLong) return `${fieldName} ต้องไม่เกิน ${field.maxLength} ตัวอักษร`;
        return `กรุณาตรวจสอบ ${fieldName}`;
    }

    function clearFieldError(field) {
        if (!(field instanceof HTMLElement)) return;
        const errorId = field.dataset.validationErrorId;
        if (errorId) document.getElementById(errorId)?.remove();
        delete field.dataset.validationErrorId;
        field.removeAttribute('aria-invalid');
        const describedBy = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).filter(id => id !== errorId);
        if (describedBy.length) field.setAttribute('aria-describedby', describedBy.join(' '));
        else field.removeAttribute('aria-describedby');
    }

    function showFieldError(field) {
        if (!(field instanceof HTMLElement)) return;
        clearFieldError(field);
        const error = document.createElement('p');
        error.id = nextAccessibilityId('field-error');
        error.className = 'ui-form-error';
        error.setAttribute('role', 'alert');
        error.textContent = getFieldValidationMessage(field);
        field.insertAdjacentElement('afterend', error);
        field.dataset.validationErrorId = error.id;
        field.setAttribute('aria-invalid', 'true');
        const describedBy = new Set((field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        describedBy.add(error.id);
        field.setAttribute('aria-describedby', [...describedBy].join(' '));
    }

    function clearFormErrorSummary(form) {
        form?.querySelector(':scope > .ui-form-error-summary')?.remove();
    }

    function showFormErrorSummary(formOrId, message, focusTarget = null) {
        const form = typeof formOrId === 'string' ? document.getElementById(formOrId) : formOrId;
        if (!form) return;
        clearFormErrorSummary(form);
        const summary = document.createElement('div');
        summary.className = 'ui-form-error ui-form-error-summary';
        summary.tabIndex = -1;
        summary.setAttribute('role', 'alert');
        summary.setAttribute('aria-live', 'assertive');
        summary.textContent = message;
        form.prepend(summary);
        const target = typeof focusTarget === 'string' ? document.querySelector(focusTarget) : focusTarget;
        if (target instanceof HTMLElement && !target.matches('a[href], button, input, select, textarea, [tabindex]')) target.tabIndex = -1;
        requestAnimationFrame(() => (target || summary).focus?.({ preventScroll: false }));
    }

    function setupGlobalAccessibility() {
        document.addEventListener('keydown', event => {
            const activeModal = [...activeDialogStack].reverse().find(modal => !modal.classList.contains('hidden'));
            if (event.key === 'Escape' && activeModal) {
                if (closeAccessibleDialog(activeModal)) event.preventDefault();
                return;
            }
            if (event.key === 'Tab' && activeModal) {
                const focusable = getDialogFocusableElements(activeModal);
                if (!focusable.length) {
                    event.preventDefault();
                    getSharedModalPanel(activeModal)?.focus();
                    return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
                return;
            }
            if (event.target.matches?.('.history-tab') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                const tabs = [...document.querySelectorAll('.history-tab')];
                const currentIndex = tabs.indexOf(event.target);
                const nextIndex = event.key === 'Home' ? 0
                    : event.key === 'End' ? tabs.length - 1
                    : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                event.preventDefault();
                tabs[nextIndex]?.focus();
                tabs[nextIndex]?.click();
                return;
            }
            if ((event.key === 'Enter' || event.key === ' ') && !event.defaultPrevented) {
                const target = event.target.closest('[role="button"]');
                if (target && !target.matches('button, a[href], input') && !target.hasAttribute('disabled')) {
                    event.preventDefault();
                    target.click();
                }
            }
        });
        document.addEventListener('invalid', event => {
            showFieldError(event.target);
            requestAnimationFrame(() => event.target.focus({ preventScroll: false }));
        }, true);
        document.addEventListener('input', event => {
            if (event.target.matches('input, select, textarea')) {
                clearFieldError(event.target);
                clearFormErrorSummary(event.target.form);
            }
        }, true);
        document.addEventListener('change', event => {
            if (event.target.matches('input, select, textarea')) {
                clearFieldError(event.target);
                clearFormErrorSummary(event.target.form);
            }
        }, true);
        window.addEventListener('resize', debounce(updateScrollableTableRegions, 120));
    }

function findSharedComponentNodes(root, selector) {
        const nodes = [];
        if (root instanceof Element && root.matches(selector)) nodes.push(root);
        if (root?.querySelectorAll) nodes.push(...root.querySelectorAll(selector));
        return nodes;
    }

    function getSharedModalPanel(modal) {
        const candidates = [...modal.children].filter(child =>
            !child.matches('.modal-backdrop, [class*="bg-black/"]:not([id]), [class*="bg-gray-900/"]:not([id])') &&
            (child.id.endsWith('Card') || child.id.endsWith('Sheet') || child.classList.contains('bg-white') || child.classList.contains('bg-gray-100') || child.classList.contains('relative'))
        );
        return candidates.find(isVisibleInteractiveElement) || candidates[0] || modal.querySelector(':scope > div:not(.absolute) > .bg-white, :scope > div:not(.absolute) > .bg-gray-100');
    }

    function ensureControlAccessibility(control) {
        if (!(control instanceof HTMLElement)) return;
        if (!control.id) control.id = nextAccessibilityId('control');
        const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(control.id) : control.id.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        let label = control.closest('label') || document.querySelector(`label[for="${escapedId}"]`);
        if (!label) {
            const container = control.closest('div, fieldset');
            label = container ? [...container.querySelectorAll(':scope > label')].find(candidate => candidate.textContent.trim()) : null;
            if (label && !label.htmlFor) label.htmlFor = control.id;
        }
        if (!label && !control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) {
            const fallback = control.getAttribute('placeholder') || control.getAttribute('name') || control.id.replace(/[-_]/g, ' ');
            control.setAttribute('aria-label', fallback || 'ช่องกรอกข้อมูล');
        }
        if (control.required) control.setAttribute('aria-required', 'true');
        if (label && ['radio', 'checkbox'].includes(control.type)) label.classList.add('ui-choice-label');
    }

    function inferIconActionLabel(element) {
        const icon = element.querySelector('i');
        if (!icon) return '';
        const iconLabels = [
            ['fa-xmark', 'ปิด'], ['fa-times', 'ปิด'], ['fa-trash', 'ลบ'], ['fa-pen', 'แก้ไข'],
            ['fa-rotate', 'รีเฟรช'], ['fa-magnifying-glass', 'ค้นหา'], ['fa-search', 'ค้นหา'],
            ['fa-chevron-right', 'ดูรายละเอียด'], ['fa-arrow-right', 'ดูรายละเอียด'], ['fa-star', 'ให้คะแนน'],
            ['fa-download', 'ดาวน์โหลด'], ['fa-print', 'พิมพ์'], ['fa-plus', 'เพิ่มรายการ'],
            ['fa-minus', 'ลดจำนวน'], ['fa-bell', 'การแจ้งเตือน'], ['fa-bars', 'เปิดเมนู'],
            ['fa-right-to-bracket', 'เข้าสู่ระบบ'], ['fa-right-from-bracket', 'ออกจากระบบ'],
        ];
        return iconLabels.find(([className]) => icon.classList.contains(className))?.[1] || '';
    }

    function ensureInteractiveAccessibility(element) {
        if (!(element instanceof HTMLElement)) return;
        const isNative = element.matches('button, input, select, textarea, a[href]');
        if (!isNative && (element.hasAttribute('onclick') || element.getAttribute('role') === 'button')) {
            element.setAttribute('role', 'button');
            if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
        }
        const text = element.textContent.replace(/\s+/g, ' ').trim();
        if (!text && !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) {
            const label = element.getAttribute('title') || inferIconActionLabel(element);
            if (label) element.setAttribute('aria-label', label);
        }
        if (element.matches('a[target="_blank"]')) element.setAttribute('rel', 'noopener noreferrer');
    }

    function standardizeAccessibleTable(table) {
        if (!(table instanceof HTMLTableElement)) return;
        table.classList.add('ui-table');
        if (!table.hasAttribute('aria-label') && !table.querySelector('caption')) {
            const section = table.closest('section, .ui-card, .module-shell');
            const heading = section?.querySelector('h2, h3, h4');
            table.setAttribute('aria-label', heading?.textContent.trim() || 'ตารางข้อมูล');
        }
        const headers = [...table.querySelectorAll('thead th')].map(header => header.textContent.replace(/\s+/g, ' ').trim());
        table.querySelectorAll('tbody tr').forEach(row => {
            [...row.children].forEach((cell, index) => {
                if (cell.tagName === 'TD' && headers[index] && !cell.dataset.label) cell.dataset.label = headers[index];
            });
        });
        const container = table.parentElement;
        if (container) {
            container.classList.add('ui-table-container');
            if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', `${table.getAttribute('aria-label')} เลื่อนแนวนอนได้เมื่อจำเป็น`);
        }
        requestAnimationFrame(updateScrollableTableRegions);
    }

    function updateScrollableTableRegions() {
        document.querySelectorAll('.ui-table-container').forEach(container => {
            const isScrollable = container.scrollWidth > container.clientWidth + 1;
            container.classList.toggle('is-scrollable', isScrollable);
            if (isScrollable) container.tabIndex = 0;
            else container.removeAttribute('tabindex');
        });
    }

    function ensureImageAccessibility(image) {
        if (!(image instanceof HTMLImageElement)) return;
        if (!image.hasAttribute('alt')) {
            const contextualName = image.closest('article, li, .ui-card')?.querySelector('h2, h3, h4, strong')?.textContent.trim();
            image.alt = contextualName ? `ภาพ ${contextualName}` : 'ภาพอุปกรณ์ PPE';
        }
        if (!image.hasAttribute('decoding')) image.decoding = 'async';
        if (!image.hasAttribute('loading') && !image.classList.contains('system-logo') && !image.closest('#splashScreen')) {
            image.loading = 'lazy';
        }
    }

    function applySharedComponentStyles(root = document) {
        const modulePages = findSharedComponentNodes(root, '.page');
        modulePages.forEach(page => {
            page.querySelector(':scope > .module-shell')?.classList.add('ui-component-scope');

            const title = page.querySelector('h2, h3');
            if (title) {
                title.classList.add('ui-page-title');
                const header = title.closest('div, section');
                header?.classList.add('ui-page-header');
                const subtitle = header?.querySelector('p');
                if (subtitle && subtitle !== title) subtitle.classList.add('ui-page-subtitle');
            }
        });

        findSharedComponentNodes(root, '.module-shell input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="range"]), .module-shell select, .module-shell textarea, [id$="Modal"] input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), [id$="Modal"] select, [id$="Modal"] textarea')
            .forEach(control => {
                control.classList.add('ui-control');
                ensureControlAccessibility(control);
            });

        findSharedComponentNodes(root, '.module-shell input[type="radio"], .module-shell input[type="checkbox"], [id$="Modal"] input[type="radio"], [id$="Modal"] input[type="checkbox"], [id$="Modal"] input[type="file"]')
            .forEach(ensureControlAccessibility);

        findSharedComponentNodes(root, '.module-shell label, [id$="Modal"] label')
            .forEach(label => {
                if (!label.classList.contains('sr-only') && label.textContent.trim()) label.classList.add('ui-label');
            });

        findSharedComponentNodes(root, '.module-shell button, [id$="Modal"] button')
            .forEach(button => {
                button.classList.add('ui-button');
                ensureInteractiveAccessibility(button);
                const hasSemanticColor = [...button.classList].some(className =>
                    /^(?:bg|text|border)-(?:red|rose|orange|amber|yellow|emerald|green)-/.test(className)
                );
                if (button.classList.contains('bg-blue-600')) button.classList.add('ui-button-primary');
                else if (!hasSemanticColor && (
                    button.classList.contains('bg-white') ||
                    button.classList.contains('bg-gray-100') ||
                    button.classList.contains('border-gray-300')
                )) button.classList.add('ui-button-secondary');
            });

        findSharedComponentNodes(root, '.module-shell a, .module-shell [role="button"], .module-shell [onclick], [id$="Modal"] a, [id$="Modal"] [role="button"], [id$="Modal"] [onclick]')
            .forEach(ensureInteractiveAccessibility);
        findSharedComponentNodes(root, 'button, a, [role="button"]')
            .forEach(ensureInteractiveAccessibility);

        findSharedComponentNodes(root, '.module-shell table, [id$="Modal"] table')
            .forEach(standardizeAccessibleTable);
        const containingTable = root instanceof Element ? root.closest('table') : null;
        if (containingTable) standardizeAccessibleTable(containingTable);

        findSharedComponentNodes(root, '.module-shell img, [id$="Modal"] img')
            .forEach(ensureImageAccessibility);

        findSharedComponentNodes(root, '.module-shell span.rounded-full, .module-shell span[class*="rounded-full"], [id$="Modal"] span.rounded-full')
            .forEach(badge => badge.classList.add('ui-badge'));

        findSharedComponentNodes(root, '[id*="EmptyState"], [id*="emptyState"], .issue-empty-state, .ui-empty-state')
            .forEach(emptyState => emptyState.classList.add('ui-empty-state'));

        findSharedComponentNodes(root, '.module-shell section.bg-white, .module-shell > div.bg-white, .module-shell > div > section.bg-white, .card-calm')
            .forEach(card => card.classList.add('ui-card'));

        const filterSelectors = [
            '#stockToolbar > div',
            '#allHistoryPage .module-shell > div:nth-child(2)',
            '#reportPage .module-shell > div:first-child',
            '#notificationsPage .module-shell > div:first-child',
        ];
        if (root === document || root === document.documentElement || root === document.body) {
            document.querySelectorAll(filterSelectors.join(',')).forEach(filter => filter.classList.add('ui-filter-bar'));
        }

        findSharedComponentNodes(root, '[id$="Modal"]')
            .forEach(configureAccessibleDialog);

        const containingModal = root instanceof Element ? root.closest('[id$="Modal"]') : null;
        if (containingModal) {
            configureAccessibleDialog(containingModal);
        }

        const loadingPanel = document.querySelector('#loadingOverlay > div');
        loadingPanel?.classList.add('ui-loading-panel');
    }

    function observeSharedComponents() {
        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                if (mutation.type === 'attributes' && mutation.target.matches?.('[id$="Modal"]')) {
                    syncAccessibleDialogState(mutation.target);
                    return;
                }
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) applySharedComponentStyles(node);
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
