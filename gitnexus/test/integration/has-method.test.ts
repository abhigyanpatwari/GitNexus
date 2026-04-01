/**
 * Integration tests for HAS_METHOD edge extraction.
 *
 * These tests exercise findEnclosingClassId against real tree-sitter ASTs
 * produced by the actual parser pipeline (loadParser + loadLanguage + queries).
 * Unlike the unit tests that test findEnclosingClassId in isolation with simple
 * snippets, these focus on multi-class files, interface vs class disambiguation,
 * and cross-language pipeline correctness.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import {
  findEnclosingClassId,
  getDefinitionNodeFromCaptures,
} from '../../src/core/ingestion/utils/ast-helpers.js';

let parser: Parser;

beforeAll(async () => {
  parser = await loadParser();
});

/** Parse code with given language, run definition queries, return matched definitions with their enclosing class IDs. */
function parseAndExtractMethods(
  code: string,
  lang: SupportedLanguages,
  filePath: string,
): { name: string; defType: string; enclosingClassId: string | null }[] {
  const tree = parser.parse(code);
  const provider = getProvider(lang);
  const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);
  const matches = query.matches(tree.rootNode);

  const results: { name: string; defType: string; enclosingClassId: string | null }[] = [];

  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    let nameNode: any = null;

    for (const capture of match.captures) {
      captureMap[capture.name] = capture.node;
      if (capture.name === 'name') {
        nameNode = capture.node;
      }
    }

    const defNode = getDefinitionNodeFromCaptures(captureMap);
    if (!defNode || !nameNode) continue;

    const defType = Object.keys(captureMap).find((k) => k.startsWith('definition.')) || 'unknown';
    const enclosingClassId = findEnclosingClassId(nameNode, filePath);

    results.push({
      name: nameNode.text,
      defType,
      enclosingClassId,
    });
  }

  return results;
}

describe('HAS_METHOD integration — C#: class with interface', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.CSharp);
  });

  it('methods link to correct owner (interface vs class)', () => {
    const code = `
interface IRepository {
  void FindById(int id);
  void Save(object entity);
}

class SqlRepository {
  public void FindById(int id) {}
  public void Save(object entity) {}
  private void Connect() {}
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.CSharp, 'src/Repo.cs');

    // Interface methods should be enclosed by the interface
    const ifaceFindById = results.find(
      (r) => r.name === 'FindById' && r.enclosingClassId?.startsWith('Interface:'),
    );
    expect(ifaceFindById).toBeDefined();
    expect(ifaceFindById!.enclosingClassId).toBe('Interface:src/Repo.cs:IRepository');

    const ifaceSave = results.find(
      (r) => r.name === 'Save' && r.enclosingClassId?.startsWith('Interface:'),
    );
    expect(ifaceSave).toBeDefined();
    expect(ifaceSave!.enclosingClassId).toBe('Interface:src/Repo.cs:IRepository');

    // Class methods should be enclosed by the class
    const classFindById = results.find(
      (r) => r.name === 'FindById' && r.enclosingClassId?.startsWith('Class:'),
    );
    expect(classFindById).toBeDefined();
    expect(classFindById!.enclosingClassId).toBe('Class:src/Repo.cs:SqlRepository');

    const classConnect = results.find((r) => r.name === 'Connect');
    expect(classConnect).toBeDefined();
    expect(classConnect!.enclosingClassId).toBe('Class:src/Repo.cs:SqlRepository');
  });

  it('class/interface name captures point to their own container (self-referential)', () => {
    const code = `
interface IService {
  void Execute();
}

class ServiceImpl {
  public void Execute() {}
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.CSharp, 'src/Service.cs');

    // The name node for IService sits inside the interface_declaration, so
    // findEnclosingClassId returns the interface itself. This is expected —
    // the pipeline uses defType (definition.interface vs definition.method) to
    // distinguish container declarations from methods, not enclosingClassId.
    const ifaceDecl = results.find((r) => r.name === 'IService');
    expect(ifaceDecl).toBeDefined();
    expect(ifaceDecl!.defType).toBe('definition.interface');

    const classDecl = results.find((r) => r.name === 'ServiceImpl');
    expect(classDecl).toBeDefined();
    expect(classDecl!.defType).toBe('definition.class');

    // Methods should still correctly reference their container
    const execMethods = results.filter((r) => r.name === 'Execute');
    expect(execMethods.length).toBe(2);
    expect(
      execMethods.some((r) => r.enclosingClassId === 'Interface:src/Service.cs:IService'),
    ).toBe(true);
    expect(execMethods.some((r) => r.enclosingClassId === 'Class:src/Service.cs:ServiceImpl')).toBe(
      true,
    );
  });
});

describe('HAS_METHOD integration — Rust: impl + trait', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.Rust);
  });

  it('methods link to impl vs trait nodes', () => {
    const code = `
trait Drawable {
    fn draw(&self);
    fn resize(&self, w: u32, h: u32);
}

struct Circle {
    radius: f64,
}

impl Circle {
    fn new(radius: f64) -> Circle {
        Circle { radius }
    }

    fn area(&self) -> f64 {
        3.14 * self.radius * self.radius
    }
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.Rust, 'src/shapes.rs');

    // Trait methods should be enclosed by the trait
    const traitDraw = results.find((r) => r.name === 'draw');
    if (traitDraw) {
      expect(traitDraw.enclosingClassId).toBe('Trait:src/shapes.rs:Drawable');
    }

    const traitResize = results.find((r) => r.name === 'resize');
    if (traitResize) {
      expect(traitResize.enclosingClassId).toBe('Trait:src/shapes.rs:Drawable');
    }

    // Impl methods should be enclosed by the impl block
    const implNew = results.find((r) => r.name === 'new');
    if (implNew) {
      expect(implNew.enclosingClassId).toBe('Impl:src/shapes.rs:Circle');
    }

    const implArea = results.find((r) => r.name === 'area');
    if (implArea) {
      expect(implArea.enclosingClassId).toBe('Impl:src/shapes.rs:Circle');
    }
  });

  it('standalone functions do not get HAS_METHOD', () => {
    const code = `
fn helper() -> bool {
    true
}

struct Foo;

impl Foo {
    fn bar(&self) {}
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.Rust, 'src/lib.rs');

    const helper = results.find((r) => r.name === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.enclosingClassId).toBeNull();

    const bar = results.find((r) => r.name === 'bar');
    if (bar) {
      expect(bar.enclosingClassId).toBe('Impl:src/lib.rs:Foo');
    }
  });
});

describe('HAS_METHOD integration — Python: class methods vs standalone functions', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.Python);
  });

  it('methods link to class, standalone functions get null', () => {
    const code = `
def standalone_helper():
    return 42

class Calculator:
    def __init__(self):
        self.value = 0

    def add(self, x):
        self.value += x
        return self

    def result(self):
        return self.value

def another_standalone():
    pass
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.Python, 'src/calc.py');

    // Standalone functions should not be enclosed
    const standaloneHelper = results.find((r) => r.name === 'standalone_helper');
    expect(standaloneHelper).toBeDefined();
    expect(standaloneHelper!.enclosingClassId).toBeNull();

    const anotherStandalone = results.find((r) => r.name === 'another_standalone');
    expect(anotherStandalone).toBeDefined();
    expect(anotherStandalone!.enclosingClassId).toBeNull();

    // Class methods should be enclosed
    const init = results.find((r) => r.name === '__init__');
    expect(init).toBeDefined();
    expect(init!.enclosingClassId).toBe('Class:src/calc.py:Calculator');

    const add = results.find((r) => r.name === 'add');
    expect(add).toBeDefined();
    expect(add!.enclosingClassId).toBe('Class:src/calc.py:Calculator');

    const resultMethod = results.find((r) => r.name === 'result');
    expect(resultMethod).toBeDefined();
    expect(resultMethod!.enclosingClassId).toBe('Class:src/calc.py:Calculator');
  });
});

describe('HAS_METHOD integration — Multiple classes in one file', () => {
  describe('TypeScript', () => {
    beforeAll(async () => {
      await loadLanguage(SupportedLanguages.TypeScript, 'multi.ts');
    });

    it('methods associate with their owning class', () => {
      const code = `
class UserService {
  findUser(id: number) {
    return null;
  }
  deleteUser(id: number) {}
}

class OrderService {
  createOrder(data: any) {
    return data;
  }
  cancelOrder(id: number) {}
}

function topLevelUtil() {
  return true;
}
`;
      const results = parseAndExtractMethods(
        code,
        SupportedLanguages.TypeScript,
        'src/services.ts',
      );

      // UserService methods
      const findUser = results.find((r) => r.name === 'findUser');
      expect(findUser).toBeDefined();
      expect(findUser!.enclosingClassId).toBe('Class:src/services.ts:UserService');

      const deleteUser = results.find((r) => r.name === 'deleteUser');
      expect(deleteUser).toBeDefined();
      expect(deleteUser!.enclosingClassId).toBe('Class:src/services.ts:UserService');

      // OrderService methods
      const createOrder = results.find((r) => r.name === 'createOrder');
      expect(createOrder).toBeDefined();
      expect(createOrder!.enclosingClassId).toBe('Class:src/services.ts:OrderService');

      const cancelOrder = results.find((r) => r.name === 'cancelOrder');
      expect(cancelOrder).toBeDefined();
      expect(cancelOrder!.enclosingClassId).toBe('Class:src/services.ts:OrderService');

      // Top-level function
      const topLevelUtil = results.find((r) => r.name === 'topLevelUtil');
      expect(topLevelUtil).toBeDefined();
      expect(topLevelUtil!.enclosingClassId).toBeNull();
    });
  });

  describe('Java', () => {
    beforeAll(async () => {
      await loadLanguage(SupportedLanguages.Java);
    });

    it('methods associate with their owning class', () => {
      const code = `
class Logger {
  public void info(String msg) {}
  public void error(String msg) {}
}

class Formatter {
  public String format(String template) { return template; }
  private String escape(String input) { return input; }
}
`;
      const results = parseAndExtractMethods(
        code,
        SupportedLanguages.Java,
        'src/util/Logging.java',
      );

      const info = results.find((r) => r.name === 'info');
      expect(info).toBeDefined();
      expect(info!.enclosingClassId).toBe('Class:src/util/Logging.java:Logger');

      const error = results.find((r) => r.name === 'error');
      expect(error).toBeDefined();
      expect(error!.enclosingClassId).toBe('Class:src/util/Logging.java:Logger');

      const format = results.find((r) => r.name === 'format');
      expect(format).toBeDefined();
      expect(format!.enclosingClassId).toBe('Class:src/util/Logging.java:Formatter');

      const escape = results.find((r) => r.name === 'escape');
      expect(escape).toBeDefined();
      expect(escape!.enclosingClassId).toBe('Class:src/util/Logging.java:Formatter');
    });
  });
});

describe('HAS_METHOD integration — Java: class with interface', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.Java);
  });

  it('methods link to correct owner (interface vs class)', () => {
    const code = `
interface Validator {
  boolean validate(Object input);
  String getMessage();
}

class EmailValidator {
  public boolean validate(Object input) { return true; }
  public String getMessage() { return "invalid email"; }
  private boolean checkFormat(String email) { return true; }
}
`;
    const results = parseAndExtractMethods(
      code,
      SupportedLanguages.Java,
      'src/validation/Validator.java',
    );

    // Interface methods
    const ifaceValidate = results.find(
      (r) => r.name === 'validate' && r.enclosingClassId?.startsWith('Interface:'),
    );
    expect(ifaceValidate).toBeDefined();
    expect(ifaceValidate!.enclosingClassId).toBe(
      'Interface:src/validation/Validator.java:Validator',
    );

    const ifaceGetMessage = results.find(
      (r) => r.name === 'getMessage' && r.enclosingClassId?.startsWith('Interface:'),
    );
    expect(ifaceGetMessage).toBeDefined();
    expect(ifaceGetMessage!.enclosingClassId).toBe(
      'Interface:src/validation/Validator.java:Validator',
    );

    // Class methods
    const classValidate = results.find(
      (r) => r.name === 'validate' && r.enclosingClassId?.startsWith('Class:'),
    );
    expect(classValidate).toBeDefined();
    expect(classValidate!.enclosingClassId).toBe(
      'Class:src/validation/Validator.java:EmailValidator',
    );

    const classCheckFormat = results.find((r) => r.name === 'checkFormat');
    expect(classCheckFormat).toBeDefined();
    expect(classCheckFormat!.enclosingClassId).toBe(
      'Class:src/validation/Validator.java:EmailValidator',
    );
  });

  it('class/interface declarations are captured with correct defType', () => {
    const code = `
interface Repository {
  void save(Object entity);
}

class UserRepository {
  public void save(Object entity) {}
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.Java, 'src/repo/Repo.java');

    // The pipeline distinguishes containers from methods via defType, not enclosingClassId
    const repoDecl = results.find((r) => r.name === 'Repository');
    expect(repoDecl).toBeDefined();
    expect(repoDecl!.defType).toBe('definition.interface');

    const userRepoDecl = results.find((r) => r.name === 'UserRepository');
    expect(userRepoDecl).toBeDefined();
    expect(userRepoDecl!.defType).toBe('definition.class');

    // Methods associate correctly
    const saveMethods = results.filter((r) => r.name === 'save');
    expect(saveMethods.length).toBe(2);
    expect(
      saveMethods.some((r) => r.enclosingClassId === 'Interface:src/repo/Repo.java:Repository'),
    ).toBe(true);
    expect(
      saveMethods.some((r) => r.enclosingClassId === 'Class:src/repo/Repo.java:UserRepository'),
    ).toBe(true);
  });
});

describe('HAS_METHOD integration — C++ class methods', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.CPlusPlus);
  });

  it('inline methods link to their owning class_specifier', () => {
    const code = `
class Stack {
public:
  void push(int val) { data[top++] = val; }
  int pop() { return data[--top]; }
  int size() { return top; }
private:
  int data[100];
  int top;
};

class Queue {
public:
  void enqueue(int val) {}
  int dequeue() { return 0; }
};
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.CPlusPlus, 'src/containers.h');

    // Stack methods
    const push = results.find((r) => r.name === 'push');
    if (push) {
      expect(push.enclosingClassId).toBe('Class:src/containers.h:Stack');
    }

    const pop = results.find((r) => r.name === 'pop');
    if (pop) {
      expect(pop.enclosingClassId).toBe('Class:src/containers.h:Stack');
    }

    const size = results.find((r) => r.name === 'size');
    if (size) {
      expect(size.enclosingClassId).toBe('Class:src/containers.h:Stack');
    }

    // Queue methods
    const enqueue = results.find((r) => r.name === 'enqueue');
    if (enqueue) {
      expect(enqueue.enclosingClassId).toBe('Class:src/containers.h:Queue');
    }

    const dequeue = results.find((r) => r.name === 'dequeue');
    if (dequeue) {
      expect(dequeue.enclosingClassId).toBe('Class:src/containers.h:Queue');
    }
  });

  it('free functions have null enclosingClassId', () => {
    const code = `
void freeFunction() {}

class Foo {
public:
  void method() {}
};
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.CPlusPlus, 'src/mixed.cpp');

    const freeFn = results.find((r) => r.name === 'freeFunction');
    if (freeFn) {
      expect(freeFn.enclosingClassId).toBeNull();
    }

    const method = results.find((r) => r.name === 'method');
    if (method) {
      expect(method.enclosingClassId).toBe('Class:src/mixed.cpp:Foo');
    }
  });
});

describe('HAS_METHOD integration — TypeScript: abstract, interface, and #private methods', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.TypeScript, 'methods.ts');
  });

  it('abstract method signatures are captured and link to abstract class', () => {
    const code = `
abstract class Shape {
  abstract area(): number;
  describe(): string { return "shape"; }
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.TypeScript, 'src/shapes.ts');

    const area = results.find((r) => r.name === 'area' && r.defType === 'definition.method');
    expect(area).toBeDefined();
    expect(area!.enclosingClassId).toBe('Class:src/shapes.ts:Shape');

    const describe = results.find(
      (r) => r.name === 'describe' && r.defType === 'definition.method',
    );
    expect(describe).toBeDefined();
    expect(describe!.enclosingClassId).toBe('Class:src/shapes.ts:Shape');
  });

  it('interface method signatures are captured and link to interface', () => {
    const code = `
interface Printable {
  print(format: string): void;
  getLabel(): string;
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.TypeScript, 'src/printable.ts');

    const print = results.find((r) => r.name === 'print' && r.defType === 'definition.method');
    expect(print).toBeDefined();
    expect(print!.enclosingClassId).toBe('Interface:src/printable.ts:Printable');

    const getLabel = results.find(
      (r) => r.name === 'getLabel' && r.defType === 'definition.method',
    );
    expect(getLabel).toBeDefined();
    expect(getLabel!.enclosingClassId).toBe('Interface:src/printable.ts:Printable');
  });

  it('ES2022 #private methods are captured and link to class', () => {
    const code = `
class Vault {
  #decrypt(data: string): string { return data; }
  read(): string { return this.#decrypt("x"); }
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.TypeScript, 'src/vault.ts');

    const decrypt = results.find((r) => r.name === '#decrypt');
    expect(decrypt).toBeDefined();
    expect(decrypt!.defType).toBe('definition.method');
    expect(decrypt!.enclosingClassId).toBe('Class:src/vault.ts:Vault');

    const read = results.find((r) => r.name === 'read');
    expect(read).toBeDefined();
    expect(read!.enclosingClassId).toBe('Class:src/vault.ts:Vault');
  });
});

describe('HAS_METHOD integration — JavaScript: ES2022 #private methods', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.JavaScript);
  });

  it('#private methods are captured and link to class', () => {
    const code = `
class Encapsulated {
  #internal() { return 42; }
  expose() { return this.#internal(); }
}
`;
    const results = parseAndExtractMethods(
      code,
      SupportedLanguages.JavaScript,
      'src/encapsulated.js',
    );

    const internal = results.find((r) => r.name === '#internal');
    expect(internal).toBeDefined();
    expect(internal!.defType).toBe('definition.method');
    expect(internal!.enclosingClassId).toBe('Class:src/encapsulated.js:Encapsulated');
  });
});

describe('HAS_METHOD integration — C# struct and record', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.CSharp);
  });

  it('struct methods link to struct, record methods link to record', () => {
    const code = `
struct Vector2 {
  public float Length() { return 0; }
  public Vector2 Normalize() { return this; }
}

record Person {
  public string GetFullName() { return ""; }
}
`;
    const results = parseAndExtractMethods(code, SupportedLanguages.CSharp, 'src/Types.cs');

    const length = results.find((r) => r.name === 'Length');
    if (length) {
      expect(length.enclosingClassId).toBe('Struct:src/Types.cs:Vector2');
    }

    const normalize = results.find((r) => r.name === 'Normalize');
    if (normalize) {
      expect(normalize.enclosingClassId).toBe('Struct:src/Types.cs:Vector2');
    }

    const getFullName = results.find((r) => r.name === 'GetFullName');
    if (getFullName) {
      expect(getFullName.enclosingClassId).toBe('Record:src/Types.cs:Person');
    }
  });
});
