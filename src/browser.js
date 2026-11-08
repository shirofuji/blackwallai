// Injected into the Foundry page after login. Each helper takes one JSON argument object and returns
// JSON data; the MCP tools in index.js call them through FoundrySession#call. Folders are addressed
// by path ("Session2/Maps"), documents by id or by name.
window.__mcp = (() => {
  const collection = (type) => {
    const c = game.collections.get(type)
    if (!c) throw new Error(`Unknown document type "${type}". World types: ${[...game.collections.keys()].join(', ')}`)
    return c
  }
  const folderPath = (folder) => {
    const parts = []
    for (let f = folder; f; f = f.folder) parts.unshift(f.name)
    return parts.join('/')
  }
  const splitPath = (path) => String(path ?? '').split('/').map((s) => s.trim()).filter(Boolean)
  const childFolder = (type, name, parent) => game.folders.find((f) => f.type === type && f.name === name
    && (f.folder?.id ?? null) === (parent?.id ?? null))

  const findFolder = (type, path) => {
    let folder = null
    for (const name of splitPath(path)) if (!(folder = childFolder(type, name, folder))) return null
    return folder
  }
  const ensureFolder = async (type, path) => {
    let folder = null
    for (const name of splitPath(path))
      folder = childFolder(type, name, folder) ?? await Folder.create({ name, type, folder: folder?.id ?? null })
    return folder
  }

  const summarize = (doc) => {
    const s = { id: doc.id, name: doc.name }
    if (doc.documentName === 'Folder') return { ...s, documentType: doc.type, path: folderPath(doc), contents: doc.contents.length,
      subfolders: doc.getSubfolders(true).length }
    if (doc.type && doc.type !== 'base') s.type = doc.type
    if (doc.folder) s.folder = folderPath(doc.folder)
    switch (doc.documentName) {
      case 'Scene':
        Object.assign(s, { size: `${doc.width}x${doc.height}`, grid: doc.grid.size, walls: doc.walls.size,
          doors: doc.walls.filter((w) => w.door).length, lights: doc.lights.size, tokens: doc.tokens.size })
        if (doc.active) s.active = true
        break
      case 'Actor': s.items = doc.items.size; break
      case 'JournalEntry': s.pages = doc.pages.size; break
      case 'RollTable': s.results = doc.results.size; break
      case 'Playlist': s.sounds = doc.sounds.size; break
    }
    return s
  }

  // One document by id, or by name (optionally within a folder path). Names must be unambiguous.
  const findDoc = (type, { id, name, folder }) => {
    const c = collection(type)
    if (id) {
      const doc = c.get(id)
      if (!doc) throw new Error(`No ${type} with id ${id}.`)
      return doc
    }
    if (!name) throw new Error('Give an id or a name.')
    let docs = c.filter((d) => d.name === name)
    if (folder !== undefined) docs = docs.filter((d) => folderPath(d.folder) === splitPath(folder).join('/'))
    if (!docs.length) throw new Error(`No ${type} named "${name}"${folder ? ` in ${folder}` : ''}.`)
    if (docs.length > 1) throw new Error(`${docs.length} ${type}s are named "${name}": `
      + docs.map((d) => `${d.id} (${folderPath(d.folder) || 'no folder'})`).join(', ') + '. Use an id.')
    return docs[0]
  }

  const cleanForCreate = (data, keepId) => {
    const d = foundry.utils.deepClone(data)
    delete d.folder
    delete d._stats
    if (!keepId) delete d._id
    return d
  }

  const thumbnail = async (scene) => {
    if (!scene.background?.src || game.settings.get('core', 'noCanvas')) return false
    const t = await scene.createThumbnail().catch(() => null)
    if (t?.thumb) await scene.update({ thumb: t.thumb })
    return !!t?.thumb
  }

  // Tokens can be given as { actorId | actorName, x, y, ...overrides }: they start from the actor's prototype token.
  const expandTokens = async (data) => Promise.all(data.map(async (t) => {
    if (!t.actorId && !t.actorName) return t
    const { actorId, actorName, ...rest } = t
    const actor = findDoc('Actor', { id: actorId, name: actorName })
    const token = await actor.getTokenDocument(rest)
    return token.toObject()
  }))

  const embeddedSummary = (doc) => {
    switch (doc.documentName) {
      case 'Item': return { id: doc.id, name: doc.name, type: doc.type }
      case 'JournalEntryPage': return { id: doc.id, name: doc.name, type: doc.type }
      case 'ActiveEffect': return { id: doc.id, name: doc.name, disabled: doc.disabled }
      case 'Token': return { id: doc.id, name: doc.name, actorId: doc.actorId, actorLink: doc.actorLink, x: doc.x, y: doc.y, hidden: doc.hidden }
      default: return doc.toObject()
    }
  }

  const create = async ({ type, data, folder, onDuplicate = 'skip', dryRun = false, keepId = false, thumbnails = true }) => {
    const cls = CONFIG[type]?.documentClass
    if (!cls) throw new Error(`Unknown document type "${type}".`)
    const docs = (Array.isArray(data) ? data : [data]).map((d) => cleanForCreate(d, keepId))
    // For type Folder, `folder` is the parent folder of the new folders, which must already exist.
    const folderType = type === 'Folder' ? docs[0]?.type : type
    const existing = folder ? findFolder(folderType, folder) : null
    if (folder && !existing && type === 'Folder') throw new Error(`No ${folderType} folder ${folder}.`)
    const folderMissing = !!folder && !existing
    const result = { folder: folder ? splitPath(folder).join('/') : null, created: [], skipped: [], replaced: [] }
    if (folderMissing) result.folderCreated = dryRun ? 'would be created' : true

    const toCreate = []
    for (const d of docs) {
      if (!d.name) throw new Error(`Every ${type} needs a name.`)
      const dupes = folderMissing ? [] : collection(type).filter((x) => x.name === d.name
        && (x.folder?.id ?? null) === (existing?.id ?? null) && (type !== 'Folder' || x.type === d.type))
      if (dupes.length && onDuplicate === 'skip') { result.skipped.push({ name: d.name, existing: dupes.map((x) => x.id) }); continue }
      if (dupes.length && onDuplicate === 'replace') result.replaced.push(...dupes.map(summarize))
      toCreate.push(d)
    }
    if (dryRun) {
      result.dryRun = true
      result.created = toCreate.map((d) => ({ name: d.name, type: d.type }))
      return result
    }
    const target = folderMissing ? await ensureFolder(folderType, folder) : existing
    if (result.replaced.length) await cls.deleteDocuments(result.replaced.map((r) => r.id))
    if (type === 'Scene') for (const d of toCreate) if (d.tokens?.length) d.tokens = await expandTokens(d.tokens)
    const made = toCreate.length
      ? await cls.createDocuments(toCreate.map((d) => (target ? { ...d, folder: target.id } : d)), { keepId, keepEmbeddedIds: true })
      : []
    if (type === 'Scene' && thumbnails) for (const s of made) await thumbnail(s)
    result.created = made.map(summarize)
    return result
  }

  return {
    status: () => ({
      world: { id: game.world.id, title: game.world.title },
      system: { id: game.system.id, title: game.system.title, version: game.system.version },
      foundry: game.version,
      user: { name: game.user.name, role: Object.entries(CONST.USER_ROLES).find(([, v]) => v === game.user.role)?.[0] },
      online: game.users.filter((u) => u.active).map((u) => `${u.name}${u.isGM ? ' (GM)' : ''}`),
      activeScene: game.scenes.active?.name ?? null,
      counts: Object.fromEntries([...game.collections.entries()].map(([k, c]) => [k, c.size])),
    }),

    list: ({ type, folder, name, recursive = true, folderType, limit = 200 }) => {
      let docs = collection(type).contents
      if (type === 'Folder' && folderType) docs = docs.filter((f) => f.type === folderType)
      if (folder !== undefined) {
        const p = splitPath(folder).join('/')
        docs = docs.filter((d) => { const at = folderPath(d.folder); return at === p || (recursive && p && at.startsWith(p + '/')) })
      }
      if (name) docs = docs.filter((d) => d.name?.toLowerCase().includes(name.toLowerCase()))
      if (type === 'Folder') docs.sort((a, b) => folderPath(a).localeCompare(folderPath(b)))
      return { total: docs.length, documents: docs.slice(0, limit).map(summarize), truncated: docs.length > limit || undefined }
    },

    get: ({ type, id, name, folder, path }) => {
      const doc = findDoc(type, { id, name, folder })
      const data = doc.toObject()
      return { uuid: doc.uuid, ...(path ? { path, value: foundry.utils.getProperty(data, path) ?? null } : { data }) }
    },

    create,

    update: async ({ type, id, name, folder, changes, dryRun = false }) => {
      const doc = findDoc(type, { id, name, folder })
      const diff = foundry.utils.diffObject(doc.toObject(), foundry.utils.expandObject(changes))
      const deletions = Object.keys(foundry.utils.flattenObject(changes)).filter((k) => k.split('.').pop().startsWith('-='))
      if (!Object.keys(diff).length && !deletions.length) return { document: summarize(doc), changed: false }
      if (!dryRun) await doc.update(changes)
      return { document: summarize(doc), changes: diff, deletions: deletions.length ? deletions : undefined, dryRun: dryRun || undefined }
    },

    delete: async ({ type, ids = [], names = [], folder, dryRun = false, withContents = false }) => {
      const docs = [...ids.map((id) => findDoc(type, { id })), ...names.map((name) => findDoc(type, { name, folder }))]
      const summary = docs.map(summarize)
      if (dryRun || !docs.length) return { dryRun: dryRun || undefined, deleted: summary }
      const options = type === 'Folder' ? { deleteSubfolders: withContents, deleteContents: withContents } : {}
      await CONFIG[type].documentClass.deleteDocuments(docs.map((d) => d.id), options)
      return { deleted: summary }
    },

    embedded: async ({ parentType, parentId, parentName, embedded, action, data = [], ids = [], dryRun = false }) => {
      const parent = findDoc(parentType, { id: parentId, name: parentName })
      const coll = parent.getEmbeddedCollection(embedded)
      const head = () => ({ parent: summarize(parent), embedded })
      if (action === 'list') return { ...head(), documents: coll.contents.map(embeddedSummary) }
      if (dryRun) return { ...head(), action, dryRun: true, count: action === 'delete' ? ids.length : data.length,
        targets: action === 'create' ? undefined : (action === 'delete' ? ids : data.map((d) => d._id)).map((i) => {
          const d = coll.get(i); return d ? embeddedSummary(d) : { id: i, missing: true } }) }
      if (action === 'create') {
        const docs = embedded === 'Token' ? await expandTokens(data) : data
        const made = await parent.createEmbeddedDocuments(embedded, docs)
        return { ...head(), created: made.map(embeddedSummary) }
      }
      if (action === 'update') {
        const missing = data.filter((d) => !coll.get(d._id))
        if (missing.length) throw new Error(`No ${embedded} with _id ${missing.map((d) => d._id).join(', ')} on ${parent.name}.`)
        const done = await parent.updateEmbeddedDocuments(embedded, data)
        return { ...head(), updated: done.map(embeddedSummary) }
      }
      if (action === 'delete') {
        const missing = ids.filter((i) => !coll.get(i))
        if (missing.length) throw new Error(`No ${embedded} with id ${missing.join(', ')} on ${parent.name}.`)
        const done = await parent.deleteEmbeddedDocuments(embedded, ids)
        return { ...head(), deleted: done.map(embeddedSummary) }
      }
      throw new Error(`Unknown action ${action}.`)
    },

    upload: async ({ dir, name, base64, mime }) => {
      const parts = splitPath(dir)
      for (let i = 1; i <= parts.length; i++) await FilePicker.createDirectory('data', parts.slice(0, i).join('/')).catch(() => null)
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const res = await FilePicker.upload('data', parts.join('/'), new File([bytes], name, { type: mime }), {}, { notify: false })
      if (!res?.path) throw new Error(`Upload of ${name} failed: ${res?.message ?? 'no path returned'}`)
      return { path: res.path, bytes: bytes.length }
    },

    browse: async ({ dir = '', extensions }) => {
      const res = await FilePicker.browse('data', dir, extensions ? { extensions } : {})
      return { dir: res.target, dirs: res.dirs, files: res.files }
    },

    imageSize: async ({ src }) => {
      const tex = await loadTexture(src)
      if (!tex) throw new Error(`Could not load ${src}.`)
      return { width: tex.width, height: tex.height }
    },

    thumbnail: async ({ id, name }) => {
      const scene = findDoc('Scene', { id, name })
      return { scene: summarize(scene), thumbnail: await thumbnail(scene) }
    },

    packs: () => game.packs.map((p) => ({ id: p.collection, label: p.metadata.label, documentType: p.documentName,
      package: p.metadata.packageName, entries: p.index.size })),

    compendiumSearch: async ({ query = '', pack, documentType, itemType, limit = 50 }) => {
      const q = query.toLowerCase()
      const hits = []
      for (const p of game.packs) {
        if (pack && p.collection !== pack) continue
        if (documentType && p.documentName !== documentType) continue
        const index = await p.getIndex({ fields: ['type'] })
        for (const e of index) {
          if (q && !e.name.toLowerCase().includes(q)) continue
          if (itemType && e.type !== itemType) continue
          hits.push({ uuid: e.uuid ?? `Compendium.${p.collection}.${p.documentName}.${e._id}`, name: e.name, type: e.type, pack: p.collection })
        }
      }
      hits.sort((a, b) => (a.name.toLowerCase() === q ? -1 : 0) - (b.name.toLowerCase() === q ? -1 : 0) || a.name.localeCompare(b.name))
      return { total: hits.length, results: hits.slice(0, limit), truncated: hits.length > limit || undefined }
    },

    compendiumImport: async ({ uuids, folder, onDuplicate = 'skip', dryRun = false }) => {
      const byType = {}
      for (const uuid of uuids) {
        const doc = await fromUuid(uuid)
        if (!doc?.pack) throw new Error(`${uuid} is not a compendium document.`)
        ;(byType[doc.documentName] ??= []).push(game.collections.get(doc.documentName).fromCompendium(doc, { keepId: false }))
      }
      const results = {}
      for (const [type, data] of Object.entries(byType)) results[type] = await create({ type, data, folder, onDuplicate, dryRun })
      return results
    },

    chatLog: ({ limit = 20 }) => {
      const text = (html) => { const div = document.createElement('div'); div.innerHTML = html ?? ''; return div.innerText.replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim() }
      return game.messages.contents.slice(-limit).map((m) => ({
        id: m.id, time: new Date(m.timestamp).toISOString(), author: m.author?.name, speaker: m.speaker?.alias,
        flavor: text(m.flavor) || undefined, content: text(m.content).slice(0, 800) || undefined,
        rolls: m.rolls.length ? m.rolls.map((r) => ({ formula: r.formula, total: r.total })) : undefined,
        whisperTo: m.whisper.length ? m.whisper.map((u) => game.users.get(u)?.name) : undefined,
      }))
    },
  }
})()
