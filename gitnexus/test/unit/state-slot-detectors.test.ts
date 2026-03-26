import { describe, it, expect } from 'vitest';
import { detectSwrSlots } from '../../src/core/ingestion/state-slot-detectors/swr.js';
import { detectReactQuerySlots } from '../../src/core/ingestion/state-slot-detectors/react-query.js';

describe('state-slot-detectors', () => {
  describe('detectSwrSlots', () => {
    it('detects useSWR with string key', () => {
      const code = `
        function VendorDetail({ id }) {
          const { data, error } = useSWR('/api/vendors/' + id, fetcher);
          return <div>{data?.name}</div>;
        }
      `;
      const slots = detectSwrSlots(code, '/src/components/VendorDetail.tsx');
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('swr');
      expect(slots[0].cacheKey).toBe("'/api/vendors/' + id");
      expect(slots[0].filePath).toBe('/src/components/VendorDetail.tsx');
      expect(slots[0].lineNumber).toBeGreaterThan(0);
    });

    it('detects useSWR with array key', () => {
      const code = `
        function useVendor(id) {
          const { data } = useSWR(['vendors', id], fetchVendor);
          return data;
        }
      `;
      const slots = detectSwrSlots(code, '/src/hooks/useVendor.ts');
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('swr');
      expect(slots[0].cacheKey).toBe("['vendors', id]");
      expect(slots[0].name).toBe("['vendors', id]");
    });

    it('detects useSWRMutation', () => {
      const code = `
        function useUpdateVendor() {
          const { trigger, isMutating } = useSWRMutation('/api/vendors', updateVendor);
          return { trigger, isMutating };
        }
      `;
      const slots = detectSwrSlots(code, '/src/hooks/useUpdateVendor.ts');
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('swr');
      expect(slots[0].cacheKey).toBe("'/api/vendors'");
    });

    it('returns empty for files without SWR', () => {
      const code = `
        function MyComponent() {
          const [state, setState] = useState(null);
          useEffect(() => { setState('hello'); }, []);
          return <div>{state}</div>;
        }
      `;
      const slots = detectSwrSlots(code, '/src/components/MyComponent.tsx');
      expect(slots).toHaveLength(0);
    });

    it('extracts consumer access patterns from context window', () => {
      const code = `
        function VendorList() {
          const { data } = useSWR('/api/vendors', fetcher);
          return (
            <ul>
              {data?.items.map(v => <li key={v.id}>{v.name}</li>)}
              <span>Total: {data?.total}</span>
            </ul>
          );
        }
      `;
      const slots = detectSwrSlots(code, '/src/components/VendorList.tsx');
      expect(slots).toHaveLength(1);
      // Consumer access keys should be detected from the context window
      const consumers = slots[0].consumers;
      expect(consumers.length).toBeGreaterThan(0);
      expect(consumers[0].accessedKeys).toContain('items');
      expect(consumers[0].accessedKeys).toContain('total');
    });

    it('detects multiple SWR calls in same file', () => {
      const code = `
        function useData() {
          const { data: vendors } = useSWR('/api/vendors', fetchVendors);
          const { data: grants } = useSWR('/api/grants', fetchGrants);
          return { vendors, grants };
        }
      `;
      const slots = detectSwrSlots(code, '/src/hooks/useData.ts');
      expect(slots).toHaveLength(2);
      const keys = slots.map(s => s.cacheKey);
      expect(keys).toContain("'/api/vendors'");
      expect(keys).toContain("'/api/grants'");
    });

    it('detects useSWR with template literal key', () => {
      const code = `
        function useVendorById(id) {
          const { data } = useSWR(\`/api/vendors/\${id}\`, fetcher);
          return data;
        }
      `;
      const slots = detectSwrSlots(code, '/src/hooks/useVendorById.ts');
      expect(slots).toHaveLength(1);
      expect(slots[0].cacheKey).toBe('`/api/vendors/${id}`');
    });
  });

  describe('detectReactQuerySlots', () => {
    const FILE_PATH = '/project/src/hooks/useVendors.ts';

    it('detects useQuery with array queryKey', () => {
      const source = `
        export function useVendorPatterns(slug: string) {
          return useQuery({
            queryKey: ['vendor-patterns', slug],
            queryFn: () => fetchVendorPatterns(slug),
          });
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('react-query');
      expect(slots[0].cacheKey).toBe(`['vendor-patterns', slug]`);
      expect(slots[0].name).toBe(`['vendor-patterns', slug]`);
      expect(slots[0].filePath).toBe(FILE_PATH);
      expect(slots[0].lineNumber).toBeGreaterThan(0);
    });

    it('detects multiple useQuery calls in same file', () => {
      const source = `
        export function useVendors() {
          return useQuery({
            queryKey: ['vendors-list'],
            queryFn: fetchVendors,
          });
        }

        export function useVendorDetail(id: string) {
          return useQuery({
            queryKey: ['vendor-detail', id],
            queryFn: () => fetchVendorDetail(id),
          });
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(2);
      const keys = slots.map((s) => s.cacheKey);
      expect(keys).toContain(`['vendors-list']`);
      expect(keys).toContain(`['vendor-detail', id]`);
    });

    it('detects useMutation with mutationKey', () => {
      const source = `
        export function useUpdateVendor() {
          return useMutation({
            mutationKey: ['update-vendor'],
            mutationFn: (data: VendorInput) => updateVendor(data),
          });
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('react-query');
      expect(slots[0].cacheKey).toBe(`['update-vendor']`);
    });

    it('detects useInfiniteQuery', () => {
      const source = `
        export function useVendorsPaged() {
          return useInfiniteQuery({
            queryKey: ['vendors-paged'],
            queryFn: ({ pageParam }) => fetchVendorsPage(pageParam),
            getNextPageParam: (last) => last.nextCursor,
          });
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('react-query');
      expect(slots[0].cacheKey).toBe(`['vendors-paged']`);
    });

    it('detects useSuspenseQuery', () => {
      const source = `
        export function useVendorSuspense(id: string) {
          return useSuspenseQuery({
            queryKey: ['vendor-suspense', id],
            queryFn: () => fetchVendor(id),
          });
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(1);
      expect(slots[0].slotKind).toBe('react-query');
      expect(slots[0].cacheKey).toBe(`['vendor-suspense', id]`);
    });

    it('returns empty array for files without React Query hooks', () => {
      const source = `
        export function fetchVendors() {
          return fetch('/api/vendors').then((r) => r.json());
        }

        const data = useState(null);
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(0);
    });

    it('extracts consumer accessed keys from destructuring', () => {
      const source = `
        export function VendorList() {
          const { data, isLoading, error } = useQuery({
            queryKey: ['vendor-list'],
            queryFn: fetchVendors,
          });
          const { patterns, total } = data ?? {};
          return <div>{total}</div>;
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(1);
      const consumer = slots[0].consumers[0];
      expect(consumer).toBeDefined();
      expect(consumer.accessedKeys).toContain('patterns');
      expect(consumer.accessedKeys).toContain('total');
    });

    it('extracts consumer accessed keys from property access', () => {
      // Uses `data.name` so that extractPropertyAccessKeys matches `data` as the var name
      // and captures `name` as the accessed key (shape-inference only tracks known var names)
      const source = `
        export function VendorDetail({ id }: { id: string }) {
          const { data } = useQuery({
            queryKey: ['vendor-detail', id],
            queryFn: () => fetchVendor(id),
          });
          return <h1>{data?.name}</h1>;
        }
      `;
      const slots = detectReactQuerySlots(source, FILE_PATH);
      expect(slots).toHaveLength(1);
      const consumer = slots[0].consumers[0];
      expect(consumer).toBeDefined();
      expect(consumer.accessedKeys).toContain('name');
    });
  });
});
