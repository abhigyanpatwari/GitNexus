class Result { save() {} }
declare function create(): Result;

export function use() {
  const result = create();
  result.save();
}
