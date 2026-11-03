/**
 * 给任何人讲清楚 (Human-Readable) — Client half.
 *
 * Adds one icon button to the composer. Clicking it sends the draft plus the
 * recent conversation window to this package's Host half and writes the result
 * back into the composer, replacing the draft in place. Visible text follows the
 * Host's active locale; the only preference is the context-turn count.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-human-readable',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STRINGS = {
      zh: {
        label: '给任何人讲清楚',
        empty: '先写点什么，再点这里',
        busy: '正在改写…',
        failed: '没改成功：',
        noWriter: '没有可用的写入接口',
        title: '给任何人讲清楚',
        desc: '点输入框右上角的按钮，把草稿改写成任何人都听得懂的版本。',
        rounds: '上下文轮数',
        roundsHint: '最多看最近几轮对话，0–20，默认 6。和下面的 token 上限以先到者为准。',
        tokens: '上下文 token 上限',
        tokensHint: '最多带多少 token，默认 1500。和轮数上限以先到者为准。',
        shortcut: '快捷键',
        shortcutHint: '点一下右边的按钮，再按你想要的组合键（必须包含 Ctrl / Alt / Cmd）；按 Esc 取消。',
        shortcutRecording: '请按组合键…',
        shortcutUnset: '未设置',
        shortcutClear: '清除',
        model: '模型',
        modelHint: '固定跟随当前会话，不单独设置。这样理解最一致。',
        follow: '跟随当前会话',
      },
      en: {
        label: 'Human-Readable',
        empty: 'Write something first',
        busy: 'Rewriting…',
        failed: 'Failed: ',
        noWriter: 'No draft writer available',
        title: 'Human-Readable',
        desc: 'The composer button rewrites your draft into language anyone can follow.',
        rounds: 'Context turns',
        roundsHint: 'At most this many recent turns, 0–20, default 6. Whichever limit is hit first wins.',
        tokens: 'Context token budget',
        tokensHint: 'Token cap for the context, default 1500. Whichever limit is hit first wins.',
        shortcut: 'Shortcut',
        shortcutHint: 'Click the button, then press the combo you want (Ctrl, Alt, or Cmd required); Esc cancels.',
        shortcutRecording: 'Press keys…',
        shortcutUnset: 'Not set',
        shortcutClear: 'Clear',
        model: 'Model',
        modelHint: 'Always follows the current session; it is not configurable.',
        follow: 'Current session',
      },
    }

    let pluginCtx = null

    function activeLocale() {
      try {
        const snapshot = pluginCtx && pluginCtx.locale && pluginCtx.locale.getSnapshot()
        return String((snapshot && snapshot.active) || '')
      } catch {
        return ''
      }
    }

    function isZh() {
      const active = activeLocale()
      if (active !== '') return /^zh/i.test(active)
      return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    }

    function strings() {
      return isZh() ? STRINGS.zh : STRINGS.en
    }

    /** Re-render when the Host locale or a dictionary changes. */
    function useLocale() {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (!pluginCtx || !pluginCtx.locale || typeof pluginCtx.locale.subscribe !== 'function') return undefined
        return pluginCtx.locale.subscribe(() => setRevision((value) => value + 1))
      }, [])
    }

    const SETTINGS_KEY = 'dsh-human-readable.settings.v1'
    const DEFAULT_ROUNDS = 6
    const DEFAULT_CONTEXT_TOKENS = 1500
    const MIN_CONTEXT_TOKENS = 200
    const MAX_CONTEXT_TOKENS = 8000
    const DEFAULT_SHORTCUT = 'alt+h'

    const MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta'])

    /** Normalize one keydown into a stored combo, or '' when it is only a modifier. */
    function comboOf(event) {
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      if (key === '' || MODIFIER_KEYS.has(key)) return ''
      const parts = []
      if (event.ctrlKey) parts.push('ctrl')
      if (event.altKey) parts.push('alt')
      if (event.metaKey) parts.push('cmd')
      if (event.shiftKey) parts.push('shift')
      parts.push(key)
      return parts.join('+')
    }

    /** A usable combo needs Ctrl, Alt, or Cmd so plain typing never triggers it. */
    function isUsableCombo(combo) {
      return /^(ctrl|alt|cmd)(\+|$)/.test(combo)
    }

    function formatCombo(combo) {
      if (!combo) return ''
      return combo
        .split('+')
        .map((part) => (part === 'ctrl' ? 'Ctrl' : part === 'alt' ? 'Alt' : part === 'cmd' ? 'Cmd' : part === 'shift' ? 'Shift' : part.toUpperCase()))
        .join('+')
    }

    function matchesCombo(event, combo) {
      if (!combo) return false
      const parts = combo.split('+')
      const key = parts[parts.length - 1]
      const mods = new Set(parts.slice(0, -1))
      if (typeof event.key !== 'string' || event.key.toLowerCase() !== key) return false
      if (Boolean(event.ctrlKey) !== mods.has('ctrl')) return false
      if (Boolean(event.altKey) !== mods.has('alt')) return false
      if (Boolean(event.metaKey) !== mods.has('cmd')) return false
      if (Boolean(event.shiftKey) !== mods.has('shift')) return false
      return true
    }

    function readSettings() {
      try {
        const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}
        const rawRounds = Number(value.rounds)
        const rounds = Number.isFinite(rawRounds) ? Math.min(20, Math.max(0, Math.trunc(rawRounds))) : DEFAULT_ROUNDS
        const rawTokens = Number(value.contextTokens)
        const contextTokens = Number.isFinite(rawTokens)
          ? Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.trunc(rawTokens)))
          : DEFAULT_CONTEXT_TOKENS
        const shortcut = typeof value.shortcut === 'string' ? value.shortcut : DEFAULT_SHORTCUT
        return { rounds, contextTokens, shortcut }
      } catch {
        return { rounds: DEFAULT_ROUNDS, contextTokens: DEFAULT_CONTEXT_TOKENS, shortcut: DEFAULT_SHORTCUT }
      }
    }

    function writeSettings(next) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* settings stay in memory for this page only */
      }
    }

    let lastShortcutAt = 0
    let shortcutRecording = false

    const styles = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', pointerEvents: 'auto' },
      button: {
        all: 'unset',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        cursor: 'pointer',
        transition: 'background-color .12s ease, color .12s ease',
      },
      buttonOn: {
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
      },
      buttonOff: { opacity: 0.35, cursor: 'default' },
      bubble: {
        position: 'absolute',
        bottom: 34,
        right: 0,
        width: 280,
        maxWidth: 'min(280px, 70vw)',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
        cursor: 'default',
      },
      dot: {
        flex: '0 0 auto',
        width: 8,
        height: 8,
        marginTop: 5,
        borderRadius: 4,
        background: 'var(--dsw-alias-state-error-primary)',
      },
      bubbleText: {
        flex: 1,
        fontSize: 12,
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-primary)',
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        overflowWrap: 'anywhere',
      },
    }

    function Icon() {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 18 18',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M11.8 1.4c.56 3.2 1.96 4.6 5.16 5.16-3.2.56-4.6 1.96-5.16 5.16-.56-3.2-1.96-4.6-5.16-5.16 3.2-.56 4.6-1.96 5.16-5.16z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M4.4 9.9c.28 1.6.94 2.26 2.54 2.54-1.6.28-2.26.94-2.54 2.54-.28-1.6-.94-2.26-2.54-2.54 1.6-.28 2.26-.94 2.54-2.54z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    }

    function Spinner() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 5.6,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeDasharray: '22 40',
          style: { transformOrigin: '8px 8px', animation: 'dhr-spin .9s linear infinite' },
        }),
      )
    }

    function draftOf(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return ''
      if (typeof snapshot.text === 'string') return snapshot.text
      if (typeof snapshot.draft === 'string') return snapshot.draft
      return ''
    }

    /** Replace the whole draft; the exposed writer name differs across host builds. */
    function writeDraft(actions, text) {
      if (typeof actions?.setDraft === 'function') return actions.setDraft(text)
      if (typeof actions?.setText === 'function') return actions.setText(text)
      const insertion = typeof actions?.captureInsertion === 'function' ? actions.captureInsertion() : undefined
      if (insertion && typeof actions?.insertText === 'function') return actions.insertText(text, insertion)
      throw new Error(`${strings().noWriter}: ${Object.keys(actions ?? {}).join(',') || 'none'}`)
    }

    function HumanReadableButton(props) {
      const { useInput, inputActions, sessionId } = props
      const draft = useInput(draftOf)
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [error, setError] = React.useState('')
      const alive = React.useRef(true)
      useLocale()
      React.useEffect(() => () => {
        alive.current = false
      }, [])

      React.useEffect(() => {
        if (error === '') return undefined
        const close = () => setError('')
        const timer = setTimeout(close, 4000)
        const options = { capture: true }
        document.addEventListener('pointerdown', close, options)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('pointerdown', close, options)
        }
      }, [error])

      const text = strings()
      const canRun = !busy && typeof draft === 'string' && draft.trim() !== ''
      const shortcutLabel = formatCombo(readSettings().shortcut)
      const title = busy
        ? text.busy
        : canRun
          ? shortcutLabel === ''
            ? text.label
            : `${text.label} · ${shortcutLabel}`
          : `${text.label} · ${text.empty}`

      async function run() {
        if (!canRun) return
        const started = performance.now()
        setBusy(true)
        setError('')
        const settings = readSettings()
        try {
          const response = await fetch('dsh-human-readable/rewrite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: typeof sessionId === 'string' ? sessionId : '',
              draft,
              rounds: settings.rounds,
              contextTokens: settings.contextTokens,
            }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const reply = await response.json()
          if (!reply || reply.ok !== true) {
            throw new Error((reply && reply.error && reply.error.message) || 'rewrite failed')
          }
          const next = reply.value && reply.value.text
          if (typeof next !== 'string' || next.trim() === '') throw new Error('empty rewrite')
          writeDraft(inputActions, next.trim())
          if (typeof console !== 'undefined') {
            console.log(`[human-readable] ${Math.round(performance.now() - started)}ms · ${reply.value.model ?? ''}`)
          }
        } catch (failure) {
          if (!alive.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
          if (typeof console !== 'undefined') console.error('[human-readable]', failure)
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const runRef = React.useRef(run)
      runRef.current = run
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (shortcutRecording || event.defaultPrevented || !canRun) return
          if (!matchesCombo(event, readSettings().shortcut)) return
          const now = Date.now()
          if (now - lastShortcutAt < 400) return
          lastShortcutAt = now
          event.preventDefault()
          event.stopPropagation()
          runRef.current()
        }
        document.addEventListener('keydown', onKeyDown, { capture: true })
        return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
      }, [canRun])

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, '@keyframes dhr-spin{to{transform:rotate(360deg)}}'),
        h(
          'span',
          { key: 'wrap', style: styles.wrap },
          h(
            'button',
            {
              type: 'button',
              className: 'dhr-button',
              'aria-label': text.label,
              title,
              disabled: !canRun,
              onClick: run,
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              style: {
                ...styles.button,
                ...(hover && canRun ? styles.buttonOn : null),
                ...(canRun ? null : styles.buttonOff),
              },
            },
            busy ? h(Spinner) : h(Icon),
          ),
          error === ''
            ? null
            : h(
                'div',
                { key: 'bubble', style: styles.bubble, role: 'alert' },
                h('span', { style: styles.dot }),
                h('span', { style: styles.bubbleText }, error),
              ),
        ),
      )
    }

    const pageStyles = {
      page: { display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 2px 8px', maxWidth: 640 },
      title: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      desc: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4, lineHeight: '18px' },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        padding: '14px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        marginTop: 12,
      },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 3, lineHeight: '17px' },
      input: {
        boxSizing: 'border-box',
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        outline: 'none',
      },
    }

    function SettingsPage() {
      const [settings, setSettings] = React.useState(readSettings)
      const [recording, setRecording] = React.useState(false)
      useLocale()
      const text = strings()

      const update = (patch) => {
        const next = { ...settings, ...patch }
        setSettings(next)
        writeSettings(next)
      }

      React.useEffect(() => {
        shortcutRecording = recording
        if (!recording) return undefined
        const onKeyDown = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') {
            setRecording(false)
            return
          }
          const combo = comboOf(event)
          if (combo === '' || !isUsableCombo(combo)) return
          update({ shortcut: combo })
          setRecording(false)
        }
        document.addEventListener('keydown', onKeyDown, { capture: true })
        return () => {
          shortcutRecording = false
          document.removeEventListener('keydown', onKeyDown, { capture: true })
        }
      }, [recording])

      return h('div', { style: pageStyles.page }, [
        h('div', { key: 'head' }, [
          h('div', { style: pageStyles.title }, text.title),
          h('div', { style: pageStyles.desc }, text.desc),
        ]),
        h('div', { key: 'rounds', style: pageStyles.row }, [
          h('div', { key: 'label' }, [
            h('div', { style: pageStyles.label }, text.rounds),
            h('div', { style: pageStyles.hint }, text.roundsHint),
          ]),
          h('input', {
            key: 'control',
            type: 'number',
            min: 0,
            max: 20,
            step: 1,
            value: String(settings.rounds),
            style: { ...pageStyles.input, width: 96 },
            onChange: (event) => {
              const next = Math.min(20, Math.max(0, Math.trunc(Number(event.target.value) || 0)))
              update({ rounds: next })
            },
          }),
        ]),
        h('div', { key: 'tokens', style: pageStyles.row }, [
          h('div', { key: 'label' }, [
            h('div', { style: pageStyles.label }, text.tokens),
            h('div', { style: pageStyles.hint }, text.tokensHint),
          ]),
          h('input', {
            key: 'control',
            type: 'number',
            min: MIN_CONTEXT_TOKENS,
            max: MAX_CONTEXT_TOKENS,
            step: 100,
            value: String(settings.contextTokens),
            style: { ...pageStyles.input, width: 96 },
            onChange: (event) => {
              const next = Math.min(
                MAX_CONTEXT_TOKENS,
                Math.max(MIN_CONTEXT_TOKENS, Math.trunc(Number(event.target.value) || DEFAULT_CONTEXT_TOKENS)),
              )
              update({ contextTokens: next })
            },
          }),
        ]),
        h('div', { key: 'shortcut', style: pageStyles.row }, [
          h('div', { key: 'label' }, [
            h('div', { style: pageStyles.label }, text.shortcut),
            h('div', { style: pageStyles.hint }, text.shortcutHint),
          ]),
          h('div', { key: 'control', style: { display: 'inline-flex', alignItems: 'center', gap: 8 } }, [
            h(
              'button',
              {
                key: 'record',
                type: 'button',
                onClick: () => setRecording((value) => !value),
                style: {
                  ...pageStyles.input,
                  width: 150,
                  display: 'inline-flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  borderColor: recording ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
                  color: recording ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
                },
              },
              recording
                ? text.shortcutRecording
                : settings.shortcut
                  ? formatCombo(settings.shortcut)
                  : text.shortcutUnset,
            ),
            settings.shortcut
              ? h(
                  'button',
                  {
                    key: 'clear',
                    type: 'button',
                    onClick: () => update({ shortcut: '' }),
                    style: {
                      all: 'unset',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  text.shortcutClear,
                )
              : null,
          ]),
        ]),
        h('div', { key: 'model', style: pageStyles.row }, [
          h('div', { key: 'label' }, [
            h('div', { style: pageStyles.label }, text.model),
            h('div', { style: pageStyles.hint }, text.modelHint),
          ]),
          h(
            'div',
            {
              key: 'control',
              style: {
                ...pageStyles.input,
                width: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            text.follow,
          ),
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginCtx = ctx

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.right', () =>
              ctx.slots.register(
                { name: 'conversation.input.right', id: 'human-readable', order: 10 },
                HumanReadableButton,
              ),
            ),
          'human-readable: composer button',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'human-readable',
                  order: 25,
                  label: () => (isZh() ? STRINGS.zh.title : STRINGS.en.title),
                },
                SettingsPage,
              ),
            ),
          'human-readable: settings section',
        )
      },
    }
  },
})
