/**
 * Small DOM helpers. Kept deliberately tiny — no framework, no polyfills.
 */

/** @returns {Element|null} */
export const $ = (selector, root = document) => root.querySelector(selector);

/** @returns {Element[]} */
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * addEventListener that returns a disposer.
 * @template {EventTarget} T
 * @param {T} target
 * @param {string} type
 * @param {(event: Event) => void} handler
 * @param {AddEventListenerOptions|boolean} [options]
 * @returns {() => void}
 */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * Create an element with attributes, dataset, classes and children.
 *
 * Text is always set with `textContent`: no caller can smuggle markup into the
 * DOM, which is why the app has no `innerHTML` sink at all.
 *
 * @param {string} tag
 * @param {{
 *   class?: string|string[],
 *   text?: string,
 *   dataset?: Record<string, string>,
 *   attrs?: Record<string, string|number|boolean|null|undefined>,
 *   children?: Node[],
 * }} [options]
 * @returns {HTMLElement}
 */
export function createElement(tag, options = {}) {
  const element = document.createElement(tag);
  const { class: className, text, dataset, attrs, children } = options;
  if (className) {
    const list = Array.isArray(className) ? className : String(className).split(/\s+/);
    element.classList.add(...list.filter(Boolean));
  }
  if (text !== undefined) element.textContent = text;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) element.dataset[key] = value;
  }
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (children) {
    for (const child of children) if (child) element.append(child);
  }
  return element;
}

/**
 * Toggle a boolean attribute (e.g. `disabled`, `hidden`) without touching it
 * when the value has not changed, which avoids needless attribute churn.
 *
 * @param {Element} element
 * @param {string} name
 * @param {boolean} value
 */
export function setFlag(element, name, value) {
  if (!element) return;
  if (value) {
    if (!element.hasAttribute(name)) element.setAttribute(name, '');
  } else if (element.hasAttribute(name)) {
    element.removeAttribute(name);
  }
}

/** Screen-reader friendly string comparison to avoid repeated announcements. */
const lastAnnouncements = new WeakMap();

/**
 * Update an ARIA live region, forcing a re-announcement of identical text by
 * clearing it first (browsers ignore unchanged live-region content).
 *
 * @param {Element} region
 * @param {string} message
 */
export function announce(region, message) {
  if (!region) return;
  const previous = lastAnnouncements.get(region);
  if (previous === message) {
    region.textContent = '';
    requestAnimationFrame(() => {
      region.textContent = message;
    });
  } else {
    region.textContent = message;
  }
  lastAnnouncements.set(region, message);
}

/** True when the event target is a text entry control (shortcuts stay quiet). */
export function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (target.getAttribute('type') ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(
      type,
    );
  }
  return tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/**
 * Translate every element carrying a `data-i18n*` attribute.
 *
 * Keeping translations declarative in the HTML means a language switch never
 * needs to rebuild markup — the same nodes are re-labelled in place, so focus,
 * scroll position and form state all survive.
 *
 * @param {Document|HTMLElement} root
 * @param {(key: string, params?: object) => string} t
 */
export function translateTree(root, t) {
  if (!root || typeof t !== 'function') return;
  for (const element of $$('[data-i18n]', root)) {
    element.textContent = t(element.getAttribute('data-i18n'));
  }
  const attributes = [
    ['[data-i18n-placeholder]', 'data-i18n-placeholder', 'placeholder'],
    ['[data-i18n-aria-label]', 'data-i18n-aria-label', 'aria-label'],
    ['[data-i18n-title]', 'data-i18n-title', 'title'],
  ];
  for (const [selector, attribute, target] of attributes) {
    for (const element of $$(selector, root)) {
      element.setAttribute(target, t(element.getAttribute(attribute)));
    }
  }
}

/** Restore focus to the element that opened a dialog. */
export function restoreFocus(element) {
  if (element && typeof element.focus === 'function') {
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  }
}
