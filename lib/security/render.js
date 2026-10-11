// ASCII JSON makes controls and invisible Unicode visible, including accented text.
export function escapedJSON(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}
