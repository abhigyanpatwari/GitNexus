import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { querySpringAopMetadata } from '../../src/mcp/local/aop-metadata.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const SERVICE_ID = 'Class:src/PaymentService.java:PaymentService';
const ASPECT_CLASS_ID = 'Class:src/AuditAspect.java:AuditAspect';
const NOISY_ASPECT_CLASS_ID = 'Class:src/NoisyAspect.java:NoisyAspect';
const PAY_ID = 'Method:src/PaymentService.java:PaymentService.pay#0';
const CLASS_LEVEL_METHOD_ID = 'Method:src/PaymentService.java:PaymentService.list#0';
const AUDIT_ID = 'Method:src/AuditAspect.java:AuditAspect.audit#0';
const UNKNOWN_ADVICE_ID = 'Method:src/AuditAspect.java:AuditAspect.authorize#0';
const HIGH_FAN_IN_ADVICE_ID = 'Method:src/AuditAspect.java:AuditAspect.hotAdvice#0';
const NOISY_ADVICE_ID = 'Method:src/NoisyAspect.java:NoisyAspect.noisyAdvice#0';
const NOISY_ADVISED_SOURCE_ID = 'Method:src/NoisySource.java:NoisySource.run#0';
const NOISY_ADVICE_TARGET_ID = 'Method:src/NoisyTarget.java:NoisyTarget.advise#0';
const FOREIGN_ADVISED_SOURCE_ID = 'Method:src/ForeignSource.java:ForeignSource.run#0';
const FOREIGN_ADVICE_TARGET_ID = 'Method:src/ForeignTarget.java:ForeignTarget.advise#0';
const PLAIN_ID = 'Method:src/Plain.java:Plain.run#0';
const CLASS_BEHAVIOR_ID = `CodeElement:spring-aop:${SERVICE_ID}:transactional`;
const METHOD_BEHAVIOR_ID = `CodeElement:spring-aop:${PAY_ID}:cacheable`;
const UNKNOWN_POINTCUT_ID = `CodeElement:spring-aop:${UNKNOWN_ADVICE_ID}:pointcut`;
const UNRELATED_DECLARATION_ID = `CodeElement:spring-bean:${PLAIN_ID}`;
const ASPECT_EVIDENCE_ID = `CodeElement:spring-aop:${ASPECT_CLASS_ID}:aspect`;
const NOISY_ASPECT_EVIDENCE_ID = `CodeElement:spring-aop:${NOISY_ASPECT_CLASS_ID}:aspect`;
const NOISY_POINTCUT_ID = `CodeElement:spring-aop:${NOISY_ADVICE_ID}:pointcut`;

const springReason = (value: object): string => `spring-aop:v1:${JSON.stringify(value)}`;

const CLASS_BEHAVIOR_REASON = springReason({
  kind: 'behavior',
  annotation: 'org.springframework.transaction.annotation.Transactional',
  behavior: 'transactional',
  declaredOn: 'class',
  activation: 'unknown',
  proxy: 'possible',
});
const METHOD_BEHAVIOR_REASON = springReason({
  kind: 'behavior',
  annotation: 'org.springframework.cache.annotation.Cacheable',
  behavior: 'cacheable',
  declaredOn: 'method',
  activation: 'unknown',
  proxy: 'possible',
});
const ADVICE_REASON = springReason({
  kind: 'advice',
  annotation: 'org.aspectj.lang.annotation.Around',
  advice: 'around',
  pointcut: 'execution(* com.example.PaymentService.pay(..))',
  match: 'static',
  activation: 'unknown',
  proxy: 'possible',
});
const UNKNOWN_POINTCUT_REASON = springReason({
  kind: 'pointcut',
  annotation: 'org.aspectj.lang.annotation.Before',
  pointcut: 'securedOperation()',
  match: 'unresolved',
  resolution: 'unknown',
});
const ASPECT_REASON = springReason({
  kind: 'aspect',
  annotation: 'org.aspectj.lang.annotation.Aspect',
  activation: 'unknown',
  registration: 'unknown',
});

const HIGH_FAN_IN_ADVISED_IDS = Array.from(
  { length: 31 },
  (_, index) => `Method:src/FanInService.java:FanInService.advised${index}#0`,
);
const HIGH_FAN_IN_CALLER_IDS = Array.from(
  { length: 31 },
  (_, index) => `Method:src/LegacyCaller.java:LegacyCaller.call${index}#0`,
);

const SEED = [
  `CREATE (c:Class {id:'${SERVICE_ID}', name:'PaymentService', filePath:'src/PaymentService.java', startLine:0, endLine:20, isExported:false, content:'class PaymentService {}', description:'', frameworkAnnotations:[]})`,
  `CREATE (c:Class {id:'${ASPECT_CLASS_ID}', name:'AuditAspect', filePath:'src/AuditAspect.java', startLine:0, endLine:20, isExported:false, content:'class AuditAspect {}', description:'', frameworkAnnotations:[]})`,
  `CREATE (c:Class {id:'${NOISY_ASPECT_CLASS_ID}', name:'NoisyAspect', filePath:'src/NoisyAspect.java', startLine:0, endLine:20, isExported:false, content:'class NoisyAspect {}', description:'', frameworkAnnotations:[]})`,
  `CREATE (m:Method {id:'${PAY_ID}', name:'pay', filePath:'src/PaymentService.java', startLine:4, endLine:8, isExported:false, content:'void pay() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${CLASS_LEVEL_METHOD_ID}', name:'list', filePath:'src/PaymentService.java', startLine:10, endLine:12, isExported:false, content:'void list() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${AUDIT_ID}', name:'audit', filePath:'src/AuditAspect.java', startLine:4, endLine:8, isExported:false, content:'Object audit() {}', description:'', parameterCount:0, returnType:'Object'})`,
  `CREATE (m:Method {id:'${UNKNOWN_ADVICE_ID}', name:'authorize', filePath:'src/AuditAspect.java', startLine:10, endLine:12, isExported:false, content:'void authorize() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${HIGH_FAN_IN_ADVICE_ID}', name:'hotAdvice', filePath:'src/AuditAspect.java', startLine:14, endLine:16, isExported:false, content:'void hotAdvice() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${NOISY_ADVICE_ID}', name:'noisyAdvice', filePath:'src/NoisyAspect.java', startLine:4, endLine:8, isExported:false, content:'void noisyAdvice() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${NOISY_ADVISED_SOURCE_ID}', name:'run', filePath:'src/NoisySource.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${NOISY_ADVICE_TARGET_ID}', name:'advise', filePath:'src/NoisyTarget.java', startLine:1, endLine:2, isExported:false, content:'void advise() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${FOREIGN_ADVISED_SOURCE_ID}', name:'run', filePath:'src/ForeignSource.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (m:Method {id:'${FOREIGN_ADVICE_TARGET_ID}', name:'advise', filePath:'src/ForeignTarget.java', startLine:1, endLine:2, isExported:false, content:'void advise() {}', description:'', parameterCount:0, returnType:'void'})`,
  ...HIGH_FAN_IN_ADVISED_IDS.map(
    (id, index) =>
      `CREATE (m:Method {id:'${id}', name:'advised${index}', filePath:'src/FanInService.java', startLine:${index}, endLine:${index}, isExported:false, content:'void advised${index}() {}', description:'', parameterCount:0, returnType:'void'})`,
  ),
  ...HIGH_FAN_IN_CALLER_IDS.map(
    (id, index) =>
      `CREATE (m:Method {id:'${id}', name:'call${index}', filePath:'src/LegacyCaller.java', startLine:${index}, endLine:${index}, isExported:false, content:'void call${index}() {}', description:'', parameterCount:0, returnType:'void'})`,
  ),
  `CREATE (m:Method {id:'${PLAIN_ID}', name:'run', filePath:'src/Plain.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
  `CREATE (e:CodeElement {id:'${CLASS_BEHAVIOR_ID}', name:'Transactional', filePath:'src/PaymentService.java', startLine:0, endLine:0, isExported:false, content:'', description:'Spring AOP behavior evidence'})`,
  `CREATE (e:CodeElement {id:'${METHOD_BEHAVIOR_ID}', name:'Cacheable', filePath:'src/PaymentService.java', startLine:4, endLine:4, isExported:false, content:'', description:'Spring AOP behavior evidence'})`,
  `CREATE (e:CodeElement {id:'${UNKNOWN_POINTCUT_ID}', name:'securedOperation()', filePath:'src/AuditAspect.java', startLine:10, endLine:10, isExported:false, content:'', description:'Spring AOP unresolved pointcut evidence'})`,
  `CREATE (e:CodeElement {id:'${UNRELATED_DECLARATION_ID}', name:'plain', filePath:'src/Plain.java', startLine:1, endLine:1, isExported:false, content:'', description:'Spring Bean factory declaration'})`,
  `CREATE (e:CodeElement {id:'${ASPECT_EVIDENCE_ID}', name:'Aspect', filePath:'src/AuditAspect.java', startLine:0, endLine:0, isExported:false, content:'', description:'Spring AOP aspect evidence'})`,
  `CREATE (e:CodeElement {id:'${NOISY_ASPECT_EVIDENCE_ID}', name:'Aspect', filePath:'src/NoisyAspect.java', startLine:0, endLine:0, isExported:false, content:'', description:'Spring AOP aspect evidence'})`,
  `CREATE (e:CodeElement {id:'${NOISY_POINTCUT_ID}', name:'securedOperation()', filePath:'src/NoisyAspect.java', startLine:4, endLine:4, isExported:false, content:'', description:'Spring AOP unresolved pointcut evidence'})`,
  `MATCH (c:Class {id:'${SERVICE_ID}'}), (e:CodeElement {id:'${CLASS_BEHAVIOR_ID}'}) CREATE (c)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${CLASS_BEHAVIOR_REASON}', step:0}]->(e)`,
  `MATCH (m:Method {id:'${CLASS_LEVEL_METHOD_ID}'}), (e:CodeElement {id:'${CLASS_BEHAVIOR_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${CLASS_BEHAVIOR_REASON}', step:0}]->(e)`,
  `MATCH (m:Method {id:'${PAY_ID}'}), (e:CodeElement {id:'${METHOD_BEHAVIOR_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${METHOD_BEHAVIOR_REASON}', step:0}]->(e)`,
  // Duplicate evidence exercises read-side deduplication for indexes produced
  // by an interrupted/retried incremental write.
  `MATCH (m:Method {id:'${PAY_ID}'}), (e:CodeElement {id:'${METHOD_BEHAVIOR_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${METHOD_BEHAVIOR_REASON}', step:0}]->(e)`,
  `MATCH (m:Method {id:'${PAY_ID}'}), (a:Method {id:'${AUDIT_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:0}]->(a)`,
  `MATCH (a:Method {id:'${UNKNOWN_ADVICE_ID}'}), (e:CodeElement {id:'${UNKNOWN_POINTCUT_ID}'}) CREATE (a)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${UNKNOWN_POINTCUT_REASON}', step:0}]->(e)`,
  `MATCH (c:Class {id:'${ASPECT_CLASS_ID}'}), (e:CodeElement {id:'${ASPECT_EVIDENCE_ID}'}) CREATE (c)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${ASPECT_REASON}', step:0}]->(e)`,
  `MATCH (m:Method {id:'${PLAIN_ID}'}), (e:CodeElement {id:'${UNRELATED_DECLARATION_ID}'}) CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'spring-bean-factory:{"names":["plain"],"namesKnown":true}', step:0}]->(e)`,
  `MATCH (c:Class {id:'${NOISY_ASPECT_CLASS_ID}'}), (e:CodeElement {id:'${UNRELATED_DECLARATION_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (c)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'spring-bean-factory:{"names":["noise"],"namesKnown":true}', step:ignored}]->(e)`,
  `MATCH (c:Class {id:'${NOISY_ASPECT_CLASS_ID}'}), (e:CodeElement {id:'${NOISY_ASPECT_EVIDENCE_ID}'}) CREATE (c)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${ASPECT_REASON}', step:0}]->(e)`,
  `MATCH (m:Method {id:'${PLAIN_ID}'}), (e:CodeElement {id:'${NOISY_POINTCUT_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'spring-bean-factory:{"names":["noise"],"namesKnown":true}', step:ignored}]->(e)`,
  `MATCH (m:Method {id:'${NOISY_ADVICE_ID}'}), (e:CodeElement {id:'${NOISY_POINTCUT_ID}'}) CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${UNKNOWN_POINTCUT_REASON}', step:0}]->(e)`,
  `MATCH (m:Method {id:'${NOISY_ADVISED_SOURCE_ID}'}), (a:Method {id:'${NOISY_ADVICE_TARGET_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:0}]->(a)`,
  `MATCH (m:Method {id:'${NOISY_ADVISED_SOURCE_ID}'}), (a:Method {id:'${FOREIGN_ADVICE_TARGET_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.1, reason:'foreign-advice', step:ignored}]->(a)`,
  `MATCH (m:Method {id:'${FOREIGN_ADVISED_SOURCE_ID}'}), (a:Method {id:'${NOISY_ADVICE_TARGET_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.1, reason:'foreign-advice', step:ignored}]->(a)`,
  ...HIGH_FAN_IN_ADVISED_IDS.map(
    (id) =>
      `MATCH (m:Method {id:'${id}'}), (a:Method {id:'${HIGH_FAN_IN_ADVICE_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:0}]->(a)`,
  ),
  ...HIGH_FAN_IN_CALLER_IDS.map(
    (id) =>
      `MATCH (m:Method {id:'${id}'}), (a:Method {id:'${HIGH_FAN_IN_ADVICE_ID}'}) CREATE (m)-[:CodeRelation {type:'CALLS', confidence:1.0, reason:'test fixture', step:0}]->(a)`,
  ),
];

withTestLbugDB(
  'spring-aop-mcp',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(() => {
      backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
    });

    describe('Spring AOP metadata enrichment', () => {
      it('normalizes declarative behavior and explicit advice for an advised method', async () => {
        const metadata = await querySpringAopMetadata(handle.repoId, PAY_ID, 'Method');

        expect(metadata).toEqual({
          framework: 'spring',
          proxied: 'possible',
          behaviors: [
            {
              annotation: 'org.springframework.cache.annotation.Cacheable',
              behavior: 'cacheable',
              declaredOn: 'method',
              activation: 'unknown',
              evidenceId: METHOD_BEHAVIOR_ID,
            },
          ],
          advices: [
            {
              annotation: 'org.aspectj.lang.annotation.Around',
              advice: 'around',
              pointcut: 'execution(* com.example.PaymentService.pay(..))',
              match: 'static',
              activation: 'unknown',
              adviceId: AUDIT_ID,
              adviceName: 'audit',
              adviceFilePath: 'src/AuditAspect.java',
              advisedId: PAY_ID,
              advisedName: 'pay',
              advisedFilePath: 'src/PaymentService.java',
            },
          ],
          unresolvedPointcuts: [],
        });
      });

      it('returns the same canonical advice direction from the advice method', async () => {
        const metadata = await querySpringAopMetadata(handle.repoId, AUDIT_ID, 'Method');

        expect(metadata?.advices).toEqual([
          expect.objectContaining({
            adviceId: AUDIT_ID,
            advisedId: PAY_ID,
            advice: 'around',
          }),
        ]);
        expect(metadata).not.toHaveProperty('proxied');
      });

      it('exposes the same AOP metadata through context and impact', async () => {
        const [context, adviceContext, impact, adviceImpact] = await Promise.all([
          backend.callTool('context', { uid: PAY_ID }),
          backend.callTool('context', { uid: AUDIT_ID }),
          backend.callTool('impact', {
            target: 'pay',
            direction: 'upstream',
          }),
          backend.callTool('impact', {
            target: 'audit',
            direction: 'upstream',
            relationTypes: ['ADVISED_BY'],
            includeTests: true,
          }),
        ]);

        expect(context.symbol.aop).toEqual(
          expect.objectContaining({
            framework: 'spring',
            proxied: 'possible',
            behaviors: [expect.objectContaining({ behavior: 'cacheable' })],
            advices: [expect.objectContaining({ advice: 'around', adviceId: AUDIT_ID })],
          }),
        );
        expect(context.outgoing.advised_by).toEqual(
          expect.arrayContaining([expect.objectContaining({ uid: AUDIT_ID, name: 'audit' })]),
        );
        expect(adviceContext.incoming.advised_by).toEqual(
          expect.arrayContaining([expect.objectContaining({ uid: PAY_ID, name: 'pay' })]),
        );
        expect(adviceContext.symbol.aop).not.toHaveProperty('proxied');
        expect(impact.target.aop).toEqual(context.symbol.aop);
        expect(adviceImpact.target.aop).toEqual(adviceContext.symbol.aop);
        expect(adviceImpact.byDepth[1]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: PAY_ID,
              name: 'pay',
              relationType: 'ADVISED_BY',
            }),
          ]),
        );
      });

      it('keeps legacy context relations when advice fan-in exceeds the context window', async () => {
        const context = await backend.callTool('context', { uid: HIGH_FAN_IN_ADVICE_ID });

        expect(context.incoming.calls).toHaveLength(30);
        expect(context.incoming.advised_by).toHaveLength(30);
        expect(context.symbol.aop.advices).toHaveLength(31);
      });

      it('supports Class and CodeElement behavior evidence', async () => {
        const classMetadata = await querySpringAopMetadata(handle.repoId, SERVICE_ID, 'Class');
        const classLevelMethodMetadata = await querySpringAopMetadata(
          handle.repoId,
          CLASS_LEVEL_METHOD_ID,
          'Method',
        );
        const evidenceMetadata = await querySpringAopMetadata(
          handle.repoId,
          METHOD_BEHAVIOR_ID,
          'CodeElement',
        );

        expect(classMetadata?.behaviors).toEqual([
          expect.objectContaining({ behavior: 'transactional', declaredOn: 'class' }),
        ]);
        expect(classMetadata?.proxied).toBe('possible');
        expect(classLevelMethodMetadata?.behaviors).toEqual([
          expect.objectContaining({ behavior: 'transactional', declaredOn: 'class' }),
        ]);
        expect(classLevelMethodMetadata?.proxied).toBe('possible');
        expect(evidenceMetadata?.behaviors).toEqual([
          expect.objectContaining({ behavior: 'cacheable', evidenceId: METHOD_BEHAVIOR_ID }),
        ]);
        expect(evidenceMetadata).not.toHaveProperty('proxied');
      });

      it('surfaces standalone Aspect declarations without claiming proxy activation', async () => {
        const [classMetadata, evidenceMetadata, context] = await Promise.all([
          querySpringAopMetadata(handle.repoId, ASPECT_CLASS_ID, 'Class'),
          querySpringAopMetadata(handle.repoId, ASPECT_EVIDENCE_ID, 'CodeElement'),
          backend.callTool('context', { uid: ASPECT_CLASS_ID }),
        ]);
        const expectedAspect = {
          annotation: 'org.aspectj.lang.annotation.Aspect',
          activation: 'unknown',
          registration: 'unknown',
          evidenceId: ASPECT_EVIDENCE_ID,
        };

        expect(classMetadata?.aspect).toEqual(expectedAspect);
        expect(classMetadata).not.toHaveProperty('proxied');
        expect(evidenceMetadata?.aspect).toEqual(expectedAspect);
        expect(evidenceMetadata).not.toHaveProperty('proxied');
        expect(context.symbol.aop.aspect).toEqual(expectedAspect);
        expect(context.symbol.aop).not.toHaveProperty('proxied');
      });

      it('surfaces unresolved pointcuts without guessing an advised target', async () => {
        const adviceMetadata = await querySpringAopMetadata(
          handle.repoId,
          UNKNOWN_ADVICE_ID,
          'Method',
        );
        const evidenceMetadata = await querySpringAopMetadata(
          handle.repoId,
          UNKNOWN_POINTCUT_ID,
          'CodeElement',
        );

        const expected = [
          {
            annotation: 'org.aspectj.lang.annotation.Before',
            pointcut: 'securedOperation()',
            adviceId: UNKNOWN_ADVICE_ID,
            adviceName: 'authorize',
            adviceFilePath: 'src/AuditAspect.java',
            evidenceId: UNKNOWN_POINTCUT_ID,
          },
        ];
        expect(adviceMetadata).toEqual({
          framework: 'spring',
          behaviors: [],
          advices: [],
          unresolvedPointcuts: expected,
        });
        expect(evidenceMetadata?.unresolvedPointcuts).toEqual(expected);
      });

      it('does not let unrelated DECLARES exhaust the Spring AOP query budget', async () => {
        const [aspectMetadata, pointcutMetadata] = await Promise.all([
          querySpringAopMetadata(handle.repoId, NOISY_ASPECT_CLASS_ID, 'Class'),
          querySpringAopMetadata(handle.repoId, NOISY_POINTCUT_ID, 'CodeElement'),
        ]);

        expect(aspectMetadata?.aspect).toEqual({
          annotation: 'org.aspectj.lang.annotation.Aspect',
          activation: 'unknown',
          registration: 'unknown',
          evidenceId: NOISY_ASPECT_EVIDENCE_ID,
        });
        expect(aspectMetadata).not.toHaveProperty('truncated');
        expect(pointcutMetadata?.unresolvedPointcuts).toEqual([
          {
            annotation: 'org.aspectj.lang.annotation.Before',
            pointcut: 'securedOperation()',
            adviceId: NOISY_ADVICE_ID,
            adviceName: 'noisyAdvice',
            adviceFilePath: 'src/NoisyAspect.java',
            evidenceId: NOISY_POINTCUT_ID,
          },
        ]);
        expect(pointcutMetadata).not.toHaveProperty('truncated');
      });

      it('does not let unrelated ADVISED_BY exhaust either AOP query direction', async () => {
        const [sourceMetadata, targetMetadata] = await Promise.all([
          querySpringAopMetadata(handle.repoId, NOISY_ADVISED_SOURCE_ID, 'Method'),
          querySpringAopMetadata(handle.repoId, NOISY_ADVICE_TARGET_ID, 'Method'),
        ]);

        expect(sourceMetadata?.advices).toEqual([
          expect.objectContaining({
            advisedId: NOISY_ADVISED_SOURCE_ID,
            adviceId: NOISY_ADVICE_TARGET_ID,
          }),
        ]);
        expect(targetMetadata?.advices).toEqual(sourceMetadata?.advices);
        expect(sourceMetadata).not.toHaveProperty('truncated');
        expect(targetMetadata).not.toHaveProperty('truncated');
      });

      it('ignores unrelated DECLARES evidence and unsupported symbol kinds', async () => {
        await expect(
          querySpringAopMetadata(handle.repoId, PLAIN_ID, 'Method'),
        ).resolves.toBeUndefined();
        await expect(
          querySpringAopMetadata(handle.repoId, 'Function:src/plain.ts:run', 'Function'),
        ).resolves.toBeUndefined();
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 3, nodes: 12, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
