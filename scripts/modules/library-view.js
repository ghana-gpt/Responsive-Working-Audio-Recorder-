/**
 * Recording library view: the list of saved recordings, its toolbar and the
 * bulk-selection bar.
 *
 * The view is intentionally "dumb": the orchestrator owns the data and passes a
 * flat render model in, while the view emits intents through `onAction`. That
 * keeps IndexedDB, object URLs and the recorder entirely outside the DOM layer.
 */

import { $, createElement, setFlag } from './dom.js';
import { formatBytes, formatDateTime, formatDuration } from './format.js';

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
    onAction({ type: 'query', value: searchInput.value });
  });

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
                    duration: formatDuration(record.durationMs),
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
   * Render the whole library.
   *
   * @param {{
   *   records?: object[],
   *   total?: number,
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
    const selection = model.selection instanceof Set ? model.selection : new Set();
    const query = String(model.query ?? '');
    const sort = model.sort ?? 'newest';

    // Do not clobber an open inline editor (it would lose the caret and text).
    if (renamingId && records.some((record) => record.id === renamingId)) return;

    if (searchInput && searchInput.value !== query) searchInput.value = query;
    if (sortSelect) sortSelect.value = sort;

    if (countLabel) countLabel.textContent = total > 0 ? t('library.count', { count: total }) : '';

    if (empty) {
      empty.textContent = total === 0 ? t('library.empty') : t('library.noMatches', { query });
      setFlag(empty, 'hidden', records.length > 0);
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
      selectAllBox.disabled = records.length === 0;
    }

    if (!list) return;

    // Remember where the focus was so a re-render does not move it.
    const active = document.activeElement;
    const activeRow = active instanceof Element ? active.closest('[data-id]') : null;
    const focusInfo =
      activeRow && list.contains(activeRow) && activeRow.dataset.id
        ? { id: activeRow.dataset.id, action: active.getAttribute('data-action') }
        : null;

    list.replaceChildren(...records.map((record) => buildRow(record, { ...model, selection })));

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
