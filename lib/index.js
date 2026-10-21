/**
 * Host half of the delete-session bundle.
 *
 * The client reaches this half through an ordinary HTTP route registered on the
 * Connection (`ctx.connection.fetch.register`), not through a Typert Remote
 * namespace. That is a deliberate choice, and it is the pattern the rest of the
 * DSH plugin ecosystem uses:
 *
 *  - A `ctx.remote.<namespace>` can only be mounted from a generated Typert
 *    contribution. `@deepseek-ai/dsh-api-remotes` mounts a fixed allowlist, and
 *    `ctx.remote.$mount()` refuses any descriptor whose codecs are not
 *    `mode: 'strict'`. A hand-written bundle can author that shape, but it then
 *    depends on a generated-artifact contract for a single method.
 *  - `ctx.connection.fetch.register` is a first-class shipped API
 *    (`ConnectionFetchRoute`: `path`, `methods`, `requestBody`, `fetch`). The
 *    Connection already authenticates the browser with a signed cookie, so the
 *    route needs no authorization code of its own.
 *
 * The route is registered as an effect, so it disappears with the plugin.
 *
 * The removal runs in an order that keeps every projection consistent:
 *
 *  1. collect the session's subagent lineage (the session plus every
 *     `origin: 'subagent'` descendant, transitively);
 *  2. refuse while ANY session in that lineage still has running work — a live
 *     turn, a running subagent, an owned job, an active reminder — the same
 *     admission the archive path uses, so the caller sees the same activity
 *     list and can stop it first;
 *  3. dispose each live agent in the lineage, deepest first, which drains the
 *     loops and closes their persistence write handles;
 *  4. drop each projection-cache row;
 *  5. delete each durable JSONL log directory (the search index reconciles
 *     from the persistence listing, so its rows disappear with the logs);
 *  6. drop each session from the workspace accounting: every workspace's
 *     `sessionIds`, plus the registry-global archive and pin sets.
 *
 * Lineage follows the durable header fields through subagent-origin sessions
 * only: a fork of a deleted session is an independent conversation, exactly as
 * the archive gate treats it.
 *
 * Steps 3-6 are individually fail-soft (logged, not thrown) so one stubborn
 * derived store cannot leave the durable log behind: the log is the thing the
 * sidebar would otherwise keep showing.
 */

import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The route the browser half calls. */
const DELETE_PATH = '/api/session-delete.delete'

/** Services this plugin coordinates across. */
const inject = ['agents', 'sessionPersistence', 'workspaceRegistry', 'connection']

/** A JSON response that is never cached. */
const json = (value, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/**
 * Whether one value is usable as a session id: a non-empty, bounded string.
 * @param value - the candidate value.
 * @returns whether it can be treated as a session id.
 */
const isSessionId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512

/** Everything one session owns on disk and in derived stores. */
class SessionDeleteCommands {
  ctx

  /** @param ctx - Host context carrying the registries this plugin coordinates. */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * Delete one session and all of its derived state, including its subagent
   * lineage.
   * @param sessionId - the root session identity.
   * @returns the root identity and every session that was deleted with it.
   */
  async delete(sessionId) {
    // 1. Collect the lineage: the session plus every subagent descendant.
    const lineage = await this.collectLineage(sessionId)

    // 2. Refuse while ANY session in the lineage has running work. The
    //    registry's providers answer the `turn`, `subagent`, `job`, and
    //    `schedule` families themselves; asking them once per session costs
    //    one waterfall each, and a refusal names every offending id so the
    //    caller can stop them all at once.
    const active = []
    for (const id of lineage) {
      const activity = await this.ctx.waterfall(
        'workspace/session-activity',
        { sessionId: id },
        () => Promise.resolve([])
      )
      if (activity.length > 0) active.push({ sessionId: id, activity })
    }
    if (active.length > 0) {
      throw failed(
        'session/delete-active',
        `session "${sessionId}" still has running work in its lineage; stop it before deleting`,
        { sessionId, active }
      )
    }

    // 3. Resolve every header before anything is removed: the persistence
    //    `locate` needs each header's `cwd` to name its log directory.
    const headers = new Map()
    for (const id of lineage) headers.set(id, await this.readHeader(id))

    // 4. Take each live session out of the runtime entirely, deepest first, so
    //    no settlement can arrive after the parent's log is gone.
    //
    //    This step is what keeps a deleted-but-open session from lingering as a
    //    phantom row: DSH's session list merges every LIVE session with the
    //    persisted ones, so deleting the log alone leaves an open conversation
    //    listed — and, once it is also detached from workspace accounting, it
    //    shows up under "Ungrouped". Closing the conversation in the UI does not
    //    help either: the browser half only tears down its own event stream and
    //    never asks the Host to release the session.
    for (const id of [...lineage].reverse()) {
      await this.releaseLive(id)
    }

    // 5. Drop the projection-cache rows. The domain table is in-memory state
    //    shared with every reader, so each delete takes effect synchronously.
    try {
      const cache = this.ctx.get('sessionProjectionCache')
      if (cache !== undefined) {
        const table = cache.requireTable()
        for (const id of lineage) await table.delete(id)
      }
    } catch (error) {
      this.ctx.logger.warn(
        `session-delete: clearing the projection cache for the "${sessionId}" lineage failed: ${String(error)}`
      )
    }

    // 6. Delete each durable log directory. `locate` names the current
    //    generation's file; the session directory is its parent.
    for (const id of lineage) {
      try {
        const logPath = this.ctx.sessionPersistence.locate(headers.get(id)).path
        await rm(dirname(logPath), { recursive: true, force: true })
      } catch (error) {
        this.ctx.logger.warn(
          `session-delete: removing the log directory for "${id}" failed: ${String(error)}`
        )
      }
    }

    // 7. Drop each session from the workspace accounting.
    const registry = this.ctx.workspaceRegistry
    for (const id of lineage) {
      for (const entity of [...registry.entities.values()]) {
        if (!entity.record.sessionIds.includes(id)) continue
        try {
          await entity.detachSession(id)
        } catch (error) {
          this.ctx.logger.warn(
            `session-delete: detaching "${id}" from workspace "${entity.id}" failed: ${String(error)}`
          )
        }
      }
      if (registry.archivedSessionIds.includes(id)) {
        await registry.unarchiveSession(id).catch((error) => {
          this.ctx.logger.warn(`session-delete: unarchiving "${id}" failed: ${String(error)}`)
        })
      }
      if (registry.pinnedSessionIds.includes(id)) {
        await registry.unpinSession(id).catch((error) => {
          this.ctx.logger.warn(`session-delete: unpinning "${id}" failed: ${String(error)}`)
        })
      }
    }

    return { sessionId, deletedSessionIds: lineage }
  }

  /**
   * Take one session out of the runtime, so it stops being listed and stops
   * publishing. A session that was opened during this app run is LIVE: DSH
   * promotes it on first history read, keeps it in the session store, and never
   * evicts it, and the persisted-session deletion alone would leave it visible.
   *
   * DSH publishes no per-session removal API, so this reproduces the steps the
   * Agent factory's own teardown takes, in its own order:
   *
   *   1. `cancel({ kind: 'disposed' })` — the same cause the factory uses;
   *   2. `whenIdle()` — let the loop drain;
   *   3. `scope.dispose()` — unwind the agent-scoped registrations;
   *   4. close the persistence write handle — this is what releases the session
   *      directory's kernel write lock, so the log directory is removable
   *      afterwards. DSH 0.2.1 added this as its own teardown step; without it
   *      the directory can stay locked on Windows and the delete silently leaves
   *      the log behind;
   *   5. remove the agent registration;
   *   6. remove the session registration, which emits `session/disposed` and is
   *      what the Session Controller forwards to the browser as
   *      `api-session/removed`, so the row leaves the sidebar immediately.
   *
   * Every step is feature-detected and idempotent, and each is independently
   * contained: a partially live session still gets its durable data removed by
   * the caller. What this cannot reach is the factory's internal abort signal
   * and its ownership bookkeeping; both are reclaimed when the owning fiber
   * unloads (app restart), and the store removals here are identity-checked, so
   * the factory's later teardown of the same agent is a no-op rather than a
   * double removal.
   * @param sessionId - the session to take out of the runtime.
   */
  async releaseLive(sessionId) {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')

    const agent = agents?.get(sessionId)
    if (agent !== undefined) {
      try {
        agent.cancel({ kind: 'disposed' })
      } catch (error) {
        this.ctx.logger.warn(
          `session-delete: cancelling the live agent for "${sessionId}" failed: ${String(error)}`
        )
      }
      try {
        await agent.whenIdle?.()
      } catch (error) {
        this.ctx.logger.warn(
          `session-delete: waiting for the live agent "${sessionId}" to go idle failed: ${String(error)}`
        )
      }
      try {
        await agent.scope?.dispose?.()
      } catch (error) {
        this.ctx.logger.warn(
          `session-delete: disposing the agent scope for "${sessionId}" failed: ${String(error)}`
        )
      }
      await this.closeWriteHandle(sessionId)
      try {
        const entry = agents.store?.get?.(sessionId)
        if (entry === undefined) {
          this.ctx.logger.warn(
            `session-delete: could not unregister the live agent "${sessionId}" — the agent store no longer exposes its entry; the registration will be reclaimed when the app restarts`
          )
        } else {
          entry.detach?.()
        }
      } catch (error) {
        this.ctx.logger.warn(
          `session-delete: unregistering the agent for "${sessionId}" failed: ${String(error)}`
        )
      }
    }

    if (sessions?.get?.(sessionId) !== undefined) {
      try {
        const entry = sessions.store?.get?.(sessionId)
        if (entry === undefined) {
          // This is the regression that would recreate the phantom row: the
          // session stays live, so the list keeps merging it and, once the
          // workspace accounting below drops it, it lands under "Ungrouped".
          this.ctx.logger.warn(
            `session-delete: could not unregister the live session "${sessionId}" — the session store no longer exposes its entry, so it may keep appearing in the sidebar until the app restarts`
          )
        } else {
          entry.detach?.()
        }
      } catch (error) {
        this.ctx.logger.warn(
          `session-delete: unregistering the session "${sessionId}" failed: ${String(error)}`
        )
      }
    }
  }

  /**
   * Close one session's persistence write handle, if it holds one.
   *
   * The handle owns the session directory's kernel write lock and the buffered
   * writer chain. `close()` drains the buffer, releases that lock, and frees the
   * in-process write claim; deleting the log directory before this leaves the
   * lock descriptor open, which on Windows keeps the directory from being
   * removed and silently strands the log — the exact thing this plugin exists to
   * delete.
   *
   * The handle lives in the JSONL backend's write-handle map, keyed by session
   * id. Both it and the backend are private to `@deepseek-ai/dsh-session-persistence-jsonl`,
   * so every hop is feature-detected: a backend without this shape (a different
   * persistence package, or a future rearrangement) simply skips the step and
   * lets the caller's deletion report whatever the filesystem says.
   * @param sessionId - the session whose write handle is closed.
   */
  async closeWriteHandle(sessionId) {
    let handle
    try {
      handle = this.ctx.sessionPersistence?.tracker?.writers?.get?.(sessionId)
    } catch (error) {
      this.ctx.logger.warn(
        `session-delete: could not reach the persistence write handle for "${sessionId}": ${String(error)}`
      )
      return
    }
    if (handle === undefined || handle === null) return
    if (typeof handle.close !== 'function') {
      this.ctx.logger.warn(
        `session-delete: the persistence write handle for "${sessionId}" exposes no close(); the log directory may stay locked`
      )
      return
    }
    try {
      await handle.close()
    } catch (error) {
      this.ctx.logger.warn(
        `session-delete: closing the persistence write handle for "${sessionId}" failed: ${String(error)}`
      )
    }
  }

  /**
   * Collect the session plus every subagent descendant, in stable pre-order.
   *
   * Lineage is read from the durable headers, not from the live Subagent
   * runtime's catalog projection, so a lineage is still complete when an
   * intermediate session is unreadable or its catalog was never registered.
   * Only `origin: 'subagent'` children count: a fork is an independent
   * conversation and survives, exactly as the archive gate treats it.
   * @param sessionId - the root session identity.
   * @returns the lineage's session ids.
   */
  async collectLineage(sessionId) {
    const childrenOf = await this.childrenByParent()
    const lineage = [sessionId]
    const visited = new Set([sessionId])
    const queue = [sessionId]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const child of childrenOf.get(current) ?? []) {
        if (visited.has(child)) continue
        visited.add(child)
        lineage.push(child)
        queue.push(child)
      }
    }
    return lineage
  }

  /**
   * Build the subagent child map from every durable and live header.
   * @returns each parent session id mapped to its subagent children's ids.
   */
  async childrenByParent() {
    const childrenOf = new Map()
    for (const header of await this.listHeaders()) {
      if (header.origin !== 'subagent') continue
      if (header.parentSession === undefined) continue
      const siblings = childrenOf.get(header.parentSession)
      if (siblings === undefined) childrenOf.set(header.parentSession, [header.id])
      else siblings.push(header.id)
    }
    return childrenOf
  }

  /**
   * Every session header this process can see: the durable listing plus the
   * live store, so a lineage that includes an unmaterialized session is still
   * complete.
   * @returns the headers, live entries preferred over stored snapshots.
   */
  async listHeaders() {
    const headers = []
    const seen = new Set()
    for (const session of this.ctx.get('sessions')?.list() ?? []) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      headers.push(session.header)
    }
    for (const snapshot of await this.ctx.sessionPersistence.list()) {
      if (seen.has(snapshot.header.id)) continue
      seen.add(snapshot.header.id)
      headers.push(snapshot.header)
    }
    return headers
  }

  /**
   * Read one session header from the live store or the durable listing, so the
   * project directory that owns its log can be resolved.
   * @param sessionId - session identity.
   * @returns the session header.
   */
  async readHeader(sessionId) {
    const live = this.ctx.get('sessions')?.get(sessionId)
    if (live !== undefined) return live.header
    const snapshots = await this.ctx.sessionPersistence.list()
    const header = snapshots.find((snapshot) => snapshot.header.id === sessionId)?.header
    if (header === undefined) {
      throw failed('session/not-found', `session "${sessionId}" is not live and has no stored log`, {
        sessionId
      })
    }
    return header
  }
}

/**
 * Build a tagged failure the route turns into a status code and a JSON body.
 * @param code - stable failure code.
 * @param message - the human diagnostic.
 * @param details - structured payload for the caller.
 * @returns the tagged error.
 */
function failed(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

/** The HTTP status one failure code maps to. */
const STATUS_OF = {
  'session/not-found': 404,
  'session/delete-active': 409
}

/**
 * Register the delete route on the Connection.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const commands = new SessionDeleteCommands(ctx)

  ctx.effect(() => ctx.connection.fetch.register({
    path: DELETE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ error: 'bad request' }, 400)
      }
      const sessionId = body?.sessionId
      if (!isSessionId(sessionId)) return json({ error: 'bad request' }, 400)
      try {
        return json(await commands.delete(sessionId))
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'session/delete-failed'
        ctx.logger.warn(`session-delete: deleting "${sessionId}" failed: ${String(error)}`)
        return json(
          {
            error: code,
            message: error instanceof Error ? error.message : String(error),
            ...(error?.details === undefined ? {} : { details: error.details })
          },
          STATUS_OF[code] ?? 500
        )
      }
    }
  }), 'session-delete: delete route')
}

export { SessionDeleteCommands, DELETE_PATH, inject }
