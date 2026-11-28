function publish(value: number): void;
function publish(value: string): void;
function publish(value: number | string): void {}

function send(callback: (value: number) => void) {
  callback(1);
}
send(publish);
