
function original() {}
function defaultImpl() {}
function literalEscape() {}
function ordinary() {}
function astral() {}
export { astral as "\u{1F600}", \u006friginal as escapedLocal };
export { original as "pub\x6cic-name", defaultImpl as 'default', literalEscape as '\\u0061', ordinary as a };
