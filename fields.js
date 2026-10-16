// The number fields, in the order they appear on screen.
// To add a field later: add a line here and restart; the database column is created automatically.
// `extra: true` fields only apply to the clubs in EXTRA_FIELD_CLUBS (default: Zandhoven).
const FIELD_DEFS = [
  { key: 'L',  label: 'Opportunities' },
  { key: 'C',  label: 'Belgesprekken' },
  { key: 'A',  label: 'Gemaakte afspraken' },
  { key: 'AM', label: 'Afspraken door Milo' },
  { key: 'P',  label: 'Presentaties gegeven' },
  { key: 'I',  label: 'Inschrijvingen' },
  { key: 'IO', label: 'IO' },
  { key: 'R',  label: 'Gescoorde referenties' },
  { key: 'B',  label: 'Benfit' },
  { key: 'F',  label: 'Posts op sociale media' },
  { key: 'PL', label: 'Pelvi lead',          extra: true },
  { key: 'PA', label: 'Pelvi afspraak',      extra: true },
  { key: 'PI', label: 'Pelvi inschrijving',  extra: true },
];

const MIN = 0;
const MAX = 99; // two digits for every field
const column = f => 'f_' + f.key.toLowerCase(); // database column name, e.g. f_am

module.exports = { FIELD_DEFS, MIN, MAX, column };
