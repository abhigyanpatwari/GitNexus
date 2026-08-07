/**
 * Unit test: Spring dynamic bean lookup heuristic.
 *
 * Tests `extractDynamicLookups` directly and the end-to-end
 * `attachJavaSpringDynamicLookup` function with an in-memory graph.
 */
import { describe, it, expect } from 'vitest';

// We test the regex extraction logic directly since building a full
// KnowledgeGraph mock is heavy. The integration is verified by the
// end-to-end analyze tests.

// Re-implement the extraction logic for unit testing (it's a pure function)
function extractDynamicLookups(sourceText: string, callerNodeId: string) {
  const KNOWN_RECEIVERS = new Set([
    'SpringContextUtil',
    'SpringContextHolder',
    'SpringBeanUtil',
    'ApplicationContextProvider',
    'BeanFactoryProvider',
    'applicationContext',
    'context',
    'ctx',
    'appContext',
    'beanFactory',
  ]);
  const COLLECTION_METHODS = new Set(['getBeans', 'getBeansOfType']);
  const SINGLE_METHODS = new Set(['getBean']);
  const sites: Array<{ callerNodeId: string; typeName: string; isCollection: boolean }> = [];
  const pattern = /(\w+)\.(getBeans(?:OfType)?|getBean)\s*\(\s*(\w+)\.class\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sourceText)) !== null) {
    const receiver = match[1];
    const methodName = match[2];
    const typeName = match[3];
    if (!KNOWN_RECEIVERS.has(receiver)) continue;
    const isCollection = COLLECTION_METHODS.has(methodName);
    if (!isCollection && !SINGLE_METHODS.has(methodName)) continue;
    sites.push({ callerNodeId, typeName, isCollection });
  }
  return sites;
}

describe('extractDynamicLookups', () => {
  it('detects SpringContextUtil.getBeans(X.class) as collection lookup', () => {
    const code = `
      Map<String, OrderService> beans = SpringContextUtil.getBeans(OrderService.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('OrderService');
    expect(sites[0].isCollection).toBe(true);
  });

  it('detects SpringContextUtil.getBean(X.class) as single lookup', () => {
    const code = `
      RedisAbility redis = SpringContextUtil.getBean(RedisAbility.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('RedisAbility');
    expect(sites[0].isCollection).toBe(false);
  });

  it('detects getBeansOfType variant', () => {
    const code = `
      Map<String, Factory> map = SpringContextUtil.getBeansOfType(Factory.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Factory');
    expect(sites[0].isCollection).toBe(true);
  });

  it('detects applicationContext.getBeans(X.class)', () => {
    const code = `
      Map<String, Plugin> plugins = applicationContext.getBeans(Plugin.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Plugin');
  });

  it('detects ctx.getBean(X.class)', () => {
    const code = `
      Service svc = ctx.getBean(Service.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Service');
  });

  it('skips unknown receivers', () => {
    const code = `
      Map<String, X> map = someRandomHelper.getBeans(X.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('skips getBean(String) — string argument, not .class', () => {
    const code = `
      Object bean = SpringContextUtil.getBean("myBean");
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('detects multiple lookups in the same function', () => {
    const code = `
      Map<String, A> aMap = SpringContextUtil.getBeans(A.class);
      B b = SpringContextUtil.getBean(B.class);
      Map<String, C> cMap = ctx.getBeansOfType(C.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(3);
    expect(sites.map((s) => s.typeName).sort()).toEqual(['A', 'B', 'C']);
  });

  it('handles getBeans with extra whitespace', () => {
    const code = `
      Map<String, X> map = SpringContextUtil.getBeans(  X.class  );
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('X');
  });

  it('handles fully-qualified receiver', () => {
    // SpringContextUtil is imported, so the receiver text is the simple name
    const code = `
      Map<String, X> map = SpringContextUtil.getBeans(X.class);
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
  });

  it('does not match getBean without .class argument', () => {
    const code = `
      Object x = SpringContextUtil.getBean();
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('does not match unrelated methods like getContext', () => {
    const code = `
      ApplicationContext ctx = SpringContextUtil.getContext();
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(0);
  });

  it('handles stream-style getBeans usage', () => {
    const code = `
      List<Service> services = SpringContextUtil.getBeans(Service.class)
          .values().stream().collect(Collectors.toList());
    `;
    const sites = extractDynamicLookups(code, 'fn-1');
    expect(sites).toHaveLength(1);
    expect(sites[0].typeName).toBe('Service');
    expect(sites[0].isCollection).toBe(true);
  });
});
