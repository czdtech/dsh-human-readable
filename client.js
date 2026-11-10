/**
 * 给任何人讲清楚 (Human-Readable) — Client half.
 *
 * Adds one icon button to the composer. Clicking it sends the draft plus the
 * session's full transcript to this package's Host half and writes the result
 * back into the composer, replacing the draft in place. Visible text follows
 * the Host's active locale; settings configure the shortcut.
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
        noContext: '先发一条消息，让改写有上下文可参考',
        unchangedNote: '草稿已经能独立看懂，未改动',
        unchangedMissed: '没有生成改写，草稿已保留',
        stale: '草稿已变化，这次结果没有写入；需要的话请再点一次',
        busy: '正在改写…',
        changed: '改写期间草稿发生了变化：请检查插入的改写结果，再决定是否发送。',
        insertFailed: '改写结果没有写入输入框，当前内容已保留。',
        title: '给任何人讲清楚',
        desc: '结合对话把草稿改写成脱离上下文也能看懂、可以直接发送的版本；保持原意和语气，上下文里能查到的都补齐，查不到的保持你的原话，不编造、不留空。',
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
        noContext: 'Send a message first so the rewrite has context',
        unchangedNote: 'Your draft already stands alone; nothing changed.',
        unchangedMissed: 'No rewrite was produced; your draft is preserved.',
        stale: 'Your draft changed, so this result was not written. Run it again if you want it.',
        busy: 'Rewriting…',
        changed: 'Your draft changed while rewriting. Review the inserted rewrite before sending.',
        insertFailed: 'The rewrite was not written into the composer; your current text is preserved.',
        title: 'Human-Readable',
        desc: 'Rewrite your draft so it reads clearly without this conversation and can be sent as-is; meaning and tone preserved, everything the conversation answers is filled in, what it cannot answer keeps your own wording, nothing invented, nothing left blank.',
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
        const shortcut = typeof value.shortcut === 'string' ? value.shortcut : DEFAULT_SHORTCUT
        // Retired numeric controls must not survive in storage or affect requests.
        if (['rounds', 'contextTokens', 'migratedContextTokens'].some((key) => Object.hasOwn(value, key))) {
          writeSettings({ shortcut })
        }
        return { shortcut }
      } catch {
        return { shortcut: DEFAULT_SHORTCUT }
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

    /** Insert a completed rewrite without replacing text entered after capture. */
    function insertDraft(actions, text) {
      const insertion = typeof actions?.captureInsertion === 'function' ? actions.captureInsertion() : undefined
      if (insertion && typeof actions?.insertText === 'function' && actions.insertText(text, insertion) !== false) return
      throw new Error(strings().insertFailed)
    }

    function HumanReadableButton(props) {
      const { useInput, inputActions, sessionId, useSession } = props
      const draft = useInput(draftOf)
      // A blank Session has no sent message, so there is no evidence to clarify
      // against; the button stays disabled until the first prompt is accepted.
      const blank = useSession((session) => session?.blank === true)
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const alive = React.useRef(true)
      const inFlight = React.useRef(false)
      useLocale()
      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        if (!notice) return undefined
        const close = () => setNotice(null)
        const timer = setTimeout(close, notice.kind === 'error' ? 5000 : 3500)
        const options = { capture: true }
        document.addEventListener('pointerdown', close, options)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('pointerdown', close, options)
        }
      }, [notice])

      const text = strings()
      const emptyDraft = typeof draft !== 'string' || draft.trim() === ''
      const canRun = !busy && !blank && !emptyDraft
      const shortcutLabel = formatCombo(readSettings().shortcut)
      const title = busy
        ? text.busy
        : emptyDraft
          ? `${text.label} · ${text.empty}`
          : blank
            ? `${text.label} · ${text.noContext}`
            : shortcutLabel === ''
              ? text.label
              : `${text.label} · ${shortcutLabel}`

      async function run() {
        if (!canRun || inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setNotice(null)
        const originalDraft = draft
        try {
          const response = await fetch('dsh-human-readable/rewrite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: typeof sessionId === 'string' ? sessionId : '',
              draft,
            }),
          })
          if (response.status === 401 || response.status === 403) {
            throw new Error('登录状态失效，刷新页面后再试')
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const reply = await response.json()
          if (!reply || reply.ok !== true) {
            throw new Error((reply && reply.error && reply.error.message) || 'rewrite failed')
          }
          const next = reply.value && reply.value.text
          if (typeof next !== 'string' || next.trim() === '') throw new Error('empty rewrite')
          if (!alive.current) return
          const incoming = next.trim()
          const value = reply.value || {}
          if (typeof console !== 'undefined') {
            console.info('[human-readable]', {
              changed: incoming !== originalDraft.trim(),
              model: value.model,
              elapsedMs: value.elapsedMs,
              hasContext: value.hasContext,
            })
          }
          // A rewrite identical to the draft has nothing to write back, but the
          // click must never look like a no-op: say what happened either way.
          if (incoming === originalDraft.trim()) {
            if (draftRef.current !== originalDraft) {
              setNotice({ kind: 'info', text: text.stale })
              return
            }
            const base = value.form === 'unchanged' ? text.unchangedNote : ''
            setNotice({ kind: 'info', text: base === '' ? text.unchangedMissed : base })
            return
          }
          if (draftRef.current === originalDraft) {
            if (typeof inputActions?.setDraft === 'function') inputActions.setDraft(incoming)
            else if (typeof inputActions?.setText === 'function') inputActions.setText(incoming)
            else {
              insertDraft(inputActions, incoming)
              return
            }
            setTimeout(() => {
              if (!alive.current) return
              if (draftRef.current === originalDraft) setNotice({ kind: 'error', text: text.insertFailed })
            }, 800)
            return
          }
          insertDraft(inputActions, incoming)
          setNotice({ kind: 'info', text: text.changed })
        } catch (failure) {
          if (!alive.current) return
          setNotice({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
          if (typeof console !== 'undefined') console.error('[human-readable]', failure)
        } finally {
          inFlight.current = false
          if (alive.current) setBusy(false)
        }
      }

      const runRef = React.useRef(run)
      runRef.current = run
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (shortcutRecording || event.defaultPrevented || !canRun) return
          const active = document.activeElement
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
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
          notice === null
            ? null
            : h(
                'div',
                { key: 'bubble', style: styles.bubble, role: 'alert' },
                h('span', {
                  style:
                    notice.kind === 'error'
                      ? styles.dot
                      : { ...styles.dot, background: 'var(--dsw-alias-label-secondary)' },
                }),
                h('span', { style: styles.bubbleText }, notice.text),
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
                  label: () => strings().title,
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
