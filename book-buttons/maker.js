// Book Buttons: talking buttons that float over a teacher's adapted book or
// activity. The activity itself (Google Slides, PowerPoint, a PDF viewer) is
// never opened, changed or uploaded here: pictures come from a frozen screen
// grab of it, or from the picture library. The result downloads as one HTML
// file (panel.html with the button sets embedded in the shared "calm-buttons"
// JSON format), and the sets can be exported to the browser extension.
// Work in progress is kept in IndexedDB on this computer.
/* global localStorage, document, window, navigator, indexedDB, setTimeout, clearTimeout, atob, btoa, fetch, URL, confirm, requestAnimationFrame, Image, Audio, SpeechSynthesisUtterance, FileReader, MediaRecorder, Blob, BroadcastChannel */

const DB_NAME = 'calming-corner-book-maker'
const DB_STORE = 'activities'
const DB_KEY = 'current'
const FORMAT = 'calm-buttons'
const DATA_TAG = '<script type="application/json" id="calm-buttons">null</script>'
const ASSET_TAG = '<script type="application/json" id="panel-assets">null</script>'
const RECORD_SECONDS = 8 // also the longest recording
/* The same limits as the browser extension, so sets move both ways without losing anything.
   The panel shows 12 buttons at a time and pages through longer sets. */
const MAX_BUTTONS = 200
const MAX_SETS = 500
const LABEL_MAX = 80
const SAY_MAX = 300
const NAME_MAX = 80
const PICTURE_SIZE = 512
const GRAB_WAIT = 2000
const CREDITS = 'Pictures: Mulberry Symbols by Steve Lee and OpenMoji, both CC BY-SA 4.0'

/* Fitzgerald-style colour key: the same keys and colours as the classroom board and Talk Boards. */
export const CATEGORIES = [
  { key: 'pronoun', name: 'People', hint: 'I, you, mum', color: '#f8efae' },
  { key: 'verb', name: 'Actions', hint: 'put on, take off', color: '#d8eed3' },
  { key: 'describe', name: 'Describing', hint: 'warm, big, red', color: '#cde4f6' },
  { key: 'noun', name: 'Things', hint: 'scarf, hat, coat', color: '#fde0c2' },
  { key: 'place', name: 'Little words', hint: 'in, on, under', color: '#e6def1' },
  { key: 'social', name: 'Social', hint: 'hello, please', color: '#f9d3e3' },
  { key: 'question', name: 'Questions', hint: 'what, where', color: '#d9c8ef' },
  { key: 'negative', name: 'No / not', hint: "no, don't", color: '#f6c6c3' },
  { key: 'neutral', name: 'Other', hint: '', color: '#ffffff' },
]
const CATEGORY = new Map(CATEGORIES.map((c) => [c.key, c]))
/* The core strip (fixed words in fixed places, see panel.html). */
const CORE = ['i', 'want', 'put', 'on', 'off', 'more', 'finished', 'help', 'stop', 'go', 'no']

const $ = (id) => document.getElementById(id)

let panelHTML = ''
let library = []
const libraryById = new Map()
let voices = new Set()
let act = null
let setIndex = 0
let editing = null
let sayLinked = false
let recorder = null

/* Matches slugify() in classroom-board/render_voice.py, which names the clips. */
export function slugify(text) {
  return String(text).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const num01 = (n) => Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) <= 1

/* ---------- the activity being made ---------- */
function blank() {
  return { v: 1, title: 'My adapted book', core: true, sentence: true, credit: false, sets: [newSet('Page 1')], tray: [], images: {}, recordings: {} }
}
function newSet(name) { return { id: uid('s'), name, slide: null, buttons: [] } }
function cleanButton(b) {
  const pos = b.pos && ['x', 'y', 'w', 'h'].every((k) => num01(b.pos[k])) ? { x: +b.pos.x, y: +b.pos.y, w: +b.pos.w, h: +b.pos.h } : null
  return {
    id: typeof b.id === 'string' && b.id ? b.id.slice(0, 60) : uid('b'),
    label: String(b.label || '').slice(0, LABEL_MAX),
    say: String(b.say || '').slice(0, SAY_MAX),
    category: CATEGORY.has(b.category) ? b.category : 'neutral',
    picture: typeof b.picture === 'string' ? b.picture : null,
    recording: typeof b.recording === 'string' ? b.recording : null,
    pos,
  }
}
function normalize(a) {
  const out = blank()
  out.title = String(a.title || out.title).slice(0, 80)
  out.core = a.core !== false
  out.sentence = a.sentence !== false
  out.credit = !!a.credit
  out.savedAt = Number(a.savedAt) || 0
  out.images = a.images && typeof a.images === 'object' ? { ...a.images } : {}
  out.recordings = a.recordings && typeof a.recordings === 'object' ? { ...a.recordings } : {}
  out.tray = (Array.isArray(a.tray) ? a.tray : []).filter((id) => out.images[id])
  const sets = (Array.isArray(a.sets) ? a.sets : []).slice(0, MAX_SETS).map((s, i) => ({
    id: typeof s.id === 'string' && s.id ? s.id : uid('s'),
    name: String(s.name ?? `Page ${i + 1}`).slice(0, NAME_MAX),
    slide: typeof s.slide === 'string' || typeof s.slide === 'number' ? s.slide : null,
    buttons: (Array.isArray(s.buttons) ? s.buttons : []).slice(0, MAX_BUTTONS).map(cleanButton),
  }))
  if (sets.length) out.sets = sets
  // Every set and button needs its own id: editing and deleting find them by id.
  const ids = new Set()
  for (const x of out.sets.flatMap((st) => [st, ...st.buttons])) {
    if (ids.has(x.id)) x.id = uid(x.buttons ? 's' : 'b')
    ids.add(x.id)
  }
  for (const b of out.sets.flatMap((s) => s.buttons)) if (b.recording && !out.recordings[b.recording]) b.recording = null
  return out
}
function addImage(url) {
  const id = uid('a')
  act.images[id] = url
  return id
}
function prune() {
  const buttons = act.sets.flatMap((s) => s.buttons)
  const used = new Set([...act.tray, ...buttons.map((b) => b.picture)])
  for (const id of Object.keys(act.images)) if (!used.has(id)) delete act.images[id]
  const rec = new Set(buttons.map((b) => b.recording))
  for (const id of Object.keys(act.recordings)) if (!rec.has(id)) delete act.recordings[id]
}
const currentSet = () => act.sets[setIndex]

/* ---------- saving in the browser (IndexedDB) ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, 2)
    } catch (err) {
      reject(err)
      return
    }
    req.onupgradeneeded = () => {
      for (const name of [...req.result.objectStoreNames]) req.result.deleteObjectStore(name)
      req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('blocked'))
  })
}
async function dbRun(write, value) {
  const db = await openDB()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, write ? 'readwrite' : 'readonly')
      const store = tx.objectStore(DB_STORE)
      const req = write ? store.put(value, DB_KEY) : store.get(DB_KEY)
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error || req.error)
      tx.onabort = () => reject(tx.error || new Error('aborted'))
    })
  } finally {
    db.close()
  }
}
async function restore() {
  let raw = null
  try {
    raw = await dbRun(false)
  } catch {
    raw = null
  }
  const journal = readJournal()
  if (journal && (!raw || (journal.savedAt || 0) >= (raw.savedAt || 0))) raw = journal
  return raw && raw.v === 1 ? normalize(raw) : null
}
let saveTimer = 0
let saving = Promise.resolve()
function saveNow() {
  clearTimeout(saveTimer)
  saveTimer = 0
  if (!act) return
  prune()
  act.savedAt = Date.now()
  const snapshot = JSON.parse(JSON.stringify(act))
  saving = dbRun(true, snapshot).then(
    () => { document.documentElement.dataset.saved = String(Date.now()) },
    () => setStatus('This browser could not save your work. Download the panel to keep it.', true),
  )
}
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 400)
}
/* Don't lose the last few changes when the tab closes or is hidden. A browser may
   drop a database write that starts as the page closes, so the latest changes also
   go into a small synchronous journal in localStorage (when they fit), which the
   next start reads if it is newer than the database. */
const JOURNAL = `${DB_NAME}:journal`
function flush() {
  if (!saveTimer) return
  saveNow()
  try { localStorage.setItem(JOURNAL, JSON.stringify(act)) } catch { /* too big or no storage: the database write is all we have */ }
}
window.addEventListener('pagehide', flush)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
function readJournal() {
  try {
    const raw = JSON.parse(localStorage.getItem(JOURNAL))
    localStorage.removeItem(JOURNAL)
    return raw && raw.v === 1 ? raw : null
  } catch {
    return null
  }
}
function changed() {
  save()
  render()
}
function setStatus(text, warn = false) {
  $('status').textContent = text
  $('status').classList.toggle('warn', warn)
}

/* ---------- pictures and voices ---------- */
function pictureURL(id) {
  if (!id) return null
  if (act.images[id]) return act.images[id]
  if (id.startsWith('m:')) return `library/mulberry/${encodeURIComponent(id.slice(2))}.svg`
  if (id.startsWith('o:')) return `library/openmoji/${encodeURIComponent(id.slice(2))}.svg`
  if (id.startsWith('core:')) return `core/${encodeURIComponent(id.slice(5))}.svg`
  return null
}
function pictureName(id) {
  if (!id) return 'No picture'
  if (act.images[id]) return act.tray.includes(id) ? 'Grabbed from the activity' : 'Your picture'
  const entry = libraryById.get(id)
  return entry ? `${entry[1]} (${id.startsWith('m:') ? 'Mulberry' : 'OpenMoji'})` : id
}
const spoken = (b) => (b.say || b.label || '').trim()
/* Voice order: a Calming Corner clip for the words, then the teacher's recording, then the device's voice. */
function voiceOf(b) {
  const slug = slugify(spoken(b))
  if (slug && voices.has(slug)) return { calm: slug }
  if (b.recording && act.recordings[b.recording]) return { recording: act.recordings[b.recording] }
  return null
}
function voiceText(b) {
  const v = voiceOf(b)
  if (v?.calm) return 'Calming Corner voice'
  if (v) return 'your recording'
  return spoken(b) ? "device's voice" : 'silent'
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fetched = new Map()
function fetchBase64(url) {
  if (!fetched.has(url)) {
    fetched.set(url, fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`Could not load ${url}`)
      return base64(await res.arrayBuffer())
    }))
    fetched.get(url).catch(() => fetched.delete(url))
  }
  return fetched.get(url)
}
async function pictureData(id) {
  const url = pictureURL(id)
  if (!url) return null
  if (url.startsWith('data:')) return url
  return `data:image/svg+xml;base64,${await fetchBase64(url)}`
}
/* A button's clip as { clip: bare base64, type }, the way the extension writes clips. */
async function clipData(b) {
  const v = voiceOf(b)
  if (!v) return null
  if (v.calm) return { clip: await fetchBase64(`voices/calm/${v.calm}.mp3`), type: 'audio/mpeg' }
  const m = v.recording.match(/^data:([^;,]*)[^,]*;base64,(.*)$/s)
  return m ? { clip: m[2], type: m[1] || sniffAudio(m[2]) } : null
}
/* What kind of audio some base64 is, from its first bytes (the extension records WebM). */
export function sniffAudio(b64) {
  let head = ''
  try { head = atob(b64.slice(0, 24)) } catch { return 'audio/mpeg' }
  const at = (i) => head.charCodeAt(i)
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'audio/webm'
  if (head.startsWith('OggS')) return 'audio/ogg'
  if (head.startsWith('RIFF')) return 'audio/wav'
  if (head.slice(4, 8) === 'ftyp') return 'audio/mp4'
  return 'audio/mpeg'
}
const AUDIO_TYPE = /^audio\/[a-z0-9.+-]+$/i
const BASE64 = /^[A-Za-z0-9+/=\s]+$/

/* ---------- the shared "calm-buttons" format ---------- */
/* Pictures are data URLs. A clip is bare base64 audio: an MP3 for a Calming
   Corner clip, usually WebM for a teacher's recording. The optional clipType
   says which; readers without it can tell from the audio's first bytes. */
const usesLibrary = () => act.credit || act.sets.some((s) => s.buttons.some((b) => /^[mo]:/.test(b.picture || '')))
async function toCalm() {
  prune()
  return {
    format: FORMAT,
    version: 1,
    title: act.title,
    core: act.core,
    sentence: act.sentence,
    ...(usesLibrary() ? { credits: CREDITS } : {}),
    sets: await Promise.all(act.sets.map(async (s) => ({
      name: s.name,
      ...(s.slide != null ? { slide: s.slide } : {}),
      buttons: await Promise.all(s.buttons.map(async (b) => {
        const c = await clipData(b)
        return {
          id: b.id, label: b.label, say: spoken(b), category: b.category,
          picture: await pictureData(b.picture), clip: c ? c.clip : null, ...(c ? { clipType: c.type } : {}), ...(b.pos || {}),
        }
      })),
    }))),
  }
}
/* Reads a calm-buttons file. Sets and buttons get fresh ids, so the same file can
   be added twice. Anything over the limits is reported in notes, never dropped silently. */
function fromCalm(doc) {
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.sets)) throw new Error('it has no button sets in it')
  if (typeof doc.version === 'number' && doc.version > 1) throw new Error('it was made by a newer version')
  const a = blank()
  const notes = []
  a.title = String(doc.title || a.title).slice(0, 80)
  a.core = doc.core !== false
  a.sentence = doc.sentence !== false
  a.credit = typeof doc.credits === 'string' && !!doc.credits
  if (doc.sets.length > MAX_SETS) notes.push(`only the first ${MAX_SETS} of its ${doc.sets.length} sets were kept`)
  let long = 0
  const seen = new Map()
  a.sets = doc.sets.slice(0, MAX_SETS).map((s, i) => ({
    id: uid('s'),
    name: String(s?.name ?? `Page ${i + 1}`).slice(0, NAME_MAX),
    slide: typeof s?.slide === 'string' || typeof s?.slide === 'number' ? s.slide : null,
    buttons: (Array.isArray(s?.buttons) ? s.buttons : []).filter((b) => b && typeof b === 'object').filter((b, n, list) => {
      if (n === MAX_BUTTONS) notes.push(`“${s.name || `Set ${i + 1}`}” has ${list.length} buttons; only the first ${MAX_BUTTONS} were kept`)
      return n < MAX_BUTTONS
    }).map((b) => {
      if (String(b.label ?? '').length > LABEL_MAX || String(b.say ?? '').length > SAY_MAX) long++
      let picture = null
      if (typeof b.picture === 'string' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/.test(b.picture)) {
        if (!seen.has(b.picture)) {
          const id = uid('a')
          a.images[id] = b.picture
          a.tray.push(id)
          seen.set(b.picture, id)
        }
        picture = seen.get(b.picture)
      }
      let recording = null
      const slug = slugify(b.say || b.label || '')
      const clip = typeof b.clip === 'string' ? b.clip.trim() : ''
      if (clip && !(slug && voices.has(slug))) {
        const m = clip.match(/^data:(audio\/[^;,]+)[^,]*;base64,(.*)$/s)
        const body = m ? m[2] : clip
        if (BASE64.test(body.slice(0, 4096))) {
          const type = m ? m[1] : AUDIO_TYPE.test(b.clipType || '') ? b.clipType : sniffAudio(body)
          recording = uid('r')
          a.recordings[recording] = `data:${type};base64,${body.replace(/\s+/g, '')}`
        }
      }
      const pos = ['x', 'y', 'w', 'h'].every((k) => num01(b[k])) ? { x: b.x, y: b.y, w: b.w, h: b.h } : null
      return cleanButton({ ...b, id: null, picture, recording, pos })
    }),
  }))
  if (long) notes.push(`${long} button${long === 1 ? "'s words were" : "s' words were"} shortened to ${LABEL_MAX} characters (${SAY_MAX} for what it says)`)
  if (!a.sets.length) a.sets = [newSet('Page 1')]
  return { act: normalize(a), notes }
}
async function readActivity(file) {
  const text = await file.text()
  let doc
  if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) {
    try { doc = JSON.parse(text) } catch { throw new Error('it is not a button-sets file') }
  } else {
    const m = text.match(/<script type="application\/json" id="calm-buttons">([\s\S]*?)<\/script>/)
    try { doc = m && JSON.parse(m[1]) } catch { doc = null }
  }
  return fromCalm(doc)
}

async function assets() {
  const core = {}
  if (act.core) {
    await Promise.all(CORE.map(async (slug) => {
      core[slug] = {
        picture: await pictureData(`core:${slug}`),
        clip: voices.has(slug) ? await fetchBase64(`voices/calm/${slug}.mp3`) : null,
      }
    }))
  }
  return { core, credits: act.core || usesLibrary() ? CREDITS : '' }
}
const escapeHTML = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
const asJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c')
async function buildHTML() {
  const [data, extra] = await Promise.all([toCalm(), assets()])
  return panelHTML
    .replace('<title>Talking Buttons</title>', () => `<title>${escapeHTML(data.title)}</title>`)
    .replace(DATA_TAG, () => DATA_TAG.replace('null', asJSON(data)))
    .replace(ASSET_TAG, () => ASSET_TAG.replace('null', asJSON(extra)))
}
function saveFile(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 20000)
}
const baseName = () => slugify(act.title) || 'talking-buttons'

/* ---------- drawing the maker ---------- */
function render() {
  $('title').value = act.title
  $('show-core').checked = act.core
  $('show-sentence').checked = act.sentence
  setIndex = Math.max(0, Math.min(act.sets.length - 1, setIndex))
  renderSets()
  renderButtons()
  renderTray()
}

function renderSets() {
  const list = $('sets')
  list.textContent = ''
  act.sets.forEach((s, i) => {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('aria-current', String(i === setIndex))
    b.innerHTML = '<span></span><small></small>'
    b.firstChild.textContent = s.name || `Set ${i + 1}`
    b.lastChild.textContent = `${s.buttons.length} button${s.buttons.length === 1 ? '' : 's'}`
    b.addEventListener('click', () => { setIndex = i; render() })
    li.appendChild(b)
    list.appendChild(li)
  })
  const s = currentSet()
  if (document.activeElement !== $('set-name')) $('set-name').value = s.name
  $('move-up').disabled = setIndex === 0
  $('move-down').disabled = setIndex === act.sets.length - 1
  $('delete-set').disabled = act.sets.length < 2
}

function renderButtons() {
  const list = $('buttons')
  list.textContent = ''
  for (const b of currentSet().buttons) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.style.background = CATEGORY.get(b.category)?.color || '#fff'
    btn.setAttribute('aria-label', `Button: ${b.label || 'no word yet'}`)
    const url = pictureURL(b.picture)
    if (url) {
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      btn.appendChild(img)
    } else {
      const n = document.createElement('span')
      n.className = 'nopic'
      n.textContent = 'No picture'
      btn.appendChild(n)
    }
    const name = document.createElement('b')
    name.textContent = b.label || '(no word yet)'
    const sub = document.createElement('small')
    sub.textContent = spoken(b) ? `says “${spoken(b)}” · ${voiceText(b)}` : 'says nothing yet'
    btn.append(name, sub)
    btn.addEventListener('click', () => openButton(b.id))
    li.appendChild(btn)
    list.appendChild(li)
  }
  if (currentSet().buttons.length < MAX_BUTTONS) {
    const li = document.createElement('li')
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'add'
    add.id = 'add-button'
    add.textContent = '+ Add a button'
    add.addEventListener('click', () => addButton({}))
    li.appendChild(add)
    list.appendChild(li)
  }
  $('how').hidden = act.sets.some((s) => s.buttons.length)
}

function renderTray() {
  const tray = $('tray')
  tray.textContent = ''
  if (!act.tray.length) {
    tray.innerHTML = '<p class="empty">Nothing grabbed yet.</p>'
    return
  }
  for (const id of act.tray) {
    const b = document.createElement('button')
    b.type = 'button'
    b.title = 'Make a button with this picture'
    b.setAttribute('aria-label', 'Grabbed picture: make a button')
    const img = document.createElement('img')
    img.src = act.images[id]
    img.alt = ''
    b.appendChild(img)
    b.addEventListener('click', () => addButton({ picture: id }))
    tray.appendChild(b)
  }
}

function addButton(patch) {
  const set = currentSet()
  if (set.buttons.length >= MAX_BUTTONS) {
    setStatus(`A set holds up to ${MAX_BUTTONS} buttons. Add another set for the next page.`, true)
    return
  }
  const b = cleanButton({ category: 'noun', ...patch })
  set.buttons.push(b)
  changed()
  openButton(b.id)
}

/* ---------- sets ---------- */
$('add-set').addEventListener('click', () => {
  act.sets.splice(setIndex + 1, 0, newSet(`Page ${act.sets.length + 1}`))
  setIndex++
  changed()
  $('set-name').select()
})
$('set-name').addEventListener('input', (e) => {
  currentSet().name = e.target.value.slice(0, NAME_MAX)
  save()
  renderSets()
})
function moveSet(by) {
  const to = setIndex + by
  if (to < 0 || to >= act.sets.length) return
  const [s] = act.sets.splice(setIndex, 1)
  act.sets.splice(to, 0, s)
  setIndex = to
  changed()
}
$('move-up').addEventListener('click', () => moveSet(-1))
$('move-down').addEventListener('click', () => moveSet(1))
$('delete-set').addEventListener('click', () => {
  if (act.sets.length < 2) return
  const s = currentSet()
  if (s.buttons.length && !confirm(`Delete “${s.name}” and its ${s.buttons.length} buttons?`)) return
  act.sets.splice(setIndex, 1)
  changed()
})

/* ---------- grabbing pictures from the activity ---------- */
const grabDialog = $('grab-dialog')
const grabCanvas = $('grab-canvas')
let grabFor = null

/* Captures one frame of the tab or window the teacher picks, then stops the capture at once. */
async function grabFrame() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('This browser cannot grab pictures from another tab or window. Use Chrome or Edge on a computer, or pick from the picture library.', true)
    return false
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', preferCurrentTab: false,
    })
  } catch {
    setStatus('Nothing was grabbed. Choose the tab or window with the activity in it.')
    return false
  }
  const video = document.createElement('video')
  try {
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    // A minimised or hidden window may send no frames at all: give up after 2 seconds.
    const late = (ms) => new Promise((r) => setTimeout(() => r('late'), ms))
    if (await Promise.race([video.play().then(() => 'ok', () => 'late'), late(GRAB_WAIT)]) === 'late') throw new Error('no frames')
    // Wait for a couple of real frames so the picture is not blank.
    for (let i = 0; i < 2; i++) {
      await Promise.race([
        new Promise((r) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => r()) : requestAnimationFrame(() => r()))),
        late(700),
      ])
    }
    if (!video.videoWidth) throw new Error('no frames')
    grabCanvas.width = video.videoWidth
    grabCanvas.height = video.videoHeight
    grabCanvas.getContext('2d').drawImage(video, 0, 0)
    return true
  } catch {
    setStatus('No picture came through. If that window is minimised or hidden, open it and try again.', true)
    return false
  } finally {
    stream.getTracks().forEach((t) => t.stop())
    video.srcObject = null
  }
}
async function startGrab(forButton = null) {
  grabFor = forButton
  if (!(await grabFrame())) return
  $('grab-cuts').textContent = ''
  $('grab-hint').textContent = grabFor
    ? 'Drag a box around the picture for this button.'
    : 'Each box becomes a picture for a button. Drag as many as you like.'
  if (!grabDialog.open) grabDialog.showModal()
  fitGrab()
  setStatus('The capture has stopped. This is a still picture of the activity.')
}
function fitGrab() {
  const stage = $('grab-stage')
  const W = stage.clientWidth - 24, H = stage.clientHeight - 24
  const ratio = grabCanvas.width / grabCanvas.height || 1
  let w = W, h = W / ratio
  if (h > H) { h = H; w = H * ratio }
  $('grab-box').style.width = `${Math.max(0, Math.floor(w))}px`
  $('grab-box').style.height = `${Math.max(0, Math.floor(h))}px`
}
window.addEventListener('resize', () => { if (grabDialog.open) fitGrab() })
$('grab').addEventListener('click', () => startGrab(null))
$('item-grab').addEventListener('click', () => startGrab(editing))
$('grab-again').addEventListener('click', () => startGrab(grabFor))
$('grab-done').addEventListener('click', () => grabDialog.close())
grabDialog.addEventListener('close', () => {
  // The still picture is not kept: only the pieces cut from it.
  grabCanvas.width = grabCanvas.height = 0
  grabFor = null
})

let drag = null
const grabBox = $('grab-box')
function fraction(e) {
  const r = grabBox.getBoundingClientRect()
  const clamp = (v) => Math.max(0, Math.min(1, v))
  return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }
}
grabBox.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return
  e.preventDefault()
  grabBox.setPointerCapture(e.pointerId)
  drag = { id: e.pointerId, start: fraction(e), rect: null }
})
grabBox.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return
  const a = drag.start, b = fraction(e)
  drag.rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
  const sel = $('grab-sel')
  sel.hidden = false
  Object.assign(sel.style, { left: `${drag.rect.x * 100}%`, top: `${drag.rect.y * 100}%`, width: `${drag.rect.w * 100}%`, height: `${drag.rect.h * 100}%` })
})
grabBox.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return
  const r = drag.rect
  drag = null
  $('grab-sel').hidden = true
  if (!r || r.w * grabCanvas.width < 12 || r.h * grabCanvas.height < 12) return
  const url = cut(r)
  const id = addImage(url)
  act.tray.unshift(id)
  const thumb = document.createElement('img')
  thumb.src = url
  thumb.alt = 'Grabbed picture'
  $('grab-cuts').prepend(thumb)
  if (grabFor && current()?.id === grabFor) {
    choosePicture(id)
    renderGrabbed()
    grabDialog.close()
  }
  changed()
  setStatus('Picture added to “Pictures you grabbed”.')
})
grabBox.addEventListener('pointercancel', () => { drag = null; $('grab-sel').hidden = true })

function cut(r) {
  const sw = r.w * grabCanvas.width, sh = r.h * grabCanvas.height
  const s = Math.min(1, PICTURE_SIZE / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * s))
  c.height = Math.max(1, Math.round(sh * s))
  const g = c.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(grabCanvas, r.x * grabCanvas.width, r.y * grabCanvas.height, sw, sh, 0, 0, c.width, c.height)
  const png = c.toDataURL('image/png')
  return png.length < 260_000 ? png : c.toDataURL('image/jpeg', 0.9)
}

/* ---------- editing a button ---------- */
const itemDialog = $('item-dialog')
function current() {
  if (!editing) return null
  for (const s of act.sets) {
    const b = s.buttons.find((x) => x.id === editing)
    if (b) return b
  }
  return null
}
function openButton(id) {
  editing = id
  const b = current()
  if (!b) { editing = null; return }
  sayLinked = !b.say || b.say === b.label
  $('item-label').value = b.label
  $('item-say').value = b.say
  renderCats()
  renderPic()
  updateVoice()
  renderGrabbed()
  $('lib-search').value = b.label
  search()
  showTab(b.picture && /^[mo]:/.test(b.picture) ? 'library' : 'grabbed')
  if (!itemDialog.open) itemDialog.showModal()
  $('item-label').focus()
}
itemDialog.addEventListener('close', () => {
  if (recorder) recorder.stop()
  editing = null
  render()
})
function editButton(patch) {
  Object.assign(current(), patch)
  save()
}
$('item-label').addEventListener('input', (e) => {
  const patch = { label: e.target.value.slice(0, LABEL_MAX) }
  if (sayLinked) {
    patch.say = patch.label
    $('item-say').value = patch.label
  }
  editButton(patch)
  updateVoice()
})
$('item-say').addEventListener('input', (e) => {
  sayLinked = false
  editButton({ say: e.target.value.slice(0, SAY_MAX) })
  updateVoice()
})
$('item-delete').addEventListener('click', () => {
  for (const s of act.sets) {
    const i = s.buttons.findIndex((x) => x.id === editing)
    if (i > -1) s.buttons.splice(i, 1)
  }
  itemDialog.close('deleted')
  changed()
})
function renderCats() {
  const box = $('item-cats')
  box.textContent = ''
  for (const cat of CATEGORIES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = cat.name
    b.title = cat.hint
    b.style.background = cat.color
    b.setAttribute('aria-pressed', String(current().category === cat.key))
    b.addEventListener('click', () => { editButton({ category: cat.key }); renderCats() })
    box.appendChild(b)
  }
}
function renderPic() {
  const b = current()
  const box = $('item-pic')
  box.textContent = ''
  const url = pictureURL(b.picture)
  if (url) {
    const img = document.createElement('img')
    img.src = url
    img.alt = ''
    box.appendChild(img)
  }
  $('item-pic-name').textContent = pictureName(b.picture)
}
function choosePicture(id) {
  editButton({ picture: id })
  renderPic()
  for (const grid of [$('grabbed-pics'), $('lib-results')]) {
    for (const b of grid.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.id === id))
  }
}
function renderGrabbed() {
  const grid = $('grabbed-pics')
  grid.textContent = ''
  if (!act.tray.length) {
    grid.innerHTML = '<p class="empty">No grabbed pictures yet.</p>'
    return
  }
  for (const id of act.tray) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.id = id
    b.setAttribute('aria-selected', String(current()?.picture === id))
    b.setAttribute('aria-label', 'Grabbed picture')
    const img = document.createElement('img')
    img.src = act.images[id]
    img.alt = ''
    b.appendChild(img)
    b.addEventListener('click', () => choosePicture(id))
    grid.appendChild(b)
  }
}
function showTab(which) {
  $('tab-grabbed').setAttribute('aria-selected', String(which === 'grabbed'))
  $('tab-library').setAttribute('aria-selected', String(which === 'library'))
  $('pane-grabbed').hidden = which !== 'grabbed'
  $('pane-library').hidden = which !== 'library'
}
$('tab-grabbed').addEventListener('click', () => showTab('grabbed'))
$('tab-library').addEventListener('click', () => { showTab('library'); $('lib-search').focus() })

function search() {
  const box = $('lib-results')
  box.textContent = ''
  if (!library.length) {
    box.innerHTML = '<p class="empty">The picture library is not installed. Run: node book-maker/build-library.mjs</p>'
    return
  }
  const q = $('lib-search').value.trim().toLowerCase()
  if (!q) {
    box.innerHTML = '<p class="empty">Type a word to find a picture.</p>'
    return
  }
  const terms = q.split(/\s+/)
  const safe = q.replace(/[^a-z0-9 ]/g, '')
  const hits = []
  for (const e of library) {
    const label = e[1].toLowerCase()
    if (!terms.every((t) => `${label} ${e[2]}`.includes(t))) continue
    const rank = label === q ? 0 : label.startsWith(q) ? 1 : safe && new RegExp(`\\b${safe}\\b`).test(label) ? 2 : label.includes(q) ? 3 : 4
    hits.push([rank, label.length, e])
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (!hits.length) {
    box.innerHTML = '<p class="empty">No pictures found. Try a simpler word.</p>'
    return
  }
  for (const [, , [id, label]] of hits.slice(0, 80)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'option')
    b.dataset.id = id
    b.setAttribute('aria-selected', String(current()?.picture === id))
    b.title = `${label} (${id.startsWith('m:') ? 'Mulberry' : 'OpenMoji'})`
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.alt = ''
    img.src = pictureURL(id)
    const span = document.createElement('span')
    span.textContent = label
    b.append(img, span)
    b.addEventListener('click', () => choosePicture(id))
    box.appendChild(b)
  }
}
let searchTimer = 0
$('lib-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 120) })
$('pic-none').addEventListener('click', () => choosePicture(null))
$('pic-upload').addEventListener('click', () => $('pic-file').click())
$('pic-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  const src = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    const s = Math.min(1, PICTURE_SIZE / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.naturalWidth * s))
    c.height = Math.max(1, Math.round(img.naturalHeight * s))
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    const flat = /jpe?g|heic|webp/i.test(file.type)
    choosePicture(addImage(c.toDataURL(flat ? 'image/jpeg' : 'image/png', 0.88)))
  } catch {
    setStatus('That picture could not be opened.', true)
  } finally {
    URL.revokeObjectURL(src)
  }
})

/* ---------- voice ---------- */
function updateVoice() {
  const b = current()
  if (!b) return
  const v = voiceOf(b)
  const text = spoken(b)
  const status = $('voice-status')
  status.classList.toggle('ok', !!v)
  if (v?.calm) status.textContent = `Calming Corner voice: “${text}”.`
  else if (v) status.textContent = 'Your recording plays for this one.'
  else if (!text) status.textContent = 'Type a word first.'
  else status.textContent = `No Calming Corner clip for “${text}”. Record one, or the panel uses the device's own voice.`
  $('voice-play').disabled = !text && !v
  $('voice-remove').hidden = !b.recording
  // A Calming Corner clip always plays first, so a recording would never be heard.
  $('voice-record').hidden = !!v?.calm
  if (!recorder) $('voice-record').textContent = b.recording ? '● Record again' : '● Record'
}
let audio = null
$('voice-play').addEventListener('click', () => {
  const b = current()
  const v = voiceOf(b)
  audio?.pause()
  try { window.speechSynthesis?.cancel() } catch { /* no speech */ }
  if (v) {
    audio = new Audio(v.calm ? `voices/calm/${v.calm}.mp3` : v.recording)
    audio.play().catch(() => {})
  } else if (spoken(b) && window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(spoken(b))
    u.rate = 0.9
    window.speechSynthesis.speak(u)
  }
})
$('voice-remove').addEventListener('click', () => { editButton({ recording: null }); updateVoice() })

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(r.result)
  r.onerror = reject
  r.readAsDataURL(blob)
})
$('voice-record').addEventListener('click', async () => {
  const button = $('voice-record')
  if (recorder) { recorder.stop(); return }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus('This browser cannot record. Try Chrome, Edge or Safari.', true)
    return
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    setStatus('The microphone is blocked. Allow it in the address bar, then try again.', true)
    return
  }
  const b = current()
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t))
  const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const parts = []
  let limit = 0
  r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
  r.onstop = async () => {
    clearTimeout(limit)
    stream.getTracks().forEach((t) => t.stop())
    recorder = null
    button.classList.remove('recording')
    const blob = new Blob(parts, { type: r.mimeType || type || 'audio/webm' })
    if (blob.size && b) {
      const id = uid('r')
      act.recordings[id] = await blobToDataURL(blob)
      b.recording = id
      save()
      setStatus('Recording saved.')
    }
    if (current() === b) updateVoice()
  }
  r.start()
  recorder = r
  button.classList.add('recording')
  button.textContent = '■ Stop'
  setStatus(`Recording… say “${spoken(b)}”, then tap Stop.`)
  limit = setTimeout(() => { if (r.state === 'recording') r.stop() }, RECORD_SECONDS * 1000)
})

/* ---------- files ---------- */
function busy(on) {
  for (const id of ['download', 'export', 'try', 'print', 'open', 'import']) $(id).disabled = on
}
$('download').addEventListener('click', async () => {
  busy(true)
  setStatus('Building the panel…')
  try {
    const blob = new Blob([await buildHTML()], { type: 'text/html' })
    saveFile(blob, `${baseName()}.html`)
    setStatus(`Downloaded ${baseName()}.html (${Math.max(1, Math.round(blob.size / 1024))} KB). Open it and tap Float.`)
  } catch (err) {
    setStatus(`The panel could not be built: ${err.message}`, true)
  } finally {
    busy(false)
  }
})
$('export').addEventListener('click', async () => {
  busy(true)
  try {
    const blob = new Blob([JSON.stringify(await toCalm(), null, 1)], { type: 'application/json' })
    saveFile(blob, `${baseName()}.json`)
    setStatus(`Exported ${act.sets.length} button set${act.sets.length === 1 ? '' : 's'} as ${baseName()}.json.`)
  } catch (err) {
    setStatus(`The button sets could not be exported: ${err.message}`, true)
  } finally {
    busy(false)
  }
})
$('open').addEventListener('click', () => $('open-file').click())
$('import').addEventListener('click', () => $('import-file').click())
$('open-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  if (act.sets.some((s) => s.buttons.length) && !confirm('Open this file instead of the activity you are working on? Download or export it first if you want to keep it.')) return
  try {
    const { act: opened, notes } = await readActivity(file)
    act = opened
    setIndex = 0
    changed()
    setStatus(`Opened ${file.name}.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`, notes.length > 0)
  } catch (err) {
    setStatus(`That file could not be opened: ${err.message}.`, true)
  }
})
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    const { act: other, notes } = await readActivity(file)
    const empty = act.sets.length === 1 && !act.sets[0].buttons.length
    if (empty) act.sets = []
    Object.assign(act.images, other.images)
    Object.assign(act.recordings, other.recordings)
    act.tray.push(...other.tray)
    act.credit = act.credit || other.credit
    const room = MAX_SETS - act.sets.length
    if (other.sets.length > room) notes.push(`only ${Math.max(0, room)} of its ${other.sets.length} sets fitted (${MAX_SETS} at most)`)
    const added = other.sets.slice(0, Math.max(0, room))
    act.sets.push(...added)
    setIndex = empty ? 0 : Math.max(0, act.sets.length - added.length)
    changed()
    setStatus(`Added ${added.length} button set${added.length === 1 ? '' : 's'} from ${file.name}.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`, notes.length > 0)
  } catch (err) {
    setStatus(`That file could not be imported: ${err.message}.`, true)
  }
})
$('new').addEventListener('click', () => {
  if (act.sets.some((s) => s.buttons.length) && !confirm('Start a new activity? Download or export this one first if you want to keep it.')) return
  act = blank()
  setIndex = 0
  changed()
  setStatus('')
})

/* ---------- trying it and printing ---------- */
const preview = $('preview')
function fitFrame() {
  const [w, h] = $('shape').value.split('x').map(Number)
  const stage = $('try-stage')
  const s = Math.min(1, (stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h)
  $('frame').style.width = `${Math.floor(w * s)}px`
  $('frame').style.height = `${Math.floor(h * s)}px`
  preview.style.width = `${w}px`
  preview.style.height = `${h}px`
  preview.style.transform = `scale(${s})`
}
$('try').addEventListener('click', async () => {
  busy(true)
  try {
    const html = await buildHTML()
    const at = setIndex
    preview.onload = () => preview.contentWindow?.postMessage({ type: 'calm-buttons:set', index: at }, '*')
    preview.srcdoc = html
    $('try-dialog').showModal()
    fitFrame()
  } catch (err) {
    setStatus(`The preview could not be built: ${err.message}`, true)
  } finally {
    busy(false)
  }
})
$('try-close').addEventListener('click', () => $('try-dialog').close())
$('try-dialog').addEventListener('close', () => { preview.srcdoc = '' })
$('shape').addEventListener('change', fitFrame)
window.addEventListener('resize', () => { if ($('try-dialog').open) fitFrame() })

$('print').addEventListener('click', async () => {
  busy(true)
  setStatus('Getting the buttons ready to print…')
  try {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1100px;height:850px;border:0'
    frame.srcdoc = await buildHTML()
    document.body.appendChild(frame)
    await new Promise((resolve) => { frame.onload = resolve })
    await Promise.all([...frame.contentDocument.images].map((img) => img.decode().catch(() => {})))
    frame.contentWindow.focus()
    frame.contentWindow.print()
    setStatus('')
    setTimeout(() => frame.remove(), 60_000)
  } catch (err) {
    setStatus(`The buttons could not be got ready to print: ${err.message}`, true)
  } finally {
    busy(false)
  }
})

/* ---------- controls ---------- */
$('title').addEventListener('input', (e) => { act.title = e.target.value.slice(0, 80) || 'My adapted book'; save() })
$('show-core').addEventListener('change', (e) => { act.core = e.target.checked; save() })
$('show-sentence').addEventListener('change', (e) => { act.sentence = e.target.checked; save() })

/* ---------- start ---------- */
async function start() {
  const [tpl, lib, clips] = await Promise.all([
    fetch('panel.html').then((r) => { if (!r.ok) throw new Error('panel.html is missing'); return r.text() }),
    fetch('library/index.json').then((r) => (r.ok ? r.json() : []), () => []),
    fetch('voices/calm/index.json').then((r) => (r.ok ? r.json() : []), () => []),
  ])
  panelHTML = tpl
  library = lib
  for (const e of library) libraryById.set(e[0], e)
  voices = new Set(clips)
  const saved = await restore()
  act = saved || blank()
  render()
  if (saved) save()
  if (saved) setStatus(`Welcome back. “${act.title}” was saved on this computer.`)
  if (!library.length) setStatus('The picture library is missing, so only grabbed and uploaded pictures can be used. To add it, run: node book-maker/build-library.mjs', true)
  watchOtherTabs()
  document.documentElement.dataset.ready = 'true'
}

/* Two maker tabs would overwrite each other's saved work, so each warns about the other. */
function watchOtherTabs() {
  try {
    const channel = new BroadcastChannel(DB_NAME)
    channel.onmessage = (e) => {
      if (e.data === 'hello') channel.postMessage('here')
      if (e.data === 'hello' || e.data === 'here') {
        setStatus('Book Buttons is also open in another tab. Close one of them: changes in one tab overwrite the other.', true)
      }
    }
    channel.postMessage('hello')
  } catch { /* no BroadcastChannel: nothing to warn about */ }
}
start().catch((err) => setStatus(`Book Buttons could not start: ${err.message}. Open it through a web server, not as a file.`, true))

/* For the tests. */
window.bookMaker = { get activity() { return act }, saved: () => saving }
