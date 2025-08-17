import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StreamingProcessor } from '../lib/streaming-processor';
import { Readable } from 'stream';

describe('StreamingProcessor', () => {
  let processor: StreamingProcessor;

  beforeEach(() => {
    (StreamingProcessor as any).instance = undefined;
    processor = StreamingProcessor.getInstance();
  });

  it('should get a singleton instance', () => {
    const instance2 = StreamingProcessor.getInstance();
    expect(processor).toBe(instance2);
  });

  describe('processFile', () => {
    it('should process a file and return data', async () => {
      const mockReadStream = new Readable();
      mockReadStream.push('line 1\n');
      mockReadStream.push('line 2\n');
      mockReadStream.push(null);

      jest.spyOn(require('fs'), 'createReadStream').mockReturnValue(mockReadStream);
      jest.spyOn(require('fs/promises'), 'stat').mockResolvedValue({ size: 100 });

      const result = await processor.processFile('test.txt', async (line) => line);
      expect(result.data).toEqual(['line 1', 'line 2']);
    });
  });

  describe('processFilesParallel', () => {
    it('should process files in parallel', async () => {
      const fileProcessor = jest.fn<() => Promise<string>>().mockResolvedValue('processed');
      const results = await processor.processFilesParallel(['a.txt', 'b.txt'], fileProcessor);
      expect(results.length).toBe(2);
      expect(fileProcessor).toHaveBeenCalledTimes(2);
    });
  });

  describe('processInBatches', () => {
    it('should process data in batches', async () => {
      const batchProcessor = jest.fn<() => Promise<string[]>>().mockResolvedValue(['processed']);
      const results = await processor.processInBatches([1, 2, 3, 4, 5], batchProcessor, 2);
      expect(results.length).toBe(3);
      expect(batchProcessor).toHaveBeenCalledTimes(3);
    });
  });
});