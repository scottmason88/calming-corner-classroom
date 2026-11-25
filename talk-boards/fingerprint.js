// A short fingerprint of a topic board's content: its layout and, for every
// square, the word, what it says, its colour category and its picture. A
// teacher's approval records the fingerprint of the board the teacher saw, so any
// later change to the board makes the approval stale. The browser (maker and
// review sheet) and Node (apply-topic-review.mjs, tests) share this file.
// cyrb53 rather than SHA-256: it needs no secure context, and this is for
// noticing changes, not for security.

export function boardContent(board) {
  return JSON.stringify({
    rows: board.rows,
    cols: board.cols,
    showSentence: board.showSentence !== false,
    showColors: !!board.showColors,
    cells: (board.cells || []).slice(0, board.rows * board.cols).map((c) => (c && (c.label || c.picture || c.swatch)
      ? [c.label || '', c.say || '', c.category || '', c.picture || null, c.swatch || null]
      : null)),
  })
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

export function fingerprint(board) {
  return cyrb53(boardContent(board))
}

/* A topic counts as approved only if the board is still the one the teacher approved. */
export function topicStatus(topic) {
  if (topic.status === 'approved') return topic.review?.fingerprint === fingerprint(topic.board) ? 'approved' : 'draft'
  return topic.status === 'needs-changes' ? 'needs-changes' : 'draft'
}
