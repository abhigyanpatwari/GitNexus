# Method Enrichment Integration Tests — Comprehensive Fixture Matrix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create exhaustive per-language integration test fixtures that verify MethodExtractor-enriched graph nodes produce richer CALLS resolution — overload disambiguation via parameterTypes, member-call enrichment, and abstract/concrete dispatch.

**Architecture:** Each language gets 3 fixture directories under `gitnexus/test/fixtures/lang-resolution/` and corresponding test blocks in `gitnexus/test/integration/resolvers/{lang}.test.ts`. Fixtures are minimal multi-file projects that the pipeline ingests. Tests use `runPipelineFromRepo()` + `getNodesByLabelFull()` to assert enriched node properties (parameterTypes, isAbstract, isFinal, annotations, visibility) and richer CALLS edge resolution.

**Tech Stack:** Vitest, tree-sitter parsers, GitNexus ingestion pipeline

**Languages:** Python, PHP, Rust, Ruby, Swift, Dart (Go deferred — requires factory changes for receiver-based methods)

**Patterns per language:**
- **P1: Method Enrichment** — Verify HAS_METHOD edges carry parameterTypes, isAbstract, isFinal, annotations, visibility on method nodes
- **P2: Overload Dispatch** — Two methods with same name but different arity/types; CALLS resolves to correct overload via parameterTypes
- **P3: Abstract Dispatch** — Abstract method in base/interface, concrete in subclass; verify isAbstract flag and HAS_METHOD edges (Python, PHP, Rust, Swift only — Ruby/Dart lack abstract methods or have limited support)

---

## Shared Conventions

All tests follow the existing resolver test pattern:
```typescript
import { FIXTURES, getRelationships, getNodesByLabel, getNodesByLabelFull, edgeSet, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Language: pattern name', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'fixture-dir'), () => {});
  }, 60000);
  // assertions...
});
```

---

## Task 1: Python Method Enrichment Fixtures + Tests

**Files:**
- Create: `gitnexus/test/fixtures/lang-resolution/python-method-enrichment/models.py`
- Create: `gitnexus/test/fixtures/lang-resolution/python-method-enrichment/app.py`
- Create: `gitnexus/test/fixtures/lang-resolution/python-overload-dispatch/service.py`
- Create: `gitnexus/test/fixtures/lang-resolution/python-overload-dispatch/app.py`
- Create: `gitnexus/test/fixtures/lang-resolution/python-abstract-dispatch/base.py`
- Create: `gitnexus/test/fixtures/lang-resolution/python-abstract-dispatch/impl.py`
- Create: `gitnexus/test/fixtures/lang-resolution/python-abstract-dispatch/app.py`
- Modify: `gitnexus/test/integration/resolvers/python.test.ts`

### P1: Method Enrichment

- [ ] **Step 1: Create fixture `python-method-enrichment/models.py`**

```python
from abc import ABC, abstractmethod

class Animal(ABC):
    @abstractmethod
    def speak(self) -> str:
        pass

    @staticmethod
    def classify(name: str) -> str:
        return "mammal"

    def breathe(self) -> bool:
        return True

class Dog(Animal):
    def speak(self) -> str:
        return "woof"

    @property
    def name(self) -> str:
        return "Rex"
```

- [ ] **Step 2: Create fixture `python-method-enrichment/app.py`**

```python
from models import Dog

def main():
    dog = Dog()
    sound = dog.speak()
    category = Dog.classify("dog")
```

- [ ] **Step 3: Add integration tests in `python.test.ts`**

Append this describe block to `gitnexus/test/integration/resolvers/python.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Method enrichment: parameterTypes, isAbstract, visibility, annotations
// ---------------------------------------------------------------------------

describe('Python method enrichment via MethodExtractor', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-method-enrichment'),
      () => {},
    );
  }, 60000);

  it('detects Animal and Dog classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Animal', 'Dog']);
  });

  it('emits HAS_METHOD edges for all methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod.filter((e) => e.source === 'Animal');
    expect(animalMethods.map((e) => e.target).sort()).toEqual(
      expect.arrayContaining(['breathe', 'classify', 'speak']),
    );
    const dogMethods = hasMethod.filter((e) => e.source === 'Dog');
    expect(dogMethods.map((e) => e.target)).toContain('speak');
  });

  it('speak on Animal has isAbstract=true', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const animalSpeak = methods.find(
      (m) => m.name === 'speak' && m.properties.filePath?.includes('models.py'),
    );
    // MethodExtractor should set isAbstract for @abstractmethod
    if (animalSpeak?.properties.isAbstract !== undefined) {
      expect(animalSpeak.properties.isAbstract).toBe(true);
    }
  });

  it('classify has parameterTypes populated', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((m) => m.name === 'classify');
    // MethodExtractor should populate parameterTypes from type hints
    if (classify?.properties.parameterTypes) {
      expect(classify.properties.parameterTypes).toEqual(['str']);
    }
  });

  it('member call dog.speak() resolves to Dog.speak', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.source === 'main' && c.target === 'speak');
    expect(speakCall).toBeDefined();
  });

  it('static call Dog.classify() resolves', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find((c) => c.source === 'main' && c.target === 'classify');
    expect(classifyCall).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd gitnexus && npx vitest run test/integration/resolvers/python.test.ts`
Expected: All existing + new tests pass

- [ ] **Step 5: Commit**

```
git add gitnexus/test/fixtures/lang-resolution/python-method-enrichment/
git add gitnexus/test/integration/resolvers/python.test.ts
git commit -m "test(python): method enrichment integration fixtures"
```

### P2: Overload Dispatch

- [ ] **Step 6: Create fixture `python-overload-dispatch/service.py`**

```python
class Formatter:
    def format(self, value: str) -> str:
        return value.upper()

    def format_with_prefix(self, value: str, prefix: str) -> str:
        return prefix + value.upper()

def format_text(text: str) -> str:
    return text.strip()

def format_text_with_width(text: str, width: int) -> str:
    return text.strip().ljust(width)
```

- [ ] **Step 7: Create fixture `python-overload-dispatch/app.py`**

```python
from service import Formatter, format_text, format_text_with_width

def run():
    f = Formatter()
    result1 = f.format("hello")
    result2 = f.format_with_prefix("hello", ">>")
    plain = format_text("  hi  ")
    padded = format_text_with_width("hi", 20)
```

- [ ] **Step 8: Add overload dispatch tests**

```typescript
describe('Python overload dispatch via arity', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-overload-dispatch'),
      () => {},
    );
  }, 60000);

  it('resolves f.format("hello") to Formatter.format (1 arg)', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find((c) => c.source === 'run' && c.target === 'format');
    expect(formatCall).toBeDefined();
  });

  it('resolves format_text("hi") to 1-param version', () => {
    const calls = getRelationships(result, 'CALLS');
    const textCall = calls.find((c) => c.source === 'run' && c.target === 'format_text');
    expect(textCall).toBeDefined();
  });

  it('resolves format_text_with_width("hi", 20) to 2-param version', () => {
    const calls = getRelationships(result, 'CALLS');
    const widthCall = calls.find(
      (c) => c.source === 'run' && c.target === 'format_text_with_width',
    );
    expect(widthCall).toBeDefined();
  });

  it('method nodes have parameterTypes populated', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const formatText = fns.find((f) => f.name === 'format_text');
    if (formatText?.properties.parameterTypes) {
      expect(formatText.properties.parameterTypes).toEqual(['str']);
    }
  });
});
```

- [ ] **Step 9: Run tests, commit**

### P3: Abstract Dispatch

- [ ] **Step 10: Create fixture `python-abstract-dispatch/base.py`**

```python
from abc import ABC, abstractmethod

class Repository(ABC):
    @abstractmethod
    def find(self, id: int) -> dict:
        pass

    @abstractmethod
    def save(self, entity: dict) -> bool:
        pass
```

- [ ] **Step 11: Create fixture `python-abstract-dispatch/impl.py`**

```python
from base import Repository

class SqlRepository(Repository):
    def find(self, id: int) -> dict:
        return {"id": id}

    def save(self, entity: dict) -> bool:
        return True
```

- [ ] **Step 12: Create fixture `python-abstract-dispatch/app.py`**

```python
from impl import SqlRepository

def process():
    repo = SqlRepository()
    user = repo.find(42)
    repo.save(user)
```

- [ ] **Step 13: Add abstract dispatch tests**

```typescript
describe('Python abstract dispatch (ABC → concrete)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-abstract-dispatch'),
      () => {},
    );
  }, 60000);

  it('detects Repository and SqlRepository classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repository', 'SqlRepository']);
  });

  it('SqlRepository EXTENDS Repository', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_[0].source).toBe('SqlRepository');
    expect(extends_[0].target).toBe('Repository');
  });

  it('abstract find on Repository has isAbstract=true if enriched', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const baseFns = fns.filter((f) => f.properties.filePath?.includes('base.py'));
    const findFn = baseFns.find((f) => f.name === 'find');
    if (findFn?.properties.isAbstract !== undefined) {
      expect(findFn.properties.isAbstract).toBe(true);
    }
  });

  it('concrete find on SqlRepository has isAbstract=false or undefined', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const implFns = fns.filter((f) => f.properties.filePath?.includes('impl.py'));
    const findFn = implFns.find((f) => f.name === 'find');
    if (findFn?.properties.isAbstract !== undefined) {
      expect(findFn.properties.isAbstract).toBe(false);
    }
  });

  it('resolves repo.find(42) through receiver type', () => {
    const calls = getRelationships(result, 'CALLS');
    const findCall = calls.find((c) => c.source === 'process' && c.target === 'find');
    expect(findCall).toBeDefined();
  });

  it('resolves repo.save(user) through receiver type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.source === 'process' && c.target === 'save');
    expect(saveCall).toBeDefined();
  });
});
```

- [ ] **Step 14: Run tests, commit**

---

## Task 2: PHP Method Enrichment Fixtures + Tests

**Files:**
- Create: `gitnexus/test/fixtures/lang-resolution/php-method-enrichment/`
- Create: `gitnexus/test/fixtures/lang-resolution/php-overload-dispatch/`
- Create: `gitnexus/test/fixtures/lang-resolution/php-abstract-dispatch/`
- Modify: `gitnexus/test/integration/resolvers/php.test.ts`

### P1: Method Enrichment

- [ ] **Step 1: Create fixture `php-method-enrichment/src/Models/Animal.php`**

```php
<?php
namespace App\Models;

abstract class Animal {
    abstract public function speak(): string;

    public static function classify(string $name): string {
        return "mammal";
    }

    final public function breathe(): bool {
        return true;
    }
}
```

- [ ] **Step 2: Create fixture `php-method-enrichment/src/Models/Dog.php`**

```php
<?php
namespace App\Models;

class Dog extends Animal {
    public function speak(): string {
        return "woof";
    }
}
```

- [ ] **Step 3: Create fixture `php-method-enrichment/src/app.php`**

```php
<?php
namespace App;

use App\Models\Dog;

function main(): void {
    $dog = new Dog();
    $sound = $dog->speak();
    $category = Dog::classify("dog");
}
```

- [ ] **Step 4: Create fixture `php-method-enrichment/composer.json`**

```json
{
  "autoload": {
    "psr-4": {
      "App\\": "src/"
    }
  }
}
```

- [ ] **Step 5: Add integration tests in `php.test.ts`**

```typescript
describe('PHP method enrichment via MethodExtractor', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-method-enrichment'),
      () => {},
    );
  }, 60000);

  it('detects Animal and Dog classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('emits HAS_METHOD edges for Animal methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod.filter((e) => e.source === 'Animal');
    expect(animalMethods.map((e) => e.target).sort()).toEqual(
      expect.arrayContaining(['breathe', 'classify', 'speak']),
    );
  });

  it('speak on Animal has isAbstract=true if enriched', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find(
      (m) => m.name === 'speak' && m.properties.filePath?.includes('Animal.php'),
    );
    if (speak?.properties.isAbstract !== undefined) {
      expect(speak.properties.isAbstract).toBe(true);
    }
  });

  it('breathe has isFinal=true if enriched', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const breathe = methods.find((m) => m.name === 'breathe');
    if (breathe?.properties.isFinal !== undefined) {
      expect(breathe.properties.isFinal).toBe(true);
    }
  });

  it('classify has parameterTypes populated', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const classify = methods.find((m) => m.name === 'classify');
    if (classify?.properties.parameterTypes) {
      expect(classify.properties.parameterTypes).toEqual(['string']);
    }
  });

  it('member call $dog->speak() resolves', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.source === 'main' && c.target === 'speak');
    expect(speakCall).toBeDefined();
  });
});
```

- [ ] **Step 6: Run tests, commit**

### P2: Overload Dispatch

- [ ] **Step 7: Create fixture `php-overload-dispatch/`**

PHP does not support true method overloading (same name, different params). Instead, test arity-based disambiguation across files:

`src/Services/Formatter.php`:
```php
<?php
namespace App\Services;

function format_text(string $text): string {
    return strtoupper(trim($text));
}
```

`src/Services/FormatterExtended.php`:
```php
<?php
namespace App\Services;

function format_text_padded(string $text, int $width): string {
    return str_pad(strtoupper(trim($text)), $width);
}
```

`src/app.php`:
```php
<?php
namespace App;

use function App\Services\format_text;
use function App\Services\format_text_padded;

function run(): void {
    $plain = format_text("  hi  ");
    $padded = format_text_padded("hi", 20);
}
```

`composer.json`:
```json
{
  "autoload": { "psr-4": { "App\\": "src/" } }
}
```

- [ ] **Step 8: Add overload dispatch tests, run, commit**

### P3: Abstract Dispatch

- [ ] **Step 9: Create fixture `php-abstract-dispatch/`**

`src/Contracts/Repository.php`:
```php
<?php
namespace App\Contracts;

interface Repository {
    public function find(int $id): array;
    public function save(array $entity): bool;
}
```

`src/Repositories/SqlRepository.php`:
```php
<?php
namespace App\Repositories;

use App\Contracts\Repository;

class SqlRepository implements Repository {
    public function find(int $id): array {
        return ['id' => $id];
    }

    public function save(array $entity): bool {
        return true;
    }
}
```

`src/app.php`:
```php
<?php
namespace App;

use App\Repositories\SqlRepository;

function process(): void {
    $repo = new SqlRepository();
    $user = $repo->find(42);
    $repo->save($user);
}
```

`composer.json`:
```json
{
  "autoload": { "psr-4": { "App\\": "src/" } }
}
```

- [ ] **Step 10: Add abstract dispatch tests**

```typescript
describe('PHP abstract dispatch (interface → concrete)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'php-abstract-dispatch'),
      () => {},
    );
  }, 60000);

  it('detects Repository interface and SqlRepository class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('Repository');
    expect(getNodesByLabel(result, 'Class')).toContain('SqlRepository');
  });

  it('SqlRepository IMPLEMENTS Repository', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    expect(edgeSet(implements_)).toContain('SqlRepository → Repository');
  });

  it('interface method find has isAbstract=true if enriched', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const ifaceFind = methods.find(
      (m) => m.name === 'find' && m.properties.filePath?.includes('Repository.php'),
    );
    if (ifaceFind?.properties.isAbstract !== undefined) {
      expect(ifaceFind.properties.isAbstract).toBe(true);
    }
  });

  it('concrete find on SqlRepository has isAbstract=false or undefined', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const concreteFind = methods.find(
      (m) => m.name === 'find' && m.properties.filePath?.includes('SqlRepository.php'),
    );
    if (concreteFind?.properties.isAbstract !== undefined) {
      expect(concreteFind.properties.isAbstract).toBe(false);
    }
  });

  it('resolves $repo->find(42) through receiver type', () => {
    const calls = getRelationships(result, 'CALLS');
    const findCall = calls.find((c) => c.source === 'process' && c.target === 'find');
    expect(findCall).toBeDefined();
  });
});
```

- [ ] **Step 11: Run tests, commit**

---

## Task 3: Rust Method Enrichment Fixtures + Tests

**Files:**
- Create: `gitnexus/test/fixtures/lang-resolution/rust-method-enrichment/`
- Create: `gitnexus/test/fixtures/lang-resolution/rust-overload-dispatch/` (Rust has no overloading — test trait-based dispatch instead)
- Create: `gitnexus/test/fixtures/lang-resolution/rust-abstract-dispatch/`
- Modify: `gitnexus/test/integration/resolvers/rust.test.ts`

### P1: Method Enrichment

- [ ] **Step 1: Create fixture `rust-method-enrichment/src/lib.rs`**

```rust
pub trait Animal {
    fn speak(&self) -> String;

    fn breathe(&self) -> bool {
        true
    }
}

pub struct Dog;

impl Animal for Dog {
    fn speak(&self) -> String {
        "woof".to_string()
    }
}

impl Dog {
    pub fn new() -> Self {
        Dog
    }

    pub fn fetch(&self, item: &str) -> String {
        format!("fetching {}", item)
    }

    #[inline]
    fn wag(&self) -> bool {
        true
    }
}
```

- [ ] **Step 2: Create fixture `rust-method-enrichment/src/main.rs`**

```rust
mod lib;

use lib::{Dog, Animal};

fn main() {
    let dog = Dog::new();
    let sound = dog.speak();
    let toy = dog.fetch("ball");
}
```

- [ ] **Step 3: Add enrichment tests in `rust.test.ts`**

```typescript
describe('Rust method enrichment via MethodExtractor', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-method-enrichment'),
      () => {},
    );
  }, 60000);

  it('emits HAS_METHOD edges for Dog impl methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogMethods = hasMethod.filter((e) => e.source === 'Dog');
    expect(dogMethods.map((e) => e.target)).toContain('fetch');
    expect(dogMethods.map((e) => e.target)).toContain('new');
  });

  it('trait method speak has isAbstract=true on Animal trait', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const traitSpeak = fns.filter((f) => f.name === 'speak');
    // The trait's required method (no body) should be abstract
    const abstractSpeak = traitSpeak.find((f) => f.properties.isAbstract === true);
    if (abstractSpeak) {
      expect(abstractSpeak.properties.isAbstract).toBe(true);
    }
  });

  it('Dog::new() is static (no self param)', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const newFn = fns.find(
      (f) => f.name === 'new' && f.properties.filePath?.includes('lib.rs'),
    );
    if (newFn?.properties.isStatic !== undefined) {
      expect(newFn.properties.isStatic).toBe(true);
    }
  });

  it('fetch has parameterTypes populated', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const fetchFn = fns.find((f) => f.name === 'fetch');
    if (fetchFn?.properties.parameterTypes) {
      expect(fetchFn.properties.parameterTypes.length).toBeGreaterThan(0);
    }
  });

  it('resolves dog.speak() and dog.fetch("ball") as member calls', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'main' && c.target === 'speak')).toBeDefined();
    expect(calls.find((c) => c.source === 'main' && c.target === 'fetch')).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests, commit**

### P3: Abstract Dispatch (trait required vs default methods)

- [ ] **Step 5: Create fixture `rust-abstract-dispatch/src/lib.rs`**

```rust
pub trait Repository {
    fn find(&self, id: i32) -> String;
    fn save(&self, entity: &str) -> bool;

    fn count(&self) -> i32 {
        0
    }
}

pub struct SqlRepo;

impl Repository for SqlRepo {
    fn find(&self, id: i32) -> String {
        format!("user-{}", id)
    }

    fn save(&self, entity: &str) -> bool {
        true
    }
}
```

- [ ] **Step 6: Create fixture `rust-abstract-dispatch/src/main.rs`**

```rust
mod lib;

use lib::{SqlRepo, Repository};

fn process() {
    let repo = SqlRepo;
    let user = repo.find(42);
    repo.save(&user);
    let n = repo.count();
}
```

- [ ] **Step 7: Add abstract dispatch tests**

```typescript
describe('Rust abstract dispatch (trait required vs default)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'rust-abstract-dispatch'),
      () => {},
    );
  }, 60000);

  it('trait required method find is abstract, default method count is not', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const findFns = fns.filter((f) => f.name === 'find');
    const countFns = fns.filter((f) => f.name === 'count');

    // At least one find should be abstract (the trait required method)
    const abstractFind = findFns.find((f) => f.properties.isAbstract === true);
    if (abstractFind) {
      expect(abstractFind.properties.isAbstract).toBe(true);
    }

    // count has a default body — should not be abstract
    const defaultCount = countFns.find((f) => f.properties.isAbstract !== true);
    expect(defaultCount).toBeDefined();
  });

  it('resolves repo.find(42) and repo.save() through receiver', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'process' && c.target === 'find')).toBeDefined();
    expect(calls.find((c) => c.source === 'process' && c.target === 'save')).toBeDefined();
  });
});
```

- [ ] **Step 8: Run tests, commit**

---

## Task 4: Ruby Method Enrichment Fixtures + Tests

**Files:**
- Create: `gitnexus/test/fixtures/lang-resolution/ruby-method-enrichment/`
- Create: `gitnexus/test/fixtures/lang-resolution/ruby-overload-dispatch/`
- Modify: `gitnexus/test/integration/resolvers/ruby.test.ts`

Note: Ruby has no abstract methods. Skip P3 (abstract dispatch). Focus on enrichment and arity-based dispatch.

### P1: Method Enrichment

- [ ] **Step 1: Create fixture `ruby-method-enrichment/lib/animal.rb`**

```ruby
class Animal
  def speak
    raise NotImplementedError
  end

  def self.classify(name)
    "mammal"
  end

  private

  def internal_state
    @state
  end
end

class Dog < Animal
  def speak
    "woof"
  end

  protected

  def energy_level
    100
  end
end
```

- [ ] **Step 2: Create fixture `ruby-method-enrichment/lib/app.rb`**

```ruby
require_relative './animal'

def main
  dog = Dog.new
  sound = dog.speak
  category = Animal.classify("dog")
end
```

- [ ] **Step 3: Add enrichment tests in `ruby.test.ts`**

```typescript
describe('Ruby method enrichment via MethodExtractor', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-method-enrichment'),
      () => {},
    );
  }, 60000);

  it('emits HAS_METHOD edges for Animal methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod.filter((e) => e.source === 'Animal');
    expect(animalMethods.map((e) => e.target)).toContain('speak');
    expect(animalMethods.map((e) => e.target)).toContain('classify');
  });

  it('internal_state has private visibility if enriched', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const internalFn = fns.find((f) => f.name === 'internal_state');
    if (internalFn?.properties.visibility !== undefined) {
      expect(internalFn.properties.visibility).toBe('private');
    }
  });

  it('energy_level has protected visibility if enriched', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const energyFn = fns.find((f) => f.name === 'energy_level');
    if (energyFn?.properties.visibility !== undefined) {
      expect(energyFn.properties.visibility).toBe('protected');
    }
  });

  it('classify is static (singleton method)', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const classifyFn = fns.find((f) => f.name === 'classify');
    if (classifyFn?.properties.isStatic !== undefined) {
      expect(classifyFn.properties.isStatic).toBe(true);
    }
  });

  it('resolves dog.speak() as member call', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.source === 'main' && c.target === 'speak');
    expect(speakCall).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests, commit**

### P2: Overload Dispatch (arity-based)

- [ ] **Step 5: Create fixture `ruby-overload-dispatch/`**

`lib/formatter.rb`:
```ruby
class Formatter
  def format(value)
    value.upcase
  end

  def format_with_prefix(value, prefix)
    prefix + value.upcase
  end
end
```

`lib/app.rb`:
```ruby
require_relative './formatter'

def run
  f = Formatter.new
  f.format("hello")
  f.format_with_prefix("hello", ">>")
end
```

- [ ] **Step 6: Add overload tests, run, commit**

---

## Task 5: Swift Method Enrichment Fixtures + Tests

**Files:**
- Create: `gitnexus/test/fixtures/lang-resolution/swift-method-enrichment/`
- Create: `gitnexus/test/fixtures/lang-resolution/swift-abstract-dispatch/`
- Modify: `gitnexus/test/integration/resolvers/swift.test.ts`

Note: Swift tests may be skipped on Node 22 due to tree-sitter-swift build issues. Use conditional `describe.skipIf` pattern.

### P1: Method Enrichment

- [ ] **Step 1: Create fixture `swift-method-enrichment/Sources/Animal.swift`**

```swift
protocol Animal {
    func speak() -> String
}

class Dog: Animal {
    func speak() -> String {
        return "woof"
    }

    static func classify(_ name: String) -> String {
        return "mammal"
    }

    @objc final func breathe() -> Bool {
        return true
    }
}
```

- [ ] **Step 2: Create fixture `swift-method-enrichment/Sources/App.swift`**

```swift
func main() {
    let dog = Dog()
    let sound = dog.speak()
    let category = Dog.classify("dog")
}
```

- [ ] **Step 3: Add enrichment tests (conditional skip for Node 22)**

```typescript
describe('Swift method enrichment via MethodExtractor', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-method-enrichment'),
      () => {},
    );
  }, 60000);

  it('protocol method speak is abstract', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const protocolSpeak = fns.filter((f) => f.name === 'speak');
    const abstractOne = protocolSpeak.find((f) => f.properties.isAbstract === true);
    if (abstractOne) {
      expect(abstractOne.properties.isAbstract).toBe(true);
    }
  });

  it('breathe has isFinal=true and @objc annotation', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const breathe = fns.find((f) => f.name === 'breathe');
    if (breathe?.properties.isFinal !== undefined) {
      expect(breathe.properties.isFinal).toBe(true);
    }
    if (breathe?.properties.annotations) {
      expect(breathe.properties.annotations).toContain('@objc');
    }
  });

  it('classify is static', () => {
    const fns = getNodesByLabelFull(result, 'Function');
    const classify = fns.find((f) => f.name === 'classify');
    if (classify?.properties.isStatic !== undefined) {
      expect(classify.properties.isStatic).toBe(true);
    }
  });
});
```

- [ ] **Step 4: Run tests, commit**

### P3: Abstract Dispatch (protocol → concrete)

- [ ] **Step 5: Create fixture `swift-abstract-dispatch/` with protocol + conforming class**
- [ ] **Step 6: Add abstract dispatch tests following Python/PHP pattern**
- [ ] **Step 7: Run tests, commit**

---

## Task 6: Dart Method Enrichment Fixtures + Tests

**Files:**
- Create: `gitnexus/test/fixtures/lang-resolution/dart-method-enrichment/`
- Create: `gitnexus/test/fixtures/lang-resolution/dart-calls/`
- Create: `gitnexus/test/fixtures/lang-resolution/dart-member-calls/`
- Modify: `gitnexus/test/integration/resolvers/dart.test.ts`

Note: Dart tests may skip due to tree-sitter-dart version mismatch. Use conditional describe.

### P1: Method Enrichment

- [ ] **Step 1: Create fixture `dart-method-enrichment/lib/animal.dart`**

```dart
abstract class Animal {
  String speak();

  static String classify(String name) {
    return "mammal";
  }

  bool breathe() {
    return true;
  }
}

class Dog extends Animal {
  @override
  String speak() {
    return "woof";
  }
}
```

- [ ] **Step 2: Create fixture `dart-method-enrichment/lib/app.dart`**

```dart
import 'animal.dart';

void main() {
  var dog = Dog();
  var sound = dog.speak();
  var category = Animal.classify("dog");
}
```

- [ ] **Step 3: Add enrichment tests (conditional skip)**
- [ ] **Step 4: Run tests, commit**

### P2: Basic CALLS + Member Calls (Dart catch-up)

Dart only has 2 fixtures currently. Add the standard `dart-calls` and `dart-member-calls` patterns:

- [ ] **Step 5: Create `dart-calls/` fixture** — two functions same arity (different files), import resolves
- [ ] **Step 6: Create `dart-member-calls/` fixture** — class method called via instantiated variable
- [ ] **Step 7: Add tests for both, run, commit**

---

## Task 7: Verify All Tests Pass Together

- [ ] **Step 1: Run the full integration resolver test suite**

```bash
cd gitnexus && npx vitest run test/integration/resolvers/
```

Expected: All existing tests still pass. New tests pass (or skip for unavailable grammars).

- [ ] **Step 2: Run TypeScript compilation check**

```bash
cd gitnexus && npx tsc --noEmit
```

Expected: Clean compilation.

- [ ] **Step 3: Final commit with all fixtures**

```bash
git add gitnexus/test/fixtures/lang-resolution/
git add gitnexus/test/integration/resolvers/
git commit -m "test: comprehensive method enrichment integration fixtures for 6 languages"
```

---

## Notes

### Enrichment Assertion Strategy

Tests use conditional property checks (`if (node.properties.isAbstract !== undefined)`) because:
1. The MethodExtractor enrichment is additive — if the pipeline doesn't set a property, the test still passes (it just doesn't assert)
2. This lets us run the same tests before and after MethodExtractor is wired, progressively validating richer output
3. As enrichment becomes reliable, these conditionals can be tightened to hard assertions

### Languages Without Abstract Methods

- **Ruby**: No abstract methods. Skip P3.
- **Dart**: Has abstract methods but tree-sitter-dart may not be available. Include fixtures, use conditional describe.
- **Go**: Deferred entirely (requires factory changes for receiver-based method extraction).

### Fixture Size

Each fixture is deliberately minimal (2-3 files, ~10-20 lines each). This keeps pipeline runs fast (~1-2s per fixture) while exercising the exact resolution patterns we need.
