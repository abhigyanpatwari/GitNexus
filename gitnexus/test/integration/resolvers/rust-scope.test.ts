/**
 * Rust scope-resolution integration tests (RFC #909 Ring 3).
 *
 * These tests exercise the scope-based resolution path. They validate
 * the core deliverables:
 * impl blocks, use statements, receiver binding, module resolution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// 1. Impl blocks: methods classified as Method, owned by struct
// ---------------------------------------------------------------------------

describe('Rust scope: impl block method classification', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-impl-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
use crate::user::User;

fn main() {
    let u = User { name: String::new() };
    u.save();
}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) -> bool {
        true
    }

    pub fn create(name: String) -> User {
        User { name }
    }
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects User struct', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
  });

  it('classifies save as a function owned by User (HAS_METHOD edge)', () => {
    const edges = getRelationships(result, 'HAS_METHOD');
    const userSave = edges.find((e) => e.source === 'User' && e.target === 'save');
    expect(userSave).toBeDefined();
  });

  it('emits HAS_METHOD edge from User to save', () => {
    const edges = getRelationships(result, 'HAS_METHOD');
    const userSave = edges.find((e) => e.source === 'User' && e.target === 'save');
    expect(userSave).toBeDefined();
  });

  it('resolves main → u.save() as CALLS edge to save in user.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const mainSave = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath?.includes('user.rs'),
    );
    expect(mainSave).toBeDefined();
  });

  it('emits IMPORTS edge from main.rs to user.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find((e) => e.targetFilePath?.includes('user.rs'));
    expect(imp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Trait implementations: IMPLEMENTS edges + method resolution
// ---------------------------------------------------------------------------

describe('Rust scope: trait implementation', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-trait-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod shapes;
use crate::shapes::{Circle, Drawable};

fn main() {
    let c = Circle { radius: 5.0 };
    c.draw();
}
`,
      'src/shapes.rs': `
pub trait Drawable {
    fn draw(&self);
}

pub struct Circle {
    pub radius: f64,
}

impl Drawable for Circle {
    fn draw(&self) {
        println!("Drawing circle");
    }
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Drawable trait and Circle struct', () => {
    expect(getNodesByLabel(result, 'Trait')).toContain('Drawable');
    expect(getNodesByLabel(result, 'Struct')).toContain('Circle');
  });

  it('emits IMPLEMENTS edge from Circle to Drawable', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const circleDrawable = impls.find((e) => e.source === 'Circle' && e.target === 'Drawable');
    expect(circleDrawable).toBeDefined();
  });

  it('resolves main → c.draw() to shapes.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const drawCall = calls.find((c) => c.target === 'draw' && c.source === 'main');
    expect(drawCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Grouped imports: use crate::models::{User, Config}
// ---------------------------------------------------------------------------

describe('Rust scope: grouped imports', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-grouped-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod models;
use crate::models::{User, Config};

fn process() {
    let u = User { name: String::new() };
    u.save();
    let c = Config { debug: true };
    c.validate();
}

fn main() {}
`,
      'src/models.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}

pub struct Config {
    pub debug: bool,
}

impl Config {
    pub fn validate(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves grouped import to models.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const modelsImport = imports.find((e) => e.targetFilePath?.includes('models.rs'));
    expect(modelsImport).toBeDefined();
  });

  it('resolves u.save() to User#save via grouped import binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });

  it('resolves c.validate() to Config#validate via grouped import binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find((c) => c.target === 'validate' && c.source === 'process');
    expect(validateCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Renamed imports: use Foo as Bar
// ---------------------------------------------------------------------------

describe('Rust scope: renamed imports (use as)', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-alias-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod models;
use crate::models::User as U;

fn process() {
    let u = U { name: String::new() };
    u.save();
}

fn main() {}
`,
      'src/models.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits IMPORTS edge to models.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find((e) => e.targetFilePath?.includes('models.rs'));
    expect(imp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Module resolution: super:: and self::
// ---------------------------------------------------------------------------

describe('Rust scope: module resolution (crate/super/self)', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-modules-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod models;
mod services;

fn main() {}
`,
      'src/models.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
      'src/services.rs': `
use crate::models::User;

pub fn process() {
    let u = User { name: String::new() };
    u.save();
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves crate::models::User import from services.rs to models.rs', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find(
      (e) => e.targetFilePath?.includes('models.rs') && e.sourceFilePath?.includes('services.rs'),
    );
    expect(imp).toBeDefined();
  });

  it('resolves process → u.save() to models.rs', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('models.rs'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Receiver binding: &self, &mut self
// ---------------------------------------------------------------------------

describe('Rust scope: receiver binding disambiguation', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-receiver-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn process() {
    let u = User { name: String::new() };
    u.save();
    let r = Repo { path: String::new() };
    r.save();
}

fn main() {}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
      'src/repo.rs': `
pub struct Repo {
    pub path: String,
}

impl Repo {
    pub fn save(&mut self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves u.save() to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.rs'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves r.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.rs'),
    );
    expect(repoSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Arity filtering: no Rust overloading
// ---------------------------------------------------------------------------

describe('Rust scope: arity filtering', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-arity-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod onearg;
mod twoarg;

fn main() {
    onearg::write_audit(String::from("test"));
}
`,
      'src/onearg.rs': `
pub fn write_audit(msg: String) {}
`,
      'src/twoarg.rs': `
pub fn write_audit(msg: String, level: i32) {}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves main → write_audit to onearg.rs (1-arg match)', () => {
    const calls = getRelationships(result, 'CALLS');
    const call = calls.find(
      (c) => c.target === 'write_audit' && c.targetFilePath?.includes('onearg.rs'),
    );
    expect(call).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Struct constructor inference: let x = Foo { ... }
// ---------------------------------------------------------------------------

describe('Rust scope: struct literal constructor inference', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-ctor-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
use crate::user::User;

fn process() {
    let u = User { name: String::new() };
    u.save();
}

fn main() {}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves u.save() to User#save via struct literal type inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.rs'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Return type inference: fn get_user() -> User
// ---------------------------------------------------------------------------

describe('Rust scope: return type inference', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-rettype-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod models;
use crate::models::User;

fn get_user() -> User {
    User { name: String::new() }
}

fn process() {
    let u = get_user();
    u.save();
}

fn main() {}
`,
      'src/models.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves process → u.save() via return type of get_user()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('models.rs'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves process → get_user() free call', () => {
    const calls = getRelationships(result, 'CALLS');
    const getUserCall = calls.find((c) => c.target === 'get_user' && c.source === 'process');
    expect(getUserCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Scoped call: Type::method()
// ---------------------------------------------------------------------------

describe('Rust scope: scoped/qualified calls (Foo::new())', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-qualified-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
use crate::user::User;

fn process() {
    let u = User::new(String::from("test"));
    u.save();
}

fn main() {}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn new(name: String) -> User {
        User { name }
    }

    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves process → User::new() free call', () => {
    const calls = getRelationships(result, 'CALLS');
    const newCall = calls.find((c) => c.target === 'new' && c.source === 'process');
    expect(newCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Struct field declarations captured as Property
// ---------------------------------------------------------------------------

describe('Rust scope: struct field declarations', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-fields-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p = Point { x: 1, y: 2 };
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Point struct', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('Point');
  });

  it('captures x and y as Property nodes', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('x');
    expect(props).toContain('y');
  });
});

// ---------------------------------------------------------------------------
// 12. Enum declarations
// ---------------------------------------------------------------------------

describe('Rust scope: enum declarations', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-enum-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
enum Color {
    Red,
    Green,
    Blue,
}

fn main() {}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Color enum', () => {
    expect(getNodesByLabel(result, 'Enum')).toContain('Color');
  });
});

// ---------------------------------------------------------------------------
// 13. Multiple impl blocks for same struct
// ---------------------------------------------------------------------------

describe('Rust scope: multiple impl blocks', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-multi-impl-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
use crate::user::User;

fn process() {
    let u = User { name: String::new() };
    u.save();
    u.display();
}

fn main() {}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}

impl User {
    pub fn display(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves u.save() from first impl block', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });

  it('resolves u.display() from second impl block', () => {
    const calls = getRelationships(result, 'CALLS');
    const displayCall = calls.find((c) => c.target === 'display' && c.source === 'process');
    expect(displayCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 14. Free function calls (non-member)
// ---------------------------------------------------------------------------

describe('Rust scope: free function calls', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-freecall-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod utils;
use crate::utils::helper;

fn main() {
    helper();
}
`,
      'src/utils.rs': `
pub fn helper() {
    println!("helping");
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves main → helper() free call', () => {
    const calls = getRelationships(result, 'CALLS');
    const helperCall = calls.find((c) => c.target === 'helper' && c.source === 'main');
    expect(helperCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 15. Variable type binding via let: type annotation
// ---------------------------------------------------------------------------

describe('Rust scope: typed let binding', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-lettype-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
use crate::user::User;

fn process() {
    let u: User = User { name: String::new() };
    u.save();
}

fn main() {}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves u.save() via typed let binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 16. Re-export chain: pub use re-exports
// ---------------------------------------------------------------------------

describe('Rust scope: pub use re-exports', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-reexport-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod models;
use crate::models::User;

fn process() {
    let u = User { name: String::new() };
    u.save();
}

fn main() {}
`,
      'src/models.rs': `
mod user;
pub use self::user::User;
`,
      'src/models/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits IMPORTS edges through re-export chain', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 17. Local shadow: inner variable shadows outer
// ---------------------------------------------------------------------------

describe('Rust scope: local variable shadowing', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-shadow-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
mod user;
use crate::user::User;

fn process() {
    let x = 42;
    let x = User { name: String::new() };
    x.save();
}

fn main() {}
`,
      'src/user.rs': `
pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves x.save() to User#save after shadow rebind', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 18. Closure / nested function scope
// ---------------------------------------------------------------------------

describe('Rust scope: closure scope isolation', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-closure-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
fn adder(x: i32) -> i32 {
    let f = |y: i32| -> i32 { x + y };
    f(10)
}

fn main() {
    adder(5);
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects adder function', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('adder');
  });

  it('resolves main → adder() call', () => {
    const calls = getRelationships(result, 'CALLS');
    const call = calls.find((c) => c.target === 'adder' && c.source === 'main');
    expect(call).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 19. Trait default method
// ---------------------------------------------------------------------------

describe('Rust scope: trait default methods', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scope-default-method-'));
    writeFixtureRepo(tmpDir, {
      'src/main.rs': `
trait Greeter {
    fn name(&self) -> String;
    fn greet(&self) -> String {
        format!("Hello, {}!", self.name())
    }
}

struct User {
    username: String,
}

impl Greeter for User {
    fn name(&self) -> String {
        self.username.clone()
    }
}

fn main() {
    let u = User { username: String::from("alice") };
    u.greet();
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Greeter trait', () => {
    expect(getNodesByLabel(result, 'Trait')).toContain('Greeter');
  });

  it('detects User struct', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('User');
  });

  it('emits IMPLEMENTS edge from User to Greeter', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find((e) => e.source === 'User' && e.target === 'Greeter');
    expect(edge).toBeDefined();
  });
});
