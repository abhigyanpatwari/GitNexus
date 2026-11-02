/**
 * Embedding sidecar entry — `child_process.fork()` target.
 *
 * Loads the local ONNX stack in this process only and returns vectors over IPC.
 * The parent keeps Ladybug writes. Do not import the parent façade from here.
 */

import { getCurrentDevice, initLocalEmbedder, localEmbedBatch } from './embedding-local-init.js';
import type { SidecarRequest, SidecarResponse } from './embedding-sidecar-protocol.js';

const send = (msg: SidecarResponse): void => {
  process.send?.(msg);
};

process.on('message', (msg: SidecarRequest) => {
  void handle(msg);
});

async function handle(msg: SidecarRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'init': {
        await initLocalEmbedder(
          (progress) => {
            send({
              id: msg.id,
              type: 'progress',
              progress: progress.progress ?? 0,
              status: progress.status,
            });
          },
          msg.embeddingConfig,
          msg.forceDevice,
        );
        send({
          id: msg.id,
          type: 'ready',
          device: getCurrentDevice() ?? 'cpu',
        });
        return;
      }
      case 'embed': {
        const vectors = await localEmbedBatch(msg.texts);
        send({
          id: msg.id,
          type: 'vectors',
          vectors: vectors.map((row) => Array.from(row)),
        });
        return;
      }
    }
  } catch (err) {
    send({
      id: msg.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
