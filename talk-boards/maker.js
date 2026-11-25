// Talk Boards: builds tap-to-talk boards in the browser and downloads each one
// as a single HTML file (board.html with the board's data, pictures and clips
// embedded). Nothing is sent anywhere; work in progress stays in localStorage.
import { CATEGORIES, COLOR_ROW, TEMPLATES, emptyCell, fromTemplate } from './templates.js'
import { topicStatus } from './fingerprint.js'

const STORE = 'board-maker:board:v1'
const DATA_TAG = '<script type="application/json" id="board-data">null</script>'
const LIMITS = { rows: [1, 8], cols: [1, 10] }
const RECORD_SECONDS = 8

const $ = (id) => document.getElementById(id)
const preview = $('preview')

let templateHTML = ''
let library = []
const libraryById = new Map()
let voices = new Set()
let board = null
let selected = -1
let mode = 'edit'
let sayLinked = false
let recorder = null
const topicsByKey = new Map()
const DRAFT_NOTE = 'Draft – not yet checked by a teacher'

/* Matches slugify() in classroom-board/render_voice.py, which names the clips. */
export function slugify(text) {
  return String(text).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/* ---------- board state ---------- */
function clamp(n, [lo, hi]) { return Math.max(lo, Math.min(hi, Number.parseInt(n, 10) || lo)) }

function normalize(b) {
  const out = {
    version: 1,
    template: b.template || 'custom',
    title: String(b.title || 'My board').slice(0, 60),
    rows: clamp(b.rows, LIMITS.rows),
    cols: clamp(b.cols, LIMITS.cols),
    showSentence: b.showSentence !== false,
    showColors: !!b.showColors,
    recordings: b.recordings && typeof b.recordings === 'object' ? { ...b.recordings } : {},
    uploads: b.uploads && typeof b.uploads === 'object' ? { ...b.uploads } : {},
    cells: [],
  }
  const cats = new Set(CATEGORIES.map((c) => c.key))
  for (let i = 0; i < out.rows * out.cols; i++) {
    const c = (b.cells || [])[i] || {}
    out.cells.push({
      label: String(c.label || '').slice(0, 40),
      say: String(c.say || '').slice(0, 120),
      category: cats.has(c.category) ? c.category : 'neutral',
      picture: typeof c.picture === 'string' ? c.picture : null,
      swatch: /^#[0-9a-f]{3,8}$/i.test(c.swatch || '') ? c.swatch : null,
      recording: typeof c.recording === 'string' && out.recordings[c.recording] ? c.recording : null,
    })
  }
  return out
}

function prune() {
  const used = new Set(board.cells.flatMap((c) => [c.recording, c.picture]))
  for (const id of Object.keys(board.recordings)) if (!used.has(id)) delete board.recordings[id]
  for (const id of Object.keys(board.uploads)) if (!used.has(id)) delete board.uploads[id]
}

function save() {
  prune()
  try {
    localStorage.setItem(STORE, JSON.stringify(board))
    setStatus('')
  } catch (err) {
    const full = err?.name === 'QuotaExceededError' || err?.code === 22 || err?.code === 1014
    setStatus(full
      ? 'This board is too big to save in the browser. Download it to keep it.'
      : 'This browser is not letting Talk Boards save (a private window, or saving is blocked). Download the board to keep it.', true)
  }
  showNotice()
}

/* The topic this board started from, while that topic has not been approved. */
function draftTopic() {
  const key = board?.template?.startsWith('topic:') ? board.template.slice(6) : null
  const topic = key && topicsByKey.get(key)
  return topic && topicStatus(topic) !== 'approved' ? topic : null
}
function showNotice() {
  const topic = draftTopic()
  const el = $('notice')
  el.hidden = !topic
  if (topic) {
    el.textContent = topicStatus(topic) === 'needs-changes'
      ? `“${topic.name}” is a topic starter a teacher asked to change. Check the words and pictures before using it.`
      : `“${topic.name}” is a draft topic starter, not yet checked by a teacher. Check the words and pictures before using it.`
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function setStatus(text, warn = false) {
  const el = $('status')
  el.textContent = text
  el.classList.toggle('warn', warn)
}

/* ---------- pictures and clips ---------- */
function pictureURL(id) {
  if (!id) return null
  if (board.uploads[id]) return board.uploads[id]
  if (id.startsWith('m:')) return `library/mulberry/${encodeURIComponent(id.slice(2))}.svg`
  if (id.startsWith('o:')) return `library/openmoji/${encodeURIComponent(id.slice(2))}.svg`
  return null
}
function pictureName(id) {
  if (!id) return 'No picture'
  if (board.uploads[id]) return 'Your picture'
  const entry = libraryById.get(id)
  const set = id.startsWith('m:') ? 'Mulberry' : 'OpenMoji'
  return entry ? `${entry[1]} (${set})` : id
}
function spoken(cell) { return (cell.say || cell.label || '').trim() }
function clipKey(cell) {
  if (cell.recording && board.recordings[cell.recording]) return `rec:${cell.recording}`
  const slug = slugify(spoken(cell))
  return slug && voices.has(slug) ? `calm:${slug}` : null
}
function clipURL(key) {
  if (key.startsWith('calm:')) return `voices/calm/${key.slice(5)}.mp3`
  if (key.startsWith('rec:')) return board.recordings[key.slice(4)]
  return null
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
async function dataURL(url, type) {
  if (url.startsWith('data:')) return url
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load ${url}`)
  return `data:${type};base64,${base64(await res.arrayBuffer())}`
}
/* Like dataURL, but a file that fails to load is reported instead of stopping the download. */
async function tryDataURL(url, type) {
  try {
    return await dataURL(url, type)
  } catch {
    return null
  }
}

/* The JSON a board file carries. With embed, every picture and clip is inside it;
   anything that fails to load is left out and its square's word goes in `problems`. */
async function boardData(embed, problems = { clips: [], pictures: [] }) {
  const n = board.rows * board.cols
  const pictures = {}
  const clips = {}
  const cells = board.cells.slice(0, n).map((c) => {
    const cell = { label: c.label, say: spoken(c), category: c.category, picture: null, swatch: c.swatch, clip: clipKey(c) }
    if (c.picture && !c.swatch && pictureURL(c.picture)) {
      cell.picture = c.picture
      pictures[c.picture] = pictureURL(c.picture)
    }
    if (cell.clip) clips[cell.clip] = clipURL(cell.clip)
    return cell
  })
  const colors = board.showColors
    ? COLOR_ROW.map(([label, hex]) => ({ label, hex, say: label, clip: voices.has(label) ? `calm:${label}` : null }))
    : []
  for (const c of colors) if (c.clip) clips[c.clip] = clipURL(c.clip)
  if (embed) {
    await Promise.all([
      ...Object.entries(pictures).map(async ([id, url]) => { pictures[id] = await tryDataURL(url, 'image/svg+xml') }),
      ...Object.entries(clips).map(async ([key, url]) => { clips[key] = await tryDataURL(url, 'audio/mpeg') }),
    ])
    for (const [id, src] of Object.entries(pictures)) {
      if (src) continue
      delete pictures[id]
      for (const c of cells) if (c.picture === id) { c.picture = null; problems.pictures.push(c.label) }
    }
    for (const [key, src] of Object.entries(clips)) {
      if (src) continue
      delete clips[key]
      /* The device voice reads these words instead. */
      for (const c of [...cells, ...colors]) if (c.clip === key) { c.clip = null; problems.clips.push(c.label) }
    }
  }
  const draft = draftTopic()
  return {
    version: 1, maker: 'Calming Corner Talk Boards', title: board.title, rows: board.rows, cols: board.cols,
    showSentence: board.showSentence, showColors: board.showColors, cells, colors, assets: { pictures, clips },
    ...(draft ? { note: topicStatus(draft) === 'needs-changes' ? 'Topic starter that a teacher asked to change' : DRAFT_NOTE } : {}),
  }
}

const escapeHTML = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

function buildHTML(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return templateHTML
    .replace('<title>Talk Board</title>', () => `<title>${escapeHTML(data.title)}</title>`)
    .replace(DATA_TAG, () => DATA_TAG.replace('null', json))
}

/* ---------- preview ---------- */
let refreshTimer = 0
function refresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(async () => { preview.srcdoc = buildHTML(await boardData(false)) }, 80)
}
function post(message) { preview.contentWindow?.postMessage(message, '*') }
function postState() {
  post({ type: 'board-maker:mode', edit: mode === 'edit' })
  post({ type: 'board-maker:select', index: selected })
}
window.addEventListener('message', (e) => {
  if (e.source !== preview.contentWindow) return
  const m = e.data || {}
  if (m.type === 'board-maker:ready') postState()
  if (m.type === 'board-maker:cell' && mode === 'edit' && Number.isInteger(m.index)) openCell(m.index)
})

function fitFrame() {
  const [w, h] = $('screen').value.split('x').map(Number)
  const stage = $('stage')
  const s = Math.min((stage.clientWidth - 32) / w, (stage.clientHeight - 32) / h)
  const frame = $('frame')
  frame.style.width = `${Math.floor(w * s)}px`
  frame.style.height = `${Math.floor(h * s)}px`
  preview.style.width = `${w}px`
  preview.style.height = `${h}px`
  preview.style.transform = `scale(${s})`
}

function setMode(next) {
  mode = next
  $('mode-edit').setAttribute('aria-checked', String(mode === 'edit'))
  $('mode-try').setAttribute('aria-checked', String(mode === 'try'))
  $('mode-hint').textContent = mode === 'edit'
    ? 'Tap a square on the board to change it.'
    : 'Tap the pictures to hear them, as children will.'
  postState()
}

function syncControls() {
  $('title').value = board.title
  $('rows').value = board.rows
  $('cols').value = board.cols
  $('show-sentence').checked = board.showSentence
  $('show-colors').checked = board.showColors
}

function changed() { save(); refresh() }

function resize(rows, cols) {
  rows = clamp(rows, LIMITS.rows)
  cols = clamp(cols, LIMITS.cols)
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(r < board.rows && c < board.cols ? board.cells[r * board.cols + c] : emptyCell())
    }
  }
  Object.assign(board, { rows, cols, cells })
  selected = -1
  syncControls()
  changed()
}

/* ---------- editing a square ---------- */
const cellDialog = $('cell-dialog')
const current = () => board.cells[selected]

function openCell(index) {
  if (index < 0 || index >= board.cells.length) return
  selected = index
  const c = current()
  sayLinked = !c.say || c.say === c.label
  $('cell-label').value = c.label
  $('cell-say').value = c.say
  $('cell-heading').textContent = `Square ${Math.floor(index / board.cols) + 1}.${(index % board.cols) + 1}`
  renderCategories()
  renderCurrentPicture()
  updateVoice()
  $('pic-search').value = c.swatch ? '' : c.label
  search()
  postState()
  if (!cellDialog.open) cellDialog.showModal()
  $('cell-label').focus()
}

cellDialog.addEventListener('close', () => {
  if (recorder) recorder.stop()
  selected = -1
  postState()
})

function editCell(patch) {
  Object.assign(current(), patch)
  changed()
}

$('cell-label').addEventListener('input', (e) => {
  const patch = { label: e.target.value }
  if (sayLinked) {
    patch.say = e.target.value
    $('cell-say').value = e.target.value
  }
  editCell(patch)
  updateVoice()
})
$('cell-say').addEventListener('input', (e) => {
  sayLinked = false
  editCell({ say: e.target.value })
  updateVoice()
})

function renderCategories() {
  const box = $('cell-cats')
  box.textContent = ''
  for (const cat of CATEGORIES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = cat.name
    b.title = cat.hint
    b.style.background = cat.color
    b.setAttribute('aria-pressed', String(current().category === cat.key))
    b.addEventListener('click', () => { editCell({ category: cat.key }); renderCategories() })
    box.appendChild(b)
  }
}

function renderCurrentPicture() {
  const c = current()
  const box = $('cell-pic')
  box.textContent = ''
  if (c.swatch) {
    const dot = document.createElement('span')
    dot.className = 'swatch'
    dot.style.background = c.swatch
    box.appendChild(dot)
    $('cell-pic-name').textContent = 'Colour'
  } else if (pictureURL(c.picture)) {
    const img = document.createElement('img')
    img.src = pictureURL(c.picture)
    img.alt = ''
    box.appendChild(img)
    $('cell-pic-name').textContent = pictureName(c.picture)
  } else {
    $('cell-pic-name').textContent = 'No picture'
  }
}

function search() {
  const q = $('pic-search').value.trim().toLowerCase()
  const set = $('pic-set').value
  const box = $('pic-results')
  box.textContent = ''
  if (!q) {
    box.innerHTML = '<p class="empty">Type a word to find a picture.</p>'
    return
  }
  const terms = q.split(/\s+/)
  const hits = []
  for (const e of library) {
    if (set !== 'all' && e[0][0] !== set) continue
    const label = e[1].toLowerCase()
    const text = `${label} ${e[2]}`
    if (!terms.every((t) => text.includes(t))) continue
    const rank = label === q ? 0 : label.startsWith(q) ? 1 : new RegExp(`\\b${q.replace(/[^a-z0-9 ]/g, '')}\\b`).test(label) ? 2 : label.includes(q) ? 3 : 4
    hits.push([rank, label.length, e])
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (!hits.length) {
    box.innerHTML = '<p class="empty">No pictures found. Try a simpler word.</p>'
    return
  }
  for (const [, , [id, label]] of hits.slice(0, 90)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'option')
    b.setAttribute('aria-selected', String(current().picture === id))
    b.dataset.id = id
    b.title = `${label} (${id.startsWith('m:') ? 'Mulberry' : 'OpenMoji'})`
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.alt = ''
    img.src = pictureURL(id)
    const span = document.createElement('span')
    span.textContent = label
    b.append(img, span)
    b.addEventListener('click', () => {
      editCell({ picture: id, swatch: null })
      renderCurrentPicture()
      for (const other of box.children) other.setAttribute('aria-selected', String(other === b))
    })
    box.appendChild(b)
  }
}
let searchTimer = 0
$('pic-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 120) })
$('pic-set').addEventListener('change', search)
/* Enter searches straight away; it must not submit (and close) the dialog. */
$('pic-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  clearTimeout(searchTimer)
  search()
})
for (const close of document.querySelectorAll('dialog .close')) close.addEventListener('click', () => close.closest('dialog').close())
$('pic-none').addEventListener('click', () => { editCell({ picture: null, swatch: null }); renderCurrentPicture(); search() })

$('pic-upload').addEventListener('click', () => $('pic-file').click())
$('pic-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    const url = await shrinkImage(file, 480)
    const id = `u:${Date.now().toString(36)}`
    board.uploads[id] = url
    editCell({ picture: id, swatch: null })
    renderCurrentPicture()
  } catch {
    setStatus('That picture could not be opened.', true)
  }
})

/* Photos are scaled down so boards stay small enough to email. */
function shrinkImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const src = URL.createObjectURL(file)
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round((img.naturalWidth || max) * s))
      canvas.height = Math.max(1, Math.round((img.naturalHeight || max) * s))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(src)
      const flat = /jpe?g|heic|webp/i.test(file.type)
      resolve(canvas.toDataURL(flat ? 'image/jpeg' : 'image/png', 0.85))
    }
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('bad image')) }
    img.src = src
  })
}

$('cell-clear').addEventListener('click', () => {
  board.cells[selected] = emptyCell()
  changed()
  cellDialog.close()
})

/* ---------- voice ---------- */
function updateVoice() {
  const c = current()
  const key = clipKey(c)
  const text = spoken(c)
  const status = $('voice-status')
  status.classList.toggle('ok', !!key)
  if (key?.startsWith('rec:')) status.textContent = 'Your recording plays for this square.'
  else if (key) status.textContent = `Calming Corner voice: “${text}”.`
  else if (!text) status.textContent = 'Type a word first.'
  else status.textContent = `No Calming Corner clip for “${text}”. Record one, or the board will use the device's own voice.`
  $('voice-play').disabled = !text && !key
  $('voice-remove').hidden = !c.recording
  if (!recorder) $('voice-record').textContent = c.recording ? '● Record again' : '● Record'
}

let playing = null
$('voice-play').addEventListener('click', () => {
  const c = current()
  const key = clipKey(c)
  playing?.pause()
  window.speechSynthesis?.cancel()
  if (key) {
    playing = new Audio(clipURL(key))
    playing.play().catch(() => {})
  } else if (window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(spoken(c))
    u.rate = 0.9
    window.speechSynthesis.speak(u)
  }
})
$('voice-remove').addEventListener('click', () => { editCell({ recording: null }); updateVoice() })

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(r.result)
  r.onerror = reject
  r.readAsDataURL(blob)
})

$('voice-record').addEventListener('click', async () => {
  if (recorder) { recorder.stop(); return }
  const status = $('voice-status')
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status.textContent = 'This browser cannot record. Try Chrome, Edge or Safari.'
    return
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    status.textContent = 'The microphone is blocked. Allow it in the address bar, then try again.'
    return
  }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t))
  const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const index = selected
  const parts = []
  const button = $('voice-record')
  let limit = 0
  r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
  r.onstop = async () => {
    clearTimeout(limit)
    stream.getTracks().forEach((t) => t.stop())
    recorder = null
    button.classList.remove('recording')
    const blob = new Blob(parts, { type: r.mimeType || type || 'audio/webm' })
    if (blob.size && board.cells[index]) {
      const id = `r${Date.now().toString(36)}`
      board.recordings[id] = await blobToDataURL(blob)
      board.cells[index].recording = id
      changed()
    }
    if (selected === index) updateVoice()
  }
  r.start()
  recorder = r
  button.classList.add('recording')
  button.textContent = '■ Stop'
  status.textContent = `Recording… say “${spoken(current())}”, then tap Stop.`
  limit = setTimeout(() => { if (r.state === 'recording') r.stop() }, RECORD_SECONDS * 1000)
})

/* ---------- opening a downloaded board ---------- */
function fromFile(text) {
  const m = text.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/)
  const data = m && JSON.parse(m[1])
  if (!data || !Array.isArray(data.cells)) throw new Error('not a board')
  const clips = data.assets?.clips || {}
  const pics = data.assets?.pictures || {}
  const b = { ...data, template: 'opened', recordings: {}, uploads: {} }
  b.cells = data.cells.map((c, i) => {
    const cell = { ...c, recording: null }
    if (typeof c.clip === 'string' && c.clip.startsWith('rec:') && /^data:audio\//.test(clips[c.clip] || '')) {
      cell.recording = c.clip.slice(4)
      b.recordings[cell.recording] = clips[c.clip]
    }
    if (c.picture && !libraryById.has(c.picture)) {
      const src = pics[c.picture]
      if (/^data:image\//.test(src || '')) {
        const id = c.picture.startsWith('u:') ? c.picture : `u:opened${i}`
        b.uploads[id] = src
        cell.picture = id
      } else {
        cell.picture = null
      }
    }
    return cell
  })
  return normalize(b)
}

$('open-board').addEventListener('click', () => $('open-file').click())
$('open-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    board = fromFile(await file.text())
    selected = -1
    syncControls()
    changed()
    setStatus(`Opened ${file.name}.`)
  } catch {
    setStatus('That file is not a board from Talk Boards.', true)
  }
})

/* ---------- download and print ---------- */
function fileName() { return `${slugify(board.title) || 'talk-board'}.html` }

$('download').addEventListener('click', async () => {
  const button = $('download')
  button.disabled = true
  setStatus('Building the board…')
  try {
    const problems = { clips: [], pictures: [] }
    const html = buildHTML(await boardData(true, problems))
    const blob = new Blob([html], { type: 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fileName()
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    const list = (words) => [...new Set(words)].map((w) => `“${w}”`).join(', ')
    const warnings = [
      problems.clips.length && `No voice clip could be loaded for ${list(problems.clips)}, so the device's voice will read ${problems.clips.length === 1 ? 'it' : 'them'}.`,
      problems.pictures.length && `No picture could be loaded for ${list(problems.pictures)}.`,
    ].filter(Boolean)
    setStatus(`Downloaded ${fileName()} (${Math.round(blob.size / 1024)} KB).${warnings.length ? ` ${warnings.join(' ')}` : ''}`, warnings.length > 0)
  } catch (err) {
    setStatus(`The board could not be built: ${err.message}`, true)
  } finally {
    button.disabled = false
  }
})

$('print').addEventListener('click', () => { preview.contentWindow?.focus(); preview.contentWindow?.print() })

/* ---------- controls ---------- */
$('title').addEventListener('input', (e) => { board.title = e.target.value.slice(0, 60) || 'My board'; changed() })
$('rows').addEventListener('change', (e) => resize(e.target.value, board.cols))
$('cols').addEventListener('change', (e) => resize(board.rows, e.target.value))
$('show-sentence').addEventListener('change', (e) => { board.showSentence = e.target.checked; changed() })
$('show-colors').addEventListener('change', (e) => { board.showColors = e.target.checked; changed() })
$('screen').addEventListener('change', fitFrame)
$('mode-edit').addEventListener('click', () => setMode('edit'))
$('mode-try').addEventListener('click', () => setMode('try'))

const newDialog = $('new-dialog')
$('new-board').addEventListener('click', () => {
  if (cellDialog.open) cellDialog.close()
  newDialog.showModal()
})
for (const [key, t] of Object.entries(TEMPLATES)) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.template = key
  b.innerHTML = '<strong></strong><span></span>'
  b.querySelector('strong').textContent = t.name
  b.querySelector('span').textContent = t.blurb
  b.addEventListener('click', () => {
    board = normalize(fromTemplate(key))
    selected = -1
    syncControls()
    changed()
    newDialog.close()
    setMode('edit')
  })
  $('templates').appendChild(b)
}

/* Topic starters: drafted with AI, checked by a teacher with review.html. */
const TOPIC_BADGES = {
  draft: 'Draft – not yet checked by a teacher',
  'needs-changes': 'Needs changes – a teacher asked for edits',
  approved: 'Checked by a teacher',
}
function renderTopics(topics) {
  const box = $('topics')
  box.textContent = ''
  for (const t of topics) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.topic = t.key
    const status = topicStatus(t)
    b.innerHTML = '<strong></strong><span></span><em class="badge"></em>'
    b.querySelector('strong').textContent = t.name
    b.querySelector('span').textContent = t.blurb
    const badge = b.querySelector('.badge')
    badge.textContent = TOPIC_BADGES[status]
    badge.classList.add(status)
    b.addEventListener('click', () => {
      board = normalize({ ...t.board, template: `topic:${t.key}` })
      selected = -1
      syncControls()
      changed()
      newDialog.close()
      setMode('edit')
    })
    box.appendChild(b)
  }
}

for (const cat of CATEGORIES) {
  const li = document.createElement('li')
  li.innerHTML = '<span class="sw"></span><span><b></b> <small></small></span>'
  li.querySelector('.sw').style.background = cat.color
  li.querySelector('b').textContent = cat.name
  li.querySelector('small').textContent = cat.hint
  $('key').appendChild(li)
}

/* ---------- start ---------- */
async function start() {
  const [tpl, lib, clips, topics] = await Promise.all([
    fetch('board.html').then((r) => r.text()),
    fetch('library/index.json').then((r) => (r.ok ? r.json() : []), () => []),
    fetch('voices/calm/index.json').then((r) => (r.ok ? r.json() : []), () => []),
    fetch('topics.json').then((r) => (r.ok ? r.json() : { topics: [] }), () => ({ topics: [] })),
  ])
  templateHTML = tpl
  for (const t of topics.topics || []) topicsByKey.set(t.key, t)
  renderTopics(topics.topics || [])
  library = lib
  for (const e of library) libraryById.set(e[0], e)
  voices = new Set(clips)
  board = restore() || normalize(fromTemplate('core'))
  syncControls()
  showNotice()
  new ResizeObserver(fitFrame).observe($('stage'))
  fitFrame()
  refresh()
  if (!library.length) setStatus('The picture library is missing. Run: node scripts/build-board-maker.mjs', true)
  document.documentElement.dataset.ready = 'true'
}

start().catch((err) => setStatus(`Talk Boards could not start: ${err.message}. Open it through a web server, not as a file.`, true))
