// Distinct lexical declarations deliberately share a line and a spelling.
export function left() { class Local { act() {} } new Local().act(); } export function right() { class Local { act() {} } new Local().act(); }
