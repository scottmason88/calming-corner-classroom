// Starting boards. Pictures are library ids: "m:" is Mulberry (library/mulberry/<name>.svg),
// "o:" is OpenMoji (library/openmoji/<hexcode>.svg). The spoken text picks the voice clip:
// voices/calm/<slug of say>.mp3, when there is one.

/* Fitzgerald-style colour key, the same keys and colours as board.html. */
export const CATEGORIES = [
  { key: 'pronoun', name: 'People', hint: 'I, you, mum', color: '#f8efae' },
  { key: 'verb', name: 'Actions', hint: 'want, go, help', color: '#d8eed3' },
  { key: 'describe', name: 'Describing', hint: 'more, big, happy', color: '#cde4f6' },
  { key: 'noun', name: 'Things', hint: 'ball, snack, water', color: '#fde0c2' },
  { key: 'place', name: 'Little words', hint: 'in, on, under', color: '#e6def1' },
  { key: 'social', name: 'Social', hint: 'hello, please', color: '#f9d3e3' },
  { key: 'question', name: 'Questions', hint: 'what, where', color: '#d9c8ef' },
  { key: 'negative', name: 'No / not', hint: "no, don't", color: '#f6c6c3' },
  { key: 'neutral', name: 'Other', hint: 'white', color: '#ffffff' },
]

/* The classroom board's colour row. */
export const COLOR_ROW = [
  ['white', '#ffffff'], ['black', '#1b1b1b'], ['brown', '#7b4a24'], ['red', '#e0262b'], ['orange', '#f47b20'], ['yellow', '#ffe11a'],
  ['green', '#22a33a'], ['blue', '#1f5fc6'], ['purple', '#6a2fa0'], ['gray', '#808080'], ['pink', '#d08ad8'],
]

const cell = (label, say, category, picture = null, swatch = null) => ({ label, say, category, picture, swatch, recording: null })
const empty = () => cell('', '', 'neutral')

export const TEMPLATES = {
  core: {
    name: 'Core words',
    blurb: 'The classroom board: 15 core words and the colour row.',
    make: () => ({
      title: 'Core words', rows: 3, cols: 5, showSentence: true, showColors: true,
      cells: [
        cell('I', 'I', 'pronoun', 'o:1F64B-1F3FC'), cell('want', 'want', 'verb', 'm:want_,_to'),
        cell('see', 'see', 'verb', 'm:look_,_to'), cell('in', 'in', 'place', 'm:in'), cell('more', 'more', 'describe', 'm:more'),
        cell('you', 'you', 'pronoun', 'o:1FAF5-1F3FC'), cell('put', 'put', 'verb', 'm:put_,_to'),
        cell('help', 'help', 'verb', 'm:help_,_to'), cell('on', 'on', 'place', 'm:on'), cell('finished', 'finished', 'describe', 'm:finish'),
        cell('he, she, it', 'he, she, it', 'pronoun', 'o:1F46B-1F3FC'), cell('turn', 'turn', 'verb', 'm:turn_,_to'),
        cell('Go', 'go', 'verb', 'm:go_,_to'), cell('Stop', 'stop', 'verb', 'o:1F6D1'), cell('no/not', 'no', 'neutral', 'm:mistake_no_wrong'),
      ],
    }),
  },
  feelings: {
    name: 'Feelings',
    blurb: '“I feel happy” and 15 more, with OpenMoji faces.',
    make: () => ({
      title: 'How I feel', rows: 4, cols: 4, showSentence: true, showColors: false,
      cells: [
        ['happy', '1F600'], ['calm', '1F60C'], ['excited', '1F929'], ['silly', '1F92A'],
        ['sad', '2639'], ['lonely', '1F614'], ['tired', '1F62B'], ['bored', '1F971'],
        ['angry', '1F620'], ['frustrated', '1F624'], ['upset', '1F622'], ['overwhelmed', '1F92F'],
        ['scared', '1F628'], ['worried', '1F61F'], ['not sure', '1F914'], ['all mixed up', '1F635-200D-1F4AB'],
      ].map(([word, hex]) => cell(word, `I feel ${word}`, 'describe', `o:${hex}`)),
    }),
  },
  needs: {
    name: 'I need…',
    blurb: '“I need a break”, help, water and more.',
    make: () => ({
      title: 'I need…', rows: 3, cols: 3, showSentence: true, showColors: false,
      cells: [
        cell('a break', 'I need a break', 'noun', 'm:break_time_1'),
        cell('help', 'I need help', 'verb', 'm:help_,_to'),
        cell('water', 'I need water', 'noun', 'm:water'),
        cell('a hug', 'I need a hug', 'noun', 'm:hug_,_to'),
        cell('quiet', 'I need quiet', 'describe', 'm:quiet'),
        cell('a snack', 'I need a snack', 'noun', 'o:1F36A'),
        cell('a rest', 'I need a rest', 'noun', 'm:rest_,_to'),
        cell('to talk', 'I need to talk', 'verb', 'm:talk_1_,_to'),
        cell('something', 'I need something', 'noun', 'o:270B-1F3FC'),
      ],
    }),
  },
  colours: {
    name: 'Colours',
    blurb: 'Eleven colours to point at and name.',
    make: () => ({
      title: 'Colours', rows: 3, cols: 4, showSentence: true, showColors: false,
      cells: [...COLOR_ROW.map(([name, hex]) => cell(name, name, 'describe', null, hex)), empty()],
    }),
  },
  blank: {
    name: 'Blank grid',
    blurb: 'An empty 3 × 4 grid to fill in yourself.',
    make: () => ({
      title: 'My board', rows: 3, cols: 4, showSentence: true, showColors: false,
      cells: Array.from({ length: 12 }, empty),
    }),
  },
}

export function fromTemplate(key) {
  const board = TEMPLATES[key].make()
  return { version: 1, template: key, recordings: {}, uploads: {}, ...board }
}

export const emptyCell = empty
