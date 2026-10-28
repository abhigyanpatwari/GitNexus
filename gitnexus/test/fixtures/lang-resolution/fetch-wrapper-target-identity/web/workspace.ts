import { workspaceRequest as send } from '@repo/http';
export const loadWorkspace = () => send('/api/workspace');
