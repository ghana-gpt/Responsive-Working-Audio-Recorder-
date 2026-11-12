/**
 * Recording library view: the list of saved recordings, its toolbar and the
 * bulk-selection bar.
 *
 * The view is intentionally "dumb": the orchestrator owns the data and passes a
 * flat render model in, while the view emits intents through `onAction`. That
 * keeps IndexedDB, object URLs and the recorder entirely outside the DOM layer.
 */

import { $, createElement, setFlag } from './dom.js';
import { formatBytes, formatDateTime, formatDuration, formatSeconds } from './format.js';

/**
 * @param {{
 *   root?: Document|HTMLElement,
 *   t: (key: string, params?: object) => string,
 *   locale?: string,
 *   canShare?: boolean,
 *   onAction: (intent: { type: string, [key: string]: any }) => void,
 * }} options
 */
export function createLibraryView({ root = document, t, locale, canShare = false, onAction }) {
  const list = $('#recording-list', root);
  const empty = $('#library-empty', root);
  const countLabel = $('#library-count', root);
  const searchInput = $('#search-input', root);
  const sortSelect = $('#sort-select', root);
  const importButton = $('#import-btn', root);
  const importInput = $('#import-input', root);
  const downloadAllButton = $('#download-all-btn', root);
  const clearAllButton = $('#clear-all-btn', root);
  const selectionBar = $('#selection-bar', root);
  const selectAllBox = $('#select-all', root);
  const selectionCount = $('#selection-count', root);
  const downloadSelectedButton = $('#download-selected-btn', root);
  const deleteSelectedButton = $('#delete-selected-btn', root);
  const moreWrap = $('#library-more', root);
  const moreButton = $('#library-more-btn', root);

  /** Typing is debounced so a long library is not re-filtered on every keypress. */
  const SEARCH_DEBOUNCE_MS = 120;
  let searchTimer = null;

  /** @type {string|null} id of the row currently in rename mode */
  let renamingId = null;

  importButton?.addEventListener('click', () => importInput?.click());

  importInput?.addEventListener('change', () => {
    const files = Array.from(importInput.files ?? []);
    importInput.value = '';
    if (files.length > 0) onAction({ type: 'import', files });
  });

  downloadAllButton?.addEventListener('click', () => onAction({ type: 'zipAll' }));
  clearAllButton?.addEventListener('click', () => onAction({ type: 'clearAll' }));

  searchInput?.addEventListener('input', () => {
    const value = searchInput.value;
    if (searchTimer) clearTimeout(searchTimer);
    // Clearing the field is immediate so the list never looks stuck.
    if (!value.trim()) {
      searchTimer = null;
      onAction({ type: 'query', value });
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      onAction({ type: 'query', value });
    }, SEARCH_DEBOUNCE_MS);
  });

  // `type="search"` also fires `search` for the clear button and Enter.
  searchInput?.addEventListener('search', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    onAction({ type: 'query', value: searchInput.value });
  });

  moreButton?.addEventListener('click', () => onAction({ type: 'showMore' }));

  sortSelect?.addEventListener('change', () => {
    onAction({ type: 'sort', value: sortSelect.value });
  });

  selectAllBox?.addEventListener('change', () => {
    onAction({ type: 'selectAll', checked: Boolean(selectAllBox.checked) });
  });

  downloadSelectedButton?.addEventListener('click', () => onAction({ type: 'zipSelection' }));
  deleteSelectedButton?.addEventListener('click', () => onAction({ type: 'deleteSelection' }));

  // Rows are re-rendered often, so every interaction is delegated from the list.
  list?.addEventListener('click', (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!trigger || !list.contains(trigger)) return;
    const row = trigger.closest('[data-id]');
    const id = row?.dataset.id;
    if (!id) return;
    const action = trigger.getAttribute('data-action');
    if (action === 'rename') {
      startRename(id, row);
      return;
    }
    if (action === 'cancel-rename') {
      renamingId = null;
      invalidate(id);
      onAction({ type: 'refresh' });
      return;
    }
    if (action === 'select') return; // handled by the change listener
    onAction({ type: action, id });
  });

  list?.addEventListener('change', (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.getAttribute('data-action') !== 'select') return;
    const row = box.closest('[data-id]');
    if (!row || !row.dataset.id) return;
    onAction({ type: 'select', id: row.dataset.id, checked: box.checked });
  });

  list?.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const id = form.dataset.id;
    if (!id) return;
    const nameField = form.elements.namedItem('name');
    const tagsField = form.elements.namedItem('tags');
    renamingId = null;
    invalidate(id);
    onAction({
      type: 'rename',
      id,
      name: nameField instanceof HTMLInputElement ? nameField.value : '',
      tags: tagsField instanceof HTMLInputElement ? tagsField.value : '',
    });
  });

  list?.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete') return;
    if (event.target instanceof Element && event.target.closest('input, textarea')) return;
    const row = event.target instanceof Element ? event.target.closest('[data-id]') : null;
    if (!row || !row.dataset.id) return;
    event.preventDefault();
    onAction({ type: 'delete', id: row.dataset.id });
  });

  /** Replace a row's content with an inline name + tags editor. */
  function startRename(id, row) {
    renamingId = id;
    const record = row.recordData;
    const nameField = createElement('input', {
      attrs: {
        type: 'text',
        name: 'name',
        value: record?.name ?? '',
        maxlength: '80',
        'aria-label': t('recording.nameLabel'),
      },
    });
    const tagsField = createElement('input', {
      attrs: {
        type: 'text',
        name: 'tags',
        value: Array.isArray(record?.tags) ? record.tags.join(', ') : '',
        maxlength: '200',
        placeholder: t('recording.tagsPlaceholder'),
        'aria-label': t('recording.tagsLabel'),
      },
    });
    const form = createElement('form', {
      class: 'recording__rename',
      dataset: { id },
      children: [
        nameField,
        tagsField,
        createElement('div', {
          class: 'recording__rename-actions',
          children: [
            createElement('button', {
              class: ['btn', 'btn--primary', 'btn--sm'],
              attrs: { type: 'submit' },
              text: t('recording.renameSave'),
            }),
            createElement('button', {
              class: ['btn', 'btn--ghost', 'btn--sm'],
              attrs: { type: 'button', 'data-action': 'cancel-rename' },
              text: t('actions.cancel'),
            }),
          ],
        }),
      ],
    });
    row.replaceChildren(form);
    nameField.focus();
    nameField.select();
  }

  /** Small icon-only action button (label is exposed to assistive tech). */
  function iconButton(action, label, icon, tone) {
    const classes = ['btn', 'btn--ghost', 'btn--sm'];
    if (tone) classes.push(`btn--${tone}`);
    return createElement('button', {
      class: classes,
      attrs: { type: 'button', 'data-action': action, 'aria-label': label, title: label },
      children: [
        createElement('span', { class: 'btn__icon', attrs: { 'aria-hidden': 'true' }, text: icon }),
      ],
    });
  }

  /** @param {object} record @param {object} model */
  function buildRow(record, model) {
    const name = record.name || t('recording.untitled');
    const isPlaying = model.activeId === record.id && model.playing;
    const durationMs = Number(record.durationMs) || 0;
    // A sub-second clip rendered as "00:00" reads like a failed save, so those
    // keep one decimal; everything else stays in the compact mm:ss clock form.
    const duration =
      durationMs > 0 && durationMs < 1000
        ? formatSeconds(durationMs / 1000)
        : formatDuration(durationMs);

    const tags = Array.isArray(record.tags) ? record.tags.slice() : [];
    const tagList = createElement('ul', { class: 'recording__tags' });
    for (const tag of tags) {
      tagList.append(createElement('li', { class: 'tag', text: String(tag) }));
    }
    if (record.trimmed) {
      tagList.append(
        createElement('li', { class: ['tag', 'tag--trimmed'], text: t('recording.trimmed') }),
      );
    }

    const checkbox = createElement('input', {
      class: 'recording__select',
      attrs: {
        type: 'checkbox',
        'data-action': 'select',
        'aria-label': t('library.select', { name }),
      },
    });
    if (model.selection.has(record.id)) checkbox.checked = true;

    const actions = createElement('div', {
      class: 'recording__actions',
      attrs: { role: 'group', 'aria-label': t('recording.actions', { name }) },
      children: [
        iconButton(
          'play',
          isPlaying ? t('recording.pause', { name }) : t('recording.play', { name }),
          isPlaying ? '❚❚' : '▶',
        ),
        iconButton('download', t('recording.download', { name }), '⤓'),
        iconButton('trim', t('recording.trim', { name }), '✂'),
        canShare ? iconButton('share', t('recording.share', { name }), '⤴') : null,
        iconButton('rename', t('recording.rename', { name }), '✎'),
        iconButton('delete', t('recording.delete', { name }), '🗑', 'danger'),
      ].filter(Boolean),
    });

    const row = createElement('li', {
      class: 'recording',
      dataset: {
        id: record.id,
        active: model.activeId === record.id ? 'true' : 'false',
      },
      children: [
        createElement('div', {
          class: 'recording__head',
          children: [
            checkbox,
            createElement('div', {
              class: 'recording__titles',
              children: [
                createElement('h3', { class: 'recording__name', text: name }),
                createElement('p', {
                  class: 'recording__meta',
                  text: t('recording.meta', {
                    format: String(record.extension || 'audio').toUpperCase(),
                    size: formatBytes(record.size),
                    duration,
                  }),
                }),
                createElement('p', {
                  class: 'recording__meta',
                  text: t('recording.created', {
                    date: formatDateTime(record.createdAt, model.locale ?? locale),
                  }),
                }),
                tagList,
              ],
            }),
          ],
        }),
        actions,
      ],
    });

    // Kept off the DOM so the rename editor can read the current values.
    row.recordData = record;
    return row;
  }

  /**
   * Update state-only parts of a row (playing icon, checkbox, active flag) in
   * place. Replacing the node here would detach the very button a user is
   * clicking whenever playback starts, pauses or ends.
   *
   * @param {HTMLElement} row
   * @param {object} record
   * @param {object} model
   */
  function syncRowState(row, record, model) {
    const name = record.name || t('recording.untitled');
    const isPlaying = model.activeId === record.id && model.playing;
    row.dataset.active = model.activeId === record.id ? 'true' : 'false';

    const checkbox = row.querySelector('[data-action="select"]');
    if (checkbox instanceof HTMLInputElement) checkbox.checked = model.selection.has(record.id);

    const playButton = row.querySelector('[data-action="play"]');
    if (!playButton) return;
    const label = isPlaying ? t('recording.pause', { name }) : t('recording.play', { name });
    playButton.setAttribute('aria-label', label);
    playButton.title = label;
    const icon = playButton.querySelector('.btn__icon');
    if (icon) icon.textContent = isPlaying ? '❚❚' : '▶';
  }

  /** Rows are reused across renders: id -> { element, signature }. */
  const rows = new Map();

  /**
   * Force the next render to rebuild one row (used when leaving rename mode,
   * because the DOM no longer matches the record it represents).
   *
   * @param {string} id
   */
  function invalidate(id) {
    const entry = rows.get(id);
    if (entry) entry.signature = null;
  }

  /** Cheap fingerprint of everything a row displays. */
  function rowSignature(record, model) {
    return JSON.stringify([
      record.name ?? '',
      Array.isArray(record.tags) ? record.tags : null,
      Boolean(record.trimmed),
      Number(record.size) || 0,
      Number(record.durationMs) || 0,
      Number(record.createdAt) || 0,
      record.extension ?? '',
      Array.isArray(record.markers) ? record.markers.length : 0,
      model.locale ?? '',
    ]);
  }

  /**
   * Render the whole library.
   *
   * @param {{
   *   records?: object[],
   *   total?: number,
   *   matching?: number,
   *   hasMore?: boolean,
   *   query?: string,
   *   sort?: string,
   *   selection?: Set<string>,
   *   activeId?: string|null,
   *   playing?: boolean,
   * }} model
   */
  function render(model = {}) {
    const records = Array.isArray(model.records) ? model.records : [];
    const total = Number(model.total) || 0;
    const matching = Number(model.matching ?? records.length) || 0;
    const selection = model.selection instanceof Set ? model.selection : new Set();
    const query = String(model.query ?? '');
    const sort = model.sort ?? 'newest';

    // Drop the rename flag when its row is no longer part of the rendered set.
    if (renamingId && !records.some((record) => record.id === renamingId)) renamingId = null;

    if (searchInput && searchInput.value !== query) searchInput.value = query;
    if (sortSelect) sortSelect.value = sort;

    if (countLabel) countLabel.textContent = total > 0 ? t('library.count', { count: total }) : '';

    if (empty) {
      empty.textContent = total === 0 ? t('library.empty') : t('library.noMatches', { query });
      setFlag(empty, 'hidden', records.length > 0);
    }

    if (moreWrap) setFlag(moreWrap, 'hidden', !model.hasMore);
    if (moreButton && model.hasMore) {
      moreButton.textContent = t('library.showMore', {
        count: Math.max(0, matching - records.length),
      });
    }

    setFlag(selectionBar, 'hidden', total === 0);
    if (selectionCount) {
      selectionCount.textContent =
        selection.size > 0 ? t('library.selectedCount', { count: selection.size }) : '';
    }
    setFlag(downloadSelectedButton, 'disabled', selection.size === 0);
    setFlag(deleteSelectedButton, 'disabled', selection.size === 0);
    setFlag(downloadAllButton, 'disabled', total === 0);
    setFlag(clearAllButton, 'disabled', total === 0);

    if (selectAllBox) {
      const selectedVisible = records.filter((record) => selection.has(record.id)).length;
      selectAllBox.checked = records.length > 0 && selectedVisible === records.length;
      selectAllBox.indeterminate = selectedVisible > 0 && selectedVisible < records.length;
      selectAllBox.disabled = matching === 0;
    }

    if (!list) return;

    // Remember where the focus was so a re-render does not move it.
    const active = document.activeElement;
    const activeRow = active instanceof Element ? active.closest('[data-id]') : null;
    const focusInfo =
      activeRow && list.contains(activeRow) && activeRow.dataset.id
        ? { id: activeRow.dataset.id, action: active.getAttribute('data-action') }
        : null;

    // Keyed reconciliation: reuse rows whose content did not change, so a
    // checkbox click or a "show more" never rebuilds the whole list (which
    // would otherwise close inline editors and drop focus).
    const rowModel = { ...model, selection };
    const desired = new Set();
    for (const [index, record] of records.entries()) {
      desired.add(record.id);
      const signature = rowSignature(record, rowModel);
      let entry = rows.get(record.id);

      if (entry && renamingId !== record.id && entry.signature !== signature) {
        const replacement = buildRow(record, rowModel);
        entry.element.replaceWith(replacement);
        entry = { element: replacement, signature };
        rows.set(record.id, entry);
      } else if (!entry) {
        entry = { element: buildRow(record, rowModel), signature };
        rows.set(record.id, entry);
      } else {
        // Keep the rename editor's data source current.
        entry.element.recordData = record;
      }

      // Playing/selection changes are state-only: patch the existing nodes
      // instead of replacing them (see syncRowState).
      syncRowState(entry.element, record, rowModel);

      const node = entry.element;
      const reference = list.children[index] ?? null;
      if (reference !== node) list.insertBefore(node, reference);
    }

    for (const [id, entry] of rows) {
      if (desired.has(id)) continue;
      entry.element.remove();
      rows.delete(id);
    }

    if (focusInfo?.action) {
      const selector = `[data-id="${CSS.escape(String(focusInfo.id))}"] [data-action="${focusInfo.action}"]`;
      list.querySelector(selector)?.focus({ preventScroll: true });
    }
  }

  /** Static, non-state dependent labels. */
  function setStatic() {
    if (importButton) importButton.title = t('library.importHint');
    if (searchInput) searchInput.setAttribute('aria-label', t('library.search'));
    if (sortSelect) sortSelect.setAttribute('aria-label', t('library.sort'));
  }

  return {
    render,
    setStatic,
    /** Id of the row currently being renamed (used by the e2e test). */
    renamingId: () => renamingId,
    focusRow: (id) => {
      list?.querySelector(`[data-id="${CSS.escape(String(id))}"] [data-action="play"]`)?.focus();
    },
  };
}
