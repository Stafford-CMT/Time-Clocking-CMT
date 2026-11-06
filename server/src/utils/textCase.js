'use strict';

/* The name lists keep one style whatever is typed (the same rules as the page's
 * copy in public/app.js and migration 019): machine types in capitals,
 * customers in title case, suffix descriptions, cost centres and rework
 * reasons in sentence case. A word typed all in capitals (an acronym such as
 * RFU) is kept as it is, unless the whole name was typed in capitals. */
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const isAcronym = (word, allCaps) => !allCaps && /[A-Z].*[A-Z]/.test(word) && word === word.toUpperCase();
const typedInCapitals = (text) => text.includes(' ') && text === text.toUpperCase() && /[A-Z]/.test(text);

function upperCase(text) {
  return tidy(text).toUpperCase();
}

function sentenceCase(text) {
  const clean = tidy(text); const allCaps = typedInCapitals(clean);
  return clean.split(' ').map((word, index) => {
    if (isAcronym(word, allCaps)) return word;
    const lower = word.toLowerCase();
    return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(' ');
}

// Every word capitalised, and each part after a hyphen or apostrophe too (Smith-Jones, O'Neil), as Postgres initcap does.
function titleCase(text) {
  const clean = tidy(text); const allCaps = typedInCapitals(clean);
  return clean.split(' ').map((word) => (isAcronym(word, allCaps) ? word : word.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (match, before, letter) => before + letter.toUpperCase()))).join(' ');
}

const LIST_CASE = { machineTypes: upperCase, suffixDescriptions: sentenceCase, customers: titleCase, costCentres: sentenceCase, reworkReasons: sentenceCase };

module.exports = { upperCase, sentenceCase, titleCase, LIST_CASE };
