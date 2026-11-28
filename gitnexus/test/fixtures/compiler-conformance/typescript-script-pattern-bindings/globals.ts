const source = { label: "answer", payload: { count: 3 }, list: [1, 2] };
const { label: title, payload: { count }, list: [first, ...rest] } = source;
