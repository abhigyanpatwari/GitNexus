export function byNumber(convert: (value: number) => string) {
  return convert(1);
}

export function byText(convert: (value: string) => string) {
  return convert('1');
}
