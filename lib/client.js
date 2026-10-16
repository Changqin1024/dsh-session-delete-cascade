/**
 * Client half of the delete-session bundle.
 *
 * It registers one row into the sidebar's `sidebar.workspaces.session.menu.item`
 * list (the "..." menu beside every session) plus one `shell.overlay` entry
 * that shows the confirmation dialog. Selecting the row opens the dialog;
 * confirming calls the Host's `sessionDelete.delete` and then refreshes the
 * Session projection so the rows disappear everywhere.
 *
 * Two deliberate constraints, both from the DSH plugin-authoring guidance:
 *
 *  - **No Harness Client package is imported as a module.** A plain-JS plugin
 *    has no type check against packages such as
 *    `@deepseek-ai/dsh-client-ui-primitives`, which change without notice, and
 *    a throwing component blanks the whole slot entry. The few controls needed
 *    here are inlined below with the same markup, behavior, and `--dsw-alias-*`
 *    tokens, so theme switching keeps working and only tokens stay shared.
 *    Only the platform seed words `react` and `react-dom` are required.
 *  - **The plugin performs no storage I/O.** The Host owns the durable log,
 *    the projection cache, the search index and the workspace accounting, and
 *    it is the only place that can remove them consistently.
 */

globalThis.__ModuleLoader__.load({
  id: 'dsh-session-delete-cascade',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'session-delete'

    /**
     * The route the Host half registers on the Connection. Both halves hard-code
     * it rather than importing a shared module: the client bundle resolves from
     * a different module table than the Host half, and one literal is cheaper
     * than a build step that would have to inline it.
     */
    const DELETE_PATH = '/api/session-delete.delete'

    /** Scoped class names, prefixed so they cannot collide with host styles. */
    const CLS = {
      root: 'dsd-root',
      mask: 'dsd-mask',
      dialog: 'dsd-dialog',
      header: 'dsd-header',
      title: 'dsd-title',
      close: 'dsd-close',
      description: 'dsd-description',
      body: 'dsd-body',
      footer: 'dsd-footer',
      button: 'dsd-button',
      buttonOutline: 'dsd-button-outline',
      note: 'dsd-note',
      lineage: 'dsd-lineage',
      lineageList: 'dsd-lineage-list',
      status: 'dsd-status',
      error: 'dsd-error',
      menuItem: 'dsd-menu-item',
      menuItemDanger: 'dsd-menu-item-danger',
      menuIcon: 'dsd-menu-icon',
      menuLabel: 'dsd-menu-label',
      toast: 'dsd-toast',
      toastIcon: 'dsd-toast-icon',
      toastText: 'dsd-toast-text'
    }

    const CSS = [
      '.dsd-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
      '.dsd-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}',
      '.dsd-mask::after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}',
      '.dsd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(440px,100%);max-height:100%;padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
      '.dsd-dialog:focus{outline:none}',
      '.dsd-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}',
      '.dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsd-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.dsd-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsd-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dsd-body{display:flex;flex-direction:column;gap:12px;min-width:0;overflow-y:auto;margin-top:20px;padding:0 24px}',
      '.dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
      '.dsd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}',
      '.dsd-button:disabled{cursor:not-allowed;opacity:.4}',
      '.dsd-button-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
      '.dsd-button-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsd-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsd-lineage{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2)}',
      '.dsd-lineage-list{margin:0;padding-inline-start:18px;max-height:170px;overflow-y:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsd-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsd-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}',
      '.dsd-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
      '.dsd-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsd-menu-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}',
      '.dsd-menu-item-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dsd-menu-item-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dsd-menu-item-danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
      '.dsd-menu-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon,currentColor)}',
      '.dsd-menu-item-danger .dsd-menu-icon{color:var(--dsw-alias-state-error-primary)}',
      '.dsd-menu-icon svg{width:14px;height:14px}',
      '.dsd-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsd-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);transform:translateX(-50%)}',
      '.dsd-toast-icon{display:grid;place-items:center;flex:none;color:var(--dsw-alias-state-success-primary)}',
      '.dsd-toast-icon svg{width:16px;height:16px}',
      '.dsd-toast-text{min-width:0}'
    ].join('')

    /** Inject the stylesheet once per document, tagged so HMR can replace it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-session-delete-cascade/session-delete.css'
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
      if (document.querySelector(selector) !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.append(tag)
    }

    const zh = {
      'menu.delete': '删除会话',
      'confirm.title': '删除会话',
      'confirm.desc': '将永久删除会话「{title}」及其全部对话记录、缓存的投影、搜索索引条目与工作区记账。此操作无法撤销。',
      'confirm.retention': '删除后，该会话的历史记录、摘要缓存、全文索引与工作区记账都会被移除，且无法恢复。',
      'confirm.lineage': '该会话有 {count} 个子会话，将一并删除：',
      'confirm.action': '删除',
      'confirm.pending': '正在删除会话…',
      'notice.deleted': '会话已删除',
      'notice.deletedMany': '已删除会话及 {count} 个子会话',
      'notice.deleteFailed': '删除会话失败'
    }

    const en = {
      'menu.delete': 'Delete session',
      'confirm.title': 'Delete session',
      'confirm.desc': 'This permanently deletes the session "{title}" together with its conversation history, cached projections, search-index entries and workspace accounting. This cannot be undone.',
      'confirm.retention': "After deleting, this session's history, summary cache, full-text index and workspace accounting are all removed and cannot be recovered.",
      'confirm.lineage': 'This session has {count} sub-session(s) that will be deleted with it:',
      'confirm.action': 'Delete',
      'confirm.pending': 'Deleting session…',
      'notice.deleted': 'Session deleted',
      'notice.deletedMany': 'Deleted the session and {count} sub-session(s)',
      'notice.deleteFailed': 'Failed to delete session'
    }

    /**
     * A tiny observable request store: the menu row sets a pending request, the
     * overlay renders one dialog per request, and settling clears it.
     */
    function createRequestStore() {
      let current = null
      let seq = 0
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        getSnapshot: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(request) {
          current = request === null ? null : { ...request, seq: ++seq }
          emit()
        }
      }
    }

    /** A 14px stroked trash glyph, matching the host's icon weight and box. */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M10 11v6' }),
        h('path', { d: 'M14 11v6' }),
        h('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }),
        h('path', { d: 'M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2' })
      )
    }

    /** A 14px stroked close glyph. */
    function CloseIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        'aria-hidden': true
      }, h('path', { d: 'M6 6l12 12' }), h('path', { d: 'M18 6L6 18' }))
    }

    /** A 16px check circle for the success toast. */
    function CheckIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M8.5 12.5l2.5 2.5 4.5-5' })
      )
    }

    /**
     * The inlined modal: portal, mask click-to-close, Escape-to-close, focus
     * entry and return, and Tab containment — the behaviors a user relies on.
     */
    function ConfirmModal({ title, closeLabel, description, footer, onClose, children }) {
      const dialog = React.useRef(null)
      const restoreTo = React.useRef(null)
      const closeRef = React.useRef(onClose)
      closeRef.current = onClose

      React.useEffect(() => {
        const element = dialog.current
        if (element === null) return undefined
        restoreTo.current = document.activeElement
        const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'
        const initial = element.querySelector('[data-modal-autofocus]') ?? element
        if (typeof initial.focus === 'function') initial.focus({ preventScroll: true })
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = [...element.querySelectorAll(focusable)]
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        element.addEventListener('keydown', onKeyDown)
        return () => {
          element.removeEventListener('keydown', onKeyDown)
          const previous = restoreTo.current
          if (previous !== null && typeof previous.focus === 'function') {
            previous.focus({ preventScroll: true })
          }
        }
      }, [])

      if (typeof document === 'undefined') return null
      return createPortal(
        h('div', { className: CLS.root, role: 'presentation' },
          h('div', {
            className: CLS.mask,
            'aria-hidden': true,
            onClick: onClose
          }),
          h('div', {
            ref: dialog,
            tabIndex: -1,
            className: CLS.dialog,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title
          },
            h('div', null,
              h('div', { className: CLS.header },
                h('h2', { className: CLS.title }, title),
                h('button', {
                  type: 'button',
                  className: CLS.close,
                  'aria-label': closeLabel,
                  onClick: onClose
                }, h(CloseIcon))
              ),
              description !== undefined && description !== ''
                ? h('p', { className: CLS.description }, description)
                : null,
              h('div', { className: CLS.body }, children)
            ),
            h('div', { className: CLS.footer }, footer)
          )
        ),
        document.body
      )
    }

    /**
     * The menu row. `useMenuOpenState` is one of the owner's slot hooks; the
     * injected `requestSessionDelete` opens the confirmation dialog.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: CLS.menuItem + ' ' + CLS.menuItemDanger,
        onClick: () => {
          setMenuOpen(false)
          requestSessionDelete(sessionId, displayTitle)
        }
      },
        h('span', { className: CLS.menuIcon }, h(TrashIcon)),
        h('span', { className: CLS.menuLabel }, t('menu.delete'))
      )
    }

    /** One request's dialog: in-flight and error state die with it. */
    function DeleteConfirmForm({ request, deleteSession, onSettle, t }) {
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(null)
      const close = () => {
        if (deleting) return
        onSettle()
      }
      const confirm = () => {
        setDeleting(true)
        setError(null)
        deleteSession(request.sessionId).then(() => {
          setDeleting(false)
          onSettle()
        }).catch((reason) => {
          setDeleting(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      const descendants = request.descendants ?? []
      return h(ConfirmModal, {
        title: t('confirm.title'),
        closeLabel: t('close'),
        description: t('confirm.desc', { title: request.displayTitle }),
        onClose: close,
        footer: [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: CLS.button + ' ' + CLS.buttonOutline,
            disabled: deleting,
            onClick: close
          }, t('cancel')),
          h('button', {
            key: 'confirm',
            type: 'button',
            className: CLS.button + ' ' + CLS.buttonOutline,
            'data-modal-autofocus': true,
            disabled: deleting,
            onClick: confirm
          }, t('confirm.action'))
        ]
      },
        h('div', { className: CLS.note }, t('confirm.retention')),
        descendants.length > 0
          ? h('div', { className: CLS.lineage },
            h('span', null, t('confirm.lineage', { count: descendants.length })),
            h('ul', { className: CLS.lineageList },
              descendants.map((child) => h('li', { key: child.sessionId },
                child.displayTitle === undefined || child.displayTitle === ''
                  ? child.sessionId
                  : child.displayTitle
              ))
            )
          )
          : null,
        deleting ? h('div', { className: CLS.status }, t('confirm.pending')) : null,
        error !== null ? h('div', { className: CLS.error, role: 'alert' }, error) : null
      )
    }

    /** The overlay entry: nothing while no request is pending. */
    function SessionDeleteConfirmDialog({ useDeleteRequest, deleteSession, settleSessionDelete, t }) {
      const request = useDeleteRequest((pending) => pending)
      if (request === null) return null
      return h(DeleteConfirmForm, {
        request,
        deleteSession,
        onSettle: settleSessionDelete,
        t
      }, request.seq)
    }

    /** The row's result notice, self-dismissing after a few seconds. */
    function DeleteNotice({ notice, onDone, t }) {
      const latestOnDone = React.useRef(onDone)
      latestOnDone.current = onDone
      const seq = notice === null ? null : notice.seq
      React.useEffect(() => {
        if (seq === null) return undefined
        const timer = setTimeout(() => {
          latestOnDone.current()
        }, 4000)
        return () => {
          clearTimeout(timer)
        }
      }, [seq])
      if (notice === null) return null
      if (typeof document === 'undefined') return null
      const count = notice.descendantCount ?? 0
      const key = notice.kind !== 'deleted'
        ? 'notice.deleteFailed'
        : count > 0 ? 'notice.deletedMany' : 'notice.deleted'
      const ok = notice.kind === 'deleted'
      return createPortal(
        h('div', { className: CLS.toast, role: 'alert' },
          ok ? h('span', { className: CLS.toastIcon }, h(CheckIcon)) : null,
          h('span', { className: CLS.toastText }, t(key, { count }))
        ),
        document.body
      )
    }

    /**
     * Subagent descendants of one session, read from the Session Controller's
     * own list projection. Only `origin: 'subagent'` rows count: a fork is an
     * independent conversation and survives, matching the Host's lineage walk.
     * This preview is advisory — the Host re-walks the lineage from the durable
     * headers and is the only authority on what is actually removed.
     * @param sessions - the Session Controller.
     * @param rootId - the session whose descendants are wanted.
     * @returns the descendant summaries, root excluded, in breadth-first order.
     */
    function collectDescendants(sessions, rootId) {
      const snapshot = sessions.list.getSnapshot()
      const childrenOf = new Map()
      for (const id of snapshot.ids) {
        const summary = snapshot.byId[id]
        if (summary === undefined) continue
        if (summary.origin !== 'subagent') continue
        if (summary.parentId === undefined) continue
        const siblings = childrenOf.get(summary.parentId)
        if (siblings === undefined) childrenOf.set(summary.parentId, [id])
        else siblings.push(id)
      }
      const out = []
      const visited = new Set([rootId])
      const queue = [rootId]
      while (queue.length > 0) {
        const current = queue.shift()
        for (const childId of childrenOf.get(current) ?? []) {
          if (visited.has(childId)) continue
          visited.add(childId)
          const summary = snapshot.byId[childId]
          out.push({
            sessionId: childId,
            displayTitle: summary?.displayTitle
          })
          queue.push(childId)
        }
      }
      return out
    }

    /**
     * The Session currently open in the main panel, when one can be determined.
     *
     * A Session is "the current one" exactly while something retains it with
     * source `mainView`: ui-session's `publishMain()` scans for the Session whose
     * `retainedBy.mainView` is positive and hands that binding to every
     * session-scoped slot. `mainReference` is the field ui-workspace itself
     * compares against when it clears an archived current Session, so it is read
     * first; `selection` is the persisted record, which can already name the
     * Session while a reload is still restoring it.
     *
     * Both are private to ui-workspace. Every read is guarded and an unknown
     * answer means "not the open one", so a change in that shape degrades to
     * leaving the panel alone rather than clearing the wrong conversation.
     * @param ctx - the plugin's client context.
     * @returns the open Session id, or undefined when it cannot be read.
     */
    function openSessionId(ctx) {
      let workspace
      try {
        workspace = ctx.get('uiWorkspace')
      } catch {
        return undefined
      }
      if (workspace === undefined || workspace === null) return undefined
      const main = workspace.mainReference?.sessionId
      if (typeof main === 'string') return main
      try {
        const selection = workspace.selection?.getSnapshot?.()?.sessionId
        return typeof selection === 'string' ? selection : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Leave the main panel when the conversation it shows has just been deleted.
     *
     * DSH clears the panel when the open Session is archived, but it has no
     * equivalent for a deleted one — it never deletes Sessions, so nothing
     * watches for that. Without this the panel keeps rendering the Session that
     * is gone: its title projection is gone with it, so the header falls back to
     * the raw session id, and the transcript it already loaded stays on screen.
     *
     * `clearMain()` is what ui-workspace calls on archive. It drops
     * `mainReference`, whose `mainView` retention is what made the Session the
     * current one; releasing it makes ui-session recompute the scoped binding as
     * absent, so the header and body re-render session-less, and the released
     * client-side instance takes its transcript with it.
     * @param ctx - the plugin's client context.
     * @param deletedIds - the Sessions the Host removed.
     * @returns whether the panel was left.
     */
    function leaveDeletedConversation(ctx, deletedIds) {
      const open = openSessionId(ctx)
      if (open === undefined || !deletedIds.includes(open)) return false
      try {
        ctx.get('uiWorkspace')?.clearMain?.()
        return true
      } catch {
        return false
      }
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        const requestStore = createRequestStore()
        const noticeStore = createRequestStore()
        let noticeSeq = 0

        ensureStyles()

        const notify = (kind, descendantCount) => {
          noticeStore.set({ kind, descendantCount, seq: ++noticeSeq })
        }

        const requestSessionDelete = (sessionId, displayTitle) => {
          requestStore.set({
            sessionId,
            displayTitle,
            descendants: collectDescendants(sessions, sessionId)
          })
        }

        const settleSessionDelete = () => {
          requestStore.set(null)
        }

        /**
         * Ask the Host to delete the session and its subagent lineage, then
         * refresh the Session projection so the rows leave the sidebar. The
         * Workspace projection needs no refresh: its follow stream relays the
         * registry writes the Host delete performs, so the accounting lands on
         * its own.
         *
         * The call is a plain `fetch` to the route the Host half registers on
         * the Connection. That is deliberate: `ctx.remote.<namespace>` can only
         * be mounted from a generated Typert contribution, and this bundle
         * hand-writes both halves. The Connection already carries the browser's
         * signed cookie, so the route needs no credential of its own.
         */
        const deleteSession = async (sessionId) => {
          try {
            const response = await fetch(DELETE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId })
            })
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            if (!response.ok) {
              // Carry the stable failure code into the dialog text: the code is
              // what makes a refusal diagnosable, the message what makes it
              // readable.
              const code = typeof payload?.error === 'string' ? payload.error : 'HTTP ' + String(response.status)
              const message = typeof payload?.message === 'string' ? payload.message : response.statusText
              throw new Error(message === '' ? code : code + ': ' + message)
            }
            await sessions.refresh()
            const deleted = payload?.deletedSessionIds ?? [sessionId]
            leaveDeletedConversation(ctx, deleted)
            notify('deleted', Math.max(0, deleted.length - 1))
          } catch (error) {
            notify('failed', 0)
            throw error
          }
        }

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: dictionaries')

        const rowInjected = () => ({ requestSessionDelete })

        const dialogInjected = () => ({
          hooks: { deleteRequest: requestStore },
          deleteSession,
          settleSessionDelete
        })

        const noticeInjected = () => ({
          hooks: { notice: noticeStore },
          onDone: () => {
            noticeStore.set(null)
          }
        })

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'delete',
          order: 500,
          locale: NS,
          inject: rowInjected
        }, DeleteSessionMenuItem))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace.session-delete',
          locale: NS,
          inject: dialogInjected
        }, SessionDeleteConfirmDialog))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace.session-delete-notice',
          locale: NS,
          inject: noticeInjected
        }, DeleteNotice))
      }
    }
  }
})
