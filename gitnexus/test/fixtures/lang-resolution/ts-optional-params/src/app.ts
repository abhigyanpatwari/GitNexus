function greet(name: string, greeting: string = "Hello"): string {
  return greeting + ", " + name;
}

function search(query: string, limit?: number): string[] {
  return [];
}

function process() {
  greet("Alice");
  greet("Bob", "Hi");
  search("test");
  search("test", 10);
}
