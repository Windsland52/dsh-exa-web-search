/**
 * Client half of dsh-exa-web-search: two Plugins-page configuration cards.
 * The bundle page carries just the API key; the row page carries the whole
 * deployment section — mode, URLs, retrieval knobs — so the unobtrusive page
 * is the one that has everything. `apiKey` is a `role('secret')` config
 * field: the card learns only whether one is set (from the describe mirror's
 * sidecar) and writes it like any other field; the literal never rides back.
 * The card dictionaries live in the on-demand `client.locales.js` chunk.
 */

window.__ModuleLoader__.load({
  id: 'dsh-exa-web-search',
  factory(require) {
    const React = require('react');
    const {
      SettingsForm, SettingsSecretField, SettingsValueField,
      SettingsFormModel, settingsTextField,
      Menu, IconChevronDownOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives');

    const h = React.createElement;
    const NS = 'exaWebSearch';
    /** The row id the bundle patch declares; also its settings namespace. */
    const ENTRY_NS = 'exa-web-search';
    /** The package-level slot key the bundle page dispatches under. */
    const BUNDLE_KEY = 'dsh-exa-web-search';
    /** `<package>#<row>` key the Plugins page dispatches row config slots by. */
    const SLOT_KEY = `${BUNDLE_KEY}#exa-web-search`;
    /** Exa search reference, linked from the retrieval-mode hint. */
    const DOCS_URL = 'https://exa.ai/docs/reference/search';
    /** On-demand dictionaries chunk; see client.locales.js. */
    const loadLocales = () => require.async('./client.locales.js');

    installStyles();

    /** One-time styling for the enum dropdown; the module system owns and removes this tag. */
    function installStyles() {
      if (typeof document === 'undefined' || document.querySelector('style[data-exa-styles="1"]') !== null) return;
      const el = document.createElement('style');
      el.setAttribute('data-exa-styles', '1');
      el.textContent = [
        '.exa-field{margin:14px 0;display:flex;flex-direction:column;gap:6px}',
        '.exa-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.exa-label{font-size:13px;font-weight:600;line-height:1.3}',
        '.exa-reset{background:none;border:none;padding:0;color:inherit;opacity:.65;font:inherit;font-size:12px;cursor:pointer}',
        '.exa-reset:hover{opacity:1}',
        '.exa-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid rgba(128,128,128,.35);border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
        '.exa-trigger:focus-visible{outline:2px solid rgba(80,140,255,.6);outline-offset:1px}',
        '.exa-trigger:disabled{opacity:.5;cursor:default}',
        '.exa-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.exa-hint{font-size:12px;line-height:1.4;opacity:.7;margin:0}',
        '.exa-doclink{margin-left:6px;color:inherit;text-decoration:underline;text-underline-offset:2px}',
      ].join('\n');
      document.head.appendChild(el);
    }

    /**
     * Whether the row's `apiKey` currently holds a value, read from the shared
     * describe mirror's secret sidecar (`path` + `set`), never from the section.
     * @param view - the shared describe snapshot's namespaces list.
     * @returns true when the effective section reports a stored key.
     */
    function apiKeyConfigured(view) {
      const entry = (view?.namespaces ?? []).find(item => item.ns === ENTRY_NS);
      return (entry?.secrets ?? []).some(secret => secret.path.length === 1 && secret.path[0] === 'apiKey' && secret.set) === true;
    }

    /**
     * A field accepting one of a fixed set of strings; anything else is an
     * invalid draft that blocks the save. An empty draft clears the override.
     * @param field - section field name.
     * @param values - the accepted values.
     * @returns the field's conversion spec.
     */
    function enumField(field, values) {
      return {
        field,
        format: value => typeof value === 'string' ? value : '',
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          return values.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined;
        },
      };
    }

    /** Form frame copy, read from this page's dictionary. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'), readOnly: t('readOnly'),
        saveFailed: t('saveFailed'), save: t('save'), saving: t('saving'),
      };
    }

    /** One editable section field control bound to the shared form. */
    function valueField(t, state, actions, field, id, label, hint, extra) {
      return h(SettingsValueField, {
        id, label, hint,
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        disabled: !state.writable || state.saving,
        ...state[field],
        ...(extra === 'numeric' ? { numeric: true } : {}),
        onEdit: (text) => { actions.edit(field, text) },
        onReset: () => { actions.resetField(field) },
      });
    }

    /**
     * A dropdown for one enumerated section field, matching the Plugins page's
     * own provider menu (a value button that opens a Menu). Picking a value
     * stages it; the reset affordance clears the override back to the default.
     * The hint explains the selected value and links its documentation.
     */
    function enumControl(t, state, actions, field, id, label, choices, hints, link) {
      const current = state[field];
      const value = current.text === '' ? choices[0] : current.text;
      return h(EnumDropdown, {
        id, label, choices, value,
        disabled: !state.writable || state.saving,
        overridden: current.overridden === true,
        invalid: current.invalid === true,
        resetLabel: t('reset'),
        invalidLabel: t('invalidEnum'),
        hint: hints?.[value],
        link,
        onSelect: (next) => { actions.edit(field, next) },
        onReset: () => { actions.resetField(field) },
      });
    }

    /** The enum dropdown body: a controlled Menu anchored to its value button. */
    function EnumDropdown(props) {
      const [open, setOpen] = React.useState(false);
      const trigger = React.useRef(null);
      const shown = open && !props.disabled;
      const items = props.choices.map(choice => ({ id: choice, label: choice }));
      const anchor = h('button', {
        ref: trigger, id: props.id, type: 'button', className: 'exa-trigger', disabled: props.disabled,
        'aria-haspopup': 'menu', 'aria-expanded': shown,
        onClick: () => { setOpen(value => !value) },
      },
        h('span', { className: 'exa-value' }, props.value),
        h(IconChevronDownOutlineRegular, { size: 12 }),
      );
      return h('div', { className: 'exa-field' },
        h('div', { className: 'exa-head' },
          h('label', { htmlFor: props.id, className: 'exa-label' }, props.label),
          props.overridden
            ? h('button', { type: 'button', className: 'exa-reset', disabled: props.disabled, onClick: props.onReset }, props.resetLabel)
            : null,
        ),
        h(Menu, {
          open: shown,
          onClose: () => { setOpen(false) },
          items,
          selectedId: props.value,
          onSelect: (next) => {
            if (trigger.current) trigger.current.focus({ preventScroll: true });
            setOpen(false);
            if (next !== props.value) props.onSelect(next);
          },
          portal: true, autoFocus: true, minWidthFromAnchor: true, anchor,
        }),
        props.invalid ? h('p', { className: 'exa-hint', role: 'status' }, props.invalidLabel) : null,
        (props.hint || props.link)
          ? h('p', { className: 'exa-hint' },
              props.hint ? h('span', null, props.hint) : null,
              props.link ? h('a', { className: 'exa-doclink', href: props.link.href, target: '_blank', rel: 'noopener noreferrer' }, props.link.label) : null,
            )
          : null,
      );
    }

    /** The API-key control shared by both cards. */
    function keyField(t, state, actions) {
      return h(SettingsSecretField, {
        id: 'plugin-config-exa-api-key',
        label: t('apiKey'),
        hint: t('apiKeyHint'),
        text: state.apiKey.text,
        disabled: !state.writable || state.saving,
        configured: state.apiKeyConfigured,
        stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
        onEdit: (text) => { actions.edit('apiKey', text) },
      });
    }

    /**
     * The bundle-page card: just the key. `summary` renders the one-liner the
     * row detail shows where a row has no description; `page` renders here.
     */
    function ExaKeyCard(props) {
      const t = props.t;
      if (props.view === 'summary') return t('summary');
      const actions = props.exaActions;
      const state = props.useExaForm(value => value);
      return h(SettingsForm, { labels: formLabels(t), state, onSave: actions.save, onDiscard: actions.discard },
        keyField(t, state, actions),
      );
    }

    /** The row-page card: the key plus every deployment-level section field. */
    function ExaConfigCard(props) {
      const t = props.t;
      if (props.view === 'summary') return t('summary');
      const actions = props.exaActions;
      const state = props.useExaForm(value => value);
      return h(SettingsForm, { labels: formLabels(t), state, onSave: actions.save, onDiscard: actions.discard },
        keyField(t, state, actions),
        enumControl(t, state, actions, 'mode', 'plugin-config-exa-mode', t('mode'),
          ['auto', 'anonymous', 'keyed'],
          { auto: t('modeAuto'), anonymous: t('modeAnonymous'), keyed: t('modeKeyed') }, null),
        enumControl(t, state, actions, 'searchType', 'plugin-config-exa-search-type', t('searchType'),
          ['auto', 'keyword', 'neural', 'lite', 'deep-lite', 'deep', 'deep-reasoning'],
          { auto: t('searchTypeAuto'), keyword: t('searchTypeKeyword'), neural: t('searchTypeNeural'), lite: t('searchTypeLite'), 'deep-lite': t('searchTypeDeepLite'), deep: t('searchTypeDeep'), 'deep-reasoning': t('searchTypeDeepReasoning') },
          { href: DOCS_URL, label: t('docsLink') }),
        valueField(t, state, actions, 'apiKeyEnv', 'plugin-config-exa-key-env', t('apiKeyEnv'), t('apiKeyEnvHint')),
        valueField(t, state, actions, 'baseURL', 'plugin-config-exa-base-url', t('baseURL'), t('baseURLHint')),
        valueField(t, state, actions, 'mcpURL', 'plugin-config-exa-mcp-url', t('mcpURL'), t('mcpURLHint')),
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      async apply(ctx) {
        const LOCALES = await loadLocales();
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'exa-web-search: dictionaries');
        const scope = ctx.configForms.get(ENTRY_NS);
        const describe = ctx.configForms.describe();
        const form = new SettingsFormModel(scope, [
          enumField('mode', ['auto', 'anonymous', 'keyed']),
          enumField('searchType', ['auto', 'keyword', 'neural', 'lite', 'deep-lite', 'deep', 'deep-reasoning']),
          settingsTextField('apiKeyEnv'),
          settingsTextField('baseURL'),
          settingsTextField('mcpURL'),
        ], [{
          field: 'apiKey',
          write: (text) => scope.mutate([{ op: 'set', path: ['apiKey'], value: text }]),
        }]);
        ctx.effect(() => () => { form.dispose() }, 'exa-web-search: form model');
        const project = () => ({
          ...form.shell(),
          apiKey: form.field('apiKey'),
          apiKeyConfigured: apiKeyConfigured(describe.getSnapshot().view),
          mode: form.field('mode'),
          searchType: form.field('searchType'),
          apiKeyEnv: form.field('apiKeyEnv'),
          baseURL: form.field('baseURL'),
          mcpURL: form.field('mcpURL'),
        });
        const formStore = form.bind(project);
        // Secret presence lives outside the section, so a key written or
        // cleared elsewhere would never republish the form on its own.
        ctx.effect(() => describe.subscribe(() => { formStore.set(project()) }), 'exa-web-search: secret presence');
        const actions = form.actions();
        ctx.effect(() => ctx.configForms.whileServed([ENTRY_NS], () => {
          const inject = () => ({ hooks: { exaForm: formStore }, exaActions: actions });
          const key = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
            { name: 'plugins.bundle.config', key: BUNDLE_KEY, locale: NS, inject },
          ExaKeyCard));
          const row = ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
            { name: 'plugins.row.config', key: SLOT_KEY, locale: NS, inject },
          ExaConfigCard));
          return () => { key(); row(); };
        }), 'exa-web-search: config cards');
      },
    };
  },
});
