
function target(): void {}
function replacement(): void {}
function entry(): void {
  target();
  {
    const target = replacement;
    target();
  }
}
